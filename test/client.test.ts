import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import {
  FRED_API_BASE_URL,
  FRED_CSV_BASE_URL,
  FredCircuitOpenError,
  FredResponseError,
  FredVintageUnavailableError,
  createFredClient,
  isRetryableFredError,
  resolveFredApiKey,
  type FetchLike,
} from "../src/index.js";

const buildCsv = (rows: string[]) => `DATE,VALUE\n${rows.join("\n")}\n`;
const CSV = buildCsv(["2024-01-01,4.00", "2024-01-02,4.01"]);

const API_BODY = JSON.stringify({
  observations: [
    { date: "2024-01-01", value: "4.00" },
    { date: "2024-01-02", value: "." },
    { date: "2024-01-03", value: "4.02" },
  ],
});

const recording = (respond: (url: string) => Response | Promise<Response>, calls: string[] = []) => {
  const fetcher: FetchLike = async (input) => {
    const url = typeof input === "string" ? input : input.href;
    calls.push(url);
    return respond(url);
  };
  return { fetcher, calls };
};

const quiet = { backoffMs: 0 };

describe("fetchCsv", () => {
  it("asks the CSV export with the series id and a bounded window", async () => {
    const { fetcher, calls } = recording(() => new Response(CSV));
    const client = createFredClient({ fetch: fetcher, apiKey: null, now: () => Date.UTC(2024, 2, 31) });

    const csv = await client.fetchCsv("DGS10", { ...quiet, lookbackDays: 30 });
    assert.equal(csv, CSV);
    const url = new URL(calls[0] ?? "");
    assert.equal(`${url.origin}${url.pathname}`, FRED_CSV_BASE_URL);
    assert.equal(url.searchParams.get("id"), "DGS10");
    assert.equal(url.searchParams.get("cosd"), "2024-03-01");
  });

  it("sends the user agent and merges requestInit", async () => {
    let seen: RequestInit | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      seen = init;
      return new Response(CSV);
    };
    const client = createFredClient({ fetch: fetcher, apiKey: null, userAgent: "MyBot/1.0", requestInit: { cache: "no-store" } });
    await client.fetchCsv("DGS10", quiet);
    assert.equal(new Headers(seen?.headers).get("user-agent"), "MyBot/1.0");
    assert.equal(seen?.cache, "no-store");
    assert.ok(seen?.signal instanceof AbortSignal);
  });

  it("throws a FredResponseError on a non-OK status", async () => {
    const { fetcher } = recording(() => new Response("error", { status: 500 }));
    const client = createFredClient({ fetch: fetcher, apiKey: null });
    await assert.rejects(client.fetchCsv("DGS10", quiet), /FRED request failed for DGS10 \(HTTP 500\)/);
  });
});

describe("circuit breaker", () => {
  const failing = () => recording(() => Promise.reject(new Error("network error")));

  it("opens after three consecutive failures and refuses without a request", async () => {
    const { fetcher, calls } = failing();
    const client = createFredClient({ fetch: fetcher, apiKey: null });

    for (let i = 0; i < 3; i += 1) await assert.rejects(client.fetchCsv("DGS10", quiet));
    assert.equal(client.breakerState().open, true);

    const before = calls.length;
    await assert.rejects(client.fetchCsv("DGS10", quiet), FredCircuitOpenError);
    assert.equal(calls.length, before, "no request while open");
  });

  it("closes again on a success", async () => {
    let fail = true;
    const { fetcher } = recording(() => (fail ? Promise.reject(new Error("down")) : new Response(CSV)));
    const client = createFredClient({ fetch: fetcher, apiKey: null });

    await assert.rejects(client.fetchCsv("DGS10", quiet));
    await assert.rejects(client.fetchCsv("DGS10", quiet));
    assert.equal(client.breakerState().consecutiveFailures, 2);

    fail = false;
    await client.fetchCsv("DGS10", quiet);
    assert.deepEqual(client.breakerState(), { open: false, consecutiveFailures: 0, lastFailureAt: null });
  });

  it("lets a probe through once the cooldown has elapsed", async () => {
    let clock = 1_000_000;
    const { fetcher, calls } = failing();
    const client = createFredClient({ fetch: fetcher, apiKey: null, now: () => clock, breaker: { threshold: 2, cooldownMs: 5_000 } });

    await assert.rejects(client.fetchCsv("DGS10", { ...quiet, attempts: 1 }));
    await assert.rejects(client.fetchCsv("DGS10", { ...quiet, attempts: 1 }));
    assert.equal(client.breakerState().open, true);
    await assert.rejects(client.fetchCsv("DGS10", { ...quiet, attempts: 1 }), FredCircuitOpenError);
    assert.equal(calls.length, 2);

    clock += 5_001;
    assert.equal(client.breakerState().open, false, "cooldown elapsed");
    await assert.rejects(client.fetchCsv("DGS10", { ...quiet, attempts: 1 }), /network error/);
    assert.equal(calls.length, 3, "the probe was sent");
  });

  it("is per client, not global", async () => {
    const { fetcher } = failing();
    const a = createFredClient({ fetch: fetcher, apiKey: null, breaker: { threshold: 1 } });
    const b = createFredClient({ fetch: fetcher, apiKey: null, breaker: { threshold: 1 } });
    await assert.rejects(a.fetchCsv("DGS10", { ...quiet, attempts: 1 }));
    assert.equal(a.breakerState().open, true);
    assert.equal(b.breakerState().open, false);
  });
});

