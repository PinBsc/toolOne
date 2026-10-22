import { describe, expect, it } from "vitest";
import { parseChainId, readFinalAddresses } from "./chainIo";
import {
  blocksAnotherSend,
  explainError,
  formatAmount,
  isDefiniteReject,
  isUncertainSendError,
  parsePositiveAmount,
  uncertainBroadcastMessage,
} from "./format";
import {
  applyExecutionBump,
  downstreamBudget,
  feeExceedsPlan,
  fundingGap,
  intermediateCount,
  nativeCanCover,
  perHopNativeCost,
  priorityFee,
  requiredNative,
  spendableNative,
  splitAmount,
  transactionCount,
  transferTargets,
} from "./plan";
import { serializeBackup } from "./backup";
import type { TransferPlan } from "./types";

describe("splitAmount", () => {
  it("splits evenly", () => {
    expect(splitAmount(10n, 2)).toEqual([5n, 5n]);
  });

  it("gives the remainder to the earlier lines", () => {
    expect(splitAmount(1000n, 3)).toEqual([334n, 333n, 333n]);
    expect(splitAmount(1000n, 3).reduce((sum, part) => sum + part, 0n)).toBe(1000n);
  });

  it("rejects an amount smaller than the line count", () => {
    expect(() => splitAmount(2n, 3)).toThrow(/不够分/);
  });
});

describe("hops", () => {
  it("counts intermediate wallets as hops minus one", () => {
    expect(intermediateCount(100, 1)).toBe(99);
    expect(intermediateCount(100, 3)).toBe(297);
    expect(intermediateCount(1, 3)).toBe(0);
  });

  it("builds a target for every hop, ending at the final address", () => {
    const targets = transferTargets(["0xA", "0xB"], "0xF");
    expect(targets).toEqual(["0xA", "0xB", "0xF"]);
    expect(targets).toHaveLength(3);
  });

  it("counts transactions", () => {
    expect(transactionCount(100, 1, "native")).toBe(100);
    expect(transactionCount(100, 3, "erc20")).toBe(600);
    expect(transactionCount(1, 3, "erc20")).toBe(3);
  });
});

describe("gas budget", () => {
  const fee = 1_000_000_000n;
  const tokenGas = 100_000n;
  const nativeGas = 21_000n;

  it("reserves token gas and native gas for each downstream hop", () => {
    const perHop = perHopNativeCost({
      tokenMode: "erc20",
      tokenGasLimit: tokenGas,
      nativeGasLimit: nativeGas,
      feePerGas: fee,
    });
    expect(perHop).toBe(121_000n * fee);
    const downstream = downstreamBudget(3, perHop);
    expect(downstream).toBe(242_000n * fee);
    const required = requiredNative({
      tokenMode: "erc20",
      amounts: [50n],
      downstreamPerLine: downstream,
      tokenGasLimit: tokenGas,
      nativeGasLimit: nativeGas,
      feePerGas: fee,
    });
    expect(required.startGasWei).toBe(121_000n * fee);
    expect(required.requiredNativeWei).toBe(363_000n * fee);
  });

  it("adds the selected native amount on top of downstream gas", () => {
    const perHop = perHopNativeCost({
      tokenMode: "native",
      tokenGasLimit: tokenGas,
      nativeGasLimit: nativeGas,
      feePerGas: fee,
    });
    const downstream = downstreamBudget(3, perHop);
    const amount = 5_000_000_000_000_000_000n;
    const required = requiredNative({
      tokenMode: "native",
      amounts: [amount],
      downstreamPerLine: downstream,
      tokenGasLimit: tokenGas,
      nativeGasLimit: nativeGas,
      feePerGas: fee,
    });
    expect(required.requiredNativeWei).toBe(amount + 63_000n * fee);
  });

  it("does not forward native gas when a token is sent in one hop", () => {
    const required = requiredNative({
      tokenMode: "erc20",
      amounts: [1n, 1n],
      downstreamPerLine: 0n,
      tokenGasLimit: tokenGas,
      nativeGasLimit: nativeGas,
      feePerGas: fee,
    });
    expect(required.requiredNativeWei).toBe(200_000n * fee);
  });
});

describe("fundingGap", () => {
  it("requires both token and native balances for erc20", () => {
    expect(
      fundingGap({
        tokenMode: "erc20",
        amountWei: 10n,
        requiredNativeWei: 5n,
        startNativeBalanceWei: 5n,
        startTokenBalanceWei: 9n,
      }),
    ).toMatchObject({ ok: false, tokenShort: true, nativeShort: false });
  });

  it("treats native amount as part of the native requirement", () => {
    expect(
      fundingGap({
        tokenMode: "native",
        amountWei: 10n,
        requiredNativeWei: 15n,
        startNativeBalanceWei: 15n,
        startTokenBalanceWei: 0n,
      }).ok,
    ).toBe(true);
  });
});

