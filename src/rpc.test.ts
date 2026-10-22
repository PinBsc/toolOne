import { describe, expect, it } from "vitest";
import { entryError, redactRpcUrl, resolveEntry, resolveRpcUrls, type RpcEntry } from "./rpc";

describe("resolveEntry", () => {
  it("builds NodeReal, Infura, and Ankr urls for the selected chain", () => {
    expect(resolveEntry("bsc", { provider: "nodereal", secret: "abc" })).toBe("https://bsc-mainnet.nodereal.io/v1/abc");
    expect(resolveEntry("ethereum", { provider: "nodereal", secret: "abc" })).toBe("https://eth-mainnet.nodereal.io/v1/abc");
    expect(resolveEntry("polygon", { provider: "infura", secret: "key" })).toBe("https://polygon-mainnet.infura.io/v3/key");
    expect(resolveEntry("ethereum", { provider: "infura", secret: "key" })).toBe("https://mainnet.infura.io/v3/key");
    expect(resolveEntry("bsc", { provider: "ankr", secret: "key" })).toBe("https://rpc.ankr.com/bsc/key");
    expect(resolveEntry("bscTestnet", { provider: "nodereal", secret: "abc" })).toBe(
      "https://bsc-testnet.nodereal.io/v1/abc",
    );
    expect(resolveEntry("bscTestnet", { provider: "infura", secret: "abc" })).toBe(
      "https://bsc-testnet.infura.io/v3/abc",
    );
  });

  it("rebuilds a pasted endpoint when the chain changes", () => {
    const pasted = "https://bsc-mainnet.nodereal.io/v1/mykey";
    expect(resolveEntry("polygon", { provider: "custom", secret: pasted })).toBe(
      "https://polygon-mainnet.nodereal.io/v1/mykey",
    );
    expect(resolveEntry("bsc", { provider: "custom", secret: "https://mainnet.infura.io/v3/infurakey" })).toBe(
      "https://bsc-mainnet.infura.io/v3/infurakey",
    );
  });

  it("uses Ankr's public endpoint when the key is empty", () => {
    expect(resolveEntry("polygon", { provider: "ankr", secret: "" })).toBe("https://rpc.ankr.com/polygon");
    expect(resolveEntry("ethereum", { provider: "nodereal", secret: "  " })).toBeNull();
  });

  it("does not treat a lookalike host as NodeReal or Infura", () => {
    expect(resolveEntry("bsc", { provider: "custom", secret: "https://notnodereal.io/v1/abc" })).toBe(
      "https://notnodereal.io/v1/abc",
    );
    expect(resolveEntry("ethereum", { provider: "custom", secret: "https://notinfura.io/v3/abc" })).toBe(
      "https://notinfura.io/v3/abc",
    );
  });

  it("keeps an unknown https url and ignores a custom value that is not a url", () => {
    expect(resolveEntry("bsc", { provider: "custom", secret: "https://example.invalid/rpc" })).toBe(
      "https://example.invalid/rpc",
    );
    expect(resolveEntry("bsc", { provider: "custom", secret: "not-a-url" })).toBeNull();
  });
});

describe("resolveRpcUrls", () => {
  it("keeps user order and drops duplicates and blank rows", () => {
    const entries: RpcEntry[] = [
      { id: "1", provider: "nodereal", secret: "" },
      { id: "2", provider: "infura", secret: "aaa" },
      { id: "3", provider: "infura", secret: "aaa" },
      { id: "4", provider: "ankr", secret: "bbb" },
    ];
    expect(resolveRpcUrls("ethereum", entries)).toEqual([
      "https://mainnet.infura.io/v3/aaa",
      "https://rpc.ankr.com/eth/bbb",
    ]);
  });
});

describe("entryError", () => {
  it("rejects a filled row that would otherwise be ignored", () => {
    expect(entryError("bsc", { provider: "custom", secret: "not-a-url" })).toMatch(/https/);
    expect(entryError("bsc", { provider: "nodereal", secret: "https://bsc-mainnet.nodereal.io/v1" })).toMatch(/API Key/);
    expect(entryError("ethereum", { provider: "infura", secret: "https://mainnet.infura.io/v3" })).toMatch(/API Key/);
    expect(entryError("bsc", { provider: "custom", secret: "notnodereal.io" })).not.toMatch(/NodeReal/);
    expect(entryError("bsc", { provider: "nodereal", secret: "" })).toBeNull();
    expect(entryError("bsc", { provider: "nodereal", secret: "abc" })).toBeNull();
  });
});

describe("redactRpcUrl", () => {
  it("hides keys for the three providers", () => {
    expect(redactRpcUrl("https://bsc-mainnet.nodereal.io/v1/secret")).toBe("https://bsc-mainnet.nodereal.io/v1/***");
    expect(redactRpcUrl("https://mainnet.infura.io/v3/secret")).toBe("https://mainnet.infura.io/v3/***");
    expect(redactRpcUrl("https://rpc.ankr.com/bsc/secret")).toBe("https://rpc.ankr.com/bsc/***");
    expect(redactRpcUrl("https://bsc-dataseed.binance.org")).toBe("https://bsc-dataseed.binance.org");
    expect(redactRpcUrl("https://example.invalid/rpc?api_key=secret")).toBe("https://example.invalid/rpc?api_key=***");
  });
});
