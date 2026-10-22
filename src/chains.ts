import type { ChainConfig, ChainKey } from "./types";

export const NATIVE_DECIMALS = 18;
export const MAX_HOPS = 200;
export const MAX_TOKEN_GAS = 400_000n;
export const NATIVE_GAS_LIMIT = 21_000n;
export const DEFAULT_TOKEN_GAS = 120_000n;

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "以太坊",
    chainId: 1,
    nativeSymbol: "ETH",
    rpcUrls: [
      "https://ethereum.publicnode.com",
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
    ],
    explorerTx: "https://etherscan.io/tx/",
    explorerAddress: "https://etherscan.io/address/",
  },
  bsc: {
    key: "bsc",
    name: "BSC",
    chainId: 56,
    nativeSymbol: "BNB",
    rpcUrls: [
      "https://bsc-dataseed.binance.org",
      "https://bsc.publicnode.com",
      "https://rpc.ankr.com/bsc",
    ],
    explorerTx: "https://bscscan.com/tx/",
    explorerAddress: "https://bscscan.com/address/",
  },
  bscTestnet: {
    key: "bscTestnet",
    name: "BSC测试网",
    chainId: 97,
    nativeSymbol: "tBNB",
    rpcUrls: [
      "https://bsc-testnet-rpc.publicnode.com",
      "https://bsc-testnet.drpc.org",
      "https://bsc-testnet.publicnode.com",
    ],
    explorerTx: "https://testnet.bscscan.com/tx/",
    explorerAddress: "https://testnet.bscscan.com/address/",
  },
  polygon: {
    key: "polygon",
    name: "马蹄",
    chainId: 137,
    nativeSymbol: "POL",
    rpcUrls: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.llamarpc.com",
      "https://rpc.ankr.com/polygon",
    ],
    explorerTx: "https://polygonscan.com/tx/",
    explorerAddress: "https://polygonscan.com/address/",
  },
};

export const CHAIN_LIST: ChainConfig[] = [CHAINS.ethereum, CHAINS.bsc, CHAINS.bscTestnet, CHAINS.polygon];
