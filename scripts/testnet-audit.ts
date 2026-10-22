import { readFileSync } from "fs";
import { Contract, ContractFactory, FetchRequest, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createPlan } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as {
  abi: string;
  bytecode: string;
};

function providerFor(url: string): JsonRpcProvider {
  const request = new FetchRequest(url);
  request.timeout = 12_000;
  return new JsonRpcProvider(request, 97, { staticNetwork: true });
}

let reader: JsonRpcProvider | undefined;
for (const url of RPCS) {
  const candidate = providerFor(url);
  try {
    await candidate.send("eth_chainId", []);
    reader = candidate;
    console.log("reader", url);
    break;
  } catch (err) {
    candidate.destroy();
    console.log("reader-skip", url, err instanceof Error ? err.message.slice(0, 80) : String(err));
  }
}
if (!reader) throw new Error("测试网节点都连不上。");
const start = new Wallet(startKey, reader);
const failures: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

async function nonce(): Promise<number> {
  return reader.getTransactionCount(start.address, "pending");
}

async function nativeOf(address: string): Promise<bigint> {
  return reader.getBalance(address);
}

function finals(count: number): string[] {
  return Array.from({ length: count }, () => Wallet.createRandom().address);
}

async function planOf(opts: {
  tokenMode: "native" | "erc20";
  tokenAddress?: string;
  amount: string;
  hopCount: number;
  lineCount: number;
  bufferPercent?: number;
  finalAddresses?: string[];
  customRpcs?: string[];
}): Promise<TransferPlan> {
  return createPlan({
    chainKey: "bscTestnet",
    customRpcs: opts.customRpcs ?? RPCS,
    tokenMode: opts.tokenMode,
    tokenAddress: opts.tokenAddress ?? "",
    amount: opts.amount,
    hopCount: opts.hopCount,
    lineCount: opts.lineCount,
    bufferPercent: opts.bufferPercent ?? 50,
    startPrivateKey: startKey,
    finalAddresses: opts.finalAddresses ?? finals(opts.lineCount),
  });
}

