import { readFileSync } from "fs";
import { Contract, Wallet } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet.drpc.org", "https://bsc-testnet-rpc.publicnode.com"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const splitAddress = "0x730b6bEC6e1329565364885eA32d752a73e50BAD";
let plan;
let last: unknown;
for (let attempt = 0; attempt < 4; attempt += 1) {
  try {
    plan = await createPlan({
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
    break;
  } catch (err) {
    last = err;
    console.log("plan-retry", attempt, err instanceof Error ? err.message.slice(0, 100) : String(err));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!plan) throw last;
const result = await runPlan({
  plan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
const split = new Contract(splitAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const balances = await Promise.all(plan.lines.map(async (line) => (await split.balanceOf(line.finalAddress)) as bigint));
const expected = plan.lines.map((line) => line.amountWei);
const ok =
  result.okLines.length === 3 &&
  result.failed.length === 0 &&
  balances.every((value, index) => value === expected[index]) &&
  plan.lines.every((line) => line.nativeBudgetWei === 0n);
console.log(`${ok ? "PASS" : "FAIL"} erc20-hop1-three-lines-wei got ${balances.join(",")} expected ${expected.join(",")}`);
console.log("LEFT", (await reader.getBalance(start.address)).toString());
reader.destroy();
if (!ok) process.exitCode = 1;
