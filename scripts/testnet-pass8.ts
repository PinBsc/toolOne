import http from "http";
import { readFileSync } from "fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

process.on("unhandledRejection", (err) => {
  console.log("unhandled", err instanceof Error ? err.message.replace(/0x[a-fA-F0-9]{64}/g, "0x…").slice(0, 160) : "error");
});

const UPSTREAM = "https://bsc-testnet-rpc.publicnode.com";
const BACKUP_URL = "https://bsc-testnet.publicnode.com";
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(UPSTREAM, 97);
const backup = makeProvider(BACKUP_URL, 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];

const proxyState = { failLeft: 0, forward: false, failed: 0, forwarded: 0 };

function safe(err: unknown): string {
  const msg = err instanceof Error ? err.message : "error";
  return msg.replace(/0x[a-fA-F0-9]{64}/g, "0x…").slice(0, 240);
}

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

async function call<T>(work: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
  try {
    return await work(reader);
  } catch {
    return await work(backup);
  }
}

function artifact(dir: string, name: string): { abi: string; bytecode: string } {
  return {
    abi: JSON.parse(readFileSync(new URL(`./${dir}/${name}.abi`, import.meta.url), "utf8")),
    bytecode: "0x" + readFileSync(new URL(`./${dir}/${name}.bin`, import.meta.url), "utf8").trim(),
  };
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
    gasPrice: ((quoted.gasPrice ?? quoted.maxFeePerGas ?? 100_000_000n) * 15n) / 10n,
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  let receipt = null;
  try {
    receipt = await reader.waitForTransaction(hash, 1, 90_000);
  } catch {
    receipt = await backup.getTransactionReceipt(hash);
  }
  if (receipt?.status !== 1) throw new Error("部署失败");
  return receipt.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}

async function planWithRetry(input: Parameters<typeof createPlan>[0]): Promise<TransferPlan> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createPlan(input);
    } catch (err) {
      last = err;
      console.log("plan-retry", attempt, safe(err));
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw last;
}

async function nativeOf(address: string): Promise<bigint> {
  return call((provider) => provider.getBalance(address));
}

async function nonceOf(address: string): Promise<number> {
  return call((provider) => provider.getTransactionCount(address));
}

async function tokenOf(token: string, address: string): Promise<bigint> {
  const contract = new Contract(token, TOKEN_ABI, reader);
  return call((provider) => contract.connect(provider).balanceOf(address) as Promise<bigint>);
}

async function quotedPrice(): Promise<bigint> {
  const fee = await call((provider) => provider.getFeeData());
  const price = fee.gasPrice ?? fee.maxFeePerGas ?? 100_000_000n;
  const bumped = (price * 15n) / 10n;
  return bumped > 100_000_000n ? bumped : 100_000_000n;
}

async function sendRaw(wallet: Wallet, tx: { to: string; value: bigint; data: string; gasLimit: bigint }): Promise<void> {
  const nonce = await call((provider) => provider.getTransactionCount(wallet.address));
  const network = await reader.getNetwork();
  const raw = await wallet.signTransaction({
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    nonce,
    chainId: network.chainId,
    type: 0,
    gasPrice: await quotedPrice(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 90_000);
  if (!receipt || receipt.status !== 1) throw new Error(`归集交易失败 ${hash}`);
}

const sweeps: Array<{ key: string; token?: string }> = [];

function remember(plan: TransferPlan, finals: Wallet[], token?: string) {
  for (const wallet of finals) sweeps.push({ key: wallet.privateKey, token });
  for (const line of plan.lines) {
    for (const mid of line.intermediates) sweeps.push({ key: mid.privateKey, token });
  }
}

async function drain(): Promise<void> {
  const jobs = sweeps.splice(0);
  for (const job of jobs) {
    const wallet = new Wallet(job.key, reader);
    if (wallet.address.toLowerCase() === start.address.toLowerCase()) continue;
    try {
      if (job.token) {
        const balance = await tokenOf(job.token, wallet.address);
        if (balance > 0n) {
          const price = await quotedPrice();
          const need = 180_000n * price;
          const native = await nativeOf(wallet.address);
          if (native < need) await sendRaw(start, { to: wallet.address, value: need * 2n, data: "0x", gasLimit: 21_000n });
          const token = new Contract(job.token, TOKEN_ABI, wallet);
          await sendRaw(wallet, {
            to: job.token,
            value: 0n,
            data: token.interface.encodeFunctionData("transfer", [start.address, balance]),
            gasLimit: 180_000n,
          });
        }
      }
      const native = await nativeOf(wallet.address);
      const fee = 21_000n * (await quotedPrice());
      if (native > fee) {
        await sendRaw(wallet, { to: start.address, value: native - fee, data: "0x", gasLimit: 21_000n });
      }
    } catch (err) {
      const left = await nativeOf(wallet.address).catch(() => 0n);
      console.log("sweep-left", wallet.address, formatEther(left), safe(err));
    }
  }
}

function expect(ok: boolean, detail: string): void {
  if (!ok) throw new Error(detail);
}

async function execute(
  plan: TransferPlan,
  signal = new AbortController().signal,
  onLog?: (message: string) => void,
  onPlanUsed?: () => void,
) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal,
    onLog: (entry) => {
      console.log(entry.level, entry.message.replace(/0x[a-fA-F0-9]{64}/g, "0x…"));
      onLog?.(entry.message);
    },
    onProgress: () => {},
    onPlanUsed,
  });
}

