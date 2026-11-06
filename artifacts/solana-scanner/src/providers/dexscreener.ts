import { withRetry } from "../lib/retry.js";

export interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number; base?: number; quote?: number };
  pairCreatedAt?: number;
  url?: string;
}

export interface TokenMarketSnapshot {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  pairAddress: string | null;
  dexId: string | null;
  pairCreatedAt: number | null;
  pairUrl: string | null;
}

export async function getTokenMarketSnapshot(mint: string): Promise<TokenMarketSnapshot | null> {
  return withRetry(
    async () => {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}.`);
      const body = (await response.json()) as { pairs?: DexPair[] | null };
      const pairs = (body.pairs ?? [])
        .filter((pair) => pair.chainId === "solana")
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const pair = pairs[0];
      if (!pair) return null;

      const price = Number(pair.priceUsd);
      return {
        priceUsd: Number.isFinite(price) && price > 0 ? price : null,
        // DexScreener's marketCap is used only when the provider supplies it.
        // FDV is intentionally not substituted for market capitalization.
        marketCapUsd:
          typeof pair.marketCap === "number" && Number.isFinite(pair.marketCap)
            ? pair.marketCap
            : null,
        liquidityUsd:
          typeof pair.liquidity?.usd === "number" && Number.isFinite(pair.liquidity.usd)
            ? pair.liquidity.usd
            : null,
        pairAddress: pair.pairAddress ?? null,
        dexId: pair.dexId ?? null,
        pairCreatedAt: pair.pairCreatedAt ?? null,
        pairUrl: pair.url ?? null,
      };
    },
    { operation: "DexScreener token market data", attempts: 3, timeoutMs: 12_000 },
  );
}
