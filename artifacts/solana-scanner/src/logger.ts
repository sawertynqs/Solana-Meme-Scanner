import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "heliusApiKey",
      "botToken",
      "DATABASE_URL",
      "config.heliusApiKey",
      "config.botToken",
      "config.databaseUrl",
    ],
    censor: "[REDACTED]",
  },
  base: { service: "solana-scanner" },
});
