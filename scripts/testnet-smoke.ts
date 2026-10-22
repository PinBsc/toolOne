import { readFileSync } from "fs";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createPlan } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const provider = new JsonRpcProvider("https://bsc-testnet-rpc.publicnode.com", 97, { staticNetwork: true });

async function balances(plan: TransferPlan, extra: string[] = []) {
  const rows: Array<{ label: string; address: string; balance: string }> = [];
  const push = async (label: string, address: string) => {
    const value = await provider.getBalance(address);
    rows.push({ label, address, balance: formatEther(value) });
  };
  await push("start", plan.startAddress);
  for (const line of plan.lines) {
    for (const [index, wallet] of line.intermediates.entries()) {
      await push(`line${line.index}-hop${index + 1}`, wallet.address);
    }
    await push(`line${line.index}-final`, line.finalAddress);
  }
  for (const address of extra) await push("extra", address);
  return rows;
}

async function runCase(name: string, amount: string, hopCount: number, lineCount: number) {
  const finals = Array.from({ length: lineCount }, () => Wallet.createRandom().address);
  console.log(`\nCASE ${name}`);
  const plan = await createPlan({
    chainKey: "bscTestnet",
    customRpcs: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"],
    tokenMode: "native",
    tokenAddress: "",
    amount,
    hopCount,
    lineCount,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals,
  });
  console.log(
    JSON.stringify({
      rpc: plan.rpcUrl,
      feePerGas: plan.feePerGas.toString(),
      required: formatEther(plan.requiredNativeWei),
      budgetPerLine: formatEther(plan.downstreamPerLineWei),
      intermediates: plan.lines.map((line) => line.intermediates.length),
    }),
  );
  const result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
  console.log("RESULT", JSON.stringify({ ok: result.okLines, failed: result.failed.map((item) => item.message), stopped: result.stopped }));
  console.log("BALANCES", JSON.stringify(await balances(plan), null, 2));
}

await runCase("native-3hop-1line", "0.002", 3, 1);
await runCase("native-2hop-2line", "0.002", 2, 2);
provider.destroy();
