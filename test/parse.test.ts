import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import {
  isMissingFredValue,
  latestObservation,
  latestYearOverYear,
  parseFredApiObservations,
  parseFredCsvRows,
  withRetry,
  yearOverYearPoints,
} from "../src/index.js";

const buildCsv = (rows: string[]) => `DATE,VALUE\n${rows.join("\n")}\n`;

describe("missing observations", () => {
  it("treats an empty field, whitespace, and a dot as absent", () => {
    assert.equal(isMissingFredValue(""), true);
    assert.equal(isMissingFredValue("   "), true);
    assert.equal(isMissingFredValue("."), true);
    assert.equal(isMissingFredValue(" . "), true);
    assert.equal(isMissingFredValue(undefined), true);
    assert.equal(isMissingFredValue("0"), false);
    assert.equal(isMissingFredValue("4.25"), false);
  });

  it("drops an empty CSV field instead of reading it as zero", () => {
    const rows = parseFredCsvRows(buildCsv(["2024-03-28,5.49", "2024-03-29,", "2024-04-01,.", "2024-04-02,5.49", "junk"]));
    assert.deepEqual(rows, [
      { date: "2024-03-28", value: 5.49 },
      { date: "2024-04-02", value: 5.49 },
    ]);
  });

  it("drops an empty API observation the same way", () => {
    const rows = parseFredApiObservations({
      observations: [
        { date: "2024-03-28", value: "5.49" },
        { date: "2024-03-29", value: "" },
        { date: "2024-04-01", value: "." },
        "not an object",
      ],
    });
    assert.deepEqual(rows, [{ date: "2024-03-28", value: 5.49 }]);
  });

  it("surfaces the API's error message, redacted, when there are no observations", () => {
    assert.throws(() => parseFredApiObservations({ error_message: "bad api_key=abc here" }), /FRED API error: bad api_key=REDACTED here/);
    assert.throws(() => parseFredApiObservations(null), /no observations payload/);
    assert.throws(() => parseFredApiObservations({}), /no observations array/);
  });
});

describe("series arithmetic", () => {
  const rows = [
    { date: "2023-01-01", value: 100 },
    { date: "2023-06-01", value: 0 },
    { date: "2024-01-01", value: 110 },
    { date: "2024-06-01", value: 120 },
  ];

  it("reads the latest observation", () => {
    assert.deepEqual(latestObservation(rows), { observedAt: "2024-06-01T00:00:00.000Z", value: 120 });
    assert.throws(() => latestObservation([], "X"), /No FRED rows found for X/);
  });

  it("computes year-over-year only where a prior-year row exists and is non-zero", () => {
    assert.deepEqual(yearOverYearPoints(rows), [{ date: "2024-01-01", value: 10 }]);
    assert.throws(() => yearOverYearPoints([{ date: "2024-01-01", value: 1 }], "X"), /No year-over-year rows for X/);
  });

  it("computes the latest year-over-year or explains why it cannot", () => {
    assert.deepEqual(latestYearOverYear(rows.slice(0, 3)), { observedAt: "2024-01-01T00:00:00.000Z", value: 10 });
    assert.throws(() => latestYearOverYear(rows, "X"), /No prior year FRED row for X/);
  });
});

describe("withRetry budget", () => {
  const fakeClock = (steps: number[]) => {
    let index = 0;
    return () => steps[Math.min(index++, steps.length - 1)] ?? 0;
  };

  it("stops once the budget is spent instead of starting a doomed attempt", async () => {
    let calls = 0;
    const now = fakeClock([0, 0, 9_000, 9_000, 9_000]);
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("timed out");
        },
        { attempts: 3, backoffMs: 0, budgetMs: 9_000, now },
      ),
      /timed out/,
    );
    assert.equal(calls, 1);
  });

  it("hands each attempt only the time the budget has left", async () => {
    const seen: number[] = [];
    const now = fakeClock([0, 0, 1_000, 1_000, 1_000]);
    await assert.rejects(
      withRetry(
        async (remainingMs) => {
          seen.push(remainingMs);
          throw new Error("boom");
        },
        { attempts: 2, backoffMs: 0, budgetMs: 9_000, now },
      ),
    );
    assert.deepEqual(seen, [9_000, 8_000]);
  });

  it("keeps retrying while the budget still funds an attempt", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { attempts: 3, backoffMs: 0, budgetMs: 9_000 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("abandons a failure the policy says a retry cannot change", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error("permanent");
        },
        { attempts: 3, backoffMs: 0, isRetryable: () => false },
      ),
      /permanent/,
    );
    assert.equal(calls, 1);
  });
});
