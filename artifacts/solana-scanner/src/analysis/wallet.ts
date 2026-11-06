import { and, eq, inArray, sql } from "drizzle-orm";
import { developerWallets, marketCapObservations, scannerLaunches } from "../db/schema.js";
import { db } from "../db/index.js";
import { LAMPORTS_PER_SOL } from "../constants.js";
import type { HeliusClient } from "../providers/helius.js";
import { getTokenMarketSnapshot } from "../providers/dexscreener.js";
import { logger } from "../logger.js";
import { decodeLaunches, directIncomingSolTransfer } from "../scanner/decoders.js";

export interface DeveloperSummary {
  wallet: string;
  solBalance: number;
  firstObservedAt: Date | null;
  observedTransactions: number;
  historyComplete: boolean;
  fundingSource: string | null;
  relatedWallets: string[];
  launchCount: number;
  verifiedSuccessfulLaunches: number;
  verifiedPeakMarketCapUsd: number | null;
  suspiciousFlags: string[];
}

const HISTORY_REFRESH_MS = 15 * 60 * 1000;
const WALLET_SIGNATURE_SAMPLE = 100;
const TRANSACTION_ANALYSIS_SAMPLE = 25;
const HISTORIC_MARKET_SAMPLE = 8;

export async function analyzeDeveloperWallet(
  wallet: string,
  helius: HeliusClient,
  forceRefresh = false,
): Promise<DeveloperSummary> {
  const [existing] = await db
    .select()
    .from(developerWallets)
    .where(eq(developerWallets.wallet, wallet))
    .limit(1);

  const recentlyRefreshed =
    existing && Date.now() - existing.updatedAt.getTime() < HISTORY_REFRESH_MS;

  let balanceLamports: number;
  let firstObservedAt = existing?.firstObservedAt ?? null;
  let observedTransactions = existing?.observedTransactions ?? 0;
  let historyComplete = existing?.historyComplete ?? false;
  let fundingSource = existing?.fundingSource ?? null;
  let relatedWallets = existing?.relatedWallets ?? [];
  let suspiciousFlags = existing?.suspiciousFlags ?? [];

  try {
    balanceLamports = await helius.getBalance(wallet);
  } catch (error) {
    if (existing?.solBalance === null || existing?.solBalance === undefined) throw error;
    logger.warn({ wallet, err: error }, "Using stored SOL balance after RPC failure");
    balanceLamports = existing.solBalance * LAMPORTS_PER_SOL;
  }
  const solBalance = balanceLamports / LAMPORTS_PER_SOL;

  if (!recentlyRefreshed || forceRefresh) {
    const signatures = await helius.getSignatures(wallet, WALLET_SIGNATURE_SAMPLE);
    observedTransactions = signatures.length;
    historyComplete = signatures.length < WALLET_SIGNATURE_SAMPLE;
    const oldestSignature = signatures.at(-1);
    firstObservedAt =
      oldestSignature?.blockTime !== null && oldestSignature?.blockTime !== undefined
        ? new Date(oldestSignature.blockTime * 1000)
        : null;
    fundingSource = null;
    relatedWallets = [];
    suspiciousFlags = [];

    const recentTxs = signatures.slice(0, TRANSACTION_ANALYSIS_SAMPLE);
    for (const signatureInfo of recentTxs) {
      const tx = await helius.getParsedTransaction(signatureInfo.signature);
      if (!tx) continue;
      const launches = decodeLaunches(tx).filter(
        (event) =>
          event.launchType === "token" &&
          event.creatorVerified &&
          event.creatorWallet === wallet,
      );
      for (const launch of launches) {
        await db
          .insert(scannerLaunches)
          .values({
            signature: signatureInfo.signature,
            mint: launch.mint,
            creatorWallet: wallet,
            creatorBasis: launch.creatorBasis,
            creatorVerified: true,
            programId: launch.programId,
            programName: launch.programName,
            launchType: launch.launchType,
            slot: String(signatureInfo.slot),
            blockTime: signatureInfo.blockTime
              ? new Date(signatureInfo.blockTime * 1000)
              : null,
            historical: true,
          })
          .onConflictDoNothing();
      }
    }

    // The first activity in this bounded sample is not necessarily the wallet's
    // first-ever funding. Only direct, parsed system transfers are reported.
    for (const signatureInfo of signatures.slice(-10).reverse()) {
      if (fundingSource) break;
      const tx = await helius.getParsedTransaction(signatureInfo.signature);
      if (tx) fundingSource = directIncomingSolTransfer(tx, wallet);
    }
    relatedWallets = fundingSource ? [fundingSource] : [];

    const launchRows = await db
      .select({ mint: scannerLaunches.mint })
      .from(scannerLaunches)
      .where(
        and(
          eq(scannerLaunches.creatorWallet, wallet),
          eq(scannerLaunches.launchType, "token"),
          eq(scannerLaunches.creatorVerified, true),
        ),
      );
    const uniqueMints = [...new Set(launchRows.map((row) => row.mint))];
    for (const mint of uniqueMints.slice(0, HISTORIC_MARKET_SAMPLE)) {
      try {
        const snapshot = await getTokenMarketSnapshot(mint);
        if (snapshot) {
          await db.insert(marketCapObservations).values({
            mint,
            marketCapUsd: snapshot.marketCapUsd,
            priceUsd: snapshot.priceUsd,
            liquidityUsd: snapshot.liquidityUsd,
            pairAddress: snapshot.pairAddress,
            source: "DexScreener current snapshot",
          });
        }
      } catch (error) {
        logger.warn({ wallet, mint, err: error }, "Could not sample an earlier launch");
      }
    }
  }

  const launchRows = await db
    .select({ mint: scannerLaunches.mint })
    .from(scannerLaunches)
    .where(
      and(
        eq(scannerLaunches.creatorWallet, wallet),
        eq(scannerLaunches.launchType, "token"),
        eq(scannerLaunches.creatorVerified, true),
      ),
    );
  const uniqueMints = [...new Set(launchRows.map((row) => row.mint))];
  let verifiedSuccessfulLaunches = 0;
  let verifiedPeakMarketCapUsd: number | null = null;

  if (uniqueMints.length > 0) {
    const peaks = await db
      .select({
        mint: marketCapObservations.mint,
        peak: sql<number | null>`max(${marketCapObservations.marketCapUsd})`,
      })
      .from(marketCapObservations)
      .where(inArray(marketCapObservations.mint, uniqueMints))
      .groupBy(marketCapObservations.mint);
    verifiedSuccessfulLaunches = peaks.filter(
      (row) => row.peak !== null && row.peak >= 100_000,
    ).length;
    const allPeaks = peaks
      .map((row) => row.peak)
      .filter((peak): peak is number => peak !== null);
    verifiedPeakMarketCapUsd = allPeaks.length ? Math.max(...allPeaks) : null;
  }

  if (observedTransactions >= TRANSACTION_ANALYSIS_SAMPLE) {
    suspiciousFlags.push(
      `Wallet history is sampled (${TRANSACTION_ANALYSIS_SAMPLE} of up to ${WALLET_SIGNATURE_SAMPLE} recent transactions analyzed).`,
    );
  }
  const launchCount = uniqueMints.length;

  await db
    .insert(developerWallets)
    .values({
      wallet,
      solBalance,
      firstObservedAt,
      observedTransactions,
      historyComplete,
      fundingSource,
      relatedWallets,
      launchCount,
      verifiedSuccessfulLaunches,
      verifiedPeakMarketCapUsd,
      suspiciousFlags,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: developerWallets.wallet,
      set: {
        solBalance,
        firstObservedAt,
        observedTransactions,
        historyComplete,
        fundingSource,
        relatedWallets,
        launchCount,
        verifiedSuccessfulLaunches,
        verifiedPeakMarketCapUsd,
        suspiciousFlags,
        updatedAt: new Date(),
      },
    });

  return {
    wallet,
    solBalance,
    firstObservedAt,
    observedTransactions,
    historyComplete,
    fundingSource,
    relatedWallets,
    launchCount,
    verifiedSuccessfulLaunches,
    verifiedPeakMarketCapUsd,
    suspiciousFlags,
  };
}
