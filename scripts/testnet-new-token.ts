import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as {
  abi: string;
  bytecode: string;
};
const reader = makeProvider(RPCS[0], 97);
const backup = makeProvider(RPCS[1], 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

async function call<T>(work: (provider: typeof reader) => Promise<T>): Promise<T> {
  try {
    return await work(reader);
  } catch {
    return await work(backup);
  }
}

const factory = new ContractFactory(artifact.abi, artifact.bytecode, start);
const unsigned = await factory.getDeployTransaction(4n * 10n ** 18n);
const nonce = await call((provider) => provider.getTransactionCount(start.address));
const network = await reader.getNetwork();
const quoted = await call((provider) => provider.getFeeData());
const raw = await start.signTransaction({
  data: unsigned.data,
  gasLimit: 1_500_000n,
  nonce,
  chainId: network.chainId,
  type: 0,
  gasPrice: ((quoted.gasPrice ?? 100_000_000n) * 11n) / 10n,
});
const hash = await reader.send("eth_sendRawTransaction", [raw]);
let receipt = null;
try {
  receipt = await reader.waitForTransaction(hash, 1, 120_000);
} catch {
  receipt = await backup.getTransactionReceipt(hash);
}
const tokenAddress = receipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce });
console.log("TOKEN", tokenAddress, "tx", hash);
const token = new Contract(tokenAddress, ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"], reader);
console.log("symbol", await call((provider) => token.connect(provider).symbol()), "supply", ((await call((provider) => token.connect(provider).balanceOf(start.address))) as bigint).toString());

async function hop(name: string, amount: string, hopCount: number, lineCount: number) {
  let plan;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      plan = await createPlan({
        chainKey: "bscTestnet",
        customRpcs: RPCS,
        tokenMode: "erc20",
        tokenAddress,
        amount,
        hopCount,
        lineCount,
        bufferPercent: 50,
        startPrivateKey: startKey,
        finalAddresses: Array.from({ length: lineCount }, () => Wallet.createRandom().address),
      });
      break;
    } catch (err) {
      console.log("plan-retry", name, attempt, err instanceof Error ? err.message.slice(0, 100) : String(err));
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!plan) throw new Error(`${name} 没能生成计划`);
  const result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
  const rows = await Promise.all(
    plan.lines.map(async (line) => {
      const finalToken = (await call((provider) => token.connect(provider).balanceOf(line.finalAddress))) as bigint;
      const midToken = line.intermediates.length
        ? ((await call((provider) => token.connect(provider).balanceOf(line.intermediates[line.intermediates.length - 1].address))) as bigint)
        : 0n;
      const midNative = line.intermediates.length
        ? await call((provider) => provider.getBalance(line.intermediates[line.intermediates.length - 1].address))
        : 0n;
      const finalNative = await call((provider) => provider.getBalance(line.finalAddress));
      return { finalToken, midToken, midNative, finalNative, share: line.amountWei };
    }),
  );
  const ok =
    result.okLines.length === lineCount &&
    result.failed.length === 0 &&
    rows.every((row) => row.finalToken === row.share && row.midToken === 0n && row.midNative === 0n && (hopCount === 1 || row.finalNative > 0n));
  report(
    name,
    ok,
    rows.map((row) => `token ${row.finalToken} native ${row.finalNative} mid ${row.midToken}/${row.midNative}`).join(" | "),
  );
}

await hop("erc20-2hop-1line", "1", 2, 1);
await hop("erc20-2hop-2lines", "2", 2, 2);
await hop("erc20-3hop-1line", "1", 3, 1);
console.log("LEFT", formatEther(await call((provider) => provider.getBalance(start.address))));
reader.destroy();
backup.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
