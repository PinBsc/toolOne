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
const FALSE_TOKEN = "0xe228606a52936C16c47B106d9CCcA8A80deaE35f";
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(UPSTREAM, 97);
const backup = makeProvider(BACKUP_URL, 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];
const DUST = 21_000n * 1_000_000_000n;
const proxyState = { pass: 0, failLeft: 0, forward: false };

function safe(err: unknown): string {
  const msg = err instanceof Error ? err.message : "error";
  return msg.replace(/0x[a-fA-F0-9]{64}/g, "0x…").slice(0, 240);
}

function report(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failures.push(name);
}

function expect(ok: boolean, detail: string): void {
  if (!ok) throw new Error(detail);
}

async function call<T>(work: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
  try {
    return await work(reader);
  } catch {
    return await work(backup);
  }
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
  if (!receipt || receipt.status !== 1) throw new Error("归集交易失败");
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
          const need = 180_000n * (await quotedPrice());
          if ((await nativeOf(wallet.address)) < need) {
            await sendRaw(start, { to: wallet.address, value: need * 2n, data: "0x", gasLimit: 21_000n });
          }
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
      if (native > fee) await sendRaw(wallet, { to: start.address, value: native - fee, data: "0x", gasLimit: 21_000n });
    } catch (err) {
      console.log("sweep-left", wallet.address, safe(err));
    }
  }
}

async function deploy(supply: bigint): Promise<string> {
  const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const nonce = await nonceOf(start.address);
  const network = await reader.getNetwork();
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: network.chainId,
    type: 0,
    gasPrice: await quotedPrice(),
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

async function planOf(input: Omit<Parameters<typeof createPlan>[0], "startPrivateKey" | "finalAddresses">, finals: string[]): Promise<TransferPlan> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createPlan({ ...input, startPrivateKey: startKey, finalAddresses: finals });
    } catch (err) {
      last = err;
      if (attempt === 3 || (err instanceof Error && /格式不对|不能是零地址|不能填代币合约/.test(err.message))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw last;
}

async function execute(plan: TransferPlan, signal = new AbortController().signal, onLog?: (message: string) => void) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal,
    onLog: (entry) => {
      console.log(entry.level, entry.message.replace(/0x[a-fA-F0-9]{64}/g, "0x…"));
      onLog?.(entry.message);
    },
    onProgress: () => {},
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

function badChecksum(address: string): string {
  for (let i = 2; i < address.length; i += 1) {
    const ch = address[i];
    if (/[a-f]/i.test(ch)) {
      const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      return address.slice(0, i) + flipped + address.slice(i + 1);
    }
  }
  return address;
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
    if (method === "eth_sendRawTransaction" && proxyState.pass > 0) proxyState.pass -= 1;
    else if (method === "eth_sendRawTransaction" && proxyState.failLeft > 0) {
      proxyState.failLeft -= 1;
      if (proxyState.forward) await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
      res.writeHead(500);
      res.end("timeout");
      return;
    }
    const upstream = await fetch(UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  } catch (err) {
    res.writeHead(502);
    res.end(safe(err));
  }
});

await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
console.log("start", formatEther(await nativeOf(start.address)));

await check("reject-zero-and-bad-checksum", async () => {
  const before = await nonceOf(start.address);
  let zero = "";
  let bad = "";
  try {
    await planOf(
      { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 1, lineCount: 1, bufferPercent: 50 },
      ["0x0000000000000000000000000000000000000000"],
    );
  } catch (err) {
    zero = safe(err);
  }
  try {
    await planOf(
      { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 1, lineCount: 1, bufferPercent: 50 },
      [badChecksum(start.address)],
    );
  } catch (err) {
    bad = safe(err);
  }
  const after = await nonceOf(start.address);
  expect(before === after, `nonce ${before}->${after}`);
  expect(zero.includes("零地址"), zero);
  expect(bad.includes("格式不对"), bad);
  return "rejected before send";
});

await check("reject-final-equals-token", async () => {
  const before = await nonceOf(start.address);
  let message = "";
  try {
    await planOf(
      { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "erc20", tokenAddress: FALSE_TOKEN, amount: "1", hopCount: 1, lineCount: 1, bufferPercent: 50 },
      [FALSE_TOKEN],
    );
  } catch (err) {
    message = safe(err);
  }
  expect((await nonceOf(start.address)) === before, "nonce moved");
  expect(message.includes("不能填代币合约"), message);
  return message.slice(0, 40);
});

