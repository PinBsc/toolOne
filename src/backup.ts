import { formatAmount } from "./format";
import { redactRpcUrl } from "./rpc";
import type { TransferPlan } from "./types";

export interface BackupFile {
  app: "wallet-hop";
  version: 1;
  createdAt: string;
  chain: string;
  rpcUrl: string;
  tokenMode: string;
  tokenAddress?: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: string;
  amountWei: string;
  hopCount: number;
  lineCount: number;
  bufferPercent: number;
  startAddress: string;
  note: string;
  lines: Array<{
    index: number;
    amount: string;
    amountWei: string;
    nativeBudget: string;
    nativeBudgetWei: string;
    finalAddress: string;
    intermediates: Array<{ hop: number; address: string; privateKey: string }>;
  }>;
}

export function serializeBackup(plan: TransferPlan): BackupFile {
  return {
    app: "wallet-hop",
    version: 1,
    createdAt: plan.createdAt,
    chain: plan.chainKey,
    rpcUrl: redactRpcUrl(plan.rpcUrl),
    tokenMode: plan.tokenMode,
    tokenAddress: plan.tokenAddress,
    tokenSymbol: plan.tokenSymbol,
    tokenDecimals: plan.tokenDecimals,
    amount: plan.amountInput,
    amountWei: plan.amountWei.toString(),
    hopCount: plan.hopCount,
    lineCount: plan.lineCount,
    bufferPercent: plan.bufferPercent,
    startAddress: plan.startAddress,
    note: "起始钱包私钥不在这个文件里。中间钱包私钥丢失后，卡在中间地址的资金无法转出。",
    lines: plan.lines.map((line) => ({
      index: line.index,
      amount: formatAmount(line.amountWei, plan.tokenDecimals),
      amountWei: line.amountWei.toString(),
      nativeBudget: formatAmount(line.nativeBudgetWei, 18),
      nativeBudgetWei: line.nativeBudgetWei.toString(),
      finalAddress: line.finalAddress,
      intermediates: line.intermediates.map((wallet, index) => ({
        hop: index + 1,
        address: wallet.address,
        privateKey: wallet.privateKey,
      })),
    })),
  };
}

export function downloadBackup(plan: TransferPlan): void {
  const data = serializeBackup(plan);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = plan.createdAt.replace(/[:.]/g, "-");
  link.href = url;
  link.download = `wallet-hop-backup-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}
