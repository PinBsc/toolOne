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
    gasLimit: 1_000_000n,
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

console.log("start", formatEther(await call((provider) => provider.getBalance(start.address))));

try {
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address],
  });
  plan.rpcUrl = "https://polygon-bor-rpc.publicnode.com";
  const before = await call((provider) => provider.getTransactionCount(start.address));
  let message = "";
  try {
    await runPlan({
      plan,
      startPrivateKey: startKey,
      signal: new AbortController().signal,
      onLog: () => {},
      onProgress: () => {},
    });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  const after = await call((provider) => provider.getTransactionCount(start.address));
  report("wrong-chain-run-no-send", before === after && message.length > 0, `nonce ${before}->${after} ${message.slice(0, 140)}`);
} catch (err) {
  report("wrong-chain-run-no-send", false, err instanceof Error ? err.message.slice(0, 160) : String(err));
}

try {
  const art = {
    abi: JSON.parse(readFileSync(new URL("./unit-out/scripts_UnitToken_sol_UnitToken.abi", import.meta.url), "utf8")),
    bytecode: "0x" + readFileSync(new URL("./unit-out/scripts_UnitToken_sol_UnitToken.bin", import.meta.url), "utf8").trim(),
  };
  const address = await deploy(art.bytecode, art.abi, 5n);
  console.log("UNIT", address);
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: address,
    amount: "5",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address, Wallet.createRandom().address],
  });
  console.log("decimals", plan.tokenDecimals, "shares", plan.lines.map((line) => line.amountWei.toString()).join(","));
  const result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message),
    onProgress: () => {},
  });
  const token = new Contract(address, ["function balanceOf(address) view returns (uint256)"], reader);
  const rows = await Promise.all(
    plan.lines.map(async (line) => ({
      finalToken: (await call((provider) => token.connect(provider).balanceOf(line.finalAddress))) as bigint,
      midToken: (await call((provider) => token.connect(provider).balanceOf(line.intermediates[0].address))) as bigint,
      midNative: await call((provider) => provider.getBalance(line.intermediates[0].address)),
      share: line.amountWei,
    })),
  );
  report(
    "decimals0-two-lines-2hop",
    plan.tokenDecimals === 0 &&
      result.okLines.length === 2 &&
      result.failed.length === 0 &&
      rows.every((row) => row.finalToken === row.share && row.midToken === 0n && row.midNative === 0n) &&
      rows.reduce((sum, row) => sum + row.finalToken, 0n) === 5n,
    rows.map((row) => `final ${row.finalToken} mid ${row.midToken}/${row.midNative}`).join(" | "),
  );
} catch (err) {
  report("decimals0-two-lines-2hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const before = await call((provider) => provider.getBalance(start.address));
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 10,
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
  const mids = await Promise.all(plan.lines[0].intermediates.map((item) => call((provider) => provider.getBalance(item.address))));
  const finalNative = await call((provider) => provider.getBalance(plan.lines[0].finalAddress));
  const spent = before - (await call((provider) => provider.getBalance(start.address)));
  const dirty = mids.filter((value) => value !== 0n);
  report(
    "native-10hop",
    plan.lines[0].intermediates.length === 9 &&
      result.okLines.length === 1 &&
      result.failed.length === 0 &&
      dirty.length === 0 &&
      finalNative > 1_000_000_000_000_000n,
    `mids ${mids.length} dirty ${dirty.map((value) => value.toString()).join(",") || "0"} final ${finalNative} spent ${spent}`,
  );
} catch (err) {
  report("native-10hop", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

try {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const address = await deploy(standard.bytecode, standard.abi, 2n * 10n ** 18n);
  console.log("RACE", address);
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: RPCS,
    tokenMode: "erc20",
    tokenAddress: address,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [Wallet.createRandom().address, Wallet.createRandom().address],
  });
  const controller = new AbortController();
  let armed = false;
  const result = await runPlan({
    plan,
    startPrivateKey: startKey,
    signal: controller.signal,
    onLog: (entry) => {
      console.log(entry.level, entry.message);
      if (!armed && entry.message.includes("第 2/2 跳")) {
        armed = true;
        controller.abort();
      }
    },
    onProgress: () => {},
  });
  const token = new Contract(address, ["function balanceOf(address) view returns (uint256)"], reader);
  let conserved = 0n;
  const details: string[] = [];
  let intact = true;
  for (const line of plan.lines) {
    const mid = line.intermediates[0].address;
    const midToken = (await call((provider) => token.connect(provider).balanceOf(mid))) as bigint;
    const midNative = await call((provider) => provider.getBalance(mid));
    const midNonce = await call((provider) => provider.getTransactionCount(mid));
    const finalToken = (await call((provider) => token.connect(provider).balanceOf(line.finalAddress))) as bigint;
    const finalNative = await call((provider) => provider.getBalance(line.finalAddress));
    conserved += midToken + finalToken;
    const held = midToken === line.amountWei && midNative > 0n && finalToken === 0n && midNonce === 0;
    const sent = midToken === 0n && midNative === 0n && finalToken === line.amountWei && finalNative > 0n && midNonce === 1;
    if (!held && !sent) intact = false;
    details.push(`line ${line.index} mid ${midToken}/${midNative} nonce ${midNonce} final ${finalToken}/${finalNative}`);
  }
  const startLeft = (await call((provider) => token.connect(provider).balanceOf(start.address))) as bigint;
  conserved += startLeft;
  report(
    "parallel-stop-keeps-token-with-gas",
    result.stopped && intact && conserved === 2n * 10n ** 18n,
    `${details.join(" | ")} conserved ${conserved} stopped ${result.stopped}`,
  );
} catch (err) {
  report("parallel-stop-keeps-token-with-gas", false, err instanceof Error ? err.message.slice(0, 180) : String(err));
}

console.log("LEFT", formatEther(await call((provider) => provider.getBalance(start.address))));
reader.destroy();
backup.destroy();
if (failures.length > 0) {
  console.log("FAILED", failures.join(", "));
  process.exitCode = 1;
}
