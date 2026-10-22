import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, formatUnits } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as {
  abi: string;
  bytecode: string;
};
const reader = makeProvider(RPCS[0], 97);
const start = new Wallet(startKey, reader);
const existing = "0xA418ba59F9918E077360f720056C4A8Bde8D058e";
const tokenReader = new Contract(existing, ["function balanceOf(address) view returns (uint256)"], reader);
let tokenAddress = existing;
let balance = 0n;
for (let attempt = 0; attempt < 3; attempt += 1) {
  try {
    balance = (await tokenReader.balanceOf(start.address)) as bigint;
    break;
  } catch (err) {
    if (attempt === 2) throw err;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}
console.log("existing", formatUnits(balance, 18));
if (balance < 10n ** 18n) {
  const deployed = await new ContractFactory(artifact.abi, artifact.bytecode, start).deploy(10n ** 18n);
  await deployed.waitForDeployment();
  tokenAddress = await deployed.getAddress();
  balance = 10n ** 18n;
}
console.log("TOKEN", tokenAddress);
let plan = await createPlan({
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
console.log("plan-fee", plan.rpcUrl, plan.rawFeePerGas.toString(), plan.feePerGas.toString());
let result;
try {
  result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes("gas 已经高于")) throw err;
  console.log("retry-plan", message);
  plan = await createPlan({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: plan.lines.map((line) => line.finalAddress),
  });
  console.log("plan-fee", plan.rpcUrl, plan.rawFeePerGas.toString(), plan.feePerGas.toString());
  result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
}
const token = new Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], reader);
const finalToken = (await token.balanceOf(plan.lines[0].finalAddress)) as bigint;
const mid = plan.lines[0].intermediates[0].address;
const midToken = (await token.balanceOf(mid)) as bigint;
const midNative = await reader.getBalance(mid);
const ok = result.okLines.length === 1 && result.failed.length === 0 && finalToken === plan.lines[0].amountWei && midToken === 0n && midNative === 0n;
console.log(`${ok ? "PASS" : "FAIL"} erc20-2hop final ${finalToken} midToken ${midToken} midNative ${midNative}`);
console.log("LEFT", formatEther(await reader.getBalance(start.address)));
reader.destroy();
if (!ok) process.exitCode = 1;