async function check(name: string, work: () => Promise<string>) {
  try {
    report(name, true, await work());
  } catch (err) {
    report(name, false, safe(err));
  } finally {
    await drain();
  }
}

const proxy = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  let method = "";
  try {
    method = String(JSON.parse(body).method ?? "");
  } catch {
    method = "";
  }
  try {
    if (method === "eth_sendRawTransaction" && proxyState.failLeft > 0) {
      proxyState.failLeft -= 1;
      proxyState.failed += 1;
      if (proxyState.forward) {
        await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
        proxyState.forwarded += 1;
      }
      res.writeHead(500);
      res.end("timeout");
      return;
    }
    const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
  } catch (err) {
    res.writeHead(502);
    res.end(safe(err));
  }
});

await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = (proxy.address() as { port: number }).port;
const proxyUrl = `http://127.0.0.1:${proxyPort}`;
console.log("start", formatEther(await nativeOf(start.address)), "proxy", proxyUrl);

let falseToken = "";

await check("wrong-chain-no-send", async () => {
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  plan.rpcUrl = "https://polygon-bor-rpc.publicnode.com";
  const before = await nonceOf(start.address);
  let message = "";
  try {
    await execute(plan);
  } catch (err) {
    message = safe(err);
  }
  const after = await nonceOf(start.address);
  expect(before === after, `nonce ${before}->${after} ${message}`);
  expect(!message.includes("已广播"), message);
  expect(message.length > 0, "没有报错");
  return message;
});

await check("retry-when-broadcast-dropped", async () => {
  const finals = [Wallet.createRandom()];
  proxyState.failLeft = 1;
  proxyState.forward = false;
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [proxyUrl],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals);
  const before = await nonceOf(start.address);
  let retries = 0;
  let used = false;
  const result = await execute(
    plan,
    new AbortController().signal,
    (message) => {
      if (message.includes("自动重试")) retries += 1;
    },
    () => {
      used = true;
    },
  );
  const after = await nonceOf(start.address);
  const got = await nativeOf(finals[0].address);
  expect(result.okLines.length === 1 && result.failed.length === 0, `ok ${result.okLines.length} failed ${result.failed.length}`);
  expect(after === before + 1, `nonce ${before}->${after}`);
  expect(got === plan.lines[0].amountWei, `final ${got}`);
  expect(retries >= 1 && used, `retries ${retries} used ${used} proxyFail ${proxyState.failed}`);
  return `retries ${retries} nonce +${after - before}`;
});

await check("hidden-broadcast-not-sent-twice", async () => {
  const finals = [Wallet.createRandom()];
  proxyState.failLeft = 1;
  proxyState.forward = true;
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [proxyUrl],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.001",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals);
  const before = await nonceOf(start.address);
  let used = false;
  const result = await execute(plan, new AbortController().signal, undefined, () => {
    used = true;
  });
  const after = await nonceOf(start.address);
  const got = await nativeOf(finals[0].address);
  expect(result.okLines.length === 1 && result.failed.length === 0, `ok ${result.okLines.length} failed ${result.failed.length}`);
  expect(after === before + 1, `nonce ${before}->${after}`);
  expect(got === plan.lines[0].amountWei, `final ${got}`);
  expect(used, "成功后没有锁计划");
  return `nonce +${after - before} final ${formatEther(got)}`;
});

