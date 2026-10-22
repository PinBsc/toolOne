import { Contract, Transaction, TransactionResponse, Wallet, type JsonRpcProvider } from "ethers";
import { CHAINS, MAX_TOKEN_GAS, NATIVE_GAS_LIMIT } from "./chains";
import { blocksAnotherSend, explainError, isDefiniteReject, isUncertainSendError, shortAddr, uncertainBroadcastMessage } from "./format";
import { applyExecutionBump, feeExceedsPlan, fundingGap, nativeCanCover, priorityFee, spendableNative } from "./plan";
import { assertSameChain, makeProvider, readBalances, readFeeData, readFeePerGas } from "./chainIo";
import type { LinePlan, LineProgress, LogEntry, RunResult, TransferPlan } from "./types";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];

type LogDraft = Omit<LogEntry, "id">;

export class StoppedError extends Error {
  constructor() {
    super("已停止后续转账。已经发出的那一笔会继续上链。");
    this.name = "StoppedError";
  }
}

export class MaybeBroadcastError extends Error {
  address: string;

  constructor(address: string, nonceMoved: boolean | null) {
    super(uncertainBroadcastMessage(address, nonceMoved));
    this.name = "MaybeBroadcastError";
    this.address = address;
  }
}

export class HopError extends Error {
  holderAddress: string;
  holderKey?: string;
  tokenMoved: boolean;

  constructor(message: string, holderAddress: string, tokenMoved: boolean, holderKey?: string) {
    super(message);
    this.name = "HopError";
    this.holderAddress = holderAddress;
    this.holderKey = holderKey;
    this.tokenMoved = tokenMoved;
  }
}

interface FeeFields {
  tx: Record<string, bigint | number>;
  feePerGas: bigint;
}

async function feeFields(provider: JsonRpcProvider): Promise<FeeFields> {
  const fee = await readFeeData(provider);
  if (fee.maxFeePerGas && fee.maxFeePerGas > 0n) {
    const maxFee = applyExecutionBump(fee.maxFeePerGas);
    const priority = priorityFee(maxFee, applyExecutionBump(fee.maxPriorityFeePerGas ?? 0n));
    return {
      tx: { type: 2, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority },
      feePerGas: maxFee,
    };
  }
  const gasPrice = applyExecutionBump(fee.gasPrice ?? 0n);
  if (gasPrice <= 0n) throw new Error("节点没有返回 gas 价格。");
  return { tx: { type: 0, gasPrice }, feePerGas: gasPrice };
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new StoppedError();
}

function holderAfter(line: LinePlan, completedHops: number): string {
  if (completedHops <= 0) return "起始钱包";
  const index = completedHops - 1;
  if (index < line.intermediates.length) return line.intermediates[index].address;
  return line.finalAddress;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readAgain<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (!isUncertainSendError(err) || attempt === 2) throw err;
      await delay(500 * (attempt + 1));
    }
  }
  throw last;
}

async function waitReceipt(tx: TransactionResponse): Promise<void> {
  const deadline = Date.now() + 180_000;
  let receipt: Awaited<ReturnType<TransactionResponse["wait"]>> = null;
  try {
    receipt = await tx.wait(1, Math.max(1_000, deadline - Date.now()));
  } catch (err) {
    if (err instanceof Error && /transaction execution reverted|CALL_EXCEPTION/i.test(err.message)) {
      throw new Error("交易已上链但执行失败。转出的金额还在发送地址，只花了手续费。");
    }
    receipt = null;
  }
  if (receipt && receipt.status !== 1) throw new Error("交易已上链但执行失败。转出的金额还在发送地址，只花了手续费。");
  while (!receipt && Date.now() < deadline) {
    try {
      receipt = (await tx.provider?.getTransactionReceipt(tx.hash)) ?? null;
    } catch {
      receipt = null;
    }
    if (receipt?.status === 1) return;
    if (receipt && receipt.status !== 1) throw new Error("交易已上链但执行失败。转出的金额还在发送地址，只花了手续费。");
    await delay(2_000);
  }
  if (!receipt || receipt.status !== 1) {
    throw new Error(`等待确认超时。交易 ${tx.hash} 可能仍在打包，请先到区块浏览器查看，不要用同一计划重发。`);
  }
}

