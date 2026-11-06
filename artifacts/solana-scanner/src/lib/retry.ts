import { logger } from "../logger.js";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  operation: string;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!options.timeoutMs) return await operation();
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${options.operation} timed out after ${options.timeoutMs}ms`)),
            options.timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * Math.max(1, delay * 0.2));
      logger.warn(
        { operation: options.operation, attempt, retryInMs: delay + jitter, err: error },
        "External request failed; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.operation} failed after ${attempts} attempts.`);
}
