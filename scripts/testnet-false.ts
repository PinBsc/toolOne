import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet.drpc.org", "https://bsc-testnet-rpc.publicnode.com"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const tokenAddress = "0x4b8291d6825Ac695D9Ff41BF4670fbD1bce0c321";
const token = new Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], reader);

const before = await reader.getTransactionCount(start.address);
const beforeToken = (await token.balanceOf(start.address)) as bigint;
console.log("before", before, beforeToken.toString(), formatEther(await reader.getBalance(start.address)));

const plan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
console.log("plan", plan.rpcUrl, plan.lines[0].intermediates[0].address, plan.lines[0].nativeBudgetWei.toString());
let failed = "";
try {
  const result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
  console.log("RESULT", JSON.stringify({ ok: result.okLines, failed: result.failed.map((item) => item.message) }));
} catch (err) {
  failed = err instanceof Error ? err.message : String(err);
  console.log("thrown", failed);
}
const mid = plan.lines[0].intermediates[0].address;
const finalAddress = plan.lines[0].finalAddress;
const startToken = (await token.balanceOf(start.address)) as bigint;
const midToken = (await token.balanceOf(mid)) as bigint;
const finalToken = (await token.balanceOf(finalAddress)) as bigint;
const midNative = await reader.getBalance(mid);
const finalNative = await reader.getBalance(finalAddress);
const nonce = await reader.getTransactionCount(start.address);
console.log(
  JSON.stringify({
    nonceDelta: nonce - before,
    startToken: startToken.toString(),
    midToken: midToken.toString(),
    finalToken: finalToken.toString(),
    midNative: midNative.toString(),
    finalNative: finalNative.toString(),
  }),
);
const kept = startToken === beforeToken && midToken === 0n && finalToken === 0n && midNative === 0n && finalNative === 0n && nonce - before <= 1;
console.log(kept ? "PASS false-token-kept-together" : "FAIL false-token-separated-gas");

const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
const factory = new ContractFactory(artifact.abi, artifact.bytecode, start);
const unsigned = await factory.getDeployTransaction(10n ** 18n);
const deployNonce = await reader.getTransactionCount(start.address);
const network = await reader.getNetwork();
const quoted = await reader.getFeeData();
const raw = await start.signTransaction({
  data: unsigned.data,
  gasLimit: 1_500_000n,
  nonce: deployNonce,
  chainId: network.chainId,
  type: 0,
  gasPrice: ((quoted.gasPrice ?? 100_000_000n) * 11n) / 10n,
});
const deployHash = await reader.send("eth_sendRawTransaction", [raw]);
const deployReceipt = await reader.waitForTransaction(deployHash, 1, 120_000);
const realAddress = deployReceipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce: deployNonce });
console.log("REAL", realAddress);
const realPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: realAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const realResult = await runPlan({
  plan: realPlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const real = new Contract(realAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const realMid = realPlan.lines[0].intermediates[0].address;
const realFinal = (await real.balanceOf(realPlan.lines[0].finalAddress)) as bigint;
const realMidToken = (await real.balanceOf(realMid)) as bigint;
const realMidNative = await reader.getBalance(realMid);
const realOk = realResult.okLines.length === 1 && realResult.failed.length === 0 && realFinal === realPlan.lines[0].amountWei && realMidToken === 0n && realMidNative === 0n;
console.log(`${realOk ? "PASS" : "FAIL"} real-erc20-2hop final ${realFinal} midToken ${realMidToken} midNative ${realMidNative}`);

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
const nativeResult = await runPlan({
  plan: nativePlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const nativeRows = await Promise.all(
  nativePlan.lines.map(async (line) => ({
    final: await reader.getBalance(line.finalAddress),
    mid: await reader.getBalance(line.intermediates[0].address),
    share: line.amountWei,
  })),
);
const leftovers = nativeRows.map((row) => row.final - row.share);
const nativeOk =
  nativeResult.okLines.length === 3 &&
  nativeResult.failed.length === 0 &&
  nativeRows.every((row) => row.mid === 0n && row.final >= row.share) &&
  leftovers.every((value) => value === leftovers[0]);
console.log(
  `${nativeOk ? "PASS" : "FAIL"} native-2hop-3lines`,
  nativeRows.map((row) => `final ${row.final} mid ${row.mid}`).join(" | "),
);
console.log("LEFT", formatEther(await reader.getBalance(start.address)));
reader.destroy();
if (!kept || !realOk || !nativeOk) process.exitCode = 1;
