import { Markup, Telegraf } from "telegraf";
import { and, desc, eq, sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import type { ScannerConfig } from "../config.js";
import { db } from "../db/index.js";
import {
  developerWallets,
  scannerLaunches,
  scannerTokens,
  sentAlerts,
} from "../db/schema.js";
import type { HeliusClient } from "../providers/helius.js";
import { logger } from "../logger.js";
import { withRetry } from "../lib/retry.js";
import { analyzeDeveloperWallet } from "../analysis/wallet.js";
import { analyzeToken, refreshTrackedToken } from "../analysis/token.js";
import { formatDeveloperReport, formatTokenReport } from "./format.js";

export interface ScannerStatus {
  startedAt: Date;
  websocketConnected: boolean;
  processedTransactions: number;
  lastEventAt: Date | null;
}

export class TelegramNotifier {
  constructor(
    private readonly bot: Telegraf,
    private readonly config: ScannerConfig,
  ) {}

  async sendNewTokenAlert(
    analysis: Awaited<ReturnType<typeof analyzeToken>>,
    signature: string,
  ): Promise<boolean> {
    if (!analysis.creatorVerified || !analysis.developer) {
      logger.info({ mint: analysis.mint }, "Alert suppressed because creator identity is unverified");
      return false;
    }
    if (analysis.developer.solBalance <= this.config.minDeveloperSol) {
      logger.info(
        { mint: analysis.mint, developerSolBalance: analysis.developer.solBalance },
        "Alert suppressed by the strict developer SOL balance rule",
      );
      return false;
    }

    await db
      .insert(sentAlerts)
      .values({ mint: analysis.mint, signature, status: "pending" })
      .onConflictDoNothing();
    const [record] = await db
      .select()
      .from(sentAlerts)
      .where(eq(sentAlerts.mint, analysis.mint))
      .limit(1);
    if (!record || record.status === "sent") return false;

    try {
      await db
        .update(sentAlerts)
        .set({ attempts: record.attempts + 1, lastError: null })
        .where(eq(sentAlerts.id, record.id));
      await withRetry(
        () =>
          this.bot.telegram.sendMessage(
            this.config.chatId,
            formatTokenReport(analysis),
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...Markup.inlineKeyboard([
                [
                  Markup.button.url("Open in Axiom", `https://axiom.trade/meme/${analysis.mint}`),
                  Markup.button.url(
                    "Open DexScreener",
                    `https://dexscreener.com/solana/${analysis.mint}`,
                  ),
                ],
                [
                  Markup.button.url(
                    "Open Solscan",
                    `https://solscan.io/token/${analysis.mint}`,
                  ),
                ],
              ]),
            },
          ),
        { operation: "Telegram sendMessage", attempts: 3, timeoutMs: 15_000 },
      );
      await db
        .update(sentAlerts)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(sentAlerts.id, record.id));
      return true;
    } catch (error) {
      const safeMessage = error instanceof Error ? error.message.slice(0, 500) : "Telegram send failed.";
      await db
        .update(sentAlerts)
        .set({ status: "retry", lastError: safeMessage })
        .where(eq(sentAlerts.id, record.id));
      logger.error({ mint: analysis.mint, err: safeMessage }, "Telegram alert delivery failed");
      return false;
    }
  }
}

