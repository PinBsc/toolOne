import { readFileSync } from "fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, formatUnits } from "ethers";
import { createPlan } from "../src/chainIo";
import { runPlan } from "../src/runner";

const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as {
  abi: string;
  bytecode: string;
};
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const provider = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97, { staticNetwork: true });
const signer = new Wallet(startKey, provider);
const lineCount = Number(process.env.LINES ?? "1");
const deployed = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(BigInt(lineCount) * 1_000_000_000_000_000_000n);
await deployed.waitForDeployment();
const tokenAddress = await deployed.getAddress();
console.log("TOKEN", tokenAddress);

const hopCount = Number(process.env.HOPS ?? "2");
const finals = Array.from({ length: lineCount }, () => Wallet.createRandom().address);
const plan = await createPlan({
  chainKey: "bscTestnet",
  customRpcs: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"],
  tokenMode: "erc20",
  tokenAddress,
  amount: String(lineCount),
  hopCount,
  lineCount,
  bufferPercent: 50,
  startPrivateKey: startKey,
  finalAddresses: finals,
});
console.log(
  JSON.stringify({
    symbol: plan.tokenSymbol,
    decimals: plan.tokenDecimals,
    requiredNative: formatEther(plan.requiredNativeWei),
    tokenGas: plan.tokenGasLimit.toString(),
  }),
);
const result = await runPlan({
  plan,
  startPrivateKey: startKey,
  signal: new AbortController().signal,
  onLog: (entry) => console.log(entry.level, entry.message),
  onProgress: () => {},
});
console.log(
  "RESULT",
  JSON.stringify({
    ok: result.okLines,
    failed: result.failed.map((item) => ({ message: item.message, blocksRetry: item.blocksRetry })),
    stopped: result.stopped,
  }),
);

const reader = new Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)"], provider);
let stuck = false;
for (const line of plan.lines) {
  const finalToken = (await reader.balanceOf(line.finalAddress)) as bigint;
  const finalNative = await provider.getBalance(line.finalAddress);
  console.log("final", line.index, line.finalAddress, "token", formatUnits(finalToken, 18), "native", formatEther(finalNative));
  if (finalToken !== line.amountWei) stuck = true;
  for (const mid of line.intermediates) {
    const token = (await reader.balanceOf(mid.address)) as bigint;
    const native = await provider.getBalance(mid.address);
    console.log("mid", line.index, mid.address, "token", formatUnits(token, 18), "native", formatEther(native));
    if (token !== 0n || native > 8_000_000_000_000n) stuck = true;
  }
}
const startToken = (await reader.balanceOf(plan.startAddress)) as bigint;
console.log("start-token", formatUnits(startToken, 18));
provider.destroy();
if (stuck || result.okLines.length !== plan.lines.length || result.failed.length > 0) process.exitCode = 1;
