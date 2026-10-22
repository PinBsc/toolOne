import { Contract, FetchRequest, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";
import {
  CHAINS,
  DEFAULT_TOKEN_GAS,
  MAX_HOPS,
  MAX_TOKEN_GAS,
  NATIVE_DECIMALS,
  NATIVE_GAS_LIMIT,
} from "./chains";
import { isUncertainSendError, parsePositiveAmount } from "./format";
import { applyExecutionBump, downstreamBudget, perHopNativeCost, requiredNative, splitAmount } from "./plan";
import { redactRpcUrl } from "./rpc";
import type { ChainKey, TokenMode, TransferPlan } from "./types";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const ERC20_BYTES32_ABI = ["function symbol() view returns (bytes32)"];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function addressFromPrivateKey(input: string): string {
  return readPrivateKey(input).address;
}

export function readPrivateKey(input: string): Wallet {
  const raw = input.trim();
  if (!raw) throw new Error("请填写起始钱包私钥。");
  if (raw.split(/\s+/).length > 1) throw new Error("这里填私钥，不填助记词。");
  try {
    return new Wallet(raw);
  } catch {
    throw new Error("私钥格式不对。");
  }
}

export function readFinalAddresses(values: string[], lineCount: number): string[] {
  const picked = values.slice(0, lineCount);
  if (picked.length !== lineCount) throw new Error("请把每条线的最终地址填完整。");
  return picked.map((value, index) => {
    const trimmed = value.trim();
    if (!isAddress(trimmed)) throw new Error(`线 ${index + 1} 的最终地址格式不对。`);
    const address = getAddress(trimmed);
    if (address === ZERO_ADDRESS) throw new Error(`线 ${index + 1} 的最终地址不能是零地址。`);
    return address;
  });
}

export function makeProvider(rpcUrl: string, chainId: number): JsonRpcProvider {
  const request = new FetchRequest(rpcUrl);
  request.timeout = 20_000;
  return new JsonRpcProvider(request, chainId, { staticNetwork: true, batchMaxCount: 1 });
}

export async function connectProvider(chainKey: ChainKey, customRpcs: string[]): Promise<{
  provider: JsonRpcProvider;
  rpcUrl: string;
}> {
  const chain = CHAINS[chainKey];
  const custom = customRpcs.map((url) => url.trim()).filter(Boolean);
  const urls = custom.length > 0 ? custom : [...chain.rpcUrls];
  let lastError: unknown;
  for (const url of urls) {
    const provider = makeProvider(url, chain.chainId);
    try {
      const raw = await provider.send("eth_chainId", []);
      const id = parseChainId(raw);
      if (id !== chain.chainId) {
        throw new Error(`这个 RPC 是链 ${id}，不是${chain.name}。`);
      }
      await provider.getBlockNumber();
      return { provider, rpcUrl: url };
    } catch (err) {
      lastError = err;
      provider.destroy();
    }
  }
  const detail = lastError instanceof Error ? redactRpcUrl(lastError.message) : "";
  throw new Error(detail ? `节点都连不上。${detail}` : "节点都连不上。");
}

export function parseChainId(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const text = String(raw).trim();
  if (text.startsWith("0x") || text.startsWith("0X")) return Number.parseInt(text, 16);
  return Number.parseInt(text, 10);
}

export async function assertSameChain(provider: JsonRpcProvider, chainId: number, chainName: string): Promise<void> {
  const id = parseChainId(await provider.send("eth_chainId", []));
  if (!Number.isFinite(id)) {
    throw new Error("读不到节点的链编号。已取消，没有发出交易。");
  }
  if (id !== chainId) {
    throw new Error(`节点现在是链 ${id}，不是${chainName}。已取消，没有发出交易。`);
  }
}

export async function readFeeData(provider: JsonRpcProvider) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fee = await provider.getFeeData();
      const price = fee.maxFeePerGas && fee.maxFeePerGas > 0n ? fee.maxFeePerGas : fee.gasPrice;
      if (price && price > 0n) return fee;
      last = new Error("节点没有返回 gas 价格。");
    } catch (err) {
      last = err;
      if (!isUncertainSendError(err)) throw err;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }
  throw last instanceof Error ? last : new Error("节点没有返回 gas 价格。");
}

