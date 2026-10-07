/**
 * A FRED client: the chart CSV export and the JSON API behind one interface.
 *
 * The CSV export (`fredgraph.csv`) needs no key and serves the current revision
 * of a series. The API needs a free key, allows 120 requests a minute, and can
 * return a series as it was known on a past date: an ALFRED vintage, via
 * `realtime_start`/`realtime_end`. Docs: https://fred.stlouisfed.org/docs/api/fred/
 *
 * With a key, reads go to the API and fall back to the CSV export on failure, so
 * a revoked key degrades to the path that needs none. A vintage request has no
 * fallback: the export cannot serve one, and returning today's revision in its
 * place would be a silent lie.
 */
import { fetchWithTimeout, type FetchLike } from "./fetchWithTimeout.js";
import { withRetry, type RetryOptions } from "./retry.js";

export { withRetry, type RetryOptions } from "./retry.js";
export { fetchWithTimeout, type FetchLike } from "./fetchWithTimeout.js";

export const FRED_CSV_BASE_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv";
export const FRED_API_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

const DEFAULT_USER_AGENT = "fred-client/0.1 (+https://www.npmjs.com/package/fred-client)";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 120_000;

export type FredRow = { date: string; value: number };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The key from the environment, or from a `FRED_API_KEY` global such as a Cloudflare
 * Worker binding installed on `globalThis`. The global wins. `null` when neither is set.
 */
export const resolveFredApiKey = (): string | null => {
  const fromGlobal: unknown = Reflect.get(globalThis, "FRED_API_KEY");
  if (typeof fromGlobal === "string" && fromGlobal.trim() !== "") return fromGlobal.trim();
  const fromEnv = typeof process !== "undefined" ? process.env?.FRED_API_KEY : undefined;
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : null;
};

