export type ChainKey = "ethereum" | "bsc" | "bscTestnet" | "polygon";

export type TokenMode = "native" | "erc20";

export interface ChainConfig {
  key: ChainKey;
  name: string;
  chainId: number;
  nativeSymbol: string;
  rpcUrls: string[];
  explorerTx: string;
  explorerAddress: string;
}

export interface HopWallet {
  address: string;
  privateKey: string;
}

export interface LinePlan {
  index: number;
  amountWei: bigint;
  nativeBudgetWei: bigint;
  intermediates: HopWallet[];
  finalAddress: string;
}

export interface TransferPlan {
  chainKey: ChainKey;
  rpcUrl: string;
  tokenMode: TokenMode;
  tokenAddress?: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountInput: string;
  amountWei: bigint;
  hopCount: number;
  lineCount: number;
  bufferPercent: number;
  rawFeePerGas: bigint;
  feePerGas: bigint;
  tokenGasLimit: bigint;
  nativeGasLimit: bigint;
  downstreamPerLineWei: bigint;
  startGasWei: bigint;
  requiredNativeWei: bigint;
  startAddress: string;
  startNativeBalanceWei: bigint;
  startTokenBalanceWei: bigint;
  lines: LinePlan[];
  createdAt: string;
}

export interface LogEntry {
  id: string;
  line?: number;
  level: "info" | "ok" | "error" | "warn";
  message: string;
  txHash?: string;
  explorerUrl?: string;
}

export interface LineProgress {
  line: number;
  completed: number;
  total: number;
  state: "pending" | "running" | "done" | "error" | "stopped";
  message?: string;
}

export interface LineFailure {
  line: number;
  message: string;
  holderAddress?: string;
  holderKey?: string;
  tokenMoved?: boolean;
  blocksRetry?: boolean;
}

export interface RunResult {
  okLines: number[];
  failed: LineFailure[];
  stopped: boolean;
  nativeLeft: boolean;
}
