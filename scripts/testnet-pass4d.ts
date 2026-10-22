import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
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

const backAddress = "0xcD0eed097E5746Eaa7043c2fCd48c99a40335AF0";
const back = new Contract(backAddress, ["function balanceOf(address) view returns (uint256)"], reader);
console.log("back-balance", ((await back.balanceOf(start.address)) as bigint).toString());
async function planWithRetry(input: Parameters<typeof createPlan>[0]) {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createPlan(input);
    } catch (err) {
      last = err;
      console.log("plan-retry", attempt, err instanceof Error ? err.message.slice(0, 120) : String(err));
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw last;
}
const backPlan = await planWithRetry({
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
const backResult = await runPlan({
  plan: backPlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const backMid = backPlan.lines[0].intermediates[0].address;
const backStart = (await back.balanceOf(start.address)) as bigint;
const backMidToken = (await back.balanceOf(backMid)) as bigint;
const backMidNative = await reader.getBalance(backMid);
report(
  "erc20-round-trip",
  backResult.okLines.length === 1 && backResult.failed.length === 0 && backStart === 10n ** 18n && backMidToken === 0n && backMidNative === 0n,
  `start ${backStart} midToken ${backMidToken} midNative ${backMidNative}`,
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
const splitResult = await runPlan({
  plan: splitPlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const split = new Contract(splitAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const splitBalances = await Promise.all(splitPlan.lines.map(async (line) => (await split.balanceOf(line.finalAddress)) as bigint));
const splitExpected = splitPlan.lines.map((line) => line.amountWei);
report(
  "erc20-hop1-three-lines-wei",
  splitResult.okLines.length === 3 &&
    splitResult.failed.length === 0 &&
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