await check("native-revert-keeps-value", async () => {
  if (!falseToken) {
    const art = artifact("odd-out", "scripts_OddToken_sol_FalseToken");
    falseToken = await deploy(art.bytecode, art.abi, 1_000_000_000_000_000_000n);
    console.log("FALSE", falseToken);
  }
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.01",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [falseToken],
  });
  const before = await nativeOf(start.address);
  const nonceBefore = await nonceOf(start.address);
  const result = await execute(plan);
  const after = await nativeOf(start.address);
  const nonceAfter = await nonceOf(start.address);
  const parked = await nativeOf(falseToken);
  const message = result.failed.map((item) => item.message).join(" ");
  expect(result.okLines.length === 0 && result.failed.length === 1, `ok ${result.okLines.length} failed ${result.failed.length}`);
  expect(message.includes("执行失败"), message);
  expect(nonceAfter === nonceBefore + 1, `nonce ${nonceBefore}->${nonceAfter}`);
  expect(parked === 0n, `contract got ${parked}`);
  expect(before - after < plan.amountWei / 2n, `spent ${before - after}`);
  return `spent ${formatEther(before - after)}`;
});

await check("native-6hop", async () => {
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.002",
    hopCount: 6,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals);
  const result = await execute(plan);
  const mids = await Promise.all(plan.lines[0].intermediates.map((item) => nativeOf(item.address)));
  const finalNative = await nativeOf(finals[0].address);
  const dirty = mids.filter((value) => value > 21_000n * 1_000_000_000n);
  expect(plan.lines[0].intermediates.length === 5, `mids ${plan.lines[0].intermediates.length}`);
  expect(result.okLines.length === 1 && result.failed.length === 0 && !result.nativeLeft, "not clean");
  expect(dirty.length === 0, `dirty ${dirty.map((value) => value.toString()).join(",")}`);
  expect(finalNative > plan.lines[0].amountWei, `final ${finalNative}`);
  return `final ${formatEther(finalNative)} mids ${mids.map((value) => value.toString()).join(",") || "0"}`;
});

await check("native-3line-remainder", async () => {
  const finals = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "native",
    tokenAddress: "",
    amount: "0.000000000000000005",
    hopCount: 2,
    lineCount: 3,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals);
  const shares = plan.lines.map((line) => line.amountWei);
  const result = await execute(plan);
  const finalsBal = await Promise.all(finals.map((item) => nativeOf(item.address)));
  const mids = await Promise.all(plan.lines.map((line) => nativeOf(line.intermediates[0].address)));
  expect(shares.join(",") === "2,2,1", shares.join(","));
  expect(result.okLines.length === 3 && result.failed.length === 0, `ok ${result.okLines.length}`);
  expect(finalsBal.every((value, index) => value >= shares[index]), finalsBal.join(","));
  expect(mids.every((value) => value <= 21_000n * 1_000_000_000n), mids.join(","));
  return `shares ${shares.join(",")} finals ${finalsBal.join(",")}`;
});

