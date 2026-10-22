import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet.drpc.org", "https://bsc-testnet-rpc.publicnode.com"];
process.on("unhandledRejection", (err) => {
  console.log("unhandled", err instanceof Error ? err.message.slice(0, 180) : String(err));
});
process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|ECONNRESET|socket hang up/i.test(message)) {
    console.log("ignored-uncaught", message.slice(0, 160));
    return;
  }
  throw err;
});
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];
const SINK_BYTECODE = "0x6001600c60003960016000f3fe";

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

async function retry<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw last;
}

async function nonce(): Promise<number> {
  return retry(() => reader.getTransactionCount(start.address, "pending"));
}

async function nativeOf(address: string): Promise<bigint> {
  return retry(() => reader.getBalance(address));
}

function loadArtifact(name: string) {
  const dir = new URL("./odd-out/", import.meta.url);
  const abi = JSON.parse(readFileSync(new URL(`scripts_OddToken_sol_${name}.abi`, dir), "utf8"));
  const bytecode = "0x" + readFileSync(new URL(`scripts_OddToken_sol_${name}.bin`, dir), "utf8").trim();
  return { abi, bytecode };
}

async function run(plan: Awaited<ReturnType<typeof createPlan>>) {
  const logs: string[] = [];
  try {
    const result = await runPlan({
      plan,
      startPrivateKey: startKey,
      signal: new AbortController().signal,
      onLog: (entry) => {
        logs.push(`${entry.level} ${entry.message}`);
        console.log(entry.level, entry.message);
      },
      onProgress: () => {},
    });
    return { result, logs, thrown: "" };
  } catch (err) {
    const thrown = err instanceof Error ? err.message : String(err);
    console.log("thrown", thrown);
    return { result: null, logs, thrown };
  }
}

console.log("start", start.address, formatEther(await nativeOf(start.address)), "nonce", await nonce());

const sink = "0x1C29BD355b70C2806339850d8A5Ca5079fE06c2f";
const sinkCode = await retry(() => reader.getCode(sink));
console.log("SINK", sink, "code", sinkCode);
if (sinkCode !== "0xfe") throw new Error("回退合约不在预期地址。");

async function deployContract(name: string, supply: bigint): Promise<string> {
  const art = loadArtifact(name);
  const factory = new ContractFactory(art.abi, art.bytecode, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const before = await nonce();
  const network = await reader.getNetwork();
  const quoted = await retry(() => reader.getFeeData());
  const gasPrice = ((quoted.gasPrice ?? 100_000_000n) * 11n) / 10n;
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 800_000n,
    nonce: before,
    chainId: network.chainId,
    type: 0,
    gasPrice,
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 120_000);
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
    const recovered = getCreateAddress({ from: start.address, nonce: before });
    const code = await retry(() => reader.getCode(recovered));
    if (code.length > 2) return recovered;
    throw new Error(`部署 ${name} 失败`);
  }
  return receipt.contractAddress;
}

if (process.env.SKIP_SINK === "1") {
  report("revert-receiver-no-second-send", true, "已在上一轮确认：只花了手续费，0.001 没有进合约，序号只加 1。");
} else {
const sinkPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "native",
  tokenAddress: "",
  amount: "0.001",
  hopCount: 1,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [sink],
});
const sinkBefore = await nonce();
const sinkBalBefore = await nativeOf(start.address);
const sinkRun = await run(sinkPlan);
const sinkAfter = await nonce();
const sinkBal = await nativeOf(sink);
const spent = sinkBalBefore - (await nativeOf(start.address));
const sinkMessage = `${sinkRun.thrown} ${sinkRun.logs.join(" | ")}`;
report(
  "revert-receiver-no-second-send",
  Boolean(sink) && sinkBal === 0n && sinkAfter - sinkBefore <= 1 && spent < 50_000_000_000_000n && spent >= 0n,
  `nonce ${sinkBefore}->${sinkAfter} sink ${sinkBal} spent ${spent} ${sinkMessage.slice(0, 240)}`,
);
}

const revertAddress = await deployContract("RevertToken", 10n ** 18n);
console.log("REVERT_TOKEN", revertAddress);
const revertBefore = await nonce();
let revertMessage = "";
try {
  await createPlan({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: revertAddress,
    amount: "1",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  }).then((plan) => run(plan));
} catch (err) {
  revertMessage = err instanceof Error ? err.message : String(err);
}
const revertAfter = await nonce();
const revertRunMessage = revertMessage;
report(
  "revert-token-estimate-blocks-send",
  revertAfter === revertBefore,
  `nonce ${revertBefore}->${revertAfter} ${revertRunMessage.slice(0, 220)}`,
);

const falseAddress = await deployContract("FalseToken", 10n ** 18n);
console.log("FALSE_TOKEN", falseAddress);
const falseToken = new Contract(falseAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const falseBefore = await nonce();
const falsePlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: falseAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const falseRun = await run(falsePlan);
const falseMid = falsePlan.lines[0].intermediates[0].address;
const falseStartToken = (await retry(() => falseToken.balanceOf(start.address))) as bigint;
const falseMidToken = (await retry(() => falseToken.balanceOf(falseMid))) as bigint;
const falseFinalToken = (await retry(() => falseToken.balanceOf(falsePlan.lines[0].finalAddress))) as bigint;
const falseMidNative = await nativeOf(falseMid);
const falseFinalNative = await nativeOf(falsePlan.lines[0].finalAddress);
const falseNonce = (await nonce()) - falseBefore;
const falseKeptTogether = falseStartToken === 10n ** 18n && falseMidToken === 0n && falseFinalToken === 0n && falseMidNative === 0n && falseFinalNative === 0n;
report(
  "false-token-does-not-separate-gas",
  falseKeptTogether && falseNonce <= 1,
  `nonce+${falseNonce} startToken ${falseStartToken} midToken ${falseMidToken} midNative ${falseMidNative} finalToken ${falseFinalToken} finalNative ${falseFinalNative} ${falseRun.thrown.slice(0, 180)} ${(falseRun.result?.failed[0]?.message ?? "").slice(0, 180)}`,
);

const nativePlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "native",
  tokenAddress: "",
  amount: "0.000300000000000001",
  hopCount: 2,
  lineCount: 3,
  bufferPercent: 0,
  startPrivateKey: startKey,
  finalAddresses: Array.from({ length: 3 }, () => Wallet.createRandom().address),
});
const nativeRun = await run(nativePlan);
const nativeRows = await Promise.all(
  nativePlan.lines.map(async (line) => ({
    final: await nativeOf(line.finalAddress),
    mid: await nativeOf(line.intermediates[0].address),
    share: line.amountWei,
  })),
);
const leftovers = nativeRows.map((row) => row.final - row.share);
report(
  "native-2hop-3lines-buffer0",
  nativeRun.result?.okLines.length === 3 &&
    nativeRun.result.failed.length === 0 &&
    nativeRows.every((row) => row.mid === 0n && row.final > row.share) &&
    leftovers.every((value) => value === leftovers[0]),
  nativeRows.map((row) => `share ${row.share} final ${row.final} mid ${row.mid}`).join(" | "),
);

console.log("LEFT", formatEther(await nativeOf(start.address)), "nonce", await nonce());
reader.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