await check("gas-above-plan-no-send", async () => {
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 1, lineCount: 1, bufferPercent: 50 },
    [final.address],
  );
  plan.feePerGas = 1n;
  const before = await nonceOf(start.address);
  let message = "";
  try {
    await execute(plan);
  } catch (err) {
    message = safe(err);
  }
  expect((await nonceOf(start.address)) === before, "nonce moved");
  expect(message.includes("没有发出交易"), message);
  return message.slice(0, 50);
});

await check("balance-short-no-send", async () => {
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "100", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [final.address],
  );
  const before = await nonceOf(start.address);
  let message = "";
  try {
    await execute(plan);
  } catch (err) {
    message = safe(err);
  }
  expect((await nonceOf(start.address)) === before, "nonce moved");
  expect(message.includes("没有发出交易"), message);
  return message.slice(0, 40);
});

await check("already-stopped-no-send", async () => {
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [final.address],
  );
  const controller = new AbortController();
  controller.abort();
  const before = await nonceOf(start.address);
  const result = await execute(plan, controller.signal);
  expect((await nonceOf(start.address)) === before, "nonce moved");
  expect(result.stopped && result.okLines.length === 0 && result.failed.length === 0, `stopped ${result.stopped} ok ${result.okLines.length}`);
  return "stopped before send";
});

await check("failover-then-one-hop", async () => {
  const final = Wallet.createRandom();
  const plan = await planOf(
    {
      chainKey: "bscTestnet",
      customRpcs: ["https://polygon-bor-rpc.publicnode.com", UPSTREAM],
      tokenMode: "native",
      tokenAddress: "",
      amount: "0.001",
      hopCount: 1,
      lineCount: 1,
      bufferPercent: 50,
    },
    [final.address],
  );
  remember(plan, [final]);
  expect(plan.rpcUrl === UPSTREAM, plan.rpcUrl);
  const before = await nonceOf(start.address);
  const result = await execute(plan);
  const got = await nativeOf(final.address);
  expect(result.okLines.length === 1 && (await nonceOf(start.address)) === before + 1, "send count");
  expect(got === plan.amountWei, `final ${got}`);
  return "used second rpc";
});

await check("stop-after-first-line-funded", async () => {
  const finals = [Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.002", hopCount: 3, lineCount: 2, bufferPercent: 50 },
    finals.map((item) => item.address),
  );
  remember(plan, finals);
  const controller = new AbortController();
  let armed = false;
  const before = await nonceOf(start.address);
  const result = await execute(plan, controller.signal, (message) => {
    if (!armed && message.includes("主币交易已广播")) {
      armed = true;
      controller.abort();
    }
  });
  const mids = await Promise.all(plan.lines.map((line) => nativeOf(line.intermediates[0].address)));
  const later = await Promise.all(plan.lines.flatMap((line) => line.intermediates.slice(1).map((item) => nativeOf(item.address))));
  const finalsBal = await Promise.all(finals.map((item) => nativeOf(item.address)));
  expect((await nonceOf(start.address)) === before + 1, "more than one funding tx");
  expect(result.stopped && result.okLines.length === 0, `stopped ${result.stopped} ok ${result.okLines.length}`);
  expect(mids[0] > plan.lines[0].amountWei && mids[1] === 0n, `mids ${mids.join(",")}`);
  expect(later.every((value) => value === 0n) && finalsBal.every((value) => value === 0n), "later hop moved");
  return `line1 ${formatEther(mids[0])}`;
});

await check("self-sweep-once", async () => {
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [Wallet.createRandom().address],
  );
  plan.lines[0].finalAddress = plan.lines[0].intermediates[0].address;
  remember(plan, []);
  let sweepsLogged = 0;
  const result = await execute(plan, new AbortController().signal, (message) => {
    if (message.includes("第 2/2") && message.includes("主币交易已广播")) sweepsLogged += 1;
    if (message.includes("第 2/2 跳") === false && message.includes("主币交易已广播") && message.includes("第 2")) sweepsLogged += 1;
  });
  const mid = plan.lines[0].intermediates[0];
  const nonce = await nonceOf(mid.address);
  const logs = sweepsLogged;
  expect(result.okLines.length === 1 && result.failed.length === 0, `ok ${result.okLines.length}`);
  expect(nonce === 1, `self nonce ${nonce} logs ${logs}`);
  return `nonce ${nonce}`;
});