await check("erc20-2line-2hop", async () => {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const token = await deploy(standard.bytecode, standard.abi, 2n * 10n ** 18n);
  console.log("HT", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const rows = await Promise.all(
    plan.lines.map(async (line, index) => ({
      finalToken: await tokenOf(token, finals[index].address),
      midToken: await tokenOf(token, line.intermediates[0].address),
      midNative: await nativeOf(line.intermediates[0].address),
      share: line.amountWei,
    })),
  );
  expect(result.okLines.length === 2 && result.failed.length === 0, `failed ${result.failed.length}`);
  expect(
    rows.every((row) => row.finalToken === row.share && row.midToken === 0n && row.midNative <= 21_000n * 1_000_000_000n),
    rows.map((row) => `${row.finalToken}/${row.midToken}/${row.midNative}`).join(" | "),
  );
  return rows.map((row) => formatEther(row.finalToken)).join(",");
});

await check("decimals0-3line", async () => {
  const art = artifact("unit-out", "scripts_UnitToken_sol_UnitToken");
  const token = await deploy(art.bytecode, art.abi, 5n);
  console.log("UNIT", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "5",
    hopCount: 2,
    lineCount: 3,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const got = await Promise.all(finals.map((item) => tokenOf(token, item.address)));
  const shares = plan.lines.map((line) => line.amountWei);
  expect(plan.tokenDecimals === 0, `decimals ${plan.tokenDecimals}`);
  expect(shares.join(",") === "2,2,1", shares.join(","));
  expect(result.okLines.length === 3 && result.failed.length === 0, `ok ${result.okLines.length}`);
  expect(got.every((value, index) => value === shares[index]), got.join(","));
  return `symbol ${plan.tokenSymbol} ${got.join(",")}`;
});

await check("bytes32-symbol-6dec", async () => {
  const art = artifact("bytes-out", "scripts_BytesToken_sol_BytesToken");
  const token = await deploy(art.bytecode, art.abi, 1_000_000n);
  console.log("USDX", token);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 1,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const got = await tokenOf(token, finals[0].address);
  expect(plan.tokenDecimals === 6, `decimals ${plan.tokenDecimals}`);
  expect(plan.tokenSymbol.includes("USDX"), plan.tokenSymbol);
  expect(result.okLines.length === 1 && got === 1_000_000n, `got ${got} ok ${result.okLines.length}`);
  return `${plan.tokenSymbol} ${got}`;
});

await check("silent-token-2hop", async () => {
  const art = artifact("edge-out", "scripts_EdgeToken_sol_SilentToken");
  const token = await deploy(art.bytecode, art.abi, 10n ** 18n);
  console.log("SILENT", token);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const got = await tokenOf(token, finals[0].address);
  const mid = await tokenOf(token, plan.lines[0].intermediates[0].address);
  expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
  expect(got === plan.amountWei && mid === 0n, `final ${got} mid ${mid}`);
  return "silent arrived";
});

function afterFee(amount: bigint, times: number): bigint {
  let left = amount;
  for (let i = 0; i < times; i += 1) left -= left / 10n;
  return left;
}

await check("fee-token-2hop", async () => {
  const art = artifact("fee-out", "scripts_FeeToken_sol_FeeToken");
  const token = await deploy(art.bytecode, art.abi, 10n ** 18n);
  console.log("FEE", token);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const got = await tokenOf(token, finals[0].address);
  const mid = await tokenOf(token, plan.lines[0].intermediates[0].address);
  const startLeft = await tokenOf(token, start.address);
  const expected = afterFee(plan.amountWei, 2);
  expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
  expect(got === expected && mid === 0n && startLeft === 0n, `final ${got} expected ${expected} mid ${mid} start ${startLeft}`);
  return `final ${got}`;
});

await check("fee-hidden-broadcast-no-double", async () => {
  const art = artifact("fee-out", "scripts_FeeToken_sol_FeeToken");
  const token = await deploy(art.bytecode, art.abi, 10n ** 18n);
  console.log("FEE2", token);
  const finals = [Wallet.createRandom()];
  proxyState.failLeft = 1;
  proxyState.forward = true;
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [proxyUrl],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const before = await nonceOf(start.address);
  const result = await execute(plan);
  const after = await nonceOf(start.address);
  const got = await tokenOf(token, finals[0].address);
  const mid = await tokenOf(token, plan.lines[0].intermediates[0].address);
  const expected = afterFee(plan.amountWei, 2);
  expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
  expect(after === before + 2, `start nonce ${before}->${after}`);
  expect(got === expected && mid === 0n, `final ${got} expected ${expected} mid ${mid}`);
  return `nonce +${after - before} final ${got}`;
});

await check("false-token-no-send", async () => {
  if (!falseToken) {
    const art = artifact("odd-out", "scripts_OddToken_sol_FalseToken");
    falseToken = await deploy(art.bytecode, art.abi, 10n ** 18n);
  }
  const beforeNonce = await nonceOf(start.address);
  const beforeToken = await tokenOf(falseToken, start.address);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: falseToken,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, falseToken);
  const result = await execute(plan);
  const afterNonce = await nonceOf(start.address);
  const afterToken = await tokenOf(falseToken, start.address);
  const message = result.failed.map((item) => item.message).join(" ");
  expect(result.okLines.length === 0, "marked success");
  expect(beforeNonce === afterNonce, `nonce ${beforeNonce}->${afterNonce}`);
  expect(beforeToken === afterToken, `token ${beforeToken}->${afterToken}`);
  expect(message.includes("没有发出交易"), message);
  return message.slice(0, 80);
});

await check("revert-token-no-send", async () => {
  const art = artifact("odd-out", "scripts_OddToken_sol_RevertToken");
  const token = await deploy(art.bytecode, art.abi, 10n ** 18n);
  console.log("REVERT", token);
  const beforeNonce = await nonceOf(start.address);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const result = await execute(plan);
  const afterNonce = await nonceOf(start.address);
  const message = result.failed.map((item) => item.message).join(" ");
  expect(beforeNonce === afterNonce, `nonce ${beforeNonce}->${afterNonce}`);
  expect(result.okLines.length === 0, "marked success");
  expect(message.includes("没有发出交易"), message);
  return message.slice(0, 80);
});

await check("lie-token-stops-before-native", async () => {
  const art = artifact("edge-out", "scripts_EdgeToken_sol_LieToken");
  const token = await deploy(art.bytecode, art.abi, 10n ** 18n);
  console.log("LIE", token);
  const finals = [Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "1",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [finals[0].address],
  });
  remember(plan, finals, token);
  const beforeNonce = await nonceOf(start.address);
  const beforeToken = await tokenOf(token, start.address);
  const result = await execute(plan);
  const afterNonce = await nonceOf(start.address);
  const afterToken = await tokenOf(token, start.address);
  const mid = plan.lines[0].intermediates[0].address;
  const midToken = await tokenOf(token, mid);
  const midNative = await nativeOf(mid);
  const message = result.failed.map((item) => item.message).join(" ");
  expect(result.okLines.length === 0 && !result.nativeLeft, "marked done");
  expect(afterNonce === beforeNonce + 1, `nonce ${beforeNonce}->${afterNonce}`);
  expect(afterToken === beforeToken && midToken === 0n && midNative === 0n, `start ${afterToken} mid ${midToken}/${midNative}`);
  expect(message.includes("余额没有减少"), message);
  return `nonce +${afterNonce - beforeNonce}`;
});

