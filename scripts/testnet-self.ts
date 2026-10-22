import { readFileSync } from "fs";
import { Contract, Wallet } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

const before = await reader.getTransactionCount(start.address);
let tooMany = "";
try {
  await createPlan({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: "0x2625ae8B778D05D62fBf8395627777f6c83e5e48",
    amount: "1.1234567",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  });
} catch (err) {
  tooMany = err instanceof Error ? err.message : String(err);
}
const afterGuard = await reader.getTransactionCount(start.address);
report("six-decimals-rejects-extra-place", afterGuard === before && /小数位/.test(tooMany), `nonce ${before}->${afterGuard} ${tooMany.slice(0, 80)}`);

const selfToken = new Contract("0x4831f1Ff62d9ed2DE078C7D3fCc59232810B4975", ["function balanceOf(address) view returns (uint256)"], reader);
const selfBefore = await reader.getTransactionCount(start.address);
const selfPlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: "0x4831f1Ff62d9ed2DE078C7D3fCc59232810B4975",
  amount: "1",
  hopCount: 1,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [start.address],
});
const selfResult = await runPlan({
  plan: selfPlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const selfStill = (await selfToken.balanceOf(start.address)) as bigint;
const selfDelta = (await reader.getTransactionCount(start.address)) - selfBefore;
report(
  "erc20-hop1-to-self",
  selfResult.okLines.length === 1 && selfResult.failed.length === 0 && selfStill === 10n ** 18n && selfDelta === 1,
  `still ${selfStill} delta ${selfDelta} ${(selfResult.failed[0]?.message ?? "").slice(0, 120)}`,
);

const lie = new Contract("0xCd8c7379216149FE9F1521a1F7F56b1913c07e63", ["function balanceOf(address) view returns (uint256)"], reader);
const lieBefore = await reader.getTransactionCount(start.address);
const liePlan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: "0xCd8c7379216149FE9F1521a1F7F56b1913c07e63",
  amount: "1",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const lieResult = await runPlan({
  plan: liePlan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const lieMid = liePlan.lines[0].intermediates[0].address;
const lieStart = (await lie.balanceOf(start.address)) as bigint;
const lieMidNative = await reader.getBalance(lieMid);
const lieDelta = (await reader.getTransactionCount(start.address)) - lieBefore;
report(
  "lie-token-still-blocks-native",
  lieStart === 10n ** 18n && lieMidNative === 0n && lieDelta <= 1 && lieResult.okLines.length === 0,
  `delta ${lieDelta} start ${lieStart} midNative ${lieMidNative} ${(lieResult.failed[0]?.message ?? "").slice(0, 140)}`,
);

reader.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
