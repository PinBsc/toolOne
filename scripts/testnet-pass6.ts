import { readFileSync } from "fs";
import { Contract, ContractFactory, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

process.on("unhandledRejection", (err) => {
  console.log("unhandled", err instanceof Error ? err.message.slice(0, 140) : String(err));
});

const RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.drpc.org"];
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
  let receipt = null;
  try {
    receipt = await reader.waitForTransaction(hash, 1, 90_000);
  } catch {
    receipt = await backup.getTransactionReceipt(hash);
  }
  return receipt?.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}

async function planWithRetry(input: Parameters<typeof createPlan>[0]): Promise<TransferPlan> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
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

async function run(plan: TransferPlan, signal = new AbortController().signal) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
}

console.log("start", formatEther(await call((provider) => provider.getBalance(start.address))));

try {
  const before = await call((provider) => provider.getTransactionCount(start.address));
  let message = "";
  try {
    await planWithRetry({
      chainKey: "bscTestnet",
      customRpcs: RPCS,
      tokenMode: "native",
      tokenAddress: "",
      amount: "1.1234567",
      hopCount: 1,
      lineCount: 1,
      bufferPercent: 50,
      startPrivateKey: startKey,
      finalAddresses: [Wallet.createRandom().address],
    });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const after = await call((provider) => provider.getTransactionCount(start.address));
  report("too-many-decimals-no-send", after === before && /小数位/.test(message), `nonce ${before}->${after} ${message.slice(0, 80)}`);
} catch (err) {
  report("too-many-decimals-no-send", false, err instanceof Error ? err.message.slice(0, 160) : String(err));
}

try {
  const art = {
    abi: JSON.parse(readFileSync(new URL("./bytes-out/scripts_BytesToken_sol_BytesToken.abi", import.meta.url), "utf8")),
    bytecode: "0x" + readFileSync(new URL("./bytes-out/scripts_BytesToken_sol_BytesToken.bin", import.meta.url), "utf8").trim(),
  };
  const address = await deploy(art.bytecode, art.abi, 5_000_000n);
  console.log("BYTES", address);
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: address,
    amount: "1.5",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  });
  console.log("symbol", plan.tokenSymbol, "decimals", plan.tokenDecimals, "wei", plan.amountWei.toString());
  const result = await run(plan);
  const token = new Contract(address, ["function balanceOf(address) view returns (uint256)"], reader);
  const mid = plan.lines[0].intermediates[0].address;
  const finalToken = (await call((provider) => token.connect(provider).balanceOf(plan.lines[0].finalAddress))) as bigint;
  const midToken = (await call((provider) => token.connect(provider).balanceOf(mid))) as bigint;
  const midNative = await call((provider) => provider.getBalance(mid));
  report(
    "decimals6-bytes32-2hop",
    plan.tokenDecimals === 6 &&
      plan.amountWei === 1_500_000n &&
      result.okLines.length === 1 &&
      result.failed.length === 0 &&
      finalToken === 1_500_000n &&
      midToken === 0n &&
      midNative === 0n,
    `symbol ${plan.tokenSymbol} final ${finalToken} midToken ${midToken} midNative ${midNative}`,
  );
} catch (err) {
  report("decimals6-bytes32-2hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const address = await deploy(standard.bytecode, standard.abi, 10n ** 18n);
  console.log("ZEROBUF", address);
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: address,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 0,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  });
  const result = await run(plan);
  const token = new Contract(address, ["function balanceOf(address) view returns (uint256)"], reader);
  const mid = plan.lines[0].intermediates[0].address;
  const finalToken = (await call((provider) => token.connect(provider).balanceOf(plan.lines[0].finalAddress))) as bigint;
  const midToken = (await call((provider) => token.connect(provider).balanceOf(mid))) as bigint;
  const midNative = await call((provider) => provider.getBalance(mid));
  const finalNative = await call((provider) => provider.getBalance(plan.lines[0].finalAddress));
  report(
    "erc20-buffer0-2hop",
    result.okLines.length === 1 && result.failed.length === 0 && finalToken === 10n ** 18n && midToken === 0n && midNative === 0n && finalNative > 0n,
    `finalToken ${finalToken} finalNative ${finalNative} midNative ${midNative}`,
  );
} catch (err) {
  report("erc20-buffer0-2hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const before = await call((provider) => provider.getBalance(start.address));
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 4,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  });
  const result = await run(plan);
  const mids = await Promise.all(plan.lines[0].intermediates.map((item) => call((provider) => provider.getBalance(item.address))));
  const finalNative = await call((provider) => provider.getBalance(plan.lines[0].finalAddress));
  const spent = before - (await call((provider) => provider.getBalance(start.address)));
  report(
    "native-4hop",
    plan.lines[0].intermediates.length === 3 &&
      result.okLines.length === 1 &&
      result.failed.length === 0 &&
      mids.every((value) => value === 0n) &&
      finalNative > 1_000_000_000_000_000n &&
      spent < finalNative + 100_000_000_000_000n,
    `mids ${mids.join(",")} final ${finalNative} spent ${spent}`,
  );
} catch (err) {
  report("native-4hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const shared = Wallet.createRandom().address;
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.0002",
    hopCount: 1,
    lineCount: 2,
    bufferPercent: 0,
    startPrivateKey: startKey,
    finalAddresses: [shared, shared],
  });
  const result = await run(plan);
  const got = await call((provider) => provider.getBalance(shared));
  report(
    "two-lines-same-final",
    result.okLines.length === 2 && result.failed.length === 0 && got === 200_000_000_000_000n && plan.lines[0].amountWei + plan.lines[1].amountWei === got,
    `got ${got} shares ${plan.lines.map((line) => line.amountWei.toString()).join("+")}`,
  );
} catch (err) {
  report("two-lines-same-final", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const address = await deploy(standard.bytecode, standard.abi, 10n ** 18n);
  console.log("SELF", address);
  const before = await call((provider) => provider.getTransactionCount(start.address));
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: address,
    amount: "1",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [start.address],
  });
  const result = await run(plan);
  const token = new Contract(address, ["function balanceOf(address) view returns (uint256)"], reader);
  const still = (await call((provider) => token.connect(provider).balanceOf(start.address))) as bigint;
  const delta = (await call((provider) => provider.getTransactionCount(start.address))) - before;
  console.log(
    "self-hop",
    JSON.stringify({
      ok: result.okLines,
      failed: result.failed.map((item) => item.message),
      still: still.toString(),
      delta,
    }),
  );
  report(
    "erc20-hop1-to-self",
    still === 10n ** 18n && delta <= 1 && result.failed.length === 0 && result.okLines.length === 1,
    `still ${still} delta ${delta} failed ${(result.failed[0]?.message ?? "").slice(0, 140)}`,
  );
} catch (err) {
  report("erc20-hop1-to-self", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

console.log("LEFT", formatEther(await call((provider) => provider.getBalance(start.address))));
reader.destroy();
backup.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