interface OutgoingTx {
  to: string;
  value?: bigint;
  data?: string;
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

async function signRaw(wallet: Wallet, chainId: bigint, nonce: number, request: OutgoingTx): Promise<string> {
  const common = {
    to: request.to,
    value: request.value ?? 0n,
    data: request.data ?? "0x",
    gasLimit: request.gasLimit,
    nonce,
    chainId,
  };
  if (request.maxFeePerGas != null) {
    return wallet.signTransaction({
      ...common,
      type: 2,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas ?? request.maxFeePerGas,
    });
  }
  if (request.gasPrice == null) throw new Error("节点没有返回 gas 价格。");
  return wallet.signTransaction({ ...common, type: 0, gasPrice: request.gasPrice });
}

function pendingResponse(provider: JsonRpcProvider, raw: string): TransactionResponse {
  const parsed = Transaction.from(raw);
  if (!parsed.hash || !parsed.from || !parsed.signature || parsed.nonce == null || parsed.gasLimit == null || parsed.value == null || parsed.chainId == null) {
    throw Object.assign(new Error("无法在本地还原已广播的交易。"), { code: "SERVER_ERROR" });
  }
  return new TransactionResponse(
    {
      blockNumber: null,
      blockHash: null,
      index: 0,
      hash: parsed.hash,
      type: parsed.type ?? 0,
      to: parsed.to,
      from: parsed.from,
      accessList: parsed.accessList,
      authorizationList: parsed.authorizationList,
      nonce: parsed.nonce,
      gasLimit: parsed.gasLimit,
      gasPrice: parsed.gasPrice ?? parsed.maxFeePerGas ?? 0n,
      maxFeePerGas: parsed.maxFeePerGas,
      maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
      data: parsed.data ?? "0x",
      value: parsed.value,
      chainId: parsed.chainId,
      signature: parsed.signature,
    },
    provider,
  );
}

async function responseFor(provider: JsonRpcProvider, raw: string, hash: string): Promise<TransactionResponse> {
  const parsed = Transaction.from(raw);
  if (parsed.hash !== hash) {
    throw new Error("节点返回的交易哈希和本地签名不一致。");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const seen = await provider.getTransaction(hash);
      if (seen) return seen;
    } catch {
      // The node already returned this hash. A lookup failure is not a second send.
    }
    if (attempt < 2) await delay(400);
  }
  return pendingResponse(provider, raw);
}

async function broadcastRaw(provider: JsonRpcProvider, raw: string): Promise<TransactionResponse> {
  const hash = await provider.send("eth_sendRawTransaction", [raw]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw Object.assign(new Error("节点没有返回交易哈希。"), { code: "SERVER_ERROR" });
  }
  return responseFor(provider, raw, hash);
}

async function sendOnce(wallet: Wallet, request: OutgoingTx): Promise<TransactionResponse> {
  const provider = wallet.provider as JsonRpcProvider;
  const nonceBefore = await readAgain(() => wallet.getNonce("pending"));
  const network = await readAgain(() => provider.getNetwork());
  const raw = await signRaw(wallet, network.chainId, nonceBefore, request);
  try {
    return await broadcastRaw(provider, raw);
  } catch (err) {
    if (isDefiniteReject(err)) throw err;
    const moved = await confirmNonce(wallet, nonceBefore);
    const message = err instanceof Error ? err.message : String(err);
    const canFallback =
      moved === false &&
      request.maxFeePerGas != null &&
      /transaction type not supported|unsupported transaction type|eip-?1559/i.test(message);
    if (!canFallback) {
      if (moved !== false || isUncertainSendError(err) || message === "节点返回的交易哈希和本地签名不一致。") {
        throw new MaybeBroadcastError(wallet.address, moved);
      }
      throw err;
    }
    try {
      const legacy = await signRaw(wallet, network.chainId, nonceBefore, {
        to: request.to,
        value: request.value,
        data: request.data,
        gasLimit: request.gasLimit,
        gasPrice: request.maxFeePerGas,
      });
      return await broadcastRaw(provider, legacy);
    } catch (fallbackErr) {
      if (isDefiniteReject(fallbackErr)) throw fallbackErr;
      const movedAfter = await confirmNonce(wallet, nonceBefore);
      if (movedAfter !== false || isUncertainSendError(fallbackErr)) throw new MaybeBroadcastError(wallet.address, movedAfter);
      throw fallbackErr;
    }
  }
}

