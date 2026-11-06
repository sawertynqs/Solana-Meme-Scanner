import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { processedSignatures, scannerTokens, sentAlerts } from "../db/schema.js";
import type { ScannerConfig } from "../config.js";
import { MONITORED_PROGRAMS } from "../constants.js";
import { logger } from "../logger.js";
import { HeliusClient } from "../providers/helius.js";
import type { StreamSignature } from "./monitor.js";
import { SolanaLogMonitor } from "./monitor.js";
import { decodeLaunches } from "./decoders.js";
import { analyzeToken, refreshTrackedToken } from "../analysis/token.js";
import { MarketPoller } from "./market-poller.js";
import type { TelegramNotifier, ScannerStatus } from "../notifications/telegram.js";
import { withRetry } from "../lib/retry.js";

interface QueuedSignature extends StreamSignature {
  live: boolean;
}

export class ScannerService {
  private readonly helius: HeliusClient;
  private readonly monitor: SolanaLogMonitor;
  private readonly marketPoller = new MarketPoller();
  private readonly queue: QueuedSignature[] = [];
  private readonly queuedSignatures = new Set<string>();
  private activeWorkers = 0;
  private readonly maxWorkers = 2;
  private processedTransactions = 0;
  private lastEventAt: Date | null = null;
  private readonly startedAt = new Date();
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backfillStarted = false;

  constructor(
    private readonly config: ScannerConfig,
    private readonly notifier: TelegramNotifier,
  ) {
    this.helius = new HeliusClient(config.heliusApiKey);
    this.monitor = new SolanaLogMonitor(this.helius.websocketUrl, (event) => {
      this.lastEventAt = new Date();
      this.enqueue({ ...event, live: true });
    });
  }

  getStatus(): ScannerStatus {
    return {
      startedAt: this.startedAt,
      websocketConnected: this.monitor.isConnected,
      processedTransactions: this.processedTransactions,
      lastEventAt: this.lastEventAt,
    };
  }

  async start(): Promise<void> {
    await db.execute("select 1");
    this.monitor.start();
    this.pollTimer = setInterval(() => {
      void this.marketPoller.poll(this.config.maxTrackedTokensPerPoll);
    }, this.config.marketPollIntervalMs);
    this.pollTimer.unref();
    this.retryTimer = setInterval(() => {
      void this.retryFailedAlerts();
    }, 30_000);
    this.retryTimer.unref();

    void this.marketPoller.poll(this.config.maxTrackedTokensPerPoll);
    setTimeout(() => {
      void this.backfillRecentSignatures();
    }, 2_000).unref();

    logger.info(
      {
        programCount: MONITORED_PROGRAMS.length,
        minDeveloperSol: this.config.minDeveloperSol,
        marketPollIntervalMs: this.config.marketPollIntervalMs,
      },
      "Solana scanner worker started",
    );
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.monitor.stop();
    await db.execute("select 1").catch(() => undefined);
  }

  private enqueue(event: QueuedSignature): void {
    if (this.queuedSignatures.has(event.signature)) return;
    this.queuedSignatures.add(event.signature);
    this.queue.push(event);
    this.drain();
  }

  private drain(): void {
    while (this.activeWorkers < this.maxWorkers && this.queue.length > 0) {
      const event = this.queue.shift();
      if (!event) return;
      this.activeWorkers += 1;
      void this.processSignature(event)
        .catch((error) => {
          logger.error(
            { signature: event.signature, programId: event.programId, err: error },
            "Transaction processing failed",
          );
        })
        .finally(() => {
          this.activeWorkers -= 1;
          this.queuedSignatures.delete(event.signature);
          this.drain();
        });
    }
  }

  private async processSignature(event: QueuedSignature): Promise<void> {
    const [alreadyProcessed] = await db
      .select({ signature: processedSignatures.signature })
      .from(processedSignatures)
      .where(eq(processedSignatures.signature, event.signature))
      .limit(1);
    if (alreadyProcessed) return;

    const transaction = await withRetry(
      () => this.helius.getParsedTransaction(event.signature),
      { operation: "Helius getTransaction", attempts: 4, timeoutMs: 20_000 },
    );
    if (!transaction) throw new Error("Helius returned no transaction data yet.");

    const launches = decodeLaunches(transaction);
    for (const launch of launches) {
      const [existingToken] = await db
        .select({ mint: scannerTokens.mint })
        .from(scannerTokens)
        .where(eq(scannerTokens.mint, launch.mint))
        .limit(1);
      const analysis = await analyzeToken(
        launch.mint,
        launch,
        event.signature,
        event.slot,
        transaction.blockTime,
        this.helius,
      );

      const eventIsRecent =
        transaction.blockTime !== null &&
        Date.now() - transaction.blockTime * 1000 <= 5 * 60 * 1000;
      const eligibleForNewMintAlert =
        launch.launchType === "token" || !existingToken;
      if (
        eligibleForNewMintAlert &&
        (event.live || eventIsRecent) &&
        analysis.creatorVerified &&
        analysis.developer &&
        analysis.developer.solBalance > this.config.minDeveloperSol
      ) {
        await this.notifier.sendNewTokenAlert(analysis, event.signature);
      }
    }

    await db
      .insert(processedSignatures)
      .values({
        signature: event.signature,
        programId: event.programId,
        slot: String(event.slot),
      })
      .onConflictDoNothing();
    this.processedTransactions += 1;
  }

  private async backfillRecentSignatures(): Promise<void> {
    if (this.backfillStarted) return;
    this.backfillStarted = true;
    for (const program of MONITORED_PROGRAMS) {
      try {
        const signatures = await this.helius.getSignatures(program.id, 10);
        for (const signature of [...signatures].reverse()) {
          this.enqueue({
            signature: signature.signature,
            programId: program.id,
            slot: signature.slot,
            live: false,
          });
        }
      } catch (error) {
        logger.warn({ program: program.name, err: error }, "Recent signature backfill failed");
      }
    }
  }

  private async retryFailedAlerts(): Promise<void> {
    const retryRows = await db
      .select({ mint: sentAlerts.mint, signature: sentAlerts.signature })
      .from(sentAlerts)
      .where(eq(sentAlerts.status, "retry"))
      .limit(5);
    for (const row of retryRows) {
      try {
        const analysis = await refreshTrackedToken(row.mint, this.helius);
        if (analysis.developer?.solBalance && analysis.developer.solBalance > this.config.minDeveloperSol) {
          await this.notifier.sendNewTokenAlert(analysis, row.signature);
        }
      } catch (error) {
        logger.warn({ mint: row.mint, err: error }, "Could not retry a pending Telegram alert");
      }
    }
  }
}
