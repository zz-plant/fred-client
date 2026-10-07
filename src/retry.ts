export interface RetryOptions {
  attempts?: number | undefined;
  /** Base backoff; attempt n sleeps `backoffMs * n`. */
  backoffMs?: number | undefined;
  /** Ceiling for all attempts combined, including backoff. */
  budgetMs?: number | undefined;
  isRetryable?: ((error: unknown) => boolean) | undefined;
  now?: (() => number) | undefined;
}

export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_BACKOFF_MS = 500;
/**
 * Wall-clock ceiling for every attempt of one request combined. Retrying does not
 * get free time on top of whatever deadline governs the caller: an attempt that
 * begins after that deadline has fired holds resources to produce a value no one
 * can still read. Bounding the whole sequence keeps the retry budget inside it.
 */
export const DEFAULT_RETRY_BUDGET_MS = 9_000;

const pause = (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs));

/**
 * Runs `fn` with bounded retries, handing it the time still left in the budget so
 * the work it starts cannot outlive the sequence it belongs to.
 */
export const withRetry = async <T>(fn: (remainingMs: number) => Promise<T>, options: RetryOptions = {}): Promise<T> => {
  const attempts = options.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const budgetMs = options.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const isRetryable = options.isRetryable ?? (() => true);
  const now = options.now ?? Date.now;

  const startedAt = now();
  const elapsed = () => now() - startedAt;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = budgetMs - elapsed();
    if (remainingMs <= 0) break;

    try {
      return await fn(remainingMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryable(error)) break;

      // Only sleep when the budget can still fund an attempt afterwards;
      // otherwise the backoff is pure delay in front of a guaranteed failure.
      const backoff = backoffMs * (attempt + 1);
      if (elapsed() + backoff >= budgetMs) break;
      await pause(backoff);
    }
  }

  throw lastError ?? new Error("request failed before any attempt was made");
};
