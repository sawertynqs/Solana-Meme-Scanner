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
  await bot.launch({ allowedUpdates: ["message", "callback_query"] });
  logger.info("Telegram command polling started");
  await service.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Stopping Solana scanner");
    bot.stop(signal);
    await service?.stop();
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? error.message : "Startup failed" },
    "Solana scanner did not start",
  );
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
