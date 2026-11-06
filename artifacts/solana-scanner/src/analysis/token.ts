import {
  ExtensionType,
  getExtensionTypes,
  unpackMint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  developerRatings,
  developerWallets,
  marketCapObservations,
  scannerLaunches,
  scannerTokens,
  securityAnalyses,
} from "../db/schema.js";
import { db } from "../db/index.js";
import { logger } from "../logger.js";
import { MONITORED_PROGRAMS } from "../constants.js";
import type {
  HeliusAsset,
  HeliusClient,
  ParsedInstruction,
  ParsedTransaction,
} from "../providers/helius.js";
import { getTokenMarketSnapshot, type TokenMarketSnapshot } from "../providers/dexscreener.js";
import type { LaunchEvent } from "../scanner/decoders.js";
import { decodeLaunches } from "../scanner/decoders.js";
import { analyzeDeveloperWallet, type DeveloperSummary } from "./wallet.js";
import { rateDeveloper, type DeveloperRating } from "./rating.js";

export interface LpStatus {
  status: "burned" | "partially_burned" | "unverified";
  lockStatus: "unverified";
  verified: boolean;
  evidence: string;
}

export interface TokenAnalysis {
  mint: string;
  name: string;
  symbol: string;
  metadataUri: string | null;
  creatorWallet: string | null;
  creatorBasis: string;
  creatorVerified: boolean;
  launchProgram: string;
  launchSignature: string;
  poolAddress: string | null;
  lpMint: string | null;
  developer: DeveloperSummary | null;
  decimals: number | null;
  supplyRaw: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  token2022Extensions: string[];
  top10HolderPct: number | null;
  top10HolderCoverageComplete: boolean;
  topTokenAccountPct: number | null;
  creatorAllocationPct: number | null;
  market: TokenMarketSnapshot | null;
  lpStatus: LpStatus;
  liquidityDropPct: number | null;
  riskFlags: string[];
  rating: DeveloperRating;
}

interface MintSecurity {
  decimals: number | null;
  supplyRaw: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  token2022Extensions: string[];
  verified: boolean;
}

interface HolderAnalysis {
  top10HolderPct: number | null;
  complete: boolean;
  topTokenAccountPct: number | null;
  accountCount: number;
  totalAccounts: number;
}

const HOLDER_ENUMERATION_LIMIT = 5_000;

function parseMetadata(asset: HeliusAsset | null, mint: string): {
  name: string;
  symbol: string;
  uri: string | null;
} {
  const metadata = asset?.content?.metadata;
  return {
    name: metadata?.name?.trim() || "",
    symbol: metadata?.symbol?.trim() || "",
    uri: metadata?.uri ?? asset?.content?.json_uri ?? null,
  };
}

async function inspectMint(helius: HeliusClient, mint: string): Promise<MintSecurity> {
  try {
    const [account, supply] = await Promise.all([
      helius.getAccountInfo(mint),
      helius.getTokenSupply(mint).catch(() => null),
    ]);
    if (!account) {
      return {
        decimals: supply?.decimals ?? null,
        supplyRaw: supply?.amount ?? null,
        mintAuthority: null,
        freezeAuthority: null,
        token2022Extensions: [],
        verified: false,
      };
    }

    const rawData = Array.isArray(account.data) ? account.data[0] : account.data;
    const programId = new PublicKey(account.owner);
    const unpacked = unpackMint(
      new PublicKey(mint),
      {
        executable: account.executable,
        owner: programId,
        lamports: account.lamports,
        data: Buffer.from(rawData, "base64"),
        rentEpoch: account.rentEpoch ?? 0,
      },
      programId,
    );
    const extensionTypes = getExtensionTypes(unpacked.tlvData);
    return {
      decimals: unpacked.decimals,
      supplyRaw: (supply?.amount ?? unpacked.supply.toString()).toString(),
      mintAuthority:
        unpacked.mintAuthority && !unpacked.mintAuthority.equals(PublicKey.default)
          ? unpacked.mintAuthority.toBase58()
          : null,
      freezeAuthority:
        unpacked.freezeAuthority && !unpacked.freezeAuthority.equals(PublicKey.default)
          ? unpacked.freezeAuthority.toBase58()
          : null,
      token2022Extensions: extensionTypes.map(
        (extension) => ExtensionType[extension] ?? `Extension(${extension})`,
      ),
      verified: true,
    };
  } catch (error) {
    logger.warn({ mint, err: error }, "Could not decode the mint account");
    return {
      decimals: null,
      supplyRaw: null,
      mintAuthority: null,
      freezeAuthority: null,
      token2022Extensions: [],
      verified: false,
    };
  }
}

