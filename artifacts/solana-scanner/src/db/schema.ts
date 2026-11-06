import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const scannerTokens = pgTable(
  "scanner_tokens",
  {
    mint: text("mint").primaryKey(),
    name: text("name").notNull().default(""),
    symbol: text("symbol").notNull().default(""),
    metadataUri: text("metadata_uri"),
    creatorWallet: text("creator_wallet"),
    creatorBasis: text("creator_basis"),
    launchProgram: text("launch_program").notNull(),
    launchSignature: text("launch_signature").notNull(),
    poolAddress: text("pool_address"),
    lpMint: text("lp_mint"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    launchedAt: timestamp("launched_at", { withTimezone: true }),
    decimals: integer("decimals"),
    supplyRaw: text("supply_raw"),
    mintAuthority: text("mint_authority"),
    freezeAuthority: text("freeze_authority"),
    token2022Extensions: jsonb("token_2022_extensions").$type<string[]>().notNull().default([]),
    developerSolBalance: doublePrecision("developer_sol_balance"),
    creatorAllocationPct: doublePrecision("creator_allocation_pct"),
    top10HolderPct: doublePrecision("top10_holder_pct"),
    currentPriceUsd: doublePrecision("current_price_usd"),
    currentMarketCapUsd: doublePrecision("current_market_cap_usd"),
    currentLiquidityUsd: doublePrecision("current_liquidity_usd"),
    lpStatus: text("lp_status").notNull().default("unverified"),
    liquidityDropPct: doublePrecision("liquidity_drop_pct"),
    riskFlags: jsonb("risk_flags").$type<string[]>().notNull().default([]),
    analysisUpdatedAt: timestamp("analysis_updated_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("scanner_tokens_creator_idx").on(table.creatorWallet),
    index("scanner_tokens_first_seen_idx").on(table.firstSeenAt),
  ],
);

export const developerWallets = pgTable(
  "scanner_developer_wallets",
  {
    wallet: text("wallet").primaryKey(),
    solBalance: doublePrecision("sol_balance"),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }),
    observedTransactions: integer("observed_transactions").notNull().default(0),
    historyComplete: boolean("history_complete").notNull().default(false),
    fundingSource: text("funding_source"),
    relatedWallets: jsonb("related_wallets").$type<string[]>().notNull().default([]),
    launchCount: integer("launch_count").notNull().default(0),
    verifiedSuccessfulLaunches: integer("verified_successful_launches").notNull().default(0),
    verifiedPeakMarketCapUsd: doublePrecision("verified_peak_market_cap_usd"),
    rating: integer("rating"),
    ratingConfidence: text("rating_confidence"),
    ratingReasons: jsonb("rating_reasons").$type<string[]>().notNull().default([]),
    suspiciousFlags: jsonb("suspicious_flags").$type<string[]>().notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("scanner_dev_rating_idx").on(table.rating)],
);

export const scannerLaunches = pgTable(
  "scanner_launches",
  {
    id: serial("id").primaryKey(),
    signature: text("signature").notNull(),
    mint: text("mint").notNull(),
    creatorWallet: text("creator_wallet"),
    creatorBasis: text("creator_basis"),
    programId: text("program_id").notNull(),
    programName: text("program_name").notNull(),
    launchType: text("launch_type").notNull(),
    poolAddress: text("pool_address"),
    lpMint: text("lp_mint"),
    slot: text("slot"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    historical: boolean("historical").notNull().default(false),
    creatorVerified: boolean("creator_verified").notNull().default(false),
    createdAt: now(),
  },
  (table) => [
    uniqueIndex("scanner_launch_signature_mint_uq").on(table.signature, table.mint),
    index("scanner_launch_creator_idx").on(table.creatorWallet),
    index("scanner_launch_mint_idx").on(table.mint),
  ],
);

export const marketCapObservations = pgTable(
  "scanner_market_cap_observations",
  {
    id: serial("id").primaryKey(),
    mint: text("mint").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    marketCapUsd: doublePrecision("market_cap_usd"),
    priceUsd: doublePrecision("price_usd"),
    liquidityUsd: doublePrecision("liquidity_usd"),
    pairAddress: text("pair_address"),
    source: text("source").notNull(),
  },
  (table) => [
    index("scanner_market_observations_mint_time_idx").on(table.mint, table.observedAt),
  ],
);

export const securityAnalyses = pgTable(
  "scanner_security_analyses",
  {
    id: serial("id").primaryKey(),
    mint: text("mint").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    mintAuthority: text("mint_authority"),
    freezeAuthority: text("freeze_authority"),
    token2022Extensions: jsonb("token_2022_extensions").$type<string[]>().notNull().default([]),
    lpStatus: text("lp_status").notNull().default("unverified"),
    top10HolderPct: doublePrecision("top10_holder_pct"),
    creatorAllocationPct: doublePrecision("creator_allocation_pct"),
    liquidityDropPct: doublePrecision("liquidity_drop_pct"),
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [index("scanner_security_mint_time_idx").on(table.mint, table.checkedAt)],
);

export const developerRatings = pgTable(
  "scanner_developer_ratings",
  {
    id: serial("id").primaryKey(),
    wallet: text("wallet").notNull(),
    mint: text("mint"),
    score: integer("score").notNull(),
    confidence: text("confidence").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    createdAt: now(),
  },
  (table) => [index("scanner_ratings_wallet_time_idx").on(table.wallet, table.createdAt)],
);

export const sentAlerts = pgTable(
  "scanner_sent_alerts",
  {
    id: serial("id").primaryKey(),
    mint: text("mint").notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: now(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("scanner_alert_mint_uq").on(table.mint),
    uniqueIndex("scanner_alert_signature_uq").on(table.signature),
  ],
);

export const processedSignatures = pgTable(
  "scanner_processed_signatures",
  {
    signature: text("signature").primaryKey(),
    programId: text("program_id").notNull(),
    slot: text("slot"),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("scanner_processed_time_idx").on(table.processedAt)],
);
