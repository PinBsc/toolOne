import { useEffect, useMemo, useRef, useState } from "react";
import { downloadBackup } from "./backup";
import { CHAIN_LIST, CHAINS, MAX_HOPS } from "./chains";
import { addressFromPrivateKey, createPlan, refreshPlanBalances } from "./chainIo";
import { explainError, formatAmount, gweiLabel, shortAddr } from "./format";
import { fundingGap, transactionCount } from "./plan";
import { entryError, redactRpcUrl, resolveEntry, resolveRpcUrls, RPC_PROVIDER_OPTIONS, type RpcEntry, type RpcProvider } from "./rpc";
import { runPlan } from "./runner";
import type { ChainKey, LineFailure, LineProgress, LogEntry, TokenMode, TransferPlan } from "./types";

const STATE_LABEL: Record<LineProgress["state"], string> = {
  pending: "等待",
  running: "进行中",
  done: "完成",
  error: "停住",
  stopped: "未继续",
};

export function App() {
  const [chainKey, setChainKey] = useState<ChainKey>("bsc");
  const [rpcEntries, setRpcEntries] = useState<RpcEntry[]>([]);
  const [tokenMode, setTokenMode] = useState<TokenMode>("native");
  const [tokenAddress, setTokenAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [hopCount, setHopCount] = useState(100);
  const [lineCount, setLineCount] = useState<1 | 2 | 3>(1);
  const [bufferPercent, setBufferPercent] = useState(50);
  const [privateKey, setPrivateKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [finals, setFinals] = useState(["", "", ""]);
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [planning, setPlanning] = useState(false);
  const [backupSaved, setBackupSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<Record<number, LineProgress>>({});
  const [runError, setRunError] = useState("");
  const [failures, setFailures] = useState<LineFailure[]>([]);
  const [copied, setCopied] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const generateLock = useRef(false);
  const startLock = useRef(false);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const chain = CHAINS[chainKey];

  const startPreview = useMemo(() => {
    if (!privateKey.trim()) return "";
    try {
      return addressFromPrivateKey(privateKey);
    } catch {
      return "";
    }
  }, [privateKey]);

  const gap = plan ? fundingGap(plan) : null;
  const consumed = logs.some((entry) => Boolean(entry.txHash));
  const canStart = Boolean(plan && backupSaved && gap?.ok && !running && !consumed && !planning && !retryBlocked);
  const allDone = Boolean(
    plan && !running && plan.lines.every((line) => progress[line.index]?.state === "done"),
  );

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  function invalidate() {
    if (running) return;
    setPlan(null);
    setPlanError("");
    setBackupSaved(false);
    setConfirming(false);
    setFailures([]);
    setRunError("");
    setProgress({});
    setLogs([]);
  }

  function blockReason(): string {
    if (!plan) return "先生成计划。";
    if (retryBlocked) return "上一笔交易可能已经广播。请先到区块浏览器确认，不要立刻重发。";
    if (consumed) return "这笔计划已经发出过交易，请重新生成。";
    if (!backupSaved) return "先下载私钥备份，再开始。";
    if (gap?.tokenShort) return "起始钱包的代币余额不够。";
    if (gap?.nativeShort) return "起始钱包的主币不够支付转出数量和后续手续费。";
    return "";
  }

  async function generate() {
    if (generateLock.current || running || planning) return;
    generateLock.current = true;
    setPlanning(true);
    setPlan(null);
    setPlanError("");
    setConfirming(false);
    setFailures([]);
    setRunError("");
    setLogs([]);
    setProgress({});
    setBackupSaved(false);
    try {
      const nodeError = rpcEntries.map((entry) => entryError(chainKey, entry)).find((item) => item);
      if (nodeError) throw new Error(nodeError);
      const next = await createPlan({
        chainKey,
        customRpcs: resolveRpcUrls(chainKey, rpcEntries),
        tokenMode,
        tokenAddress,
        amount,
        hopCount,
        lineCount,
        bufferPercent,
        startPrivateKey: privateKey,
        finalAddresses: finals,
      });
      setPlan(next);
    } catch (err) {
      setPlan(null);
      setPlanError(explainError(err));
    } finally {
      generateLock.current = false;
      setPlanning(false);
    }
  }

  async function refresh() {
    if (!plan || running) return;
    setRefreshing(true);
    setPlanError("");
    try {
      setPlan(await refreshPlanBalances(plan));
    } catch (err) {
      setPlanError(explainError(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function copyText(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(""), 1200);
    } catch {
      setCopied("");
    }
  }

  async function start() {
    if (!plan || !canStart || startLock.current) return;
    startLock.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setConfirming(false);
    setRunError("");
    setFailures([]);
    setLogs([]);
    setProgress({});
    try {
      const result = await runPlan({
        plan,
        startPrivateKey: privateKey,
        signal: controller.signal,
        onLog: (entry) => setLogs((prev) => [...prev, { ...entry, id: crypto.randomUUID() }]),
        onProgress: (item) => setProgress((prev) => ({ ...prev, [item.line]: item })),
      });
      setFailures(result.failed);
      if (result.failed.some((failure) => failure.blocksRetry)) setRetryBlocked(true);
      if (result.stopped) setRunError("已停止。请按日志和备份处理还停在中间的资金。");
      else if (result.failed.length > 0) setRunError("有线条停住了。资金位置写在下面，私钥也在备份文件里。");
    } catch (err) {
      setRunError(explainError(err));
    } finally {
      startLock.current = false;
      setRunning(false);
      abortRef.current = null;
    }
  }

  const txCount = plan ? transactionCount(plan.hopCount, plan.lineCount, plan.tokenMode) : 0;
  const reason = blockReason();

  return (
    <div className="app">
      <header className="top">
        <div>
          <svg className="mark" viewBox="0 0 88 22" aria-hidden="true">
            <path d="M6 11 H82" />
            <circle cx="6" cy="11" r="3" />
            <circle cx="32" cy="11" r="3" />
            <circle cx="58" cy="11" r="3" />
            <circle cx="82" cy="11" r="4" />
          </svg>
          <p className="eyebrow">本地签名 · 私钥不出浏览器</p>
          <h1>逐跳转账</h1>
        </div>
        <p className="muted">以太坊 · BSC · 马蹄 Polygon</p>
      </header>

      <p className="banner">
        私钥只在这台电脑的浏览器里签名。中间钱包由程序生成，私钥只存在于这次页面和你下载的备份。刷新或关闭页面前，先确认备份文件已经保存。交易发出后不能撤回。本站为静态网站，已开源至 GitHub，并且托管在开发平台，没有服务器记录信息。
      </p>

      <main className="layout">
        <form
          className="panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (!running && !planning) void generate();
          }}
        >
          <h2>参数</h2>
          <fieldset className="fields" disabled={running || planning}>
            <Seg
              label="网络"
              value={chainKey}
              options={CHAIN_LIST.map((item) => ({ value: item.key, label: item.name }))}
              onChange={(value) => {
                invalidate();
                setChainKey(value);
              }}
            />
            <p className="faint">当前网络的手续费是 {chain.nativeSymbol}。</p>
            <RpcList
              chainKey={chainKey}
              entries={rpcEntries}
              onChange={(entries) => {
                invalidate();
                setRpcEntries(entries);
              }}
            />
            <Seg
              label="资产"
              value={tokenMode}
              options={[
                { value: "native" as const, label: `主币 ${chain.nativeSymbol}` },
                { value: "erc20" as const, label: "代币合约" },
              ]}
              onChange={(value) => {
                invalidate();
                setTokenMode(value);
              }}
            />
            {tokenMode === "erc20" ? (
              <label className="field">
                <span className="label">代币合约地址</span>
                <input
                  value={tokenAddress}
                  placeholder="0x..."
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    invalidate();
                    setTokenAddress(event.target.value);
                  }}
                />
              </label>
            ) : null}
            <label className="field">
              <span className="label">起始转出数量</span>
              <input
                value={amount}
                inputMode="decimal"
                placeholder="例如 100"
                onChange={(event) => {
                  invalidate();
                  setAmount(event.target.value);
                }}
              />
            </label>
            <div className="row">
              <label className="field" style={{ flex: 1 }}>
                <span className="label">跳数</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_HOPS}
                  value={hopCount}
                  onChange={(event) => {
                    invalidate();
                    setHopCount(Number(event.target.value));
                  }}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span className="label">手续费缓冲 %</span>
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={bufferPercent}
                  onChange={(event) => {
                    invalidate();
                    setBufferPercent(Number(event.target.value));
                  }}
                />
              </label>
            </div>
            <p className="hint">
              每条线转 {Number.isFinite(hopCount) ? hopCount : 0} 次。中间钱包{" "}
              {Number.isFinite(hopCount) ? Math.max(hopCount - 1, 0) : 0} 个，最后一次进入你填的最终地址。
              {tokenMode === "erc20"
                ? " 每一跳先转走全部代币，再把剩余主币转给下一个地址。"
                : " 每一跳把余额全部转走，只留下当前这一笔的手续费。"}
            </p>
            {chainKey === "ethereum" && hopCount >= 20 ? (
              <p className="hint warn">以太坊跳数一多，手续费会明显变高。生成计划后先看需要的 ETH。</p>
            ) : null}
            <Seg
              label="线数"
              value={lineCount}
              options={[
                { value: 1 as const, label: "1 条" },
                { value: 2 as const, label: "2 条" },
                { value: 3 as const, label: "3 条" },
              ]}
              onChange={(value) => {
                invalidate();
                setLineCount(value);
              }}
            />
            <p className="hint">多于 1 条时，数量和手续费主币从第一跳就平均拆开，分别走到各自的最终地址。</p>
            <label className="field">
              <span className="label">起始私钥</span>
              <input
                type={showKey ? "text" : "password"}
                value={privateKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => {
                  invalidate();
                  setPrivateKey(event.target.value);
                }}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={showKey} onChange={(event) => setShowKey(event.target.checked)} />
              显示私钥
            </label>
            {startPreview ? (
              <p className="faint break">
                起始地址 <span className="mono">{startPreview}</span>
              </p>
            ) : null}
            {Array.from({ length: lineCount }, (_, index) => (
              <label className="field" key={index}>
                <span className="label">线 {index + 1} 最终收款地址</span>
                <input
                  value={finals[index]}
                  placeholder="0x..."
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    invalidate();
                    setFinals((current) => {
                      const next = [...current];
                      next[index] = event.target.value;
                      return next;
                    });
                  }}
                />
              </label>
            ))}
          </fieldset>
          <div className="actions">
            <button className="primary" type="submit" disabled={running || planning}>
              {planning ? "正在读取链上数据…" : "生成计划"}
            </button>
          </div>
          {planError ? (
            <p className="alert" role="alert">
              {planError}
            </p>
          ) : null}
        </form>

        <section className="panel stack">
          <h2>转账计划</h2>
          {!plan ? (
            <p className="hint">
              填写左边的参数后生成计划。这里会列出每条线的路径、中间钱包，以及起始钱包要准备的主币。
            </p>
          ) : (
            <>
              <div className="stats">
                <div>
                  {chain.name} · {plan.tokenSymbol} · {plan.lineCount} 条线 · 每条 {plan.hopCount} 跳
                </div>
                <div>
                  预计链上交易 {txCount} 笔
                  {plan.tokenMode === "erc20" && plan.hopCount > 1 ? "（每跳含代币和主币各一笔）" : ""}
                </div>
                <div className="mono">
                  预估单价 {gweiLabel(plan.feePerGas)} · 缓冲 {plan.bufferPercent}% · 另含 10% 打包余量
                </div>
                <div className="break faint">节点 {redactRpcUrl(plan.rpcUrl)}</div>
                <div>
                  起始主币余额 {formatAmount(plan.startNativeBalanceWei, 18)} {CHAINS[plan.chainKey].nativeSymbol}
                </div>
                <div>
                  需要主币 {formatAmount(plan.requiredNativeWei, 18)} {CHAINS[plan.chainKey].nativeSymbol}
                  {plan.tokenMode === "native" ? "（含转出数量和后续手续费）" : "（后续每一跳的手续费，另加起始钱包自己的 gas）"}
                </div>
                {plan.tokenMode === "erc20" ? (
                  <div>
                    代币余额 {formatAmount(plan.startTokenBalanceWei, plan.tokenDecimals)} {plan.tokenSymbol}，需要{" "}
                    {formatAmount(plan.amountWei, plan.tokenDecimals)} {plan.tokenSymbol}
                  </div>
                ) : null}
              </div>
              <p className="hint">
                重新生成会使上一份备份作废。低于一笔 gas 的手续费找零可能留在中间钱包，代币仍会按余额继续往下转。
              </p>
              {plan.lines.map((line) => {
                const item = progress[line.index];
                const width = item ? Math.min(100, Math.round((item.completed / item.total) * 100)) : 0;
                return (
                  <article className="line-card" key={line.index}>
                    <h3>
                      线 {line.index}
                      {item ? ` · ${STATE_LABEL[item.state]} ${item.completed}/${item.total}` : ""}
                    </h3>
                    {item ? (
                      <div className="bar" aria-hidden="true">
                        <span style={{ width: `${width}%` }} />
                      </div>
                    ) : null}
                    <div>
                      起始转出 {formatAmount(line.amountWei, plan.tokenDecimals)} {plan.tokenSymbol}
                    </div>
                    <div>
                      带上手续费预算 {formatAmount(line.nativeBudgetWei, 18)} {CHAINS[plan.chainKey].nativeSymbol}
                    </div>
                    <div className="break">
                      最终地址 <AddressLink chainKey={plan.chainKey} address={line.finalAddress} />
                    </div>
                    {line.intermediates.length === 0 ? (
                      <p className="faint">没有中间钱包，起始钱包直接转到最终地址。</p>
                    ) : line.intermediates.length <= 6 ? (
                      <WalletList wallets={line.intermediates} chainKey={plan.chainKey} copied={copied} onCopy={copyText} />
                    ) : (
                      <details>
                        <summary>
                          中间钱包 {line.intermediates.length} 个，首个 {shortAddr(line.intermediates[0].address)}，末个{" "}
                          {shortAddr(line.intermediates[line.intermediates.length - 1].address)}
                        </summary>
                        <WalletList wallets={line.intermediates} chainKey={plan.chainKey} copied={copied} onCopy={copyText} />
                      </details>
                    )}
                    {item?.message ? <p className="hint">{item.message}</p> : null}
                  </article>
                );
              })}
              <div className="plan-actions">
                <button
                  className="ghost"
                  type="button"
                  onClick={() => {
                    downloadBackup(plan);
                    setBackupSaved(true);
                  }}
                >
                  {backupSaved ? "已下载备份，可再下载" : "下载私钥备份"}
                </button>
                <button className="ghost" type="button" disabled={refreshing || running} onClick={() => void refresh()}>
                  {refreshing ? "正在刷新…" : "刷新余额"}
                </button>
              </div>
              {confirming ? (
                <div className="confirm">
                  <strong>确认开始</strong>
                  <p>
                    从起始钱包转出 {plan.amountInput} {plan.tokenSymbol}，分成 {plan.lineCount} 条线，每条 {plan.hopCount}{" "}
                    跳，大约 {txCount} 笔链上交易。请确认备份文件已经保存到电脑上。
                  </p>
                  <div className="plan-actions">
                    <button className="primary" type="button" onClick={() => void start()}>
                      确认开始
                    </button>
                    <button className="ghost" type="button" onClick={() => setConfirming(false)}>
                      返回
                    </button>
                  </div>
                </div>
              ) : (
                <div className="plan-actions">
                  <button className="primary" type="button" disabled={!canStart} onClick={() => setConfirming(true)}>
                    开始转账
                  </button>
                  {running ? (
                    <button className="danger" type="button" onClick={() => abortRef.current?.abort()}>
                      停止后续跳转
                    </button>
                  ) : null}
                </div>
              )}
              {!canStart && !running && !confirming ? <p className="hint warn">{reason}</p> : null}
              {retryBlocked ? (
                <button className="ghost" type="button" onClick={() => setRetryBlocked(false)}>
                  我已在浏览器确认没有上链，允许重新开始
                </button>
              ) : null}
              {running ? <p className="hint">当前正在上链的那一笔会继续。停止只拦住后面的跳。</p> : null}
            </>
          )}

          {allDone ? <p className="ok-banner">已经全部到达最终地址。</p> : null}
          {runError ? (
            <p className="alert" role="alert">
              {runError}
            </p>
          ) : null}
          {failures.map((failure) => (
            <article className="recover" key={failure.line}>
              <h3>线 {failure.line} 停住了</h3>
              <p>{failure.message}</p>
              {failure.holderAddress ? (
                <p className="break">
                  资金所在 <span className="mono">{failure.holderAddress}</span>
                </p>
              ) : null}
              {failure.holderKey ? (
                <details>
                  <summary>显示这个地址的私钥</summary>
                  <p className="mono break keys">{failure.holderKey}</p>
                  <button className="ghost" type="button" onClick={() => void copyText(failure.holderKey ?? "", `fail-${failure.line}`)}>
                    {copied === `fail-${failure.line}` ? "已复制" : "复制私钥"}
                  </button>
                </details>
              ) : null}
            </article>
          ))}
          {logs.length > 0 ? (
            <div className="logs" ref={logRef} aria-live="polite">
              {logs.map((entry) => (
                <article className={`log ${entry.level}`} key={entry.id}>
                  <div>{entry.message}</div>
                  {entry.txHash && entry.explorerUrl ? (
                    <a href={entry.explorerUrl} target="_blank" rel="noreferrer">
                      {shortAddr(entry.txHash)}
                    </a>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function RpcList({
  chainKey,
  entries,
  onChange,
}: {
  chainKey: ChainKey;
  entries: RpcEntry[];
  onChange: (entries: RpcEntry[]) => void;
}) {
  function add(provider: RpcProvider) {
    if (entries.length >= 8) return;
    onChange([...entries, { id: crypto.randomUUID(), provider, secret: "" }]);
  }

  return (
    <div className="field">
      <span className="label">节点，可选，可多条</span>
      <p className="hint">
        留空就用公共节点。填了按从上到下的顺序试，第一条不通再试下一条。NodeReal、Infura、Ankr 填 API Key 即可，换链会自动换成对应地址，也可以直接粘贴完整 URL。
      </p>
      {entries.length > 0 ? (
        <div className="rpc-list">
          {entries.map((entry, index) => {
            const preview = resolveEntry(chainKey, entry);
            const problem = entryError(chainKey, entry);
            return (
              <div className="rpc-item" key={entry.id}>
                <div className="rpc-row">
                  <select
                    aria-label={`节点 ${index + 1} 服务商`}
                    value={entry.provider}
                    onChange={(event) => {
                      const provider = event.target.value as RpcProvider;
                      onChange(entries.map((item) => (item.id === entry.id ? { ...item, provider } : item)));
                    }}
                  >
                    {RPC_PROVIDER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`节点 ${index + 1}`}
                    value={entry.secret}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={entry.provider === "custom" ? "https://..." : "API Key，或粘贴完整 URL"}
                    onChange={(event) => {
                      const secret = event.target.value;
                      onChange(entries.map((item) => (item.id === entry.id ? { ...item, secret } : item)));
                    }}
                  />
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
                  >
                    删除
                  </button>
                </div>
                {preview ? <p className="faint break">{redactRpcUrl(preview)}</p> : null}
                {problem ? <p className="hint warn">{problem}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="plan-actions">
        <button className="ghost" type="button" disabled={entries.length >= 8} onClick={() => add("nodereal")}>
          添加 NodeReal
        </button>
        <button className="ghost" type="button" disabled={entries.length >= 8} onClick={() => add("infura")}>
          添加 Infura
        </button>
        <button className="ghost" type="button" disabled={entries.length >= 8} onClick={() => add("ankr")}>
          添加 Ankr
        </button>
        <button className="ghost" type="button" disabled={entries.length >= 8} onClick={() => add("custom")}>
          添加自定义
        </button>
      </div>
    </div>
  );
}

function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AddressLink({ chainKey, address }: { chainKey: ChainKey; address: string }) {
  return (
    <a className="mono" href={`${CHAINS[chainKey].explorerAddress}${address}`} target="_blank" rel="noreferrer">
      {shortAddr(address)}
    </a>
  );
}

function WalletList({
  wallets,
  chainKey,
  copied,
  onCopy,
}: {
  wallets: { address: string; privateKey: string }[];
  chainKey: ChainKey;
  copied: string;
  onCopy: (text: string, id: string) => void;
}) {
  return (
    <ol className="wallet-list">
      {wallets.map((wallet, index) => (
        <li key={wallet.address}>
          <span>
            第 {index + 1} 跳 <AddressLink chainKey={chainKey} address={wallet.address} />
          </span>
          <details>
            <summary>私钥</summary>
            <div className="mono break keys">{wallet.privateKey}</div>
            <button className="ghost" type="button" onClick={() => onCopy(wallet.privateKey, wallet.address)}>
              {copied === wallet.address ? "已复制" : "复制"}
            </button>
          </details>
        </li>
      ))}
    </ol>
  );
}