async function inspectHolders(helius: HeliusClient, mint: string, supplyRaw: string | null): Promise<HolderAnalysis> {
  if (!supplyRaw) {
    return { top10HolderPct: null, complete: false, topTokenAccountPct: null, accountCount: 0, totalAccounts: 0 };
  }
  let supply: bigint;
  try {
    supply = BigInt(supplyRaw);
  } catch {
    return { top10HolderPct: null, complete: false, topTokenAccountPct: null, accountCount: 0, totalAccounts: 0 };
  }
  if (supply <= 0n) {
    return { top10HolderPct: null, complete: false, topTokenAccountPct: null, accountCount: 0, totalAccounts: 0 };
  }

  let holderResult: Awaited<ReturnType<HeliusClient["getTokenAccountsByMint"]>>;
  try {
    holderResult = await helius.getTokenAccountsByMint(mint, HOLDER_ENUMERATION_LIMIT);
  } catch (error) {
    logger.warn({ mint, err: error }, "Complete holder enumeration was unavailable; using largest token accounts only");
    const largest = await helius.getLargestTokenAccounts(mint).catch(() => []);
    const accountAmounts = largest.map((account) => BigInt(account.amount));
    const topTen = accountAmounts
      .slice(0, 10)
      .reduce((sum, amount) => sum + amount, 0n);
    return {
      top10HolderPct: null,
      complete: false,
      topTokenAccountPct: Number((topTen * 10_000n) / supply) / 100,
      accountCount: accountAmounts.length,
      totalAccounts: 0,
    };
  }
  const ownerAmounts = new Map<string, bigint>();
  let accountAmounts: bigint[] = [];
  for (const account of holderResult.accounts) {
    const amount = BigInt(account.amount);
    if (amount <= 0n) continue;
    accountAmounts.push(amount);
    ownerAmounts.set(account.owner, (ownerAmounts.get(account.owner) ?? 0n) + amount);
  }
  accountAmounts = accountAmounts.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const topTenAccounts = accountAmounts.slice(0, 10).reduce((sum, amount) => sum + amount, 0n);
  const topTokenAccountPct = Number((topTenAccounts * 10_000n) / supply) / 100;

  const topOwners = [...ownerAmounts.values()]
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, 10)
    .reduce((sum, amount) => sum + amount, 0n);
  const complete = holderResult.complete;
  return {
    top10HolderPct: complete ? Number((topOwners * 10_000n) / supply) / 100 : null,
    complete,
    topTokenAccountPct,
    accountCount: holderResult.accounts.length,
    totalAccounts: holderResult.total,
  };
}

async function inspectCreatorAllocation(
  helius: HeliusClient,
  creatorWallet: string | null,
  mint: string,
  supplyRaw: string | null,
): Promise<number | null> {
  if (!creatorWallet || !supplyRaw) return null;
  const supply = BigInt(supplyRaw);
  if (supply <= 0n) return null;
  try {
    const accounts = await helius.getTokenAccountsByOwner(creatorWallet, mint);
    const owned = accounts.reduce((sum, account) => {
      const amount = account.account.data.parsed?.info?.tokenAmount?.amount;
      return sum + (amount ? BigInt(amount) : 0n);
    }, 0n);
    return Number((owned * 10_000n) / supply) / 100;
  } catch (error) {
    logger.warn({ mint, creatorWallet, err: error }, "Could not calculate creator token allocation");
    return null;
  }
}

function instructionsOf(tx: ParsedTransaction): ParsedInstruction[] {
  return [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions),
  ];
}

function parsedMintAmount(ix: ParsedInstruction, mint: string, types: Set<string>): bigint {
  const info = ix.parsed?.info;
  if (!info || !types.has(ix.parsed?.type ?? "") || info.mint !== mint) return 0n;
  const amount = info.amount;
  if (typeof amount !== "string" && typeof amount !== "number") return 0n;
  try {
    return BigInt(amount);
  } catch {
    return 0n;
  }
}

