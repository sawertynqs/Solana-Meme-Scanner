export interface ScannerConfig {
  heliusApiKey: string;
  botToken: string;
  chatId: string;
  databaseUrl: string;
  minDeveloperSol: number;
  rpcCommitment: "confirmed";
  marketPollIntervalMs: number;
  maxTrackedTokensPerPoll: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing.`);
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(): ScannerConfig {
  return {
    heliusApiKey: required("HELIUS_API_KEY"),
    botToken: required("BOT_TOKEN"),
    chatId: required("CHAT_ID"),
    databaseUrl: required("DATABASE_URL"),
    minDeveloperSol: 2,
    rpcCommitment: "confirmed",
    marketPollIntervalMs: positiveInteger("MARKET_POLL_INTERVAL_MS", 60_000),
    maxTrackedTokensPerPoll: positiveInteger("MAX_TRACKED_TOKENS_PER_POLL", 50),
  };
}
