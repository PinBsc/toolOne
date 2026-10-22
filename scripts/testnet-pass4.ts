import { readFileSync } from "fs";
import { Contract, ContractFactory, Interface, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet.drpc.org", "https://bsc-testnet-rpc.publicnode.com"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

function loadArtifact(name: string) {
  const dir = new URL("./edge-out/", import.meta.url);
  return {
    abi: JSON.parse(readFileSync(new URL(`scripts_EdgeToken_sol_${name}.abi`, dir), "utf8")),
    bytecode: "0x" + readFileSync(new URL(`scripts_EdgeToken_sol_${name}.bin`, dir), "utf8").trim(),
  };
}

async function deploy(name: string, supply: bigint): Promise<string> {
  const art = loadArtifact(name);
  const factory = new ContractFactory(art.abi, art.bytecode, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const nonce = await reader.getTransactionCount(start.address);
  const network = await reader.getNetwork();
  const quoted = await reader.getFeeData();
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 900_000n,
    nonce,
    chainId: network.chainId,
    type: 0,
    gasPrice: ((quoted.gasPrice ?? 100_000_000n) * 11n) / 10n,
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 120_000);
  return receipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}

async function run(plan: Awaited<ReturnType<typeof createPlan>>) {
  try {
    const result = await runPlan({
      plan,
      startPrivateKey: startKey,
      signal: new AbortController().signal,
      onLog: (entry) => console.log(entry.level, entry.message),
      onProgress: () => {},
    });
    return { result, thrown: "" };
  } catch (err) {
    const thrown = err instanceof Error ? err.message : String(err);
    console.log("thrown", thrown);
    return { result: null, thrown };
  }
}

console.log("start", start.address, formatEther(await reader.getBalance(start.address)), "nonce", await reader.getTransactionCount(start.address));

const silentAddress = await deploy("SilentToken", 10n ** 18n);
console.log("SILENT", silentAddress);
const silent = new Contract(silentAddress, ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256)"], reader);
const probeTo = Wallet.createRandom().address;
try {
  const accepted = await silent.transfer.staticCall(probeTo, 10n ** 18n, { from: start.address });
  console.log("silent-static", String(accepted));
} catch (err) {
  const code = err instanceof Error && "code" in err ? String(err.code) : "";
  console.log("silent-static-error", code, err instanceof Error ? err.message.slice(0, 240) : String(err));
}

const silentBefore = await reader.getTransactionCount(start.address);
const silentPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: silentAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const silentRun = await run(silentPlan);
const silentMid = silentPlan.lines[0].intermediates[0].address;
const silentFinalToken = (await silent.balanceOf(silentPlan.lines[0].finalAddress)) as bigint;
const silentMidToken = (await silent.balanceOf(silentMid)) as bigint;
const silentMidNative = await reader.getBalance(silentMid);
report(
  "silent-token-2hop",
  silentRun.result?.okLines.length === 1 &&
    silentRun.result.failed.length === 0 &&
    silentFinalToken === 10n ** 18n &&
    silentMidToken === 0n &&
    silentMidNative === 0n &&
    (await reader.getTransactionCount(start.address)) > silentBefore,
  `final ${silentFinalToken} midToken ${silentMidToken} midNative ${silentMidNative} ${silentRun.thrown.slice(0, 160)} ${(silentRun.result?.failed[0]?.message ?? "").slice(0, 160)}`,
);

const lieAddress = await deploy("LieToken", 10n ** 18n);
console.log("LIE", lieAddress);
const lie = new Contract(lieAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const lieBefore = await reader.getTransactionCount(start.address);
const liePlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: lieAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const lieRun = await run(liePlan);
const lieMid = liePlan.lines[0].intermediates[0].address;
const lieStart = (await lie.balanceOf(start.address)) as bigint;
const lieMidToken = (await lie.balanceOf(lieMid)) as bigint;
const lieFinalToken = (await lie.balanceOf(liePlan.lines[0].finalAddress)) as bigint;
const lieMidNative = await reader.getBalance(lieMid);
const lieFinalNative = await reader.getBalance(liePlan.lines[0].finalAddress);
const lieDelta = (await reader.getTransactionCount(start.address)) - lieBefore;
report(
  "lie-token-does-not-send-gas",
  lieStart === 10n ** 18n && lieMidToken === 0n && lieFinalToken === 0n && lieMidNative === 0n && lieFinalNative === 0n && lieDelta <= 1,
  `delta ${lieDelta} start ${lieStart} midToken ${lieMidToken} midNative ${lieMidNative} finalToken ${lieFinalToken} finalNative ${lieFinalNative} ${(lieRun.result?.failed[0]?.message ?? lieRun.thrown).slice(0, 180)}`,
);

const roundBefore = await reader.getBalance(start.address);
const roundPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "native",
  tokenAddress: "",
  amount: "0.001",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [start.address],
});
const roundRun = await run(roundPlan);
const roundMid = await reader.getBalance(roundPlan.lines[0].intermediates[0].address);
const roundSpent = roundBefore - (await reader.getBalance(start.address));
report(
  "native-round-trip",
  roundRun.result?.okLines.length === 1 && roundRun.result.failed.length === 0 && roundMid === 0n && roundSpent > 0n && roundSpent < 100_000_000_000_000n,
  `mid ${roundMid} spent ${roundSpent} ${(roundRun.result?.failed[0]?.message ?? roundRun.thrown).slice(0, 160)}`,
);