async function inspectLpStatus(helius: HeliusClient, lpMint: string | null): Promise<LpStatus> {
  if (!lpMint) {
    return {
      status: "unverified",
      lockStatus: "unverified",
      verified: false,
      evidence: "No LP mint was identified for this token.",
    };
  }

  try {
    const supply = await helius.getTokenSupply(lpMint);
    if (!supply) {
      return {
        status: "unverified",
        lockStatus: "unverified",
        verified: false,
        evidence: "The LP mint supply could not be read.",
      };
    }
    const signatures = await helius.getSignatures(lpMint, 100);
    const historyComplete = signatures.length < 100;
    let minted = 0n;
    let burned = 0n;
    for (const signature of signatures) {
      const transaction = await helius.getParsedTransaction(signature.signature);
      if (!transaction) continue;
      for (const ix of instructionsOf(transaction)) {
        minted += parsedMintAmount(ix, lpMint, new Set(["mintTo", "mintToChecked"]));
        burned += parsedMintAmount(ix, lpMint, new Set(["burn", "burnChecked"]));
      }
    }
    const current = BigInt(supply.amount);
    if (historyComplete && minted > 0n && burned > 0n && minted - burned === current) {
      if (current === 0n) {
        return {
          status: "burned",
          lockStatus: "unverified",
          verified: true,
          evidence: "The complete indexed LP-mint history contains matching mint and burn amounts, and current supply is zero.",
        };
      }
      return {
        status: "partially_burned",
        lockStatus: "unverified",
        verified: true,
        evidence: `On-chain LP mint/burn history verified; ${supply.uiAmountString} LP token units remain in supply.`,
      };
    }
    return {
      status: "unverified",
      lockStatus: "unverified",
      verified: false,
      evidence: `Current LP supply is ${supply.uiAmountString}; the available history does not prove a full burn or lock.`,
    };
  } catch (error) {
    logger.warn({ lpMint, err: error }, "Could not verify LP supply and history");
    return {
      status: "unverified",
      lockStatus: "unverified",
      verified: false,
      evidence: "LP supply or transaction history could not be verified from Helius.",
    };
  }
}

async function resolveTokenCreator(
  mint: string,
  helius: HeliusClient,
): Promise<{ wallet: string | null; basis: string; verified: boolean }> {
  try {
    const signatures = await helius.getSignatures(mint, 100);
    for (const signature of [...signatures].reverse()) {
      const tx = await helius.getParsedTransaction(signature.signature);
      if (!tx) continue;
      const launch = decodeLaunches(tx).find(
        (event) => event.mint === mint && event.launchType === "token" && event.creatorVerified,
      );
      if (launch?.creatorWallet) {
        return {
          wallet: launch.creatorWallet,
          basis: launch.creatorBasis,
          verified: true,
        };
      }
    }
  } catch (error) {
    logger.warn({ mint, err: error }, "Could not resolve a token creator from mint history");
  }
  return {
    wallet: null,
    basis: "Token creator could not be verified from available launch instructions.",
    verified: false,
  };
}

function flagsFor(
  mintSecurity: MintSecurity,
  holders: HolderAnalysis,
  creatorAllocationPct: number | null,
  lpStatus: LpStatus,
  liquidityDropPct: number | null,
): string[] {
  const flags: string[] = [];
  if (!mintSecurity.verified) flags.push("Mint security data is incomplete.");
  if (mintSecurity.mintAuthority) flags.push("Mint authority is active.");
  if (mintSecurity.freezeAuthority) flags.push("Freeze authority is active.");
  if (mintSecurity.token2022Extensions.length > 0) {
    flags.push(`Token-2022 extensions detected: ${mintSecurity.token2022Extensions.join(", ")}.`);
  }
  if (holders.top10HolderPct !== null && holders.top10HolderPct >= 60) {
    flags.push(`Measured top-10 holder concentration is ${holders.top10HolderPct.toFixed(1)}%.`);
  }
  if (!holders.complete) {
    flags.push(
      `Holder enumeration is partial (${holders.accountCount} of ${holders.totalAccounts || "unknown"} token accounts).`,
    );
  }
  if (creatorAllocationPct !== null && creatorAllocationPct >= 25) {
    flags.push(`Creator wallet holds ${creatorAllocationPct.toFixed(1)}% of supply.`);
  }
  if (liquidityDropPct !== null && liquidityDropPct >= 50) {
    flags.push(`Observed liquidity dropped ${liquidityDropPct.toFixed(1)}% from a recent stored sample.`);
  }
  if (lpStatus.status === "unverified") {
    flags.push("LP locked/burned state is unverified.");
  }
  return flags;
}

