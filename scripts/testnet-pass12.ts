import { readFileSync } from "fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

const UPSTREAM = "https://bsc-testnet-rpc.publicnode.com";
const BACKUP_URL = "https://bsc-testnet.publicnode.com";
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(UPSTREAM, 97);
const backup = makeProvider(BACKUP_URL, 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];
const sweeps: Array<{ key: string; token?: string }> = [];

function safe(err: unknown) {
  return (err instanceof Error ? err.message : "error").replace(/0x[a-fA-F0-9]{64}/g, "0x…").slice(0, 220);
}
function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}
function expect(ok: boolean, detail: string): void {
  if (!ok) throw new Error(detail);
}
async function call<T>(work: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
  try {
    return await work(reader);
  } catch {
    return await work(backup);
  }
}
const nativeOf = (address: string) => call((provider) => provider.getBalance(address));
const nonceOf = (address: string) => call((provider) => provider.getTransactionCount(address));
async function tokenOf(token: string, address: string) {
  const contract = new Contract(token, TOKEN_ABI, reader);
  return call((provider) => contract.connect(provider).balanceOf(address) as Promise<bigint>);
}
async function gasPrice() {
  const fee = await call((provider) => provider.getFeeData());
  const quoted = fee.gasPrice ?? fee.maxFeePerGas ?? 100_000_000n;
  const bumped = (quoted * 15n) / 10n;
  return bumped > 100_000_000n ? bumped : 100_000_000n;
}
async function sendRaw(wallet: Wallet, tx: { to: string; value?: bigint; data?: string; gasLimit: bigint }) {
  const raw = await wallet.signTransaction({
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data ?? "0x",
    gasLimit: tx.gasLimit,
    nonce: await nonceOf(wallet.address),
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await gasPrice(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 90_000);
  if (!receipt || receipt.status !== 1) throw new Error("归集失败");
}
function remember(plan: TransferPlan, finals: Wallet[], token?: string) {
  for (const wallet of finals) sweeps.push({ key: wallet.privateKey, token });
  for (const line of plan.lines) for (const mid of line.intermediates) sweeps.push({ key: mid.privateKey, token });
}
async function drain() {
  for (const job of sweeps.splice(0)) {
    const wallet = new Wallet(job.key, reader);
    if (wallet.address.toLowerCase() === start.address.toLowerCase()) continue;
    try {
      if (job.token) {
        const balance = await tokenOf(job.token, wallet.address);
        if (balance > 0n) {
          const need = 180_000n * (await gasPrice());
          if ((await nativeOf(wallet.address)) < need) await sendRaw(start, { to: wallet.address, value: need * 2n, gasLimit: 21_000n });
          const token = new Contract(job.token, TOKEN_ABI, wallet);
          await sendRaw(wallet, { to: job.token, data: token.interface.encodeFunctionData("transfer", [start.address, balance]), gasLimit: 180_000n });
        }
      }
      const native = await nativeOf(wallet.address);
      const fee = 21_000n * (await gasPrice());
      if (native > fee) await sendRaw(wallet, { to: start.address, value: native - fee, gasLimit: 21_000n });
    } catch (err) {
      console.log("sweep-left", wallet.address, safe(err));
    }
  }
}
async function deploy(dir: string, name: string, supply: bigint) {
  const bin = readFileSync(new URL(`./${dir}/${name}.bin`, import.meta.url), "utf8").trim();
  const abi = JSON.parse(readFileSync(new URL(`./${dir}/${name}.abi`, import.meta.url), "utf8"));
  const factory = new ContractFactory(abi, bin.startsWith("0x") ? bin : "0x" + bin, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const nonce = await nonceOf(start.address);
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await gasPrice(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = (await reader.waitForTransaction(hash, 1, 90_000)) ?? (await backup.getTransactionReceipt(hash));
  if (receipt?.status !== 1) throw new Error("部署失败");
  return receipt.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}
async function execute(plan: TransferPlan, signal = new AbortController().signal, onLog?: (message: string) => void) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal,
    onLog: (entry) => {
      console.log(entry.level, entry.message.replace(/0x[a-fA-F0-9]{64}/g, "0x…"));
      onLog?.(entry.message);
    },
    onProgress: () => {},
  });
}
async function check(name: string, work: () => Promise<string>) {
  try {
    report(name, true, await work());
  } catch (err) {
    report(name, false, safe(err));
  } finally {
    await drain();
  }
}
function afterFee(amount: bigint, times: number) {
  let left = amount;
  for (let i = 0; i < times; i += 1) left -= left / 10n;
  return left;
}

console.log("start", formatEther(await nativeOf(start.address)));

await check("lie-line-does-not-fund-next", async () => {
  const token = await deploy("edge-out", "scripts_EdgeToken_sol_LieToken", 2n * 10n ** 18n);
  console.log("LIE", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom()];
  const plan = await createPlan({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals, token);
  const before = await nonceOf(start.address);
  const beforeToken = await tokenOf(token, start.address);
  const result = await execute(plan);
  const mids = await Promise.all(
    plan.lines.map(async (line) => ({
      token: await tokenOf(token, line.intermediates[0].address),
      native: await nativeOf(line.intermediates[0].address),
      nonce: await nonceOf(line.intermediates[0].address),
    })),
  );
  expect(result.okLines.length === 0 && result.failed.length === 1, `ok ${result.okLines.length} failed ${result.failed.length}`);
  expect((await nonceOf(start.address)) === before + 1, `start nonce +${(await nonceOf(start.address)) - before}`);
  expect((await tokenOf(token, start.address)) === beforeToken, "tokens left the start");
  expect(mids.every((mid) => mid.token === 0n && mid.native === 0n && mid.nonce === 0), mids.map((mid) => `${mid.token}/${mid.native}/n${mid.nonce}`).join(" | "));
  return "second line stayed";
});

await check("fee-token-3hop", async () => {
  const token = await deploy("fee-out", "scripts_FeeToken_sol_FeeToken", 10n ** 18n);
  console.log("FEE", token);
  const final = Wallet.createRandom();
  const plan = await createPlan({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 3,
    lineCount: 1,
    bufferPercent: 0,
    startPrivateKey: startKey,
    finalAddresses: [final.address],
  });
  remember(plan, [final], token);
  const result = await execute(plan);
  const expected = afterFee(plan.amountWei, 3);
  const got = await tokenOf(token, final.address);
  const mids = await Promise.all(
    plan.lines[0].intermediates.map(async (mid) => ({
      token: await tokenOf(token, mid.address),
      native: await nativeOf(mid.address),
    })),
  );
  expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
  expect(got === expected, `final ${got} expected ${expected}`);
  expect((await tokenOf(token, start.address)) === 0n, "start kept tokens");
  expect(mids.every((mid) => mid.token === 0n && mid.native === 0n), mids.map((mid) => `${mid.token}/${mid.native}`).join(" | "));
  return `final ${got}`;
});

await check("parallel-stop-after-token-broadcast", async () => {
  const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, start);
  const unsigned = await factory.getDeployTransaction(2n * 10n ** 18n);
  const nonce = await nonceOf(start.address);
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await gasPrice(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 90_000);
  if (receipt?.status !== 1 || !receipt.contractAddress) throw new Error("部署失败");
  const token = receipt.contractAddress;
  console.log("STOP", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom()];
  const plan = await createPlan({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals, token);
  const controller = new AbortController();
  let hop2 = false;
  const result = await execute(plan, controller.signal, (message) => {
    if (message.includes("第 2/2 跳")) hop2 = true;
    if (hop2 && message.includes("代币交易已广播")) controller.abort();
  });
  let conserved = 0n;
  const details: string[] = [];
  for (const line of plan.lines) {
    const mid = line.intermediates[0];
    const midToken = await tokenOf(token, mid.address);
    const midNative = await nativeOf(mid.address);
    const midNonce = await nonceOf(mid.address);
    const finalToken = await tokenOf(token, line.finalAddress);
    const finalNative = await nativeOf(line.finalAddress);
    conserved += midToken + finalToken;
    const okHeld = midToken === line.amountWei && finalToken === 0n && midNonce === 0;
    const okTokenOnly = midToken === 0n && finalToken === line.amountWei && midNonce === 1 && finalNative === 0n && midNative > 0n;
    const okBoth = midToken === 0n && finalToken === line.amountWei && midNonce === 2 && midNative === 0n;
    if (!okHeld && !okTokenOnly && !okBoth) details.push(`bad mid ${midToken}/${midNative}/n${midNonce} final ${finalToken}/${finalNative}`);
  }
  conserved += await tokenOf(token, start.address);
  expect(details.length === 0, details.join(" | ") || "line shape");
  expect(conserved === 2n * 10n ** 18n, `conserved ${conserved}`);
  expect(result.okLines.length < 2, "both lines were marked complete after the stop");
  return `ok ${result.okLines.length} failed ${result.failed.length} stopped ${result.stopped}`;
});

console.log("LEFT", formatEther(await nativeOf(start.address)));
reader.destroy();
backup.destroy();
if (failures.length > 0) console.log("FAILED", failures.join(", "));
process.exit(failures.length > 0 ? 1 : 0);
