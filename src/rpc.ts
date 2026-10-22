import type { ChainKey } from "./types";

export type RpcProvider = "nodereal" | "infura" | "ankr" | "custom";

export interface RpcEntry {
  id: string;
  provider: RpcProvider;
  secret: string;
}

export const RPC_PROVIDER_OPTIONS: { value: RpcProvider; label: string }[] = [
  { value: "nodereal", label: "NodeReal" },
  { value: "infura", label: "Infura" },
  { value: "ankr", label: "Ankr" },
  { value: "custom", label: "自定义" },
];

const ANKR_PUBLIC: Record<ChainKey, string> = {
  ethereum: "https://rpc.ankr.com/eth",
  bsc: "https://rpc.ankr.com/bsc",
  bscTestnet: "https://rpc.ankr.com/bsc_testnet_chapel",
  polygon: "https://rpc.ankr.com/polygon",
};

function providerUrl(provider: Exclude<RpcProvider, "custom">, chain: ChainKey, key: string): string {
  const encoded = encodeURIComponent(key);
  if (provider === "nodereal") {
    const host = {
      ethereum: "eth-mainnet",
      bsc: "bsc-mainnet",
      bscTestnet: "bsc-testnet",
      polygon: "polygon-mainnet",
    }[chain];
    return `https://${host}.nodereal.io/v1/${encoded}`;
  }
  if (provider === "infura") {
    const host = {
      ethereum: "mainnet",
      bsc: "bsc-mainnet",
      bscTestnet: "bsc-testnet",
      polygon: "polygon-mainnet",
    }[chain];
    return `https://${host}.infura.io/v3/${encoded}`;
  }
  const slug = { ethereum: "eth", bsc: "bsc", bscTestnet: "bsc_testnet_chapel", polygon: "polygon" }[chain];
  return key ? `https://rpc.ankr.com/${slug}/${encoded}` : ANKR_PUBLIC[chain];
}

function detectKnownUrl(raw: string): { provider: Exclude<RpcProvider, "custom">; secret: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (hostIs(host, "nodereal.io")) {
    const index = parts.indexOf("v1");
    return { provider: "nodereal", secret: index >= 0 ? parts[index + 1] ?? "" : "" };
  }
  if (hostIs(host, "infura.io")) {
    const index = parts.indexOf("v3");
    return { provider: "infura", secret: index >= 0 ? parts[index + 1] ?? "" : "" };
  }
  if (host === "rpc.ankr.com") {
    return { provider: "ankr", secret: parts[1] ?? "" };
  }
  return null;
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function rawHostIs(raw: string, domain: string): boolean {
  try {
    return hostIs(new URL(raw).hostname.toLowerCase(), domain);
  } catch {
    return false;
  }
}

function isUsableHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function resolveEntry(chain: ChainKey, entry: Pick<RpcEntry, "provider" | "secret">): string | null {
  const raw = entry.secret.trim();
  const detected = /^https?:\/\//i.test(raw) ? detectKnownUrl(raw) : null;
  const provider = detected?.provider ?? entry.provider;
  const secret = detected?.secret ?? raw;
  if (provider === "custom") return isUsableHttpUrl(raw) ? raw : null;
  if (!secret) return provider === "ankr" ? providerUrl("ankr", chain, "") : null;
  if (/^https?:\/\//i.test(secret)) return isUsableHttpUrl(secret) ? secret : null;
  return providerUrl(provider, chain, secret);
}

export function entryError(chain: ChainKey, entry: Pick<RpcEntry, "provider" | "secret">): string | null {
  const raw = entry.secret.trim();
  if (!raw || resolveEntry(chain, entry)) return null;
  if (rawHostIs(raw, "nodereal.io")) return "这个 NodeReal 地址里没有 API Key。";
  if (rawHostIs(raw, "infura.io")) return "这个 Infura 地址里没有 API Key。";
  return "自定义节点要填完整的 http 或 https 地址。";
}

export function resolveRpcUrls(chain: ChainKey, entries: RpcEntry[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const entry of entries) {
    const url = resolveEntry(chain, entry);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

export function redactRpcUrl(value: string): string {
  return value
    .replace(/(nodereal\.io\/v1\/)[^/?#\s]+/gi, "$1***")
    .replace(/(infura\.io\/v3\/)[^/?#\s]+/gi, "$1***")
    .replace(/(rpc\.ankr\.com\/(?:eth|bsc|bsc_testnet_chapel|polygon)\/)[^/?#\s]+/gi, "$1***")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access[_-]?token)=)[^&#\s]+/gi, "$1***");
}