export async function analyzeToken(
  mint: string,
  event: LaunchEvent | null,
  signature: string,
  slot: number | null,
  blockTime: number | null,
  helius: HeliusClient,
  forceRefresh = false,
): Promise<TokenAnalysis> {
  new PublicKey(mint);
  const [existing] = await db
    .select()
    .from(scannerTokens)
    .where(eq(scannerTokens.mint, mint))
    .limit(1);

  if (event) {
    await db
      .insert(scannerLaunches)
      .values({
        signature,
        mint,
        creatorWallet: event.creatorVerified ? event.creatorWallet : null,
        creatorBasis: event.creatorBasis,
        creatorVerified: event.creatorVerified,
        programId: event.programId,
        programName: event.programName,
        launchType: event.launchType,
        poolAddress: event.poolAddress,
        lpMint: event.lpMint,
        slot: slot === null ? null : String(slot),
        blockTime: blockTime === null ? null : new Date(blockTime * 1000),
      })
      .onConflictDoNothing();
  }

  let creatorWallet = existing?.creatorWallet ?? null;
  let creatorBasis = existing?.creatorBasis ?? "Creator not verified";
  let creatorVerified = Boolean(existing?.creatorWallet && existing.creatorBasis && !existing.creatorBasis.includes("unverified"));
  if (event?.creatorVerified && event.creatorWallet) {
    creatorWallet = event.creatorWallet;
    creatorBasis = event.creatorBasis;
    creatorVerified = true;
  } else if (!creatorVerified && !existing && (!event || event.launchType === "pool")) {
    const resolved = await resolveTokenCreator(mint, helius);
    creatorWallet = resolved.wallet;
    creatorBasis = resolved.basis;
    creatorVerified = resolved.verified;
  }

  const launchProgram = event?.programName ?? existing?.launchProgram ?? "Unknown";
  const launchSignature = event?.launchType === "token"
    ? signature
    : existing?.launchSignature ?? signature;
  const poolAddress = event?.poolAddress ?? existing?.poolAddress ?? null;
  const lpMint = event?.lpMint ?? existing?.lpMint ?? null;

  const [asset, mintSecurity, market] = await Promise.all([
    helius.getAsset(mint),
    inspectMint(helius, mint),
    getTokenMarketSnapshot(mint).catch((error) => {
      logger.warn({ mint, err: error }, "Market data was temporarily unavailable");
      return null;
    }),
  ]);
  const metadata = parseMetadata(asset, mint);
  const holders = await inspectHolders(helius, mint, mintSecurity.supplyRaw);
  const creatorAllocationPct = await inspectCreatorAllocation(
    helius,
    creatorVerified ? creatorWallet : null,
    mint,
    mintSecurity.supplyRaw,
  );

  const previousObservations = await db
    .select({ liquidityUsd: marketCapObservations.liquidityUsd, observedAt: marketCapObservations.observedAt })
    .from(marketCapObservations)
    .where(
      and(
        eq(marketCapObservations.mint, mint),
        gte(marketCapObservations.observedAt, new Date(Date.now() - 30 * 60 * 1000)),
      ),
    )
    .orderBy(desc(marketCapObservations.observedAt))
    .limit(1);
  const previousLiquidity = previousObservations[0]?.liquidityUsd;
  const liquidityDropPct =
    previousLiquidity !== null &&
    previousLiquidity !== undefined &&
    previousLiquidity > 0 &&
    market?.liquidityUsd !== null &&
    market?.liquidityUsd !== undefined &&
    market.liquidityUsd < previousLiquidity
      ? ((previousLiquidity - market.liquidityUsd) / previousLiquidity) * 100
      : null;

  if (market) {
    await db.insert(marketCapObservations).values({
      mint,
      marketCapUsd: market.marketCapUsd,
      priceUsd: market.priceUsd,
      liquidityUsd: market.liquidityUsd,
      pairAddress: market.pairAddress,
      source: "DexScreener current snapshot",
    });
  }

  const lpStatus = await inspectLpStatus(helius, lpMint);
  const riskFlags = flagsFor(mintSecurity, holders, creatorAllocationPct, lpStatus, liquidityDropPct);
  const developer = creatorWallet && creatorVerified
    ? await analyzeDeveloperWallet(creatorWallet, helius, forceRefresh)
    : null;

  let previousRiskSignalCount = 0;
  if (creatorWallet && creatorVerified) {
    const priorLaunches = await db
      .select({ mint: scannerLaunches.mint })
      .from(scannerLaunches)
      .where(
        and(
          eq(scannerLaunches.creatorWallet, creatorWallet),
          eq(scannerLaunches.creatorVerified, true),
          eq(scannerLaunches.launchType, "token"),
        ),
      );
    const priorMints = [...new Set(priorLaunches.map((row) => row.mint).filter((value) => value !== mint))];
    if (priorMints.length > 0) {
      const priorRisks = await db
        .select({ flags: scannerTokens.riskFlags })
        .from(scannerTokens)
        .where(inArray(scannerTokens.mint, priorMints));
      previousRiskSignalCount = priorRisks.filter((row) =>
        row.flags.some(
          (flag) =>
            flag.includes("Mint authority is active") ||
            flag.includes("Freeze authority is active") ||
            flag.includes("top-10 holder concentration is") ||
            flag.includes("Creator wallet holds") ||
            flag.includes("Observed liquidity dropped"),
        ),
      ).length;
    }
  }

  const rating = rateDeveloper({
    developer,
    creatorVerified,
    mintDataVerified: mintSecurity.verified,
    mintAuthority: mintSecurity.mintAuthority,
    freezeAuthority: mintSecurity.freezeAuthority,
    token2022Extensions: mintSecurity.token2022Extensions,
    top10HolderPct: holders.top10HolderPct,
    creatorAllocationPct,
    liquidityDropPct,
    previousRiskSignalCount,
    holderCoverageComplete: holders.complete,
  });
  const name = event?.name || metadata.name || existing?.name || "";
  const symbol = event?.symbol || metadata.symbol || existing?.symbol || "";

  await db
    .insert(scannerTokens)
    .values({
      mint,
      name,
      symbol,
      metadataUri: event?.metadataUri ?? metadata.uri,
      creatorWallet: creatorVerified ? creatorWallet : null,
      creatorBasis,
      launchProgram,
      launchSignature,
      poolAddress,
      lpMint,
      launchedAt: blockTime === null ? existing?.launchedAt ?? null : new Date(blockTime * 1000),
      decimals: mintSecurity.decimals,
      supplyRaw: mintSecurity.supplyRaw,
      mintAuthority: mintSecurity.mintAuthority,
      freezeAuthority: mintSecurity.freezeAuthority,
      token2022Extensions: mintSecurity.token2022Extensions,
      developerSolBalance: developer?.solBalance ?? null,
      creatorAllocationPct,
      top10HolderPct: holders.top10HolderPct,
      currentPriceUsd: market?.priceUsd ?? null,
      currentMarketCapUsd: market?.marketCapUsd ?? null,
      currentLiquidityUsd: market?.liquidityUsd ?? null,
      lpStatus: lpStatus.status,
      liquidityDropPct,
      riskFlags,
      analysisUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: scannerTokens.mint,
      set: {
        name,
        symbol,
        metadataUri: event?.metadataUri ?? metadata.uri,
        creatorWallet: creatorVerified ? creatorWallet : existing?.creatorWallet ?? null,
        creatorBasis,
        launchProgram,
        launchSignature,
        poolAddress,
        lpMint,
        launchedAt: blockTime === null ? existing?.launchedAt ?? null : new Date(blockTime * 1000),
        decimals: mintSecurity.decimals,
        supplyRaw: mintSecurity.supplyRaw,
        mintAuthority: mintSecurity.mintAuthority,
        freezeAuthority: mintSecurity.freezeAuthority,
        token2022Extensions: mintSecurity.token2022Extensions,
        developerSolBalance: developer?.solBalance ?? null,
        creatorAllocationPct,
        top10HolderPct: holders.top10HolderPct,
        currentPriceUsd: market?.priceUsd ?? null,
        currentMarketCapUsd: market?.marketCapUsd ?? null,
        currentLiquidityUsd: market?.liquidityUsd ?? null,
        lpStatus: lpStatus.status,
        liquidityDropPct,
        riskFlags,
        analysisUpdatedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  await db.insert(securityAnalyses).values({
    mint,
    mintAuthority: mintSecurity.mintAuthority,
    freezeAuthority: mintSecurity.freezeAuthority,
    token2022Extensions: mintSecurity.token2022Extensions,
    lpStatus: lpStatus.status,
    top10HolderPct: holders.top10HolderPct,
    creatorAllocationPct,
    liquidityDropPct,
    flags: riskFlags,
    evidence: {
      mintAccountDecoded: mintSecurity.verified,
      holderEnumerationComplete: holders.complete,
      holderAccountsObserved: holders.accountCount,
      holderAccountsTotal: holders.totalAccounts,
      topTokenAccountConcentrationPct: holders.topTokenAccountPct,
      lp: lpStatus,
      creatorBasis,
      creatorVerified,
      observedAt: new Date().toISOString(),
    },
  });
  if (developer) {
    await db.insert(developerRatings).values({
      wallet: developer.wallet,
      mint,
      score: rating.score,
      confidence: rating.confidence,
      reasons: rating.reasons,
    });
    await db
      .update(developerWallets)
      .set({
        rating: rating.score,
        ratingConfidence: rating.confidence,
        ratingReasons: rating.reasons,
      })
      .where(eq(developerWallets.wallet, developer.wallet));
  }

  return {
    mint,
    name,
    symbol,
    metadataUri: event?.metadataUri ?? metadata.uri,
    creatorWallet: creatorVerified ? creatorWallet : null,
    creatorBasis,
    creatorVerified,
    launchProgram,
    launchSignature,
    poolAddress,
    lpMint,
    developer,
    decimals: mintSecurity.decimals,
    supplyRaw: mintSecurity.supplyRaw,
    mintAuthority: mintSecurity.mintAuthority,
    freezeAuthority: mintSecurity.freezeAuthority,
    token2022Extensions: mintSecurity.token2022Extensions,
    top10HolderPct: holders.top10HolderPct,
    top10HolderCoverageComplete: holders.complete,
    topTokenAccountPct: holders.topTokenAccountPct,
    creatorAllocationPct,
    market,
    lpStatus,
    liquidityDropPct,
    riskFlags,
    rating,
  };
}

export async function refreshTrackedToken(mint: string, helius: HeliusClient): Promise<TokenAnalysis> {
  const [token] = await Promise.all([
    db.select().from(scannerTokens).where(eq(scannerTokens.mint, mint)).limit(1),
  ]);
  if (!token[0]) throw new Error(`Token ${mint} is not in the scanner database.`);
  const record = token[0];
  return analyzeToken(
    mint,
    null,
    record.launchSignature,
    null,
    record.launchedAt ? Math.floor(record.launchedAt.getTime() / 1000) : null,
    helius,
    true,
  );
}

export async function verifiedPeakForDeveloper(wallet: string): Promise<number | null> {
  const launches = await db
    .select({ mint: scannerLaunches.mint })
    .from(scannerLaunches)
    .where(
      and(
        eq(scannerLaunches.creatorWallet, wallet),
        eq(scannerLaunches.creatorVerified, true),
        eq(scannerLaunches.launchType, "token"),
      ),
    );
  const mints = [...new Set(launches.map((launch) => launch.mint))];
  if (!mints.length) return null;
  const peaks = await db
    .select({ peak: sql<number | null>`max(${marketCapObservations.marketCapUsd})` })
    .from(marketCapObservations)
    .where(inArray(marketCapObservations.mint, mints));
  const values = peaks.map((row) => row.peak).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

