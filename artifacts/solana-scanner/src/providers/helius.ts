import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { withRetry } from "../lib/retry.js";
import { logger } from "../logger.js";

export interface SolanaSignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export interface ParsedInstruction {
  programId?: string;
  program?: string;
  accounts?: string[];
  data?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
}

export interface ParsedTransaction {
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: Array<string | { pubkey: string; signer?: boolean }>;
      instructions: ParsedInstruction[];
    };
  };
  meta: {
    err: unknown;
    innerInstructions?: Array<{ index: number; instructions: ParsedInstruction[] }> | null;
    preTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { amount: string } }> | null;
    postTokenBalances?: Array<{ mint: string; owner?: string; uiTokenAmount: { amount: string } }> | null;
    preBalances?: number[];
    postBalances?: number[];
  } | null;
}

export interface RpcAccountInfo {
  owner: string;
  lamports: number;
  executable: boolean;
  rentEpoch?: number;
  data: [string, string] | string;
}

export interface RpcMintSupply {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

export interface LargestTokenAccount {
  address: string;
  amount: string;
  uiAmount: number | null;
  decimals: number;
}

export interface ParsedTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed?: {
        info?: {
          mint?: string;
          owner?: string;
          tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null };
        };
      };
    };
  };
}

export interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: string | number;
  delegated_amount?: string | number;
  frozen?: boolean;
  burnt?: boolean | string;
}

export interface DasTokenAccountsPage {
  total: number;
  cursor?: string;
  token_accounts: DasTokenAccount[];
}

export interface HeliusAsset {
  id?: string;
  content?: {
    metadata?: { name?: string; symbol?: string; uri?: string };
    json_uri?: string;
  };
  token_info?: {
    decimals?: number;
    supply?: number;
    mint_authority?: string | null;
    freeze_authority?: string | null;
    token_program?: string;
    extensions?: Array<{ extension?: string; [key: string]: unknown }>;
  };
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string; data?: unknown };
}

export class HeliusClient {
  readonly httpUrl: string;
  readonly websocketUrl: string;
  private requestId = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly apiKey: string) {
    const encoded = encodeURIComponent(apiKey);
    this.httpUrl = `https://mainnet.helius-rpc.com/?api-key=${encoded}`;
    this.websocketUrl = `wss://mainnet.helius-rpc.com/?api-key=${encoded}`;
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return withRetry(
      () => this.serializedRequest<T>(method, params),
      { operation: `Helius ${method}`, attempts: 5, timeoutMs: 15_000 },
    );
  }

  async getParsedTransaction(signature: string): Promise<ParsedTransaction | null> {
    return this.rpc<ParsedTransaction | null>("getTransaction", [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
  }

  async getSignatures(address: string, limit = 100): Promise<SolanaSignatureInfo[]> {
    return this.rpc<SolanaSignatureInfo[]>("getSignaturesForAddress", [
      new PublicKey(address).toBase58(),
      { limit, commitment: "confirmed" },
    ]);
  }

  async getBalance(address: string): Promise<number> {
    const result = await this.rpc<{ value: number }>("getBalance", [
      new PublicKey(address).toBase58(),
      { commitment: "confirmed" },
    ]);
    return result.value;
  }

  async getAccountInfo(address: string): Promise<RpcAccountInfo | null> {
    const result = await this.rpc<{ value: RpcAccountInfo | null }>("getAccountInfo", [
      new PublicKey(address).toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    return result.value;
  }

  async getTokenSupply(mint: string): Promise<RpcMintSupply | null> {
    const result = await this.rpc<{ value: RpcMintSupply | null }>("getTokenSupply", [
      new PublicKey(mint).toBase58(),
      { commitment: "confirmed" },
    ]);
    return result.value;
  }

  async getLargestTokenAccounts(mint: string): Promise<LargestTokenAccount[]> {
    const result = await this.rpc<{ value: LargestTokenAccount[] }>("getTokenLargestAccounts", [
      new PublicKey(mint).toBase58(),
      { commitment: "confirmed" },
    ]);
    return result.value;
  }

  async getTokenAccountsByOwner(wallet: string, mint: string): Promise<ParsedTokenAccount[]> {
    const result = await this.rpc<{ value: ParsedTokenAccount[] }>("getTokenAccountsByOwner", [
      new PublicKey(wallet).toBase58(),
      { mint: new PublicKey(mint).toBase58() },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    return result.value;
  }

  async getTokenAccountsByMint(
    mint: string,
    maxAccounts = 5_000,
  ): Promise<{ accounts: DasTokenAccount[]; total: number; complete: boolean }> {
    const accounts: DasTokenAccount[] = [];
    let cursor: string | undefined;
    let total = 0;
    const pageSize = 1_000;

    for (let page = 1; page <= Math.ceil(maxAccounts / pageSize); page += 1) {
      const params: Record<string, unknown> = {
        mint: new PublicKey(mint).toBase58(),
        page,
        limit: pageSize,
        options: { showZeroBalance: false },
      };
      if (cursor) params.cursor = cursor;
      const result = await this.rpc<DasTokenAccountsPage>("getTokenAccounts", [params]);
      total = result.total;
      accounts.push(...(result.token_accounts ?? []));
      if (accounts.length >= total || !result.cursor || result.cursor === cursor) {
        return { accounts: accounts.slice(0, maxAccounts), total, complete: accounts.length >= total };
      }
      cursor = result.cursor;
    }
    return { accounts: accounts.slice(0, maxAccounts), total, complete: accounts.length >= total };
  }

  async getAsset(mint: string): Promise<HeliusAsset | null> {
    try {
      return await this.rpc<HeliusAsset>("getAsset", [{ id: new PublicKey(mint).toBase58() }]);
    } catch (error) {
      logger.warn({ mint, err: error }, "Helius DAS getAsset was unavailable");
      return null;
    }
  }

  decodeBase58InstructionData(data: string): Buffer | null {
    try {
      return Buffer.from(bs58.decode(data));
    } catch {
      return null;
    }
  }

  private async serializedRequest<T>(method: string, params: unknown[]): Promise<T> {
    const request = this.queue.then(async () => {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.nextRequestAt = Date.now() + 100;

      const response = await fetch(this.httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.requestId,
          method,
          params,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Helius HTTP ${response.status} for ${method}.`);
      }

      const payload = (await response.json()) as RpcEnvelope<T>;
      if (payload.error) {
        throw new Error(
          `Helius ${method} error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "unknown error"}`,
        );
      }
      if (!("result" in payload)) {
        throw new Error(`Helius ${method} returned no result.`);
      }
      return payload.result as T;
    });
    this.queue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }
}