/** A key must never travel in an error message or a log line. */
export const redactFredApiKey = (text: string): string => text.replace(/api_key=[^&\s"']+/g, "api_key=REDACTED");

const redactError = (error: unknown): unknown => {
  if (error instanceof Error) error.message = redactFredApiKey(error.message);
  return error;
};

/** Thrown when a caller asks for a vintage and only the CSV export is available. */
export class FredVintageUnavailableError extends Error {
  constructor(seriesId: string) {
    super(`FRED vintage data for ${seriesId} needs the FRED API (set FRED_API_KEY); the CSV export only serves the current revision`);
    this.name = "FredVintageUnavailableError";
  }
}

/** Thrown when FRED answers with a status we did not accept. Carries the status for the retry policy. */
export class FredResponseError extends Error {
  readonly status: number;
  constructor(seriesId: string, status: number) {
    super(`FRED request failed for ${seriesId} (HTTP ${status})`);
    this.name = "FredResponseError";
    this.status = status;
  }
}

/** Thrown without a request when the breaker is open. */
export class FredCircuitOpenError extends Error {
  constructor() {
    super("FRED circuit breaker open");
    this.name = "FredCircuitOpenError";
  }
}

/**
 * A retry is only worth its latency when the same request could plausibly answer
 * differently. Transport faults, timeouts, and server-side failures qualify; a
 * request FRED actively rejected (unknown series, malformed range, bad key) will be
 * rejected identically every time.
 */
export const isRetryableFredError = (error: unknown): boolean => {
  if (error instanceof FredResponseError) return error.status >= 500 || error.status === 408 || error.status === 429;
  if (error instanceof FredCircuitOpenError) return false;
  return true;
};

/**
 * Whether a raw FRED observation is a missing value.
 *
 * The API marks one with ".", and the CSV export used to as well, but the export
 * now leaves the field empty. `Number("")` is 0, a finite number that a parser
 * guarding only against "." accepts as a real print. That is how market holidays
 * became zero yields in a shipped archive. Route every value through this first.
 */
export const isMissingFredValue = (raw: string | undefined): boolean => {
  const trimmed = raw?.trim() ?? "";
  return trimmed === "" || trimmed === ".";
};

export const parseFredCsvRows = (csv: string): FredRow[] =>
  csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((row) => row.split(","))
    .flatMap((parts): FredRow[] => {
      const [date, raw] = parts;
      if (date === undefined || parts.length < 2 || isMissingFredValue(raw)) return [];
      const value = Number(raw);
      return Number.isFinite(value) ? [{ date, value }] : [];
    });

/** The API's JSON body, reduced to the same rows the CSV parser produces. */
export const parseFredApiObservations = (payload: unknown): FredRow[] => {
  if (!isRecord(payload)) throw new Error("FRED API returned no observations payload");
  const observations = payload.observations;
  if (!Array.isArray(observations)) {
    const message = payload.error_message;
    throw new Error(typeof message === "string" ? `FRED API error: ${redactFredApiKey(message)}` : "FRED API returned no observations array");
  }
  return observations.flatMap((entry): FredRow[] => {
    if (!isRecord(entry)) return [];
    const { date, value } = entry;
    if (typeof date !== "string" || typeof value !== "string" || isMissingFredValue(value)) return [];
    const parsed = Number(value);
    return Number.isFinite(parsed) ? [{ date, value: parsed }] : [];
  });
};

/** `anchor` is an ISO date to count back from; a vintage's window ends at its `asOf`, not today. */
export const observationStartForLookback = (lookbackDays: number, anchor?: string, now: () => number = Date.now): string => {
  const end = anchor ? new Date(`${anchor}T00:00:00.000Z`).getTime() : now();
  return new Date(end - lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

export const buildFredCsvUrl = (seriesId: string, observationStart?: string): string => {
  const base = `${FRED_CSV_BASE_URL}?id=${encodeURIComponent(seriesId)}`;
  return observationStart ? `${base}&cosd=${encodeURIComponent(observationStart)}` : base;
};

export const buildFredApiUrl = (
  seriesId: string,
  apiKey: string,
  options: { observationStart?: string | undefined; asOf?: string | undefined } = {},
): string => {
  const url = new URL(FRED_API_BASE_URL);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  if (options.observationStart) url.searchParams.set("observation_start", options.observationStart);
  if (options.asOf) {
    url.searchParams.set("realtime_start", options.asOf);
    url.searchParams.set("realtime_end", options.asOf);
  }
  return url.toString();
};

export interface RequestOptions extends Omit<RetryOptions, "isRetryable" | "now"> {
  /** Per-attempt timeout. Each attempt is also capped by what remains of the retry budget. */
  timeoutMs?: number | undefined;
  /** Only request observations from this many days back. Omit for full history (decades of daily rows). */
  lookbackDays?: number | undefined;
  /** ISO date: observations as known on that date. Needs the API; the CSV export cannot serve it. */
  asOf?: string | undefined;
  /** Overrides the client's key. `null` forces the CSV path. */
  apiKey?: string | null | undefined;
}

export interface FredClientOptions {
  fetch?: FetchLike | undefined;
  /** Default: `resolveFredApiKey()` at call time. `null` disables the API path. */
  apiKey?: string | null | undefined;
  userAgent?: string | undefined;
  timeoutMs?: number | undefined;
  retry?: Omit<RetryOptions, "isRetryable" | "now"> | undefined;
  breaker?: { threshold?: number | undefined; cooldownMs?: number | undefined } | undefined;
  /** Extra `fetch` init merged into every request, e.g. Next.js `{ next: { revalidate: 900 } }`. */
  requestInit?: RequestInit | undefined;
  /** Called when a keyed read fails and the CSV export is used instead. Default: `console.warn`. */
  onFallback?: ((seriesId: string, error: unknown) => void) | undefined;
  /** Clock, for tests of the breaker cooldown and retry budget. */
  now?: (() => number) | undefined;
}

export type BreakerState = {
  open: boolean;
  consecutiveFailures: number;
  lastFailureAt: string | null;
};

export interface FredClient {
  /** The raw CSV export. */
  fetchCsv(seriesId: string, options?: RequestOptions): Promise<string>;
  /** Rows from the API. Throws without a key. Failures count against the breaker. */
  fetchApiRows(seriesId: string, options?: RequestOptions): Promise<FredRow[]>;
  /** Rows from the API when a key is available, falling back to the CSV export; a vintage never falls back. */
  fetchRows(seriesId: string, options?: RequestOptions): Promise<FredRow[]>;
  breakerState(): BreakerState;
  resetBreaker(): void;
}

export const createFredClient = (config: FredClientOptions = {}): FredClient => {
  const fetcher: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
  const now = config.now ?? Date.now;
  const threshold = config.breaker?.threshold ?? DEFAULT_BREAKER_THRESHOLD;
  const cooldownMs = config.breaker?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  const onFallback =
    config.onFallback ??
    ((seriesId: string, error: unknown) => {
      console.warn(`[fred] API request failed for ${seriesId}; using the CSV export instead:`, error instanceof Error ? error.message : error);
    });

  let consecutiveFailures = 0;
  let lastFailureAt: number | null = null;

  const headers = (accept: string): Record<string, string> => ({ accept, "user-agent": userAgent });

  const resolveKey = (options?: RequestOptions): string | null => {
    if (options?.apiKey !== undefined) return options.apiKey;
    if (config.apiKey !== undefined) return config.apiKey;
    return resolveFredApiKey();
  };

  /**
   * One breaker and one retry budget for every request, whichever endpoint serves it:
   * the breaker is about FRED being reachable, not about which URL was asked.
   *
   * An attempt that has a fallback behind it must not count against the breaker. Six
   * series fetched concurrently against a revoked key would otherwise open it before
   * any of their CSV fallbacks ran, and the fallbacks would fail without a request.
   */
  const guarded = async <T>(attempt: (remainingMs: number) => Promise<T>, options: RequestOptions | undefined, recordFailure: boolean): Promise<T> => {
    if (consecutiveFailures >= threshold && lastFailureAt !== null && now() - lastFailureAt < cooldownMs) {
      throw new FredCircuitOpenError();
    }

    try {
      const result = await withRetry(attempt, {
        attempts: options?.attempts ?? config.retry?.attempts,
        backoffMs: options?.backoffMs ?? config.retry?.backoffMs,
        budgetMs: options?.budgetMs ?? config.retry?.budgetMs,
        isRetryable: isRetryableFredError,
        now,
      });
      consecutiveFailures = 0;
      lastFailureAt = null;
      return result;
    } catch (error) {
      if (recordFailure) {
        consecutiveFailures += 1;
        lastFailureAt = now();
      }
      throw error;
    }
  };

  const request = (url: string, accept: string, options: RequestOptions | undefined, remainingMs: number) =>
    fetchWithTimeout(
      fetcher,
      url,
      { ...config.requestInit, headers: { ...headers(accept) } },
      Math.min(options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS, remainingMs),
    );

  const fetchCsv: FredClient["fetchCsv"] = (seriesId, options) =>
    guarded(
      async (remainingMs) => {
        const start = options?.lookbackDays ? observationStartForLookback(options.lookbackDays, undefined, now) : undefined;
        const response = await request(buildFredCsvUrl(seriesId, start), "text/csv,application/csv;q=0.9,*/*;q=0.7", options, remainingMs);
        if (!response.ok) throw new FredResponseError(seriesId, response.status);
        return response.text();
      },
      options,
      true,
    );

  const apiRows = async (seriesId: string, apiKey: string, options: RequestOptions | undefined, recordFailure: boolean): Promise<FredRow[]> => {
    try {
      return await guarded(
        async (remainingMs) => {
          const url = buildFredApiUrl(seriesId, apiKey, {
            // A vintage's window counts back from its own date, not from today.
            observationStart: options?.lookbackDays ? observationStartForLookback(options.lookbackDays, options.asOf, now) : undefined,
            asOf: options?.asOf,
          });
          const response = await request(url, "application/json", options, remainingMs);
          if (!response.ok) throw new FredResponseError(seriesId, response.status);
          return parseFredApiObservations(await response.json());
        },
        options,
        recordFailure,
      );
    } catch (error) {
      throw redactError(error);
    }
  };

  const fetchApiRows: FredClient["fetchApiRows"] = (seriesId, options) => {
    const apiKey = resolveKey(options);
    if (!apiKey) return Promise.reject(new FredVintageUnavailableError(seriesId));
    return apiRows(seriesId, apiKey, options, true);
  };

  const fetchRows: FredClient["fetchRows"] = async (seriesId, options) => {
    const apiKey = resolveKey(options);
    if (options?.asOf && !apiKey) throw new FredVintageUnavailableError(seriesId);

    if (apiKey) {
      // With a CSV fallback behind it, an API failure is not yet a FRED failure.
      const hasFallback = !options?.asOf;
      try {
        return await apiRows(seriesId, apiKey, options, !hasFallback);
      } catch (error) {
        if (!hasFallback) throw error;
        onFallback(seriesId, error);
      }
    }

    return parseFredCsvRows(await fetchCsv(seriesId, options));
  };

  return {
    fetchCsv,
    fetchApiRows,
    fetchRows,
    breakerState: () => ({
      open: consecutiveFailures >= threshold && lastFailureAt !== null && now() - lastFailureAt < cooldownMs,
      consecutiveFailures,
      lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
    }),
    resetBreaker: () => {
      consecutiveFailures = 0;
      lastFailureAt = null;
    },
  };
};

/* Series arithmetic. */

export type Observation = { observedAt: string; value: number };

export const latestObservation = (rows: readonly FredRow[], seriesId?: string): Observation => {
  const latest = rows[rows.length - 1];
  if (!latest) throw new Error(seriesId ? `No FRED rows found for ${seriesId}` : "No FRED rows found");
  return { observedAt: `${latest.date}T00:00:00.000Z`, value: latest.value };
};

const priorYearKey = (date: string): string | null => {
  const point = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(point.getTime())) return null;
  point.setUTCFullYear(point.getUTCFullYear() - 1);
  return point.toISOString().slice(0, 10);
};

/** Percent change against the row exactly one year earlier, for every row that has one. */
export const yearOverYearPoints = (rows: readonly FredRow[], seriesId?: string): FredRow[] => {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const valueByDate = new Map(sorted.map((point) => [point.date, point.value]));
  const result = sorted.flatMap((point): FredRow[] => {
    const priorKey = priorYearKey(point.date);
    const prior = priorKey === null ? undefined : valueByDate.get(priorKey);
    if (prior === undefined || prior === 0) return [];
    return [{ date: point.date, value: ((point.value - prior) / prior) * 100 }];
  });
  if (result.length === 0) throw new Error(`No year-over-year rows for ${seriesId ?? "unknown series"}`);
  return result;
};

export const latestYearOverYear = (rows: readonly FredRow[], seriesId?: string): Observation => {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  if (!latest) throw new Error(`No FRED rows for ${seriesId ?? "unknown series"}`);
  const priorKey = priorYearKey(latest.date);
  const prior = sorted.find((row) => row.date === priorKey);
  if (!prior || prior.value === 0) throw new Error(`No prior year FRED row for ${seriesId ?? "unknown series"}`);
  return { observedAt: `${latest.date}T00:00:00.000Z`, value: ((latest.value - prior.value) / prior.value) * 100 };
};