async function nonceMoved(wallet: Wallet, nonceBefore: number): Promise<boolean | null> {
  try {
    const nonceAfter = await wallet.getNonce("pending");
    return nonceAfter !== nonceBefore;
  } catch {
    return null;
  }
}

async function confirmNonce(wallet: Wallet, nonceBefore: number): Promise<boolean | null> {
  let unchanged = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const moved = await nonceMoved(wallet, nonceBefore);
    if (moved === true) return true;
    if (moved === false) unchanged = true;
    if (attempt < 2) await delay(2_000);
  }
  return unchanged ? false : null;
}

function isEstimateRevert(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /execution reverted|CALL_EXCEPTION|require\(false\)/i.test(message);
}

async function estimateTransferGas(token: Contract, to: string, amount: bigint): Promise<bigint> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const estimated = await token.transfer.estimateGas(to, amount);
      const padded = (estimated * 12n) / 10n;
      const sized = padded < 60_000n ? 60_000n : padded;
      return sized > MAX_TOKEN_GAS ? MAX_TOKEN_GAS : sized;
    } catch (err) {
      last = err;
      if (isEstimateRevert(err) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw new Error(`无法估算这笔代币转账的 gas，已取消，没有发出交易。${explainError(last)}`);
}

async function assertTokenAccepted(token: Contract, to: string, amount: bigint): Promise<void> {
  let accepted: unknown;
  try {
    accepted = await readAgain(() => token.transfer.staticCall(to, amount));
  } catch (err) {
    if (isEstimateRevert(err)) {
      throw new Error(`无法估算这笔代币转账的 gas，已取消，没有发出交易。${explainError(err)}`);
    }
    if (isUncertainSendError(err)) throw err;
    return;
  }
  if (accepted === false) {
    throw new Error("代币合约拒绝了这笔转账，已取消，没有发出交易。");
  }
}

async function tokenBalanceDecreased(token: Contract, holder: string, before: bigint): Promise<boolean | null> {
  try {
    const after = (await readAgain(() => token.balanceOf(holder))) as bigint;
    return after < before;
  } catch {
    return null;
  }
}

async function sweepNative(
  wallet: Wallet,
  to: string,
  signal: AbortSignal,
  required: boolean,
  onTx: (hash: string, label: string) => void,
  preset?: FeeFields,
): Promise<void> {
  let mustMove = required;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) {
      if (mustMove) throw new StoppedError();
      return;
    }
    const fields = attempt === 0 && preset ? preset : await feeFields(wallet.provider as JsonRpcProvider);
    const fee = NATIVE_GAS_LIMIT * fields.feePerGas;
    const balance = await readAgain(() => wallet.provider!.getBalance(wallet.address));
    const value = spendableNative(balance, fee);
    if (value == null) {
      if (mustMove) throw new Error("主币余额不够再付一笔手续费。");
      return;
    }
    const movingRequired = mustMove;
    try {
      const tx = await sendOnce(wallet, {
        to,
        value,
        gasLimit: NATIVE_GAS_LIMIT,
        ...fields.tx,
      });
      onTx(tx.hash, "主币");
      await waitReceipt(tx);
      mustMove = false;
    } catch (err) {
      if (movingRequired) throw err;
      return;
    }
  }
}