describe("format", () => {
  it("keeps small gas amounts visible", () => {
    expect(formatAmount(21_000_000_000_000n, 18)).toBe("0.000021");
  });

  it("parses decimal amounts", () => {
    expect(parsePositiveAmount("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(() => parsePositiveAmount("1,5", 18)).toThrow(/小数点/);
    expect(() => parsePositiveAmount("1.234", 2)).toThrow(/精度/);
  });
});

describe("execution fee", () => {
  it("keeps the quoted bump inside the planned price", () => {
    const raw = 100n;
    const buffered = (raw * 150n) / 100n;
    const planned = applyExecutionBump(buffered);
    expect(planned).toBe(165n);
    expect(feeExceedsPlan(150n, planned)).toBe(false);
    expect(feeExceedsPlan(151n, planned)).toBe(true);
  });

  it("uses part of the fee cap when the node does not suggest a tip", () => {
    const gwei = 1_000_000_000n;
    expect(priorityFee(200n * gwei, 0n)).toBe(25n * gwei);
    expect(priorityFee(50_000_000n, 0n)).toBe(50_000_000n);
    expect(priorityFee(50n * gwei, 2n * gwei)).toBe(2n * gwei);
  });

  it("requires a positive remainder after paying both hop fees", () => {
    expect(nativeCanCover(30n, [10n, 20n])).toBe(true);
    expect(nativeCanCover(30n, [10n, 20n, 1n])).toBe(false);
  });
});

describe("chain id and errors", () => {
  it("reads decimal and hex chain ids", () => {
    expect(parseChainId("0x38")).toBe(56);
    expect(parseChainId("0x1")).toBe(1);
    expect(parseChainId(137)).toBe(137);
    expect(parseChainId("56")).toBe(56);
  });

  it("keeps a pending-transaction warning intact", () => {
    const message = "等待确认超时。交易 0xabc 不要用同一计划重发。";
    expect(explainError(new Error(message))).toBe(message);
  });

  it("redacts a node key inside an error that must be shown in full", () => {
    const message = "无法估算这笔代币转账的 gas，已取消，没有发出交易。https://bsc-mainnet.nodereal.io/v1/secret";
    const shown = explainError(new Error(message));
    expect(shown).toContain("没有发出交易");
    expect(shown).not.toContain("secret");
    expect(shown).toContain("***");
  });

  it("does not treat a revert that mentions nonce as a nonce conflict", () => {
    expect(explainError(new Error('execution reverted: "nonce": 1'))).toMatch(/被拒绝/);
    expect(explainError(new Error("nonce too low"))).toMatch(/序号冲突/);
  });

  it("treats a dropped response as uncertain and a clear rejection as not", () => {
    expect(isUncertainSendError(new Error("request timeout"))).toBe(true);
    expect(isUncertainSendError(new Error("replacement fee too low"))).toBe(true);
    expect(isUncertainSendError(new Error("already known"))).toBe(true);
    expect(isUncertainSendError(new Error("insufficient funds"))).toBe(false);
    expect(isUncertainSendError(Object.assign(new Error("server response 503"), { code: "SERVER_ERROR" }))).toBe(true);
    expect(isDefiniteReject(new Error("nonce too low"))).toBe(true);
    expect(isDefiniteReject(new Error("insufficient funds"))).toBe(true);
    expect(isDefiniteReject(new Error("transaction underpriced"))).toBe(true);
    expect(isDefiniteReject(new Error("replacement transaction underpriced"))).toBe(false);
    expect(isDefiniteReject(new Error("already known"))).toBe(false);
    expect(isDefiniteReject(new Error("request timeout"))).toBe(false);
    const pending = uncertainBroadcastMessage("0xabc", null);
    expect(pending).not.toMatch(/序号已经增加/);
    expect(blocksAnotherSend(pending)).toBe(true);
    expect(uncertainBroadcastMessage("0xabc", true)).toMatch(/序号已经增加/);
    expect(explainError(new Error("replacement fee too low"))).toMatch(/序号冲突/);
    expect(blocksAnotherSend("交易 0xabc 可能仍在打包，不要用同一计划重发。")).toBe(true);
    expect(blocksAnotherSend("余额不足，已取消，没有发出交易。")).toBe(false);
  });
});

describe("final addresses", () => {
  it("rejects the zero address", () => {
    expect(() => readFinalAddresses(["0x0000000000000000000000000000000000000000"], 1)).toThrow(/零地址/);
  });
});

describe("spendableNative", () => {
  it("leaves the fee in the sender wallet", () => {
    expect(spendableNative(100n, 21n)).toBe(79n);
    expect(spendableNative(21n, 21n)).toBeNull();
  });
});

describe("serializeBackup", () => {
  it("keeps intermediate keys and omits the start key", () => {
    const plan: TransferPlan = {
      chainKey: "bsc",
      rpcUrl: "https://example.invalid",
      tokenMode: "native",
      tokenSymbol: "BNB",
      tokenDecimals: 18,
      amountInput: "1",
      amountWei: 1000n,
      hopCount: 2,
      lineCount: 1,
      bufferPercent: 50,
      rawFeePerGas: 1n,
      feePerGas: 2n,
      tokenGasLimit: 1n,
      nativeGasLimit: 21_000n,
      downstreamPerLineWei: 10n,
      startGasWei: 5n,
      requiredNativeWei: 20n,
      startAddress: "0x1111111111111111111111111111111111111111",
      startNativeBalanceWei: 100n,
      startTokenBalanceWei: 100n,
      createdAt: "2026-10-16T00:00:00.000Z",
      lines: [
        {
          index: 1,
          amountWei: 1000n,
          nativeBudgetWei: 10n,
          finalAddress: "0x2222222222222222222222222222222222222222",
          intermediates: [{ address: "0x3333333333333333333333333333333333333333", privateKey: "0xabc" }],
        },
      ],
    };
    const backup = serializeBackup(plan);
    expect(JSON.stringify(backup)).not.toContain("startPrivateKey");
    expect(backup.lines[0].intermediates[0].privateKey).toBe("0xabc");
    expect(backup.lines[0].intermediates[0].hop).toBe(1);
  });
});
