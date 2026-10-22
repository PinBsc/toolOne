import type { TokenMode } from "./types";

export function splitAmount(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new Error("线数必须是正整数。");
  }
  if (total <= 0n) throw new Error("数量必须大于 0。");
  if (total < BigInt(parts)) {
    throw new Error("数量太小，按最小单位不够分给每一条线。");
  }
  const base = total / BigInt(parts);
  let remainder = total % BigInt(parts);
  const shares: bigint[] = [];
  for (let i = 0; i < parts; i += 1) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder -= 1n;
    shares.push(base + extra);
  }
  return shares;
}

export function intermediateCount(hopCount: number, lineCount: number): number {
  if (!Number.isInteger(hopCount) || hopCount < 1) {
    throw new Error("跳数至少为 1。");
  }
  if (!Number.isInteger(lineCount) || lineCount < 1) {
    throw new Error("线数至少为 1。");
  }
  return (hopCount - 1) * lineCount;
}

export function perHopNativeCost(opts: {
  tokenMode: TokenMode;
  tokenGasLimit: bigint;
  nativeGasLimit: bigint;
  feePerGas: bigint;
}): bigint {
  if (opts.feePerGas <= 0n) throw new Error("gas 价格无效。");
  if (opts.tokenMode === "erc20") {
    return (opts.tokenGasLimit + opts.nativeGasLimit) * opts.feePerGas;
  }
  return opts.nativeGasLimit * opts.feePerGas;
}

export function downstreamBudget(hopCount: number, perHop: bigint): bigint {
  return BigInt(Math.max(hopCount - 1, 0)) * perHop;
}

export function requiredNative(opts: {
  tokenMode: TokenMode;
  amounts: bigint[];
  downstreamPerLine: bigint;
  tokenGasLimit: bigint;
  nativeGasLimit: bigint;
  feePerGas: bigint;
}): { startGasWei: bigint; requiredNativeWei: bigint } {
  let startGas = 0n;
  let valueNative = 0n;
  for (const amount of opts.amounts) {
    if (opts.tokenMode === "erc20") {
      startGas += opts.tokenGasLimit * opts.feePerGas;
      if (opts.downstreamPerLine > 0n) {
        startGas += opts.nativeGasLimit * opts.feePerGas;
        valueNative += opts.downstreamPerLine;
      }
    } else {
      startGas += opts.nativeGasLimit * opts.feePerGas;
      valueNative += amount + opts.downstreamPerLine;
    }
  }
  return { startGasWei: startGas, requiredNativeWei: startGas + valueNative };
}

export function transactionCount(hopCount: number, lineCount: number, tokenMode: TokenMode): number {
  if (tokenMode === "native") return hopCount * lineCount;
  if (hopCount === 1) return lineCount;
  return hopCount * lineCount * 2;
}

export function transferTargets(intermediates: string[], finalAddress: string): string[] {
  return [...intermediates, finalAddress];
}

export function fundingGap(opts: {
  tokenMode: TokenMode;
  amountWei: bigint;
  requiredNativeWei: bigint;
  startNativeBalanceWei: bigint;
  startTokenBalanceWei: bigint;
}): { ok: boolean; tokenShort: boolean; nativeShort: boolean } {
  const tokenNeed = opts.tokenMode === "erc20" ? opts.amountWei : 0n;
  const tokenShort = opts.startTokenBalanceWei < tokenNeed;
  const nativeShort = opts.startNativeBalanceWei < opts.requiredNativeWei;
  return { ok: !tokenShort && !nativeShort, tokenShort, nativeShort };
}

export function spendableNative(balance: bigint, fee: bigint): bigint | null {
  if (balance <= fee) return null;
  return balance - fee;
}

export const EXECUTION_BUMP_NUMERATOR = 110n;
export const EXECUTION_BUMP_DENOMINATOR = 100n;

export function applyExecutionBump(feePerGas: bigint): bigint {
  return (feePerGas * EXECUTION_BUMP_NUMERATOR) / EXECUTION_BUMP_DENOMINATOR;
}

export function priorityFee(maxFee: bigint, suggested: bigint): bigint {
  let priority = suggested;
  if (priority === 0n) {
    const share = maxFee / 8n;
    priority = share > 1_000_000_000n ? share : 1_000_000_000n;
  }
  return priority > maxFee ? maxFee : priority;
}

export function feeExceedsPlan(currentFeePerGas: bigint, plannedFeePerGas: bigint): boolean {
  return applyExecutionBump(currentFeePerGas) > plannedFeePerGas;
}

export function nativeCanCover(balance: bigint, parts: bigint[]): boolean {
  let need = 0n;
  for (const part of parts) need += part;
  return balance >= need;
}