async function forwardAll(
  wallet: Wallet,
  to: string,
  nextKey: string | undefined,
  tokenAddress: string | null,
  signal: AbortSignal,
  onTx: (hash: string, label: string) => void,
): Promise<void> {
  let tokenMoved = false;
  try {
    throwIfStopped(signal);
    const provider = wallet.provider as JsonRpcProvider;
    if (tokenAddress) {
      const token = new Contract(tokenAddress, ERC20_ABI, wallet);
      const balance = (await readAgain(() => token.balanceOf(wallet.address))) as bigint;
      if (balance <= 0n) throw new Error("这一跳没有代币可转。");
      const gasLimit = await estimateTransferGas(token, to, balance);
      const fields = await feeFields(provider);
      const nativeBalance = await readAgain(() => provider.getBalance(wallet.address));
      if (!nativeCanCover(nativeBalance, [gasLimit * fields.feePerGas, NATIVE_GAS_LIMIT * fields.feePerGas, 1n])) {
        throw new Error("主币不够同时支付代币转账和后面的主币转账，已取消这一跳，没有发出交易。");
      }
      const before = balance;
      await assertTokenAccepted(token, to, balance);
      const tx = await sendOnce(wallet, {
        to: tokenAddress,
        data: token.interface.encodeFunctionData("transfer", [to, balance]),
        gasLimit,
        ...fields.tx,
      });
      onTx(tx.hash, "代币");
      await waitReceipt(tx);
      const decreased = await tokenBalanceDecreased(token, wallet.address, before);
      if (decreased === false && wallet.address.toLowerCase() !== to.toLowerCase()) {
        throw new Error("代币交易已上链，但余额没有减少，主币没有继续转出。");
      }
      tokenMoved = true;
      await sweepNative(wallet, to, signal, true, onTx, fields);
      return;
    }
    await sweepNative(wallet, to, signal, true, onTx);
  } catch (err) {
    if (err instanceof StoppedError && !tokenMoved) throw err;
    if (err instanceof MaybeBroadcastError) {
      if (!tokenMoved) throw err;
      throw new HopError(
        `代币已经在 ${to}。随后的主币转账没有得到明确结果，可能已经广播。请先到区块浏览器查看，不要立刻重发。`,
        to,
        true,
        nextKey,
      );
    }
    const message = tokenMoved
      ? `${explainError(err)} 代币已经在下一地址 ${to}，后续手续费主币还没跟着过去。`
      : explainError(err);
    throw new HopError(message, tokenMoved ? to : wallet.address, tokenMoved, tokenMoved ? nextKey : wallet.privateKey);
  }
}

async function fundLine(
  start: Wallet,
  line: LinePlan,
  tokenAddress: string | null,
  signal: AbortSignal,
  onTx: (hash: string, label: string) => void,
): Promise<void> {
  const target = line.intermediates[0]?.address ?? line.finalAddress;
  const holderKey = line.intermediates[0]?.privateKey;
  let tokenMoved = false;
  try {
    throwIfStopped(signal);
    const provider = start.provider as JsonRpcProvider;
    const fields = await feeFields(provider);
    const nativeFee = NATIVE_GAS_LIMIT * fields.feePerGas;
    const nativeBalance = await readAgain(() => provider.getBalance(start.address));
    if (tokenAddress) {
      const token = new Contract(tokenAddress, ERC20_ABI, start);
      const gasLimit = await estimateTransferGas(token, target, line.amountWei);
      const tokenFee = gasLimit * fields.feePerGas;
      const followNative = line.nativeBudgetWei > 0n ? [line.nativeBudgetWei, nativeFee] : [];
      if (!nativeCanCover(nativeBalance, [tokenFee, ...followNative])) {
        throw new Error("起始钱包的主币不够支付这一跳的手续费。已取消，没有发出交易。");
      }
      const before = (await readAgain(() => token.balanceOf(start.address))) as bigint;
      await assertTokenAccepted(token, target, line.amountWei);
      const tx = await sendOnce(start, {
        to: tokenAddress,
        data: token.interface.encodeFunctionData("transfer", [target, line.amountWei]),
        gasLimit,
        ...fields.tx,
      });
      onTx(tx.hash, "代币");
      await waitReceipt(tx);
      const decreased = await tokenBalanceDecreased(token, start.address, before);
      if (decreased === false && start.address.toLowerCase() !== target.toLowerCase()) {
        throw new Error("代币交易已上链，但余额没有减少，主币没有继续转出。");
      }
      tokenMoved = true;
      if (line.nativeBudgetWei > 0n) {
        throwIfStopped(signal);
        const nativeTx = await sendOnce(start, {
          to: target,
          value: line.nativeBudgetWei,
          gasLimit: NATIVE_GAS_LIMIT,
          ...fields.tx,
        });
        onTx(nativeTx.hash, "手续费主币");
        await waitReceipt(nativeTx);
      }
      return;
    }
    const value = line.amountWei + line.nativeBudgetWei;
    if (!nativeCanCover(nativeBalance, [value, nativeFee])) {
      throw new Error("起始钱包的主币不够支付转出数量和手续费。已取消，没有发出交易。");
    }
    const tx = await sendOnce(start, {
      to: target,
      value,
      gasLimit: NATIVE_GAS_LIMIT,
      ...fields.tx,
    });
    onTx(tx.hash, "主币");
    await waitReceipt(tx);
  } catch (err) {
    if (err instanceof StoppedError && !tokenMoved) throw err;
    if (err instanceof MaybeBroadcastError) {
      if (!tokenMoved) throw err;
      throw new HopError(
        `代币已经在 ${target}。随后的主币转账没有得到明确结果，可能已经广播。请先到区块浏览器查看，不要立刻重发。`,
        target,
        true,
        holderKey,
      );
    }
    if (tokenMoved) {
      throw new HopError(
        `${explainError(err)} 代币已经到达下一地址，但手续费主币没过去。`,
        target,
        true,
        holderKey,
      );
    }
    throw new HopError(explainError(err), start.address, false);
  }
}