await check("two-hop-returns-to-start", async () => {
  const before = await nativeOf(start.address);
  const nonceBefore = await nonceOf(start.address);
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [start.address],
  );
  remember(plan, []);
  const result = await execute(plan);
  const mid = plan.lines[0].intermediates[0].address;
  const after = await nativeOf(start.address);
  expect(result.okLines.length === 1, `ok ${result.okLines.length}`);
  expect((await nonceOf(start.address)) === nonceBefore + 1, "start sent twice");
  expect((await nonceOf(mid)) === 1 && (await nativeOf(mid)) === 0n, "intermediate kept funds");
  expect(before - after < plan.amountWei, `spent ${formatEther(before - after)}`);
  return `spent ${formatEther(before - after)}`;
});

await check("stop-after-token-broadcast", async () => {
  const token = await deploy(10n ** 18n);
  console.log("STOP2", token);
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "erc20", tokenAddress: token, amount: "1", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [final.address],
  );
  remember(plan, [final], token);
  const controller = new AbortController();
  let hop2 = false;
  const result = await execute(plan, controller.signal, (message) => {
    if (message.includes("第 2/2 跳")) hop2 = true;
    if (hop2 && message.includes("代币交易已广播")) controller.abort();
  });
  const mid = plan.lines[0].intermediates[0];
  const failure = result.failed[0];
  expect(result.okLines.length === 0 && result.nativeLeft === false, `ok ${result.okLines.length} left ${result.nativeLeft}`);
  expect(failure?.blocksRetry === true, failure?.message ?? "no failure");
  expect(failure?.holderAddress === mid.address, `holder ${failure?.holderAddress ?? ""}`);
  expect(failure?.holderKey === mid.privateKey, "displayed key is not the wallet holding the native");
  expect((await tokenOf(token, final.address)) === plan.amountWei, "token did not arrive");
  expect((await tokenOf(token, mid.address)) === 0n, "token stayed");
  expect((await nonceOf(mid.address)) === 1, `mid nonce ${await nonceOf(mid.address)}`);
  expect((await nativeOf(final.address)) === 0n && (await nativeOf(mid.address)) > 0n, "native followed the token");
  return failure?.message.slice(0, 60) ?? "";
});

async function hiddenHop(name: string, pass: number, expectStartNonce: number, expectMidNonce: number) {
  await check(name, async () => {
    const token = await deploy(10n ** 18n);
    console.log(name, token);
    const final = Wallet.createRandom();
    const plan = await planOf(
      { chainKey: "bscTestnet", customRpcs: [proxyUrl], tokenMode: "erc20", tokenAddress: token, amount: "1", hopCount: 2, lineCount: 1, bufferPercent: 50 },
      [final.address],
    );
    remember(plan, [final], token);
    proxyState.pass = pass;
    proxyState.failLeft = 1;
    proxyState.forward = true;
    const before = await nonceOf(start.address);
    const result = await execute(plan);
    const mid = plan.lines[0].intermediates[0].address;
    expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
    expect((await nonceOf(start.address)) === before + expectStartNonce, `start nonce +${(await nonceOf(start.address)) - before}`);
    expect((await nonceOf(mid)) === expectMidNonce, `mid nonce ${await nonceOf(mid)}`);
    expect((await tokenOf(token, final.address)) === plan.amountWei, "final token");
    expect((await tokenOf(token, mid)) === 0n && (await tokenOf(token, start.address)) === 0n, "token left behind");
    return `start +${(await nonceOf(start.address)) - before} mid ${await nonceOf(mid)}`;
  });
}

await hiddenHop("hide-hop2-token-no-double", 2, 2, 2);
await hiddenHop("hide-hop2-native-no-double", 3, 2, 2);

await check("direct-self-native-one-tx", async () => {
  const before = await nativeOf(start.address);
  const nonceBefore = await nonceOf(start.address);
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.002", hopCount: 1, lineCount: 1, bufferPercent: 50 },
    [start.address],
  );
  const result = await execute(plan);
  const after = await nativeOf(start.address);
  expect(result.okLines.length === 1, `ok ${result.okLines.length} ${result.failed.map((item) => item.message).join(" ")}`);
  expect((await nonceOf(start.address)) === nonceBefore + 1, "more than one tx");
  expect(before - after < plan.amountWei / 2n, `spent ${formatEther(before - after)}`);
  return `spent ${formatEther(before - after)}`;
});

console.log("LEFT", formatEther(await nativeOf(start.address)));
reader.destroy();
backup.destroy();
proxy.close();
if (failures.length > 0) console.log("FAILED", failures.join(", "));
process.exit(failures.length > 0 ? 1 : 0);
