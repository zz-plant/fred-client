# fred-client

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Fetch economic data from [FRED](https://fred.stlouisfed.org/), the St. Louis Fed's free database of more than 800,000 US and international time series, including interest rates, inflation, and unemployment. Written in TypeScript with no dependencies. It works with or without an API key.

```ts
import { createFredClient, latestObservation } from "fred-client";

const fred = createFredClient();
const rows = await fred.fetchRows("DGS10", { lookbackDays: 14 });

latestObservation(rows);
// { observedAt: "2026-10-05T00:00:00.000Z", value: 5.31 }
```

`DGS10` is the 10-year US Treasury yield. Every series has an id like this, shown on its FRED page.

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Getting data as it was known on a past date](#getting-data-as-it-was-known-on-a-past-date)
- [How requests behave](#how-requests-behave)
- [Configuration](#configuration)
- [API](#api)
- [How it compares](#how-it-compares)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Features

- **Works without a key.** With no key it reads FRED's public CSV download. With a key it uses the official API and falls back to the CSV download if the API fails.
- **Historical revisions.** FRED revises many series after release. With a key, you can ask for a series as it stood on a past date.
- **Missing values are dropped, not read as zero.** FRED marks a missing observation, such as a market holiday, with an empty field or a `.`. Converting an empty field with `Number("")` gives `0`, which turns every holiday into a zero reading. This client drops both forms.
- **Your API key stays out of logs.** The key is removed from every error message and warning.
- **Bounded retries.** Failed requests are retried, but all attempts together share one time limit, so a slow FRED can't stall your app past its own deadline.
- **Stops calling FRED when it's down.** After repeated failures the client refuses requests for a cool-down period instead of waiting on each one. This pattern is called a *circuit breaker*.
- **Runs anywhere `fetch` does.** That includes Node.js 20+, Bun, Deno, and Cloudflare Workers.

## Install

```bash
npm install fred-client
# or
bun add fred-client
```

## Quick start

### 1. Optional: get an API key

A key is free and takes a minute to get from [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys). You need one only to get [past revisions](#getting-data-as-it-was-known-on-a-past-date). Everything else works without a key.

Put it in the environment:

```bash
export FRED_API_KEY=your-key-here
```

### 2. Fetch a series

```ts
import { createFredClient } from "fred-client";

const fred = createFredClient();

const rows = await fred.fetchRows("DGS10", { lookbackDays: 14 });
console.log(rows.slice(-3));
// [
//   { date: "2026-10-01", value: 5.24 },
//   { date: "2026-10-02", value: 5.28 },
//   { date: "2026-10-05", value: 5.31 },
// ]
```

Each row has a `date` as `YYYY-MM-DD` and a numeric `value`. Missing observations are already removed.

Always pass `lookbackDays` unless you need the full history. Without it, FRED returns every observation since the series began, which is decades of daily rows for some series.

### 3. Compute year-over-year change

Many series, such as the consumer price index, are published as index levels. Inflation is the percent change from a year earlier:

```ts
import { yearOverYearPoints } from "fred-client";

const cpi = await fred.fetchRows("CPIAUCSL", { lookbackDays: 500 });
yearOverYearPoints(cpi).at(-1);
// { date: "2026-08-01", value: 3.353016322755652 }   (3.35% inflation)
```

## Getting data as it was known on a past date

FRED publishes a first estimate for many series, then revises it as better data arrives. The unemployment rate for March might be reported as 3.8% in April and revised to 3.9% later. When you backtest a model or explain a past decision, you usually want the number people had at the time, not today's revised one.

FRED's archive of past revisions is called ALFRED, and each saved version of a series is a *vintage*. Pass `asOf` with a date to get the series as it stood on that date:

```ts
const asKnownInMarch = await fred.fetchRows("UNRATE", {
  asOf: "2024-03-31",
  lookbackDays: 365,
});
```

The `lookbackDays` window counts back from the `asOf` date, not from today.

This requires an API key. Without one, the request throws `FredVintageUnavailableError` instead of quietly returning today's numbers, because the CSV download can only serve the latest revision.

## How requests behave

**Choosing a source.** With a key, `fetchRows` calls the API first. If the API fails for any reason, such as a revoked key or an outage, it calls the CSV download instead and reports the switch through `onFallback`. A request with `asOf` never falls back, because the CSV download can't answer it.

**Retries.** A failed request is retried when trying again could help:

| Failure | Retried |
| --- | --- |
| Network error or timeout | Yes |
| HTTP `408`, `429`, or `5xx` | Yes |
| Any other HTTP `4xx`, such as an unknown series id | No, it would fail the same way again |

Each retry waits longer than the one before. Each attempt's timeout is the smaller of `timeoutMs` and the time left in `budgetMs`, so the whole sequence finishes within the budget.

**Circuit breaker.** After `threshold` failed requests in a row, the client stops calling FRED and throws `FredCircuitOpenError` straight away. After `cooldownMs`, the next request goes through as a test. A success resets the count.

A failed API call that is followed by a CSV fallback doesn't count toward the breaker. Without that rule, many series fetched at once with a bad key would trip the breaker before any of their fallbacks ran.

Each client has its own breaker. Create one client and share it across your app.

## Configuration

### Client options

```ts
const fred = createFredClient({
  apiKey: process.env.FRED_API_KEY,
  userAgent: "MyApp/1.0 (+https://example.com)",
  timeoutMs: 8_000,
  retry: { attempts: 3, backoffMs: 500, budgetMs: 9_000 },
  breaker: { threshold: 3, cooldownMs: 120_000 },
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | Read from `FRED_API_KEY` | Your key. `null` means always use the CSV download. A function is called before every request, which suits a key that only exists while a request runs, such as a Worker binding. |
| `fetch` | `globalThis.fetch` | The function used for requests. Pass a fake one in tests. |
| `userAgent` | `fred-client/0.1` | Sent with every request so FRED can tell which app is calling. |
| `timeoutMs` | `8000` | Longest wait for a single attempt. |
| `retry.attempts` | `3` | Total attempts, including the first. |
| `retry.backoffMs` | `500` | Wait before the first retry. The second retry waits twice this, the third three times this. |
| `retry.budgetMs` | `9000` | Time limit for all attempts together. |
| `breaker.threshold` | `3` | Failures in a row before the breaker opens. |
| `breaker.cooldownMs` | `120000` | How long the breaker stays open. |
| `requestInit` | None | Extra options merged into every `fetch` call, such as Next.js caching: `{ next: { revalidate: 900 } }`. |
| `onFallback` | Logs a warning | Called when an API request fails and the CSV download is used instead. |
| `now` | `Date.now` | The clock. Replace it in tests to control timing. |

### Request options

Every option in the second argument of `fetchRows` is optional:

| Option | Meaning |
| --- | --- |
| `lookbackDays` | Return only this many days of history. |
| `asOf` | A `YYYY-MM-DD` date. Return the series as it stood on that date. Needs a key. |
| `apiKey` | Use a different key for this request, or `null` to force the CSV download. |
| `fetch` | Use a different `fetch` for this request, such as a fake one in a single test. Failures still count against the client's breaker. |
| `timeoutMs`, `attempts`, `backoffMs`, `budgetMs` | Override the client's settings for this request. |

### Where the key comes from

If you don't pass `apiKey`, the client looks for it each time it makes a request:

1. A global variable named `FRED_API_KEY`. On Cloudflare Workers, secrets can be copied onto `globalThis` at startup.
2. The `FRED_API_KEY` environment variable.

## API

### Client methods

| Method | Returns |
| --- | --- |
| `fetchRows(seriesId, options?)` | `Promise<{ date, value }[]>` using the API or the CSV download as described above. |
| `fetchApiRows(seriesId, options?)` | The same, from the API only. Throws without a key. |
| `fetchCsv(seriesId, options?)` | The raw CSV text from the public download. |
| `breakerState()` | `{ open, consecutiveFailures, lastFailureAt }` |
| `resetBreaker()` | Closes the breaker and clears the failure count. |

### Working with rows

| Function | Purpose |
| --- | --- |
| `latestObservation(rows)` | The last row as `{ observedAt, value }`, where `observedAt` is an ISO timestamp. |
| `yearOverYearPoints(rows)` | Percent change from exactly one year earlier, for every row that has a match. |
| `latestYearOverYear(rows)` | The same for the latest row only. |

### Parsing and helpers

| Function | Purpose |
| --- | --- |
| `parseFredCsvRows(csv)` | Turns CSV text into rows, dropping missing values. |
| `parseFredCsvSeries(csv)` | Turns CSV text into a `Map` from date to value, keeping a missing value as `null`. Use it to line several series up by date. |
| `parseFredApiObservations(json)` | Turns an API response into rows, dropping missing values. |
| `isMissingFredValue(text)` | `true` for an empty field, whitespace, or `.`. |
| `redactFredApiKey(text)` | Replaces any `api_key=…` with `api_key=REDACTED`. |
| `resolveFredApiKey()` | The key from the global variable or environment, or `null`. |
| `withRetry(fn, options)` | The retry loop on its own, for use with other services. |
| `fetchWithTimeout(fetch, url, init, ms)` | `fetch` with a timeout. |

### Errors

| Error | When |
| --- | --- |
| `FredResponseError` | FRED answered with an error status. Has a `status` property. |
| `FredVintageUnavailableError` | `asOf` was requested without an API key. |
| `FredCircuitOpenError` | The breaker is open and no request was sent. |

## How it compares

| | fred-client | [node-fred](https://github.com/pastorsj/node-fred) 3.0 | [fred-api](https://www.npmjs.com/package/fred-api) 2.0 |
| --- | --- | --- | --- |
| Works without an API key | Yes | No | No |
| Past revisions (`asOf`) | Yes, typed | Through raw request parameters | Through raw request parameters |
| Values | Numbers, missing values removed | Raw strings, `.` left in | Raw strings |
| Key removed from errors | Yes | No | No |
| Retries | Within one total time limit | Up to 5, with no total time limit | No |
| Circuit breaker | Yes | No | No |
| Dependencies | None | axios | None |
| Endpoints covered | Series observations | All FRED API groups: series, categories, releases, sources, tags | All FRED API groups |
| Last release | Unreleased | January 2026 | June 2022 |

If you need search, categories, releases, sources, or tags, use node-fred or fred-api. This client covers series observations only.

## Limitations

- **Series observations only.** Search, categories, releases, and tags are not covered.
- **One vintage per request.** `asOf` fetches the series as of a single date. Comparing many vintages takes one request each.
- **No unit or frequency conversion.** FRED's API can convert units or average to a lower frequency on its side. This client doesn't expose those options yet.

## Development

```bash
git clone https://github.com/zz-plant/fred-client.git
cd fred-client
bun install
bun run check   # type check and tests
bun run build   # compile to dist/
```

The tests use fake `fetch` functions and make no network requests.

## License

[MIT](LICENSE)

FRED® is a registered trademark of the Federal Reserve Bank of St. Louis. This project is not affiliated with or endorsed by the Federal Reserve Bank of St. Louis.
