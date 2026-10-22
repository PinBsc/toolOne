import { readFileSync } from "fs";
import { Contract, Wallet } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const feeAddress = "0x4De9E4EA675FE3220806DFbcc2ae8E0BbB434798";
const fee = new Contract(feeAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const before = (await fee.balanceOf(start.address)) as bigint;
console.log("fee-balance", before.toString());
const plan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: RPCS,
  tokenMode: "erc20",
  tokenAddress: feeAddress,
  amount: "1000",
  hopCount: 2,
  lineCount: 1,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: [Wallet.createRandom().address],
});
const result = await runPlan({
  plan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const mid = plan.lines[0].intermediates[0].address;
const finalToken = (await fee.balanceOf(plan.lines[0].finalAddress)) as bigint;
const midToken = (await fee.balanceOf(mid)) as bigint;
const midNative = await reader.getBalance(mid);
const expected = (1000n * 10n ** 18n * 81n) / 100n;
const ok = result.okLines.length === 1 && result.failed.length === 0 && finalToken === expected && midToken === 0n && midNative === 0n;
console.log(`${ok ? "PASS" : "FAIL"} fee-token-2hop final ${finalToken} expected ${expected} midToken ${midToken} midNative ${midNative}`);
reader.destroy();
if (!ok) process.exitCode = 1;