describe("retry policy", () => {
  it("retries a server fault, which could answer differently next time", async () => {
    const { fetcher, calls } = recording(() => new Response("upstream fault", { status: 503 }));
    const client = createFredClient({ fetch: fetcher, apiKey: null });
    await assert.rejects(client.fetchCsv("DGS10", quiet));
    assert.equal(calls.length, 3, "503 exhausts the attempt budget");
  });

  it("does not retry a request FRED actively rejected", async () => {
    const { fetcher, calls } = recording(() => new Response("no such series", { status: 404 }));
    const client = createFredClient({ fetch: fetcher, apiKey: null });
    await assert.rejects(client.fetchCsv("NOT_A_SERIES", quiet), /HTTP 404/);
    assert.equal(calls.length, 1);
  });

  it("classifies retryable and non-retryable failures", () => {
    assert.equal(isRetryableFredError(new FredResponseError("DGS10", 500)), true);
    assert.equal(isRetryableFredError(new FredResponseError("DGS10", 429)), true);
    assert.equal(isRetryableFredError(new FredResponseError("DGS10", 408)), true);
    assert.equal(isRetryableFredError(new FredResponseError("DGS10", 404)), false);
    assert.equal(isRetryableFredError(new FredResponseError("DGS10", 400)), false);
    assert.equal(isRetryableFredError(new FredCircuitOpenError()), false);
    assert.equal(isRetryableFredError(new Error("fetch failed")), true, "transport faults carry no status and stay retryable");
  });

  it("caps each attempt at what remains of the budget", async () => {
    let clock = 0;
    const signals: AbortSignal[] = [];
    const fetcher: FetchLike = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      clock += 2_000;
      return new Response("down", { status: 503 });
    };
    const client = createFredClient({ fetch: fetcher, apiKey: null, now: () => clock, timeoutMs: 8_000, retry: { budgetMs: 5_000, backoffMs: 0 } });
    await assert.rejects(client.fetchCsv("DGS10"));
    // 5000 left, then 3000, then 1000: three attempts fit; a fourth would not.
    assert.equal(signals.length, 3);
  });
});

