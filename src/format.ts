import { formatUnits, parseUnits } from "ethers";
import { redactRpcUrl } from "./rpc";

export function shortAddr(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatAmount(wei: bigint, decimals: number, maxFrac = 8): string {
  const raw = formatUnits(wei, decimals);
  if (!raw.includes(".")) return raw;
  const [whole, frac] = raw.split(".");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  if (cut.length > 0) return `${whole}.${cut}`;
  if (/^0*$/.test(frac)) return whole;
  const first = frac.search(/[1-9]/);
  const end = Math.min(frac.length, first + 4);
  return `${whole}.${frac.slice(0, end)}`;
}

export function parsePositiveAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("数量格式不对，请使用小数点。");
  }
  try {
    const wei = parseUnits(trimmed, decimals);
    if (wei <= 0n) throw new Error("数量必须大于 0。");
    return wei;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("数量")) throw err;
    throw new Error("小数位超过这个代币的精度。");
  }
}

export function gweiLabel(feePerGas: bigint): string {
  return `${formatAmount(feePerGas, 9, 4)} gwei`;
}

export function blocksAnotherSend(message: string): boolean {
  return /不要用同一计划重发|不要立刻重发/.test(message);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = "code" in err && err.code != null ? String(err.code) : "";
    return `${code} ${err.message}`;
  }
  return String(err);
}

export function isUncertainSendError(err: unknown): boolean {
  const text = errorText(err);
  return /timeout|ETIMEDOUT|NETWORK_ERROR|SERVER_ERROR|ECONNRESET|ECONNREFUSED|socket hang up|failed to fetch|network changed|could not coalesce|missing response|already known|replacement fee too low|replacement transaction underpriced|nonce has already been used|NONCE_EXPIRED/i.test(
    text,
  );
}

export function isDefiniteReject(err: unknown): boolean {
  const text = errorText(err);
  if (/replacement|already known|nonce has already been used|NONCE_EXPIRED|REPLACEMENT_UNDERPRICED/i.test(text)) return false;
  return /nonce too low|insufficient funds|INSUFFICIENT_FUNDS|intrinsic gas too low|exceeds block gas limit|invalid sender|transaction underpriced|max fee per gas less than block base fee/i.test(
    text,
  );
}

export function uncertainBroadcastMessage(address: string, nonceMoved: boolean | null): string {
  if (nonceMoved === true) {
    return `节点没有返回交易结果，但 ${address} 的交易序号已经增加。这笔交易可能已经广播。请先到区块浏览器查看，不要立刻重发。`;
  }
  return `节点没有返回交易结果，暂时不能确认 ${address} 这笔交易有没有广播。请先到区块浏览器查看，不要立刻重发。`;
}

export function explainError(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return "已停止后续转账。已经发出的那一笔会继续上链。";
  }
  const msg = redactRpcUrl(err instanceof Error ? err.message : String(err));
  if (/没有发出交易|不要用同一计划重发|不要立刻重发|已取消这一跳/.test(msg)) {
    return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
  }
  if (/insufficient funds/i.test(msg)) {
    return "余额不够支付这笔转账或手续费。资金还在发出这笔交易的地址上，用备份私钥可以继续处理。";
  }
  if (/nonce too (?:low|high)|nonce has already been used|NONCE_EXPIRED|replacement transaction underpriced|replacement fee too low|already known/i.test(msg)) {
    return "交易序号冲突。请等上一笔确认后再从备份继续。";
  }
  if (/CALL_EXCEPTION|execution reverted|require\(false\)/i.test(msg)) {
    return "这笔交易被拒绝了。资金还在发出交易的地址上，请看备份里的私钥。";
  }
  if (/ETIMEDOUT|SERVER_ERROR|failed to detect network|NETWORK_ERROR|could not coalesce|timeout/i.test(msg)) {
    return "节点连接失败或超时。可以换一个 RPC 再试。";
  }
  return msg.length > 320 ? `${msg.slice(0, 320)}…` : msg;
}
