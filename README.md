# fred-client

A TypeScript client for FRED, the St. Louis Fed's economic data service. Zero dependencies. Works anywhere `fetch` does: Node 20+, Bun, Deno, Cloudflare Workers.

- The chart CSV export and the JSON API behind one interface. No key needed for the export; a free key unlocks the API.
- ALFRED vintages: a series as it was known on a past date, via `asOf`.
- The empty-field-is-missing rule. FRED's CSV export marks a missing observation with an empty field, not only `"."`. `Number("")` is `0`, so a parser that guards only against the dot reads every market holiday as a zero print. This client drops both.
- Key redaction in every error and fallback message.
- Retries inside a wall-clock budget, so a sequence of attempts cannot outlive the deadline that governs the caller.
- A circuit breaker per client, with an injectable clock.

The Python and R ecosystems have `fredapi` and `fredr`. The npm clients are thin and stale, and none handle vintages.

## Install

```bash
bun add fred-client
# or
npm install fred-client
```

## Use

```ts
import { createFredClient, latestObservation } from "fred-client";

const fred = createFredClient(); // reads FRED_API_KEY from the environment, or a global binding

const rows = await fred.fetchRows("DGS10", { lookbackDays: 90 });
// [{ date: "2026-07-07", value: 4.21 }, …]

latestObservation(rows); // { observedAt: "2026-10-06T00:00:00.000Z", value: 4.18 }
```

A vintage, as the series stood on a date:

```ts
const march = await fred.fetchRows("UNRATE", { asOf: "2024-03-31", lookbackDays: 365 });
```

This needs a key. Without one it throws `FredVintageUnavailableError` rather than returning today's revision, because the CSV export cannot serve a vintage and a silently wrong answer is worse than none.

### Client options

```ts
createFredClient({
  fetch,                           // default: globalThis.fetch
  apiKey: "…" | null,              // null forces the CSV path; omit to resolve at call time
  userAgent: "MyApp/1.0 (+https://example.com)",
  timeoutMs: 8_000,                // per attempt
  retry: { attempts: 3, backoffMs: 500, budgetMs: 9_000 },
  breaker: { threshold: 3, cooldownMs: 120_000 },
  requestInit: { next: { revalidate: 900 } },   // merged into every fetch
  onFallback: (seriesId, error) => log.warn(…), // default: console.warn
  now: Date.now,                   // injectable for tests
});
```

### Per-request options

`lookbackDays`, `asOf`, `apiKey`, `timeoutMs`, `attempts`, `backoffMs`, `budgetMs`. The lookback for a vintage counts back from the vintage date, not from today.

### Fallback and the breaker

With a key, `fetchRows` tries the API and falls back to the CSV export on any failure, so a revoked key degrades to the path that needs none. An API failure that has a fallback behind it does not count against the breaker. Six series fetched concurrently against a revoked key would otherwise open it before any of their fallbacks ran. A vintage request has no fallback and counts.

The breaker opens after `threshold` consecutive failures and refuses with `FredCircuitOpenError`, without a request, until `cooldownMs` has passed. `breakerState()` reports it; `resetBreaker()` clears it.

### Retry policy

Transport faults, timeouts, `408`, `429`, and `5xx` retry. `4xx` does not: a request FRED actively rejected will be rejected identically every time, and retrying it only spends the budget the transient case needs. Each attempt is capped at the smaller of `timeoutMs` and what remains of `budgetMs`.

### Pure helpers

`parseFredCsvRows`, `parseFredApiObservations`, `isMissingFredValue`, `latestObservation`, `yearOverYearPoints`, `latestYearOverYear`, `withRetry`, `fetchWithTimeout`, `buildFredCsvUrl`, `buildFredApiUrl`, `redactFredApiKey`, `resolveFredApiKey`.

## Key resolution

`resolveFredApiKey()` reads a `FRED_API_KEY` global first (a Cloudflare Worker secret installed on `globalThis`, say), then `process.env.FRED_API_KEY`. Pass `apiKey` to the client or the request to bypass it.

## License

MIT