async function expectNoSend(name: string, before: number, run: () => Promise<unknown>, pattern: RegExp) {
  let message = "";
  try {
    await run();
    message = "没有抛出错误";
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const after = await nonce();
  const ok = before === after && pattern.test(message);
  report(name, ok, `nonce ${before}->${after} ${message.slice(0, 180)}`);
}

const beforeAll = await nonce();
console.log("start", start.address, "nonce", beforeAll, "native", formatEther(await nativeOf(start.address)));

const fee = await reader.getFeeData();
console.log(
  "fee",
  JSON.stringify({
    maxFee: fee.maxFeePerGas?.toString() ?? null,
    gasPrice: fee.gasPrice?.toString() ?? null,
    tip: fee.maxPriorityFeePerGas?.toString() ?? null,
  }),
);

await expectNoSend(
  "final-is-token",
  beforeAll,
  () => planOf({ tokenMode: "erc20", tokenAddress: start.address, amount: "1", hopCount: 1, lineCount: 1, finalAddresses: [start.address] }),
  /小数位|代币/,
);

await expectNoSend(
  "zero-final",
  beforeAll,
  () =>
    planOf({
      tokenMode: "native",
      amount: "0.001",
      hopCount: 1,
      lineCount: 1,
      finalAddresses: ["0x0000000000000000000000000000000000000000"],
    }),
  /零地址/,
);

{
  const before = await nonce();
  let message = "";
  try {
    const plan = await planOf({
      tokenMode: "native",
      amount: "0.001",
      hopCount: 1,
      lineCount: 1,
      customRpcs: ["https://127.0.0.1:1", RPCS[0]],
    });
    if (!plan.rpcUrl.includes("bsc-testnet-rpc.publicnode.com")) message = `连到了 ${plan.rpcUrl}`;
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const after = await nonce();
  report("rpc-failover", before === after && message === "", `nonce ${before}->${after} ${message.slice(0, 180)}`);
}

await expectNoSend(
  "wrong-chain-rpc",
  beforeAll,
  () =>
    planOf({
      tokenMode: "native",
      amount: "0.001",
      hopCount: 1,
      lineCount: 1,
      customRpcs: ["https://polygon-bor-rpc.publicnode.com"],
    }),
  /不是BSC测试网|都连不上/,
);

const guardNative = await planOf({ tokenMode: "native", amount: "10", hopCount: 1, lineCount: 1 });
await expectNoSend(
  "native-too-large",
  await nonce(),
  () => runPlan({ plan: guardNative, startPrivateKey: startKey, signal: new AbortController().signal, onLog: () => {}, onProgress: () => {} }),
  /余额不足/,
);

const lowFee = await planOf({ tokenMode: "native", amount: "0.001", hopCount: 1, lineCount: 1 });
lowFee.feePerGas = 1n;
await expectNoSend(
  "gas-above-plan",
  await nonce(),
  () => runPlan({ plan: lowFee, startPrivateKey: startKey, signal: new AbortController().signal, onLog: () => {}, onProgress: () => {} }),
  /gas 已经高于/,
);

await expectNoSend(
  "wrong-start-key",
  await nonce(),
  async () =>
    runPlan({
      plan: await planOf({ tokenMode: "native", amount: "0.001", hopCount: 1, lineCount: 1 }),
      startPrivateKey: Wallet.createRandom().privateKey,
      signal: new AbortController().signal,
      onLog: () => {},
      onProgress: () => {},
    }),
  /私钥和生成计划时的钱包不一致/,
);

const hop1Amount = 10_000_000_000_000_004n;
const hop1 = await planOf({
  tokenMode: "native",
  amount: "0.010000000000000004",
  hopCount: 1,
  lineCount: 3,
  bufferPercent: 0,
});
const hop1Before = await nonce();
const hop1Result = await runPlan({
  plan: hop1,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const hop1Balances = await Promise.all(hop1.lines.map(async (line) => nativeOf(line.finalAddress)));
const hop1Expected = hop1.lines.map((line) => line.amountWei);
const hop1Ok =
  hop1Result.okLines.length === 3 &&
  hop1Result.failed.length === 0 &&
  hop1.lines.every((line) => line.nativeBudgetWei === 0n && line.intermediates.length === 0) &&
  hop1Balances.every((value, index) => value === hop1Expected[index]) &&
  hop1Amount === hop1Expected.reduce((sum, value) => sum + value, 0n) &&
  (await nonce()) === hop1Before + 3;
report(
  "native-hop1-three-lines-remainder",
  hop1Ok,
  `balances ${hop1Balances.map((value) => value.toString()).join(",")} expected ${hop1Expected.map((value) => value.toString()).join(",")} txs ${hop1Before}->${await nonce()}`,
);

const abortPlan = await planOf({ tokenMode: "native", amount: "0.001", hopCount: 2, lineCount: 2 });
const abortController = new AbortController();
const abortResult = await runPlan({
  plan: abortPlan,
  startPrivateKey: startKey,
  signal: abortController.signal,
  onLog: (entry) => {
    console.log(entry.level, entry.message);
    if (entry.message.includes("第 1 跳已确认")) abortController.abort();
  },
  onProgress: () => {},
});
const abortMid = await nativeOf(abortPlan.lines[0].intermediates[0].address);
const abortFinal = await nativeOf(abortPlan.lines[0].finalAddress);
const abortLine2 = await nativeOf(abortPlan.lines[1].intermediates[0]?.address ?? abortPlan.lines[1].finalAddress);
const abortMidNonce = await reader.getTransactionCount(abortPlan.lines[0].intermediates[0].address);
const sent = abortPlan.lines[0].amountWei + abortPlan.lines[0].nativeBudgetWei;
const abortOk =
  abortResult.stopped &&
  abortResult.okLines.length === 0 &&
  abortMid === sent &&
  abortFinal === 0n &&
  abortLine2 === 0n &&
  abortMidNonce === 0;
report(
  "native-stop-after-first-line",
  abortOk,
  `stopped ${abortResult.stopped} ok ${abortResult.okLines.join(",")} mid ${abortMid.toString()} sent ${sent.toString()} final ${abortFinal.toString()} line2 ${abortLine2.toString()} midNonce ${abortMidNonce}`,
);

const twoHop = await planOf({
  tokenMode: "native",
  amount: "0.000300000000000001",
  hopCount: 2,
  lineCount: 3,
});
const twoResult = await runPlan({
  plan: twoHop,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const twoRows = await Promise.all(
  twoHop.lines.map(async (line) => ({
    final: await nativeOf(line.finalAddress),
    mid: await nativeOf(line.intermediates[0].address),
    share: line.amountWei,
  })),
);
const leftovers = twoRows.map((row) => row.final - row.share);
const twoOk =
  twoResult.okLines.length === 3 &&
  twoResult.failed.length === 0 &&
  twoRows.every((row) => row.mid === 0n && row.final > row.share) &&
  leftovers.every((value) => value === leftovers[0]);
report(
  "native-2hop-3lines-remainder",
  twoOk,
  twoRows
    .map((row) => `share ${row.share.toString()} final ${row.final.toString()} mid ${row.mid.toString()}`)
    .join(" | "),
);

const deployed = await new ContractFactory(artifact.abi, artifact.bytecode, start).deploy(2n * 10n ** 18n);
await deployed.waitForDeployment();
const tokenAddress = await deployed.getAddress();
console.log("TOKEN", tokenAddress);
const token = new Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], reader);

await expectNoSend(
  "final-equals-token-contract",
  await nonce(),
  () =>
    planOf({
      tokenMode: "erc20",
      tokenAddress,
      amount: "1",
      hopCount: 1,
      lineCount: 1,
      finalAddresses: [tokenAddress],
    }),
  /不能填代币合约/,
);

const tooMany = await planOf({ tokenMode: "erc20", tokenAddress, amount: "3", hopCount: 1, lineCount: 1 });
await expectNoSend(
  "token-too-large",
  await nonce(),
  () => runPlan({ plan: tooMany, startPrivateKey: startKey, signal: new AbortController().signal, onLog: () => {}, onProgress: () => {} }),
  /余额不足/,
);

const direct = await planOf({ tokenMode: "erc20", tokenAddress, amount: "1", hopCount: 1, lineCount: 1 });
const directBefore = await nonce();
const directFinalBefore = await nativeOf(direct.lines[0].finalAddress);
const directResult = await runPlan({
  plan: direct,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const directToken = (await token.balanceOf(direct.lines[0].finalAddress)) as bigint;
const directNative = await nativeOf(direct.lines[0].finalAddress);
const directOk =
  directResult.okLines.length === 1 &&
  direct.lines[0].nativeBudgetWei === 0n &&
  directToken === direct.lines[0].amountWei &&
  directNative === directFinalBefore &&
  (await nonce()) === directBefore + 1;
report(
  "erc20-hop1-no-native",
  directOk,
  `token ${directToken.toString()} nativeDelta ${(directNative - directFinalBefore).toString()} txs ${directBefore}->${await nonce()} budget ${direct.lines[0].nativeBudgetWei.toString()}`,
);

const cut = await planOf({ tokenMode: "erc20", tokenAddress, amount: "1", hopCount: 2, lineCount: 1 });
const cutController = new AbortController();
const cutResult = await runPlan({
  plan: cut,
  startPrivateKey: startKey,
  signal: cutController.signal,
  onLog: (entry) => {
    console.log(entry.level, entry.message);
    if (entry.message.includes("代币交易已广播")) cutController.abort();
  },
  onProgress: () => {},
});
const cutMid = cut.lines[0].intermediates[0];
const cutToken = (await token.balanceOf(cutMid.address)) as bigint;
const cutNative = await nativeOf(cutMid.address);
const cutFinalToken = (await token.balanceOf(cut.lines[0].finalAddress)) as bigint;
const cutFailure = cutResult.failed[0];
const cutOk =
  cutToken === cut.lines[0].amountWei &&
  cutNative === 0n &&
  cutFinalToken === 0n &&
  cutResult.okLines.length === 0 &&
  Boolean(cutFailure?.holderKey) &&
  cutFailure?.holderAddress === cutMid.address &&
  /代币已经/.test(cutFailure?.message ?? "");
report(
  "erc20-stop-after-token-before-native",
  cutOk,
  `stopped ${cutResult.stopped} token ${cutToken.toString()} native ${cutNative.toString()} holder ${cutFailure?.holderAddress ?? "-"} hasKey ${Boolean(cutFailure?.holderKey)} ${cutFailure?.message ?? "no-failure"}`,
);

console.log("LEFT", formatEther(await nativeOf(start.address)), "nonce", await nonce());
reader.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