describe("fetchRows", () => {
  it("stays on the CSV export when no key is configured", async () => {
    const { fetcher, calls } = recording(() => new Response(CSV));
    const rows = await createFredClient({ fetch: fetcher, apiKey: null }).fetchRows("DGS10", quiet);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.startsWith(FRED_CSV_BASE_URL));
    assert.equal(rows.length, 2);
  });

  it("asks the API for JSON with the key and the lookback window when a key is given", async () => {
    const { fetcher, calls } = recording(() => new Response(API_BODY));
    const rows = await createFredClient({ fetch: fetcher, apiKey: "abc123" }).fetchRows("DGS10", { ...quiet, lookbackDays: 30 });

    const url = new URL(calls[0] ?? "");
    assert.equal(`${url.origin}${url.pathname}`, FRED_API_BASE_URL);
    assert.equal(url.searchParams.get("series_id"), "DGS10");
    assert.equal(url.searchParams.get("api_key"), "abc123");
    assert.equal(url.searchParams.get("file_type"), "json");
    assert.match(url.searchParams.get("observation_start") ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(url.searchParams.get("realtime_start"), null, "no vintage unless asked");
    assert.deepEqual(rows, [
      { date: "2024-01-01", value: 4 },
      { date: "2024-01-03", value: 4.02 },
    ]);
  });

  it("pins a vintage with realtime_start and realtime_end, and anchors the lookback to it", async () => {
    const { fetcher, calls } = recording(() => new Response(API_BODY));
    await createFredClient({ fetch: fetcher, apiKey: "abc123" }).fetchRows("UNRATE", { ...quiet, asOf: "2024-03-31", lookbackDays: 90 });
    const url = new URL(calls[0] ?? "");
    assert.equal(url.searchParams.get("realtime_start"), "2024-03-31");
    assert.equal(url.searchParams.get("realtime_end"), "2024-03-31");
    assert.equal(url.searchParams.get("observation_start"), "2024-01-01", "ninety days before the vintage date, not today");
  });

  it("refuses a vintage request without a key rather than returning today's revision", async () => {
    const { fetcher, calls } = recording(() => new Response(CSV));
    await assert.rejects(createFredClient({ fetch: fetcher, apiKey: null }).fetchRows("UNRATE", { asOf: "2024-03-31" }), FredVintageUnavailableError);
    assert.equal(calls.length, 0);
  });

  it("falls back to the CSV export when the API rejects the key, and never repeats the key", async () => {
    const { fetcher, calls } = recording((url) =>
      url.startsWith(FRED_API_BASE_URL)
        ? new Response(JSON.stringify({ error_code: 400, error_message: "Bad Request. The value for variable api_key is not registered." }), { status: 400 })
        : new Response(CSV),
    );
    const fallbacks: string[] = [];
    const client = createFredClient({
      fetch: fetcher,
      apiKey: "secret-key-123",
      onFallback: (seriesId, error) => fallbacks.push(`${seriesId}: ${error instanceof Error ? error.message : String(error)}`),
    });

    const rows = await client.fetchRows("DGS10", quiet);
    assert.equal(rows.length, 2, "served from the CSV export");
    assert.ok(calls.some((url) => url.startsWith(FRED_API_BASE_URL)), "the API was tried first");
    assert.ok(calls.some((url) => url.startsWith(FRED_CSV_BASE_URL)), "then the CSV export");
    assert.equal(fallbacks.length, 1);
    assert.ok(!fallbacks[0]?.includes("secret-key-123"));
  });

  it("keeps the breaker closed while keyed reads fall back concurrently, so every fallback runs", async () => {
    const { fetcher, calls } = recording((url) =>
      url.startsWith(FRED_API_BASE_URL) ? new Response("{}", { status: 400 }) : new Response(CSV),
    );
    const client = createFredClient({ fetch: fetcher, apiKey: "revoked", onFallback: () => {} });

    const results = await Promise.all(["DGS10", "BAA10Y", "UNRATE", "CPIAUCSL", "NFCI", "VIXCLS"].map((series) => client.fetchRows(series, quiet)));
    assert.ok(results.every((rows) => rows.length === 2));
    assert.equal(calls.filter((url) => url.startsWith(FRED_CSV_BASE_URL)).length, 6, "every fallback made its request");
    assert.deepEqual(client.breakerState(), { open: false, consecutiveFailures: 0, lastFailureAt: null });
  });

  it("counts an API failure against the breaker when nothing can fall back", async () => {
    const { fetcher } = recording(() => new Response("down", { status: 503 }));
    const client = createFredClient({ fetch: fetcher, apiKey: "abc123" });
    await assert.rejects(client.fetchApiRows("DGS10", { ...quiet, attempts: 1 }));
    assert.equal(client.breakerState().consecutiveFailures, 1);
  });

  it("does not fall back for a vintage: the CSV export cannot serve one", async () => {
    const { fetcher, calls } = recording(() => new Response("down", { status: 503 }));
    await assert.rejects(
      createFredClient({ fetch: fetcher, apiKey: "abc123" }).fetchRows("DGS10", { ...quiet, asOf: "2024-03-31", attempts: 1 }),
      FredResponseError,
    );
    assert.ok(calls.every((url) => url.startsWith(FRED_API_BASE_URL)));
  });

  it("redacts the key from any error it throws", async () => {
    const { fetcher } = recording((url) => Promise.reject(new Error(`connect failed for ${url}`)));
    await assert.rejects(
      createFredClient({ fetch: fetcher, apiKey: "topsecret" }).fetchApiRows("DGS10", { ...quiet, attempts: 1 }),
      (error: unknown) => error instanceof Error && !error.message.includes("topsecret") && error.message.includes("api_key=REDACTED"),
    );
  });

  it("lets a per-request key override the client's, and null force the CSV path", async () => {
    const { fetcher, calls } = recording((url) => (url.startsWith(FRED_API_BASE_URL) ? new Response(API_BODY) : new Response(CSV)));
    const client = createFredClient({ fetch: fetcher, apiKey: "client-key" });
    await client.fetchRows("DGS10", { ...quiet, apiKey: "request-key" });
    assert.equal(new URL(calls[0] ?? "").searchParams.get("api_key"), "request-key");
    await client.fetchRows("DGS10", { ...quiet, apiKey: null });
    assert.ok(calls[1]?.startsWith(FRED_CSV_BASE_URL));
  });
});

describe("resolveFredApiKey", () => {
  it("prefers a global binding over the environment, trimmed", () => {
    const previous = process.env.FRED_API_KEY;
    delete process.env.FRED_API_KEY;
    try {
      assert.equal(resolveFredApiKey(), null);
      process.env.FRED_API_KEY = "from-env";
      assert.equal(resolveFredApiKey(), "from-env");
      Object.assign(globalThis, { FRED_API_KEY: " from-binding " });
      assert.equal(resolveFredApiKey(), "from-binding");
    } finally {
      Reflect.deleteProperty(globalThis, "FRED_API_KEY");
      if (previous === undefined) delete process.env.FRED_API_KEY;
      else process.env.FRED_API_KEY = previous;
    }
  });
});