export async function readFeePerGas(provider: JsonRpcProvider): Promise<bigint> {
  const fee = await readFeeData(provider);
  const price = fee.maxFeePerGas && fee.maxFeePerGas > 0n ? fee.maxFeePerGas : fee.gasPrice;
  if (!price || price <= 0n) throw new Error("节点没有返回 gas 价格。");
  return price;
}

export async function readTokenMeta(provider: JsonRpcProvider, tokenAddress: string): Promise<{
  address: string;
  symbol: string;
  decimals: number;
}> {
  if (!isAddress(tokenAddress.trim())) throw new Error("代币合约地址格式不对。");
  const address = getAddress(tokenAddress.trim());
  const contract = new Contract(address, ERC20_ABI, provider);
  let decimals = Number.NaN;
  let decimalsError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      decimals = Number(await contract.decimals());
      decimalsError = undefined;
      break;
    } catch (err) {
      decimalsError = err;
      if (!isUncertainSendError(err) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  if (decimalsError) {
    if (isUncertainSendError(decimalsError)) throw decimalsError;
    throw new Error("读不到代币小数位。请确认这是代币合约，不是普通钱包。");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("这个合约的小数位不正常。");
  }
  let symbol = "TOKEN";
  try {
    symbol = String(await contract.symbol()).slice(0, 32);
  } catch {
    try {
      const bytesContract = new Contract(address, ERC20_BYTES32_ABI, provider);
      const raw = await bytesContract.symbol();
      symbol = new TextDecoder().decode(hexToBytes(String(raw))).replace(/\0/g, "").trim() || "TOKEN";
    } catch {
      symbol = "TOKEN";
    }
  }
  return { address, symbol, decimals };
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function estimateTokenGasLimit(
  provider: JsonRpcProvider,
  tokenAddress: string,
  from: string,
  to: string,
  amount: bigint,
): Promise<bigint> {
  try {
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);
    const estimated = await contract.transfer.estimateGas(to, amount, { from });
    const padded = (estimated * 15n) / 10n;
    const floor = padded < DEFAULT_TOKEN_GAS ? DEFAULT_TOKEN_GAS : padded;
    return floor > MAX_TOKEN_GAS ? MAX_TOKEN_GAS : floor;
  } catch {
    return DEFAULT_TOKEN_GAS;
  }
}

export async function readBalances(
  provider: JsonRpcProvider,
  startAddress: string,
  tokenAddress?: string,
): Promise<{ native: bigint; token: bigint }> {
  const native = await provider.getBalance(startAddress);
  if (!tokenAddress) return { native, token: native };
  const contract = new Contract(tokenAddress, ERC20_ABI, provider);
  const token = await contract.balanceOf(startAddress);
  return { native, token };
}

export async function createPlan(input: {
  chainKey: ChainKey;
  customRpcs: string[];
  tokenMode: TokenMode;
  tokenAddress: string;
  amount: string;
  hopCount: number;
  lineCount: number;
  bufferPercent: number;
  startPrivateKey: string;
  finalAddresses: string[];
}): Promise<TransferPlan> {
  if (!Number.isInteger(input.hopCount) || input.hopCount < 1 || input.hopCount > MAX_HOPS) {
    throw new Error(`跳数要在 1 到 ${MAX_HOPS} 之间。`);
  }
  if (![1, 2, 3].includes(input.lineCount)) throw new Error("线数只能是 1、2 或 3。");
  if (!Number.isInteger(input.bufferPercent) || input.bufferPercent < 0 || input.bufferPercent > 300) {
    throw new Error("缓冲比例要在 0 到 300 之间。");
  }

  const chain = CHAINS[input.chainKey];
  const start = readPrivateKey(input.startPrivateKey);
  const finals = readFinalAddresses(input.finalAddresses, input.lineCount);
  const { provider, rpcUrl } = await connectProvider(input.chainKey, input.customRpcs);

  try {
    const rawFeePerGas = await readFeePerGas(provider);
    const bufferedFee = (rawFeePerGas * BigInt(100 + input.bufferPercent)) / 100n;
    const feePerGas = applyExecutionBump(bufferedFee);
    let tokenSymbol = chain.nativeSymbol;
    let tokenDecimals = NATIVE_DECIMALS;
    let tokenAddress: string | undefined;
    if (input.tokenMode === "erc20") {
      const meta = await readTokenMeta(provider, input.tokenAddress);
      tokenSymbol = meta.symbol;
      tokenDecimals = meta.decimals;
      tokenAddress = meta.address;
    }

    if (tokenAddress) {
      for (const finalAddress of finals) {
        if (finalAddress.toLowerCase() === tokenAddress.toLowerCase()) {
          throw new Error("最终地址不能填代币合约本身，转到合约里通常取不回来。");
        }
      }
    }

    const amountWei = parsePositiveAmount(input.amount, tokenDecimals);
    const amounts = splitAmount(amountWei, input.lineCount);
    const tokenGasLimit = tokenAddress
      ? await estimateTokenGasLimit(provider, tokenAddress, start.address, finals[0], amounts[0])
      : DEFAULT_TOKEN_GAS;
    const perHop = perHopNativeCost({
      tokenMode: input.tokenMode,
      tokenGasLimit,
      nativeGasLimit: NATIVE_GAS_LIMIT,
      feePerGas,
    });
    const downstreamPerLineWei = downstreamBudget(input.hopCount, perHop);
    const { startGasWei, requiredNativeWei } = requiredNative({
      tokenMode: input.tokenMode,
      amounts,
      downstreamPerLine: downstreamPerLineWei,
      tokenGasLimit,
      nativeGasLimit: NATIVE_GAS_LIMIT,
      feePerGas,
    });
    const balances = await readBalances(provider, start.address, tokenAddress);

    return {
      chainKey: input.chainKey,
      rpcUrl,
      tokenMode: input.tokenMode,
      tokenAddress,
      tokenSymbol,
      tokenDecimals,
      amountInput: input.amount.trim(),
      amountWei,
      hopCount: input.hopCount,
      lineCount: input.lineCount,
      bufferPercent: input.bufferPercent,
      rawFeePerGas,
      feePerGas,
      tokenGasLimit,
      nativeGasLimit: NATIVE_GAS_LIMIT,
      downstreamPerLineWei,
      startGasWei,
      requiredNativeWei,
      startAddress: start.address,
      startNativeBalanceWei: balances.native,
      startTokenBalanceWei: balances.token,
      createdAt: new Date().toISOString(),
      lines: amounts.map((lineAmount, index) => ({
        index: index + 1,
        amountWei: lineAmount,
        nativeBudgetWei: downstreamPerLineWei,
        finalAddress: finals[index],
        intermediates: Array.from({ length: Math.max(input.hopCount - 1, 0) }, () => {
          const wallet = Wallet.createRandom();
          return { address: wallet.address, privateKey: wallet.privateKey };
        }),
      })),
    };
  } finally {
    provider.destroy();
  }
}

export async function refreshPlanBalances(plan: TransferPlan): Promise<TransferPlan> {
  const chain = CHAINS[plan.chainKey];
  const provider = makeProvider(plan.rpcUrl, chain.chainId);
  try {
    await assertSameChain(provider, chain.chainId, chain.name);
    const balances = await readBalances(provider, plan.startAddress, plan.tokenAddress);
    return {
      ...plan,
      startNativeBalanceWei: balances.native,
      startTokenBalanceWei: balances.token,
    };
  } finally {
    provider.destroy();
  }
}