export async function runPlan(opts: {
  plan: TransferPlan;
  startPrivateKey: string;
  signal: AbortSignal;
  onLog: (entry: LogDraft) => void;
  onProgress: (progress: LineProgress) => void;
}): Promise<RunResult> {
  const { plan, signal, onLog, onProgress } = opts;
  const chain = CHAINS[plan.chainKey];
  const provider = makeProvider(plan.rpcUrl, chain.chainId);
  const start = new Wallet(opts.startPrivateKey.trim(), provider);
  const tokenAddress = plan.tokenMode === "erc20" ? plan.tokenAddress ?? null : null;
  const result: RunResult = { okLines: [], failed: [], stopped: false };
  const funded: LinePlan[] = [];

  const logTx = (line: number, hash: string, label: string) => {
    onLog({
      level: "info",
      line,
      message: `线 ${line} 的${label}交易已广播`,
      txHash: hash,
      explorerUrl: `${chain.explorerTx}${hash}`,
    });
  };

  const failLine = (line: LinePlan, err: unknown, completed = 0) => {
    const message = err instanceof HopError ? err.message : explainError(err);
    const failure = {
      line: line.index,
      message,
      holderAddress:
        err instanceof HopError ? err.holderAddress : err instanceof MaybeBroadcastError ? err.address : undefined,
      holderKey: err instanceof HopError ? err.holderKey : undefined,
      tokenMoved: err instanceof HopError ? err.tokenMoved : undefined,
      blocksRetry: err instanceof MaybeBroadcastError || blocksAnotherSend(message),
    };
    result.failed.push(failure);
    onProgress({
      line: line.index,
      completed,
      total: plan.hopCount,
      state: "error",
      message: failure.message,
    });
    onLog({
      level: "error",
      line: line.index,
      message: `线 ${line.index} 停住了：${failure.message}`,
    });
  };

  try {
    if (start.address.toLowerCase() !== plan.startAddress.toLowerCase()) {
      throw new Error("起始私钥和生成计划时的钱包不一致。请重新生成计划。");
    }
    await readAgain(() => assertSameChain(provider, chain.chainId, chain.name));
    const balances = await readAgain(() => readBalances(provider, start.address, tokenAddress ?? undefined));
    const gap = fundingGap({
      tokenMode: plan.tokenMode,
      amountWei: plan.amountWei,
      requiredNativeWei: plan.requiredNativeWei,
      startNativeBalanceWei: balances.native,
      startTokenBalanceWei: balances.token,
    });
    if (!gap.ok) throw new Error("余额不足，已取消，没有发出交易。");
    const liveFee = await readAgain(() => readFeePerGas(provider));
    if (feeExceedsPlan(liveFee, plan.feePerGas)) {
      throw new Error("当前 gas 已经高于生成计划时留出的价格。请重新生成计划。这次没有发出交易。");
    }

    for (const line of plan.lines) {
      onProgress({ line: line.index, completed: 0, total: plan.hopCount, state: "pending" });
    }

    let stopFunding = false;
    for (const line of plan.lines) {
      if (stopFunding || signal.aborted) {
        result.stopped = result.stopped || signal.aborted;
        onProgress({
          line: line.index,
          completed: 0,
          total: plan.hopCount,
          state: "stopped",
          message: "这条线还没开始，对应资金仍在起始钱包。",
        });
        onLog({
          level: "warn",
          line: line.index,
          message: `线 ${line.index} 还没开始，对应资金仍在起始钱包。`,
        });
        continue;
      }
      const target = line.intermediates[0]?.address ?? line.finalAddress;
      onProgress({ line: line.index, completed: 0, total: plan.hopCount, state: "running" });
      onLog({
        level: "info",
        line: line.index,
        message: `线 ${line.index} 开始第 1/${plan.hopCount} 跳，转到 ${shortAddr(target)}`,
      });
      try {
        await fundLine(start, line, tokenAddress, signal, (hash, label) => logTx(line.index, hash, label));
        onLog({ level: "ok", line: line.index, message: `线 ${line.index} 第 1 跳已确认` });
        if (line.intermediates.length === 0) {
          result.okLines.push(line.index);
          onProgress({ line: line.index, completed: 1, total: plan.hopCount, state: "done" });
        } else {
          funded.push(line);
          onProgress({ line: line.index, completed: 1, total: plan.hopCount, state: "pending" });
        }
      } catch (err) {
        stopFunding = true;
        if (err instanceof StoppedError) {
          result.stopped = true;
          onProgress({ line: line.index, completed: 0, total: plan.hopCount, state: "stopped", message: err.message });
          onLog({ level: "warn", line: line.index, message: err.message });
        } else {
          failLine(line, err);
        }
      }
    }

    await Promise.all(
      funded.map(async (line) => {
        let reached = 1;
        try {
          for (let i = 0; i < line.intermediates.length; i += 1) {
            throwIfStopped(signal);
            const sender = new Wallet(line.intermediates[i].privateKey, provider);
            const nextWallet = line.intermediates[i + 1];
            const next = nextWallet?.address ?? line.finalAddress;
            const step = i + 2;
            onProgress({
              line: line.index,
              completed: step - 1,
              total: plan.hopCount,
              state: "running",
              message: `第 ${step} 跳`,
            });
            onLog({
              level: "info",
              line: line.index,
              message: `线 ${line.index} 第 ${step}/${plan.hopCount} 跳，从 ${shortAddr(sender.address)} 转到 ${shortAddr(next)}`,
            });
            try {
              await forwardAll(sender, next, nextWallet?.privateKey, tokenAddress, signal, (hash, label) =>
                logTx(line.index, hash, label),
              );
            } catch (err) {
              const tokenAlreadyAtFinal =
                !nextWallet && err instanceof HopError && err.tokenMoved && !blocksAnotherSend(err.message);
              if (!tokenAlreadyAtFinal) throw err;
              onLog({
                level: "warn",
                line: line.index,
                message: `线 ${line.index} 的代币已经到达最终地址。剩余主币没能一并转出，留在 ${shortAddr(sender.address)}。`,
              });
            }
            reached = step;
            onLog({ level: "ok", line: line.index, message: `线 ${line.index} 第 ${step} 跳已确认` });
            onProgress({
              line: line.index,
              completed: step,
              total: plan.hopCount,
              state: step === plan.hopCount ? "done" : "running",
            });
          }
          result.okLines.push(line.index);
        } catch (err) {
          if (err instanceof StoppedError) {
            result.stopped = true;
            const holder = holderAfter(line, reached);
            onProgress({
              line: line.index,
              completed: reached,
              total: plan.hopCount,
              state: "stopped",
              message: err.message,
            });
            onLog({
              level: "warn",
              line: line.index,
              message: `线 ${line.index} 已停止。资金在 ${holder}。${err.message}`,
            });
            return;
          }
          failLine(line, err, reached);
        }
      }),
    );

    if (result.failed.length === 0 && !result.stopped && result.okLines.length === plan.lines.length) {
      onLog({ level: "ok", message: "全部线条都已到达最终地址。" });
    }
    return result;
  } catch (err) {
    onLog({ level: "error", message: explainError(err) });
    throw err;
  } finally {
    provider.destroy();
  }
}