function cleanAddress(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new PublicKey(value).toBase58();
  } catch {
    return null;
  }
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not recorded";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function createTelegramBot(
  config: ScannerConfig,
  helius: HeliusClient,
  getStatus: () => ScannerStatus,
): { bot: Telegraf; notifier: TelegramNotifier } {
  const bot = new Telegraf(config.botToken);
  const notifier = new TelegramNotifier(bot, config);

  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id ?? "") !== config.chatId) return;
    await next();
  });

  bot.start(async (ctx) => {
    await ctx.reply(
      "Solana scanner is active for this chat. Use /status, /stats, /topdevs, /dev WALLET_ADDRESS, /check TOKEN_ADDRESS, or /settings.",
    );
  });

  bot.command("status", async (ctx) => {
    const status = getStatus();
    const uptimeSeconds = Math.max(0, Math.floor((Date.now() - status.startedAt.getTime()) / 1000));
    const last = status.lastEventAt ? status.lastEventAt.toISOString() : "none yet";
    await ctx.reply(
      [
        "<b>Scanner status</b>",
        `WebSocket: ${status.websocketConnected ? "connected" : "reconnecting"}`,
        `Uptime: ${uptimeSeconds}s`,
        `Processed transactions: ${status.processedTransactions}`,
        `Last stream event: ${last}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("topdevs", async (ctx) => {
    const rows = await db
      .select()
      .from(developerWallets)
      .where(sql`${developerWallets.rating} IS NOT NULL`)
      .orderBy(desc(developerWallets.rating))
      .limit(10);
    if (!rows.length) {
      await ctx.reply("No developer ratings have been recorded yet.");
      return;
    }
    const lines = rows.map((row, index) => {
      const score = row.rating === null ? "—" : String(row.rating);
      const success = row.verifiedSuccessfulLaunches;
      const confidence = row.ratingConfidence ?? "unknown";
      return `${index + 1}. ${row.wallet.slice(0, 6)}…${row.wallet.slice(-6)} — ${score}/100 (${confidence}), ${success} verified ≥$100k launch(es)`;
    });
    await ctx.reply(`<b>Highest recorded developer ratings</b>\n${lines.join("\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("dev", async (ctx) => {
    const raw = ctx.message.text.split(/\s+/)[1];
    const wallet = cleanAddress(raw);
    if (!wallet) {
      await ctx.reply("Usage: /dev WALLET_ADDRESS");
      return;
    }
    const summary = await analyzeDeveloperWallet(wallet, helius, true);
    const [record] = await db
      .select()
      .from(developerWallets)
      .where(eq(developerWallets.wallet, wallet))
      .limit(1);
    const reasons = record?.ratingReasons ?? [];
    await ctx.reply(
      formatDeveloperReport(
        summary,
        record?.rating ?? null,
        record?.ratingConfidence ?? null,
        reasons,
      ),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("check", async (ctx) => {
    const mint = cleanAddress(ctx.message.text.split(/\s+/)[1]);
    if (!mint) {
      await ctx.reply("Usage: /check TOKEN_ADDRESS");
      return;
    }
    const [known] = await db
      .select({ mint: scannerTokens.mint })
      .from(scannerTokens)
      .where(eq(scannerTokens.mint, mint))
      .limit(1);
    const analysis = known
      ? await refreshTrackedToken(mint, helius)
      : await analyzeToken(mint, null, `manual-check:${mint}`, null, null, helius, true);
    await ctx.reply(formatTokenReport(analysis), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...Markup.inlineKeyboard([
        [
          Markup.button.url("Open in Axiom", `https://axiom.trade/meme/${mint}`),
          Markup.button.url("Open DexScreener", `https://dexscreener.com/solana/${mint}`),
        ],
        [Markup.button.url("Open Solscan", `https://solscan.io/token/${mint}`)],
      ]),
    });
  });

  bot.command("settings", async (ctx) => {
    await ctx.reply(
      [
        "<b>Scanner settings</b>",
        `Minimum developer balance: strictly greater than ${config.minDeveloperSol} SOL.`,
        "Creator must be identified from a supported on-chain launch instruction for an automatic alert.",
        "Monitoring: Pump.fun, PumpSwap, Raydium CPMM, AMM v4, and LaunchLab.",
        "Market-cap history starts when this scanner first records observations; no external all-time-high claim is made.",
        "LP lock status remains unverified; a burn is reported only when complete on-chain mint/burn history proves it.",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("stats", async (ctx) => {
    const [tokens] = await db.select({ count: sql<number>`count(*)::int` }).from(scannerTokens);
    const [developers] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(developerWallets);
    const [alerts] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sentAlerts)
      .where(eq(sentAlerts.status, "sent"));
    const [launches] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(scannerLaunches);
    await ctx.reply(
      [
        "<b>Scanner statistics</b>",
        `Tracked tokens: ${tokens?.count ?? 0}`,
        `Developer wallets: ${developers?.count ?? 0}`,
        `Recorded launches/pools: ${launches?.count ?? 0}`,
        `Sent alerts: ${alerts?.count ?? 0}`,
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.catch((error) => {
    logger.error(
      { err: error instanceof Error ? error.message : "Telegram handler failed" },
      "Telegram update handler failed",
    );
  });

  return { bot, notifier };
}