await check("parallel-stop", async () => {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const token = await deploy(standard.bytecode, standard.abi, 2n * 10n ** 18n);
  console.log("STOP", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "2",
    hopCount: 2,
    lineCount: 2,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: finals.map((item) => item.address),
  });
  remember(plan, finals, token);
  const controller = new AbortController();
  let armed = false;
  const result = await execute(plan, controller.signal, (message) => {
    if (!armed && message.includes("第 2/2 跳")) {
      armed = true;
      controller.abort();
    }
  });
  let conserved = 0n;
  let intact = true;
  const details: string[] = [];
  for (const line of plan.lines) {
    const mid = line.intermediates[0].address;
    const midToken = await tokenOf(token, mid);
    const midNative = await nativeOf(mid);
    const midNonce = await nonceOf(mid);
    const finalToken = await tokenOf(token, line.finalAddress);
    conserved += midToken + finalToken;
    const held = midToken === line.amountWei && midNative > 0n && finalToken === 0n && midNonce === 0;
    const sent = midToken === 0n && finalToken === line.amountWei && midNonce >= 1;
    if (!held && !sent) intact = false;
    details.push(`mid ${midToken}/${midNative} nonce ${midNonce} final ${finalToken}`);
  }
  conserved += await tokenOf(token, start.address);
  expect(result.stopped && intact && conserved === 2n * 10n ** 18n, `${details.join(" | ")} conserved ${conserved} stopped ${result.stopped}`);
  return details.join(" | ");
});

await check("last-hop-native-left", async () => {
  const standard = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const token = await deploy(standard.bytecode, standard.abi, 10n ** 15n);
  console.log("LEFT", token);
  const plan = await planWithRetry({
    chainKey: "bscTestnet",
    customRpcs: [UPSTREAM],
    tokenMode: "erc20",
    tokenAddress: token,
    amount: "0.001",
    hopCount: 2,
    lineCount: 1,
    bufferPercent: 50,
    startPrivateKey: startKey,
    finalAddresses: [falseToken],
  });
  remember(plan, [], token);
  const result = await execute(plan);
  const mid = plan.lines[0].intermediates[0];
  const midToken = await tokenOf(token, mid.address);
  const midNative = await nativeOf(mid.address);
  const finalToken = await tokenOf(token, falseToken);
  const failure = result.failed[0];
  expect(result.nativeLeft && result.okLines.length === 0 && result.failed.length === 1, `left ${result.nativeLeft} ok ${result.okLines.length} failed ${result.failed.length}`);
  expect(failure?.blocksRetry === true && failure.holderAddress === mid.address, failure?.message ?? "no failure");
  expect(Boolean(failure?.holderKey && failure.holderKey.length > 60), "missing key");
  expect(finalToken === plan.amountWei && midToken === 0n && midNative > 0n, `final ${finalToken} mid ${midToken}/${midNative}`);
  return `native left ${formatEther(midNative)}`;
});

console.log("LEFT", formatEther(await nativeOf(start.address)));
reader.destroy();
backup.destroy();
proxy.close();
if (failures.length > 0) console.log("FAILED", failures.join(", "));
process.exit(failures.length > 0 ? 1 : 0);
