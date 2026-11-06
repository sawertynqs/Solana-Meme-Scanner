import { and, desc, eq, gte } from "drizzle-orm";
import { marketCapObservations, scannerTokens } from "../db/schema.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import { getTokenMarketSnapshot } from "../providers/dexscreener.js";

export class MarketPoller {
  private offset = 0;

  async poll(limit: number): Promise<void> {
    const tracked = await db
      .select({ mint: scannerTokens.mint, riskFlags: scannerTokens.riskFlags })
      .from(scannerTokens)
      .orderBy(desc(scannerTokens.firstSeenAt));
    if (!tracked.length) return;

    const start = this.offset % tracked.length;
    const batch = Array.from({ length: Math.min(limit, tracked.length) }, (_, index) => {
      return tracked[(start + index) % tracked.length]!;
    });
    this.offset = (start + batch.length) % tracked.length;

    for (const token of batch) {
      try {
        const market = await getTokenMarketSnapshot(token.mint);
        if (!market) continue;

        const recent = await db
          .select({ liquidityUsd: marketCapObservations.liquidityUsd })
          .from(marketCapObservations)
          .where(
            and(
              eq(marketCapObservations.mint, token.mint),
              gte(marketCapObservations.observedAt, new Date(Date.now() - 30 * 60 * 1000)),
            ),
          )
          .orderBy(desc(marketCapObservations.observedAt))
          .limit(1);
        const previousLiquidity = recent[0]?.liquidityUsd;
        const liquidityDropPct =
          previousLiquidity !== null &&
          previousLiquidity !== undefined &&
          previousLiquidity > 0 &&
          market.liquidityUsd !== null &&
          market.liquidityUsd < previousLiquidity
            ? ((previousLiquidity - market.liquidityUsd) / previousLiquidity) * 100
            : null;

        await db.insert(marketCapObservations).values({
          mint: token.mint,
          marketCapUsd: market.marketCapUsd,
          priceUsd: market.priceUsd,
          liquidityUsd: market.liquidityUsd,
          pairAddress: market.pairAddress,
          source: "DexScreener current snapshot",
        });

        const flags = token.riskFlags.filter(
          (flag) => !flag.startsWith("Observed liquidity dropped "),
        );
        if (liquidityDropPct !== null && liquidityDropPct >= 50) {
          flags.push(`Observed liquidity dropped ${liquidityDropPct.toFixed(1)}% from a recent stored sample.`);
        }
        await db
          .update(scannerTokens)
          .set({
            currentPriceUsd: market.priceUsd,
            currentMarketCapUsd: market.marketCapUsd,
            currentLiquidityUsd: market.liquidityUsd,
            liquidityDropPct,
            riskFlags: flags,
            updatedAt: new Date(),
          })
          .where(eq(scannerTokens.mint, token.mint));
      } catch (error) {
        logger.warn({ mint: token.mint, err: error }, "Market snapshot poll failed");
      }
    }
  }
}
