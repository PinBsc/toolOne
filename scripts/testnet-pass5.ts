import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

process.on("unhandledRejection", (err) => {
  console.log("unhandled", err instanceof Error ? err.message.slice(0, 140) : String(err));
});

const RPCS = ["https://bsc-testnet.drpc.org", "https://bsc-testnet-rpc.publicnode.com"];
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
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

async function deploy(bytecode: string, abi: string, supply: bigint): Promise<string> {
  const factory = new ContractFactory(abi, bytecode, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const nonce = await call((provider) => provider.getTransactionCount(start.address));
  const network = await reader.getNetwork();
  const quoted = await call((provider) => provider.getFeeData());
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: network.chainId,
    type: 0,
    gasPrice: ((quoted.gasPrice ?? 100_000_000n) * 11n) / 10n,
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 120_000);
  return receipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}

async function planWithRetry(input: Parameters<typeof createPlan>[0]): Promise<TransferPlan> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createPlan(input);
    } catch (err) {
      last = err;
      console.log("plan-retry", attempt, err instanceof Error ? err.message.slice(0, 100) : String(err));
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  throw last;
}

async function run(plan: TransferPlan, signal = new AbortController().signal) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
}

console.log("start", formatEther(await call((provider) => provider.getBalance(start.address))), "nonce", await call((provider) => provider.getTransactionCount(start.address)));

try {
  const art = {
    abi: JSON.parse(readFileSync(new URL("./fee-out/scripts_FeeToken_sol_FeeToken.abi", import.meta.url), "utf8")),
    bytecode: "0x" + readFileSync(new URL("./fee-out/scripts_FeeToken_sol_FeeToken.bin", import.meta.url), "utf8").trim(),
  };
  const feeAddress = await deploy(art.bytecode, art.abi, 1000n * 10n ** 18n);
  console.log("FEE", feeAddress);
  const fee = new Contract(feeAddress, ["function balanceOf(address) view returns (uint256)"], reader);
  const feePlan = await planWithRetry({
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
  const feeResult = await run(feePlan);
  const feeMid = feePlan.lines[0].intermediates[0].address;
  const feeFinal = (await call((provider) => fee.connect(provider).balanceOf(feePlan.lines[0].finalAddress))) as bigint;
  const feeMidToken = (await call((provider) => fee.connect(provider).balanceOf(feeMid))) as bigint;
  const feeMidNative = await call((provider) => provider.getBalance(feeMid));
  const expected = (1000n * 10n ** 18n * 9n) / 10n * 9n / 10n;
  report(
    "fee-token-2hop",
    feeResult.okLines.length === 1 && feeResult.failed.length === 0 && feeFinal === expected && feeMidToken === 0n && feeMidNative === 0n,
    `final ${feeFinal} expected ${expected} midToken ${feeMidToken} midNative ${feeMidNative}`,
  );
} catch (err) {
  report("fee-token-2hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const threeAddress = await deploy(standard.bytecode, standard.abi, 3n);
  console.log("THREE", threeAddress);
  const threePlan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: threeAddress,
    amount: "0.000000000000000003",
    hopCount: 2,
    lineCount: 3,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: Array.from({ length: 3 }, () => Wallet.createRandom().address),
  });
  const threeResult = await run(threePlan);
  const three = new Contract(threeAddress, ["function balanceOf(address) view returns (uint256)"], reader);
  const rows = await Promise.all(
    threePlan.lines.map(async (line) => ({
      finalToken: (await call((provider) => three.connect(provider).balanceOf(line.finalAddress))) as bigint,
      midToken: (await call((provider) => three.connect(provider).balanceOf(line.intermediates[0].address))) as bigint,
      midNative: await call((provider) => provider.getBalance(line.intermediates[0].address)),
      finalNative: await call((provider) => provider.getBalance(line.finalAddress)),
      share: line.amountWei,
    })),
  );
  report(
    "erc20-2hop-3lines",
    threeResult.okLines.length === 3 &&
      threeResult.failed.length === 0 &&
      rows.every((row) => row.finalToken === row.share && row.midToken === 0n && row.midNative === 0n && row.finalNative > 0n),
    rows.map((row) => `token ${row.finalToken} native ${row.finalNative} mid ${row.midNative}`).join(" | "),
  );
} catch (err) {
  report("erc20-2hop-3lines", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const stopAddress = await deploy(standard.bytecode, standard.abi, 2n * 10n ** 18n);
  console.log("STOP", stopAddress);
  const stopPlan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: stopAddress,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address, Wallet.createRandom().address],
  });
  const stopNonce = await call((provider) => provider.getTransactionCount(start.address));
  const controller = new AbortController();
  const stopResult = await runPlan({
    plan: stopPlan,
    startPrivateKey: startKey,
    signal: controller.signal,
    onLog: (entry) => {
      console.log(entry.level, entry.message);
      if (entry.message.includes("第 1 跳已确认")) controller.abort();
    },
    onProgress: () => {},
  });
  const stopToken = new Contract(stopAddress, ["function balanceOf(address) view returns (uint256)"], reader);
  const line1 = stopPlan.lines[0];
  const line2 = stopPlan.lines[1];
  const mid = line1.intermediates[0].address;
  const midToken = (await call((provider) => stopToken.connect(provider).balanceOf(mid))) as bigint;
  const midNative = await call((provider) => provider.getBalance(mid));
  const midNonce = await call((provider) => provider.getTransactionCount(mid));
  const line2Token = (await call((provider) => stopToken.connect(provider).balanceOf(line2.intermediates[0].address))) as bigint;
  const line2Native = await call((provider) => provider.getBalance(line2.intermediates[0].address));
  const finalToken = (await call((provider) => stopToken.connect(provider).balanceOf(line1.finalAddress))) as bigint;
  const delta = (await call((provider) => provider.getTransactionCount(start.address))) - stopNonce;
  report(
    "erc20-stop-after-full-first-hop",
    stopResult.stopped &&
      stopResult.okLines.length === 0 &&
      midToken === line1.amountWei &&
      midNative > 0n &&
      midNonce === 0 &&
      finalToken === 0n &&
      line2Token === 0n &&
      line2Native === 0n &&
      delta === 2,
    `stopped ${stopResult.stopped} delta ${delta} midToken ${midToken} midNative ${midNative} midNonce ${midNonce} line2 ${line2Token}/${line2Native} final ${finalToken}`,
  );
} catch (err) {
  report("erc20-stop-after-full-first-hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

console.log("LEFT", formatEther(await call((provider) => provider.getBalance(start.address))));
reader.destroy();
backup.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
