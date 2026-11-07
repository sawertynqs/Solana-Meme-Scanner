import { loadConfig } from "./config.js";
import { pool } from "./db/index.js";
import { logger } from "./logger.js";
import { HeliusClient } from "./providers/helius.js";
import { createTelegramBot } from "./notifications/telegram.js";
import { ScannerService } from "./scanner/service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const helius = new HeliusClient(config.heliusApiKey);
  let service: ScannerService | null = null;
  const { bot, notifier } = createTelegramBot(config, helius, () => {
    if (!service) {
      return {
        startedAt: new Date(),
        websocketConnected: false,
        processedTransactions: 0,
        lastEventAt: null,
      };
    }
    return service.getStatus();
  });
  service = new ScannerService(config, notifier);

  await pool.query("select 1");
  try {
    await bot.telegram.getChat(config.chatId);
    notifier.markRecipientReady();
    logger.info("Configured Telegram recipient is accessible");
  } catch {
    logger.warn(
      "Configured Telegram recipient is not accessible yet; send /start to the bot or add it to the target group.",
    );
  }
  let stopping = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Stopping Solana scanner");
    try {
      bot.stop(signal);
    } catch {
      // Telegram may fail before the polling loop is fully initialized.
    }
    await service?.stop();
    await pool.end();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  const polling = bot.launch({ allowedUpdates: ["message", "callback_query"] });
  void polling.catch((error: unknown) => {
    logger.fatal(
      { err: error instanceof Error ? error.name : "Unknown Telegram error" },
      "Telegram long polling stopped unexpectedly",
    );
    void shutdown("Telegram polling failed", 1);
  });
  logger.info("Telegram long-polling initialization requested");
  await service.start();
}

main().catch(async (error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.name : "Unknown startup error" },
    "Solana scanner did not start",
  );
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
