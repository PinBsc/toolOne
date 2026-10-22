import { readFileSync } from "fs";
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther, getCreateAddress } from "ethers";
import { createPlan, makeProvider } from "../src/chainIo";
import { runPlan } from "../src/runner";
import type { TransferPlan } from "../src/types";

const UPSTREAM = "https://bsc-testnet-rpc.publicnode.com";
const BACKUP_URL = "https://bsc-testnet.publicnode.com";
const startKey = JSON.parse(readFileSync(new URL("../testnet-wallet.local", import.meta.url), "utf8")).privateKey as string;
const reader = makeProvider(UPSTREAM, 97);
const backup = makeProvider(BACKUP_URL, 97);
const start = new Wallet(startKey, reader);
const failures: string[] = [];
const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"];
const sweeps: Array<{ key: string; token?: string }> = [];

function safe(err: unknown): string {
  return (err instanceof Error ? err.message : "error").replace(/0x[a-fA-F0-9]{64}/g, "0x…").slice(0, 220);
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
async function nativeOf(address: string) {
  return call((provider) => provider.getBalance(address));
}
async function nonceOf(address: string, tag: "latest" | "pending" = "latest") {
  return call((provider) => provider.getTransactionCount(address, tag));
}
async function tokenOf(token: string, address: string) {
  const contract = new Contract(token, TOKEN_ABI, reader);
  return call((provider) => contract.connect(provider).balanceOf(address) as Promise<bigint>);
}
async function price() {
  const fee = await call((provider) => provider.getFeeData());
  const quoted = fee.gasPrice ?? fee.maxFeePerGas ?? 100_000_000n;
  console.log("fee", String(fee.gasPrice), String(fee.maxFeePerGas), String(fee.maxPriorityFeePerGas));
  const bumped = (quoted * 15n) / 10n;
  return bumped > 100_000_000n ? bumped : 100_000_000n;
}
async function sendRaw(wallet: Wallet, tx: { to: string; value?: bigint; data?: string; gasLimit: bigint }) {
  const raw = await wallet.signTransaction({
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data ?? "0x",
    gasLimit: tx.gasLimit,
    nonce: await nonceOf(wallet.address, "pending"),
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await price(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 90_000);
  if (!receipt || receipt.status !== 1) throw new Error("归集失败");
}
function remember(plan: TransferPlan, finals: Wallet[], token?: string) {
  for (const wallet of finals) sweeps.push({ key: wallet.privateKey, token });
  for (const line of plan.lines) for (const mid of line.intermediates) sweeps.push({ key: mid.privateKey, token });
}
async function drain() {
  for (const job of sweeps.splice(0)) {
    const wallet = new Wallet(job.key, reader);
    if (wallet.address.toLowerCase() === start.address.toLowerCase()) continue;
    try {
      if (job.token) {
        const balance = await tokenOf(job.token, wallet.address);
        if (balance > 0n) {
          const need = 180_000n * (await price());
          if ((await nativeOf(wallet.address)) < need) await sendRaw(start, { to: wallet.address, value: need * 2n, gasLimit: 21_000n });
          const token = new Contract(job.token, TOKEN_ABI, wallet);
          await sendRaw(wallet, { to: job.token, data: token.interface.encodeFunctionData("transfer", [start.address, balance]), gasLimit: 180_000n });
        }
      }
      const native = await nativeOf(wallet.address);
      const fee = 21_000n * (await price());
      if (native > fee) await sendRaw(wallet, { to: start.address, value: native - fee, gasLimit: 21_000n });
    } catch (err) {
      console.log("sweep-left", wallet.address, safe(err));
    }
  }
}
async function deploy(file: string, supply: bigint) {
  const bytecode = "0x" + readFileSync(new URL(file, import.meta.url), "utf8").trim();
  const abi = JSON.parse(readFileSync(new URL(file.replace(/\.bin$/, ".abi"), import.meta.url), "utf8"));
  const factory = new ContractFactory(abi, bytecode, start);
  const unsigned = await factory.getDeployTransaction(supply);
  const nonce = await nonceOf(start.address, "pending");
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await price(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = (await reader.waitForTransaction(hash, 1, 90_000)) ?? (await backup.getTransactionReceipt(hash));
  if (receipt?.status !== 1) throw new Error("部署失败");
  return receipt.contractAddress ?? getCreateAddress({ from: start.address, nonce });
}
async function planOf(input: Omit<Parameters<typeof createPlan>[0], "startPrivateKey" | "finalAddresses">, finals: string[]) {
  return createPlan({ ...input, startPrivateKey: startKey, finalAddresses: finals });
}
async function execute(plan: TransferPlan) {
  return runPlan({
    plan,
    startPrivateKey: startKey,
    signal: new AbortController().signal,
    onLog: (entry) => console.log(entry.level, entry.message.replace(/0x[a-fA-F0-9]{64}/g, "0x…")),
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

const latest = await nonceOf(start.address);
const pending = await nonceOf(start.address, "pending");
console.log("start", formatEther(await nativeOf(start.address)), "nonce", latest, pending);
expect(latest === pending, `stuck nonce ${latest}/${pending}`);

await check("token-short-no-send", async () => {
  const token = await deploy("./unit-out/scripts_UnitToken_sol_UnitToken.bin", 10n);
  const before = await nonceOf(start.address);
  const beforeToken = await tokenOf(token, start.address);
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "erc20", tokenAddress: token, amount: "11", hopCount: 2, lineCount: 1, bufferPercent: 50 },
    [Wallet.createRandom().address],
  );
  let message = "";
  try {
    await execute(plan);
  } catch (err) {
    message = safe(err);
  }
  expect((await nonceOf(start.address)) === before, "nonce moved");
  expect((await tokenOf(token, start.address)) === beforeToken, "token moved");
  expect(message.includes("没有发出交易"), message);
  return message.slice(0, 40);
});

await check("one-hop-three-lines-no-native", async () => {
  const token = await deploy("./unit-out/scripts_UnitToken_sol_UnitToken.bin", 10n);
  console.log("UNIT", token);
  const finals = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "erc20", tokenAddress: token, amount: "10", hopCount: 1, lineCount: 3, bufferPercent: 50 },
    finals.map((item) => item.address),
  );
  remember(plan, finals, token);
  expect(plan.lines.every((line) => line.intermediates.length === 0 && line.nativeBudgetWei === 0n), "unexpected hop wallet");
  const before = await nonceOf(start.address);
  const result = await execute(plan);
  const got = await Promise.all(finals.map((item) => tokenOf(token, item.address)));
  const native = await Promise.all(finals.map((item) => nativeOf(item.address)));
  expect(plan.lines.map((line) => line.amountWei.toString()).join(",") === "4,3,3", "shares");
  expect(result.okLines.length === 3 && result.failed.length === 0, `ok ${result.okLines.length}`);
  expect((await nonceOf(start.address)) === before + 3, `nonce +${(await nonceOf(start.address)) - before}`);
  expect(got.map(String).join(",") === "4,3,3", got.join(","));
  expect(native.every((value) => value === 0n), native.join(","));
  expect((await tokenOf(token, start.address)) === 0n, "start kept tokens");
  return got.join(",");
});

await check("buffer0-native-4hop", async () => {
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "native", tokenAddress: "", amount: "0.001", hopCount: 4, lineCount: 1, bufferPercent: 0 },
    [final.address],
  );
  remember(plan, [final]);
  const result = await execute(plan);
  const mids = await Promise.all(plan.lines[0].intermediates.map((item) => nativeOf(item.address)));
  const got = await nativeOf(final.address);
  expect(result.okLines.length === 1 && result.failed.length === 0 && !result.nativeLeft, "not clean");
  expect(mids.every((value) => value === 0n), mids.join(","));
  expect(got === plan.amountWei, `final ${got}`);
  return `final ${formatEther(got)} mids ${mids.join(",") || "0"}`;
});

await check("buffer0-erc20-2hop", async () => {
  const artifact = JSON.parse(readFileSync(new URL("./test-token.json", import.meta.url), "utf8")) as { abi: string; bytecode: string };
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, start);
  const unsigned = await factory.getDeployTransaction(10n ** 18n);
  const nonce = await nonceOf(start.address, "pending");
  const raw = await start.signTransaction({
    data: unsigned.data,
    gasLimit: 1_200_000n,
    nonce,
    chainId: (await reader.getNetwork()).chainId,
    type: 0,
    gasPrice: await price(),
  });
  const hash = await reader.send("eth_sendRawTransaction", [raw]);
  const receipt = await reader.waitForTransaction(hash, 1, 90_000);
  if (receipt?.status !== 1 || !receipt.contractAddress) throw new Error("部署失败");
  const token = receipt.contractAddress;
  console.log("BUF", token);
  const final = Wallet.createRandom();
  const plan = await planOf(
    { chainKey: "bscTestnet", customRpcs: [UPSTREAM], tokenMode: "erc20", tokenAddress: token, amount: "1", hopCount: 2, lineCount: 1, bufferPercent: 0 },
    [final.address],
  );
  remember(plan, [final], token);
  const result = await execute(plan);
  const mid = plan.lines[0].intermediates[0].address;
  expect(result.okLines.length === 1 && result.failed.length === 0, result.failed.map((item) => item.message).join(" "));
  expect((await tokenOf(token, final.address)) === plan.amountWei, "token short");
  expect((await tokenOf(token, mid)) === 0n && (await nativeOf(mid)) === 0n, "mid kept funds");
  return "buffer 0 arrived";
});

console.log("LEFT", formatEther(await nativeOf(start.address)));
reader.destroy();
backup.destroy();
if (failures.length > 0) console.log("FAILED", failures.join(", "));
process.exit(failures.length > 0 ? 1 : 0);