const backAddress = await deploy("SilentToken", 10n ** 18n);
console.log("BACK", backAddress);
const back = new Contract(backAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const backPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: backAddress,
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [start.address],
});
const backRun = await run(backPlan);
const backMid = backPlan.lines[0].intermediates[0].address;
const backStart = (await back.balanceOf(start.address)) as bigint;
const backMidToken = (await back.balanceOf(backMid)) as bigint;
const backMidNative = await reader.getBalance(backMid);
report(
  "erc20-round-trip",
  backRun.result?.okLines.length === 1 && backRun.result.failed.length === 0 && backStart === 10n ** 18n && backMidToken === 0n && backMidNative === 0n,
  `start ${backStart} midToken ${backMidToken} midNative ${backMidNative} ${(backRun.result?.failed[0]?.message ?? backRun.thrown).slice(0, 160)}`,
);

const splitArtifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
const splitFactory = new ContractFactory(splitArtifact.abi, splitArtifact.bytecode, start);
const splitUnsigned = await splitFactory.getDeployTransaction(4n);
const splitNonce = await reader.getTransactionCount(start.address);
const splitNetwork = await reader.getNetwork();
const splitFee = await reader.getFeeData();
const splitRaw = await start.signTransaction({
  data: splitUnsigned.data,
  gasLimit: 1_500_000n,
  nonce: splitNonce,
  chainId: splitNetwork.chainId,
  type: 0,
  gasPrice: ((splitFee.gasPrice ?? 100_000_000n) * 11n) / 10n,
});
const splitHash = await reader.send("eth_sendRawTransaction", [splitRaw]);
const splitReceipt = await reader.waitForTransaction(splitHash, 1, 120_000);
const splitAddress = splitReceipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce: splitNonce });
console.log("SPLIT", splitAddress);
const splitPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: splitAddress,
  amount: "0.000000000000000004",
  hopCount: 1,
  lineCount: 3,
  bufferPercent: 0,
  startPrivateKey: startKey,
  finalAddresses: Array.from({ length: 3 }, () => Wallet.createRandom().address),
});
const splitRun = await run(splitPlan);
const splitReader = new Contract(splitAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const splitBalances = await Promise.all(splitPlan.lines.map(async (line) => (await splitReader.balanceOf(line.finalAddress)) as bigint));
const splitExpected = splitPlan.lines.map((line) => line.amountWei);
const splitIface = new Interface(["function balanceOf(address) view returns (uint256)"]);
void splitIface;
report(
  "erc20-hop1-three-lines-wei",
  splitRun.result?.okLines.length === 3 &&
    splitRun.result.failed.length === 0 &&
    splitBalances.every((value, index) => value === splitExpected[index]) &&
    splitPlan.lines.every((line) => line.nativeBudgetWei === 0n),
  `got ${splitBalances.join(",")} expected ${splitExpected.join(",")}`,
);

console.log("LEFT", formatEther(await reader.getBalance(start.address)));
reader.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
