import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { handleSignalsRequest, handleSignalsRawBody } from "../lib/aiSignalsHandler.js";
import { parseJsonBody, MAX_SUMMARY_MARKETS } from "../lib/aiRequest.js";

/**
 * Tests for the POST /api/v1/ai/signals request layer.
 *
 * These drive lib/aiSignalsHandler.js — the module the route file delegates to —
 * because a Next route module cannot be imported by `node --test` (Next 14
 * ships no `exports` map, so `next/server` only resolves inside Next's bundler).
 * The handler is exercised exactly as the route calls it, with the engine
 * singletons on `globalThis` populated the same way client/server.js does.
 */

const REQUIRED_FIELDS = ["signals", "source", "model", "generated_at"];
const ADDITIVE_FIELDS = ["warnings", "universe", "data_source"];

function clearEngines() {
  delete globalThis._marketEngine;
  delete globalThis._matchingEngine;
}

/** Fake of the real MarketEngine surface the handler touches. */
function engineWith(markets) {
  return {
    overview: () => ({ volume_24h_total: 0, server_ts: 1, markets }),
    isFeedConnected: () => false,
  };
}

function market(id, change, volume) {
  return {
    id,
    pair: `${id.toUpperCase()}-USDT`,
    base: id.toUpperCase(),
    quote: "USDT",
    mark_price: 100,
    change_24h_pct: change,
    volume_24h: volume,
  };
}

/** 35 markets, so anything derived from a 6-market summary is detectable. */
function fullUniverse() {
  const markets = [];
  for (let i = 0; i < 35; i++) {
    // Exactly one flat market (i=17); 17 positive and 17 negative around it.
    const change = i === 17 ? 0 : i < 17 ? (i + 1) / 4 : -(i - 17) / 4;
    markets.push(market(`m${String(i).padStart(2, "0")}`, change, 1_000_000 + i * 1000));
  }
  return markets;
}

const UNIVERSE_SIZE = 35;
/** 35 markets minus the single flat one, which has no direction. */
const DIRECTIONAL_COUNT = 34;

beforeEach(clearEngines);
after(clearEngines);

describe("POST /api/v1/ai/signals — success", () => {
  it("returns 200 with the required response fields", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    const res = await handleSignalsRequest({});

    assert.equal(res.status, 200);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in res.json, `missing required field: ${field}`);
    }
    assert.equal(res.json.source, "heuristic");
    assert.equal(res.json.model, null);
    assert.ok(Array.isArray(res.json.signals));
    assert.ok(Number.isInteger(res.json.generated_at));
    assert.ok(Math.abs(Math.floor(Date.now() / 1000) - res.json.generated_at) <= 5);
  });

  it("includes the additive provenance fields", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    const res = await handleSignalsRequest({});
    for (const field of ADDITIVE_FIELDS) {
      assert.ok(field in res.json, `missing additive field: ${field}`);
    }
    assert.equal(res.json.data_source, "server");
  });

  it("treats an absent or empty summary as 'no summary supplied'", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    for (const body of [undefined, null, {}, { summary: null }, { question: "hi" }]) {
      const res = await handleSignalsRequest(body);
      assert.equal(res.status, 200, `body ${JSON.stringify(body)} should use server state`);
      assert.equal(res.json.data_source, "server");
    }
  });
});

describe("POST /api/v1/ai/signals — raw body parsing", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseJsonBody('{"summary":null}'), { ok: true, body: { summary: null } });
    assert.deepEqual(parseJsonBody("{}"), { ok: true, body: {} });
  });

  it("treats an absent or whitespace-only body as no body", () => {
    for (const raw of [undefined, null, "", "   ", "\n\t "]) {
      assert.deepEqual(parseJsonBody(raw), { ok: true, body: {} });
    }
  });

  it("rejects malformed JSON instead of guessing", () => {
    for (const raw of ["not-json-at-all", "{", '{"a":}', '{"summary": 1,}', "undefined"]) {
      const parsed = parseJsonBody(raw);
      assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to fail`);
      assert.equal(parsed.reason, "request body must be valid JSON");
    }
  });

  it("returns 400 for a malformed body rather than falling back to server state", async () => {
    // Server state is available and would happily return 35 signals.
    globalThis._marketEngine = engineWith(fullUniverse());

    const res = await handleSignalsRawBody("not-json-at-all");
    assert.equal(res.status, 400);
    assert.equal(res.text, "request body must be valid JSON");
    assert.equal(res.json, undefined, "must not evaluate server state instead");
    assert.doesNotMatch(res.text, /\d+ signals/);
  });

  it("does not evaluate server state for any malformed payload", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    for (const raw of ["{", '{"summary":', "nonsense", "[1,2,"]) {
      const res = await handleSignalsRawBody(raw);
      assert.equal(res.status, 400, `raw ${JSON.stringify(raw)}`);
      assert.equal(res.json, undefined);
    }
  });

  it("still accepts an empty body and a valid summary through the raw entry point", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());

    const empty = await handleSignalsRawBody("");
    assert.equal(empty.status, 200);
    assert.equal(empty.json.data_source, "server");

    const supplied = await handleSignalsRawBody(
      JSON.stringify({ summary: { markets: [market("solo", 2, 100)] } }),
    );
    assert.equal(supplied.status, 200);
    assert.equal(supplied.json.data_source, "summary");
    assert.deepEqual(supplied.json.signals.map((s) => s.market_id), ["solo"]);
  });

  it("reports a malformed body even when server state is unavailable", async () => {
    // A 400 must take precedence over the warming-up 503: the request is broken
    // regardless of engine readiness.
    const res = await handleSignalsRawBody("not-json");
    assert.equal(res.status, 400);
    assert.equal(res.text, "request body must be valid JSON");
  });

  it("validates a non-object JSON payload", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    for (const raw of ['"just a string"', "42", "[1,2,3]", "true"]) {
      const res = await handleSignalsRawBody(raw);
      assert.equal(res.status, 400, `raw ${raw}`);
      assert.equal(res.text, "request body must be a JSON object");
    }
  });
});

describe("POST /api/v1/ai/signals — market universe", () => {
  it("evaluates the FULL live universe, not the six-market dashboard summary", async () => {
    const markets = fullUniverse();
    assert.equal(markets.length, UNIVERSE_SIZE);
    globalThis._marketEngine = engineWith(markets);
    const res = await handleSignalsRequest({});

    assert.equal(res.json.signals.length, DIRECTIONAL_COUNT);
    assert.ok(res.json.signals.length > 6, "must exceed the dashboard summary's 6 markets");
    assert.equal(res.json.universe, "markets");
    assert.equal(res.json.signals.filter((s) => s.type === "opportunity").length, 17);
    assert.equal(res.json.signals.filter((s) => s.type === "risk").length, 17);
    // Only the single flat market is skipped.
    assert.equal(res.json.warnings.length, 1);

    // A mid-ranked market, which no top-3 bucket could surface, is present.
    const ids = new Set(res.json.signals.map((s) => s.market_id));
    assert.ok(ids.has("m09"), "expected a mid-ranked market to be scored");
    assert.ok(ids.has("m30"));
  });

  it("does not depend on the dashboard summary or the matching engine", async () => {
    // Deliberately no globalThis._matchingEngine: buildDashboardSummary could not
    // run, so a 200 proves the universe came straight from the market engine.
    assert.equal(globalThis._matchingEngine, undefined);
    globalThis._marketEngine = engineWith(fullUniverse());
    const res = await handleSignalsRequest({});
    assert.equal(res.status, 200);
    assert.equal(res.json.signals.length, DIRECTIONAL_COUNT);
  });

  it("uses a caller-supplied summary without merging server state", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    const res = await handleSignalsRequest({
      summary: { markets: [market("solo", 2.5, 500)] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "summary");
    assert.equal(res.json.signals.length, 1);
    assert.equal(res.json.signals[0].market_id, "solo");
    const ids = res.json.signals.map((s) => s.market_id);
    assert.ok(!ids.some((id) => id.startsWith("m")), "server markets must not leak in");
  });

  it("validates caller-supplied records instead of trusting them", async () => {
    const res = await handleSignalsRequest({
      summary: {
        markets: [
          market("good", 1.5, 100),
          { ...market("bad", 1.5, 100), mark_price: "not-a-number" },
          { ...market("nope", 1.5, 100), volume_24h: undefined },
        ],
      },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.json.signals.map((s) => s.market_id), ["good"]);
    assert.equal(res.json.warnings.length, 2);
    assert.ok(res.json.warnings.some((w) => /"bad".*mark_price/.test(w)));
    assert.ok(res.json.warnings.some((w) => /"nope".*volume_24h/.test(w)));
  });
});

describe("POST /api/v1/ai/signals — directionality", () => {
  it("types every signal from its own metrics", async () => {
    globalThis._marketEngine = engineWith([
      market("up-usdt", 3, 900),
      market("down-usdt", -2, 800),
      market("flat-usdt", 0, 700),
    ]);
    const res = await handleSignalsRequest({});

    const opp = res.json.signals.filter((s) => s.type === "opportunity");
    const risk = res.json.signals.filter((s) => s.type === "risk");
    assert.deepEqual(opp.map((s) => s.market_id), ["up-usdt"]);
    assert.deepEqual(risk.map((s) => s.market_id), ["down-usdt"]);
    assert.ok(opp.every((s) => s.evidence.change_24h_pct > 0));
    assert.ok(risk.every((s) => s.evidence.change_24h_pct < 0));
    // The flat market produces no directional signal.
    assert.ok(!res.json.signals.some((s) => s.market_id === "flat-usdt"));
  });

  it("ignores bucket labels and reports the mismatch", async () => {
    const res = await handleSignalsRequest({
      summary: {
        top_gainers: [market("loser-usdt", -1.9, 500)],
        top_losers: [market("winner-usdt", 1.88, 400)],
      },
    });

    assert.equal(res.status, 200);
    const byId = Object.fromEntries(res.json.signals.map((s) => [s.market_id, s.type]));
    assert.deepEqual(byId, { "loser-usdt": "risk", "winner-usdt": "opportunity" });
    assert.ok(res.json.warnings.some((w) => /top_gainers but change_24h_pct is negative/.test(w)));
    assert.ok(res.json.warnings.some((w) => /top_losers but change_24h_pct is positive/.test(w)));
  });

  it("preserves evidence verbatim from the supplied universe", async () => {
    const src = { ...market("exact-usdt", 2.0054005480801913, 1297474.1427741423), mark_price: 7.2 };
    const res = await handleSignalsRequest({ summary: { markets: [src] } });
    assert.deepEqual(res.json.signals[0].evidence, {
      change_24h_pct: 2.0054005480801913,
      volume_24h: 1297474.1427741423,
      mark_price: 7.2,
    });
  });
});

describe("POST /api/v1/ai/signals — request validation", () => {
  it("rejects a malformed summary with a plain-text 400", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    for (const summary of ["garbage", 42, [], true]) {
      const res = await handleSignalsRequest({ summary });
      assert.equal(res.status, 400, `summary ${JSON.stringify(summary)}`);
      assert.equal(res.text, "summary must be an object");
      assert.equal(res.json, undefined);
    }
  });

  it("rejects a summary with no usable market array", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    const res = await handleSignalsRequest({ summary: { active_markets: 35 } });
    assert.equal(res.status, 400);
    assert.match(res.text, /summary must include a markets, top_gainers, or top_losers array/);
  });

  it("rejects a non-object request body", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    for (const body of ["text", 42, []]) {
      const res = await handleSignalsRequest(body);
      assert.equal(res.status, 400);
      assert.equal(res.text, "request body must be a JSON object");
    }
  });

  it("rejects an oversized summary with a plain-text 400", async () => {
    globalThis._marketEngine = engineWith(fullUniverse());
    const markets = Array.from({ length: MAX_SUMMARY_MARKETS + 1 }, (_, i) => market(`x${i}`, 1, 1));
    const res = await handleSignalsRequest({ summary: { markets } });
    assert.equal(res.status, 400);
    assert.equal(res.text, `summary exceeds ${MAX_SUMMARY_MARKETS} market records`);
  });

  it("accepts a summary at exactly the size limit", async () => {
    const markets = Array.from({ length: MAX_SUMMARY_MARKETS }, (_, i) => market(`x${i}`, 1, 1));
    const res = await handleSignalsRequest({ summary: { markets } });
    assert.equal(res.status, 200);
    assert.equal(res.json.signals.length, MAX_SUMMARY_MARKETS);
  });
});

describe("POST /api/v1/ai/signals — unavailable market state", () => {
  it("creates the market engine on demand when nothing has primed it", async () => {
    // No engine on globalThis. The accessor builds one lazily, so a serverless
    // instance still returns a full signal set instead of failing to warm up.
    clearEngines();
    const res = await handleSignalsRequest({});
    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "server");
    assert.ok(res.json.signals.length > 0);
  });

  it("returns 503 rather than a fabricated empty success", async () => {
    for (const overview of [{ markets: [] }, {}, { markets: "nope" }, { markets: null }]) {
      globalThis._marketEngine = { overview: () => overview };
      const res = await handleSignalsRequest({});
      assert.equal(res.status, 503, `overview ${JSON.stringify(overview)}`);
      assert.equal(res.text, "market state unavailable");
      assert.equal(res.json, undefined, "must not return a successful empty payload");
    }
  });

  it("returns 500 without leaking a stack trace when the engine throws", async () => {
    globalThis._marketEngine = {
      overview: () => {
        throw new Error("boom internal detail");
      },
    };
    const res = await handleSignalsRequest({});
    assert.equal(res.status, 500);
    assert.equal(res.text, "failed to generate AI signals");
    assert.ok(!res.text.includes("boom"), "must not leak the internal message");
    assert.doesNotMatch(res.text, /Error:|at\s+\S+:\d+:\d+/);
  });

  it("returns 500 without leaking a stack trace for an unexpected failure", async () => {
    globalThis._marketEngine = {
      overview: () => {
        throw new TypeError("cannot read properties of undefined");
      },
    };
    const res = await handleSignalsRequest({});
    assert.equal(res.status, 500);
    assert.equal(res.text, "failed to generate AI signals");
    assert.doesNotMatch(res.text, /TypeError|at\s+\S+:\d+:\d+/);
  });

  it("still serves a caller-supplied summary when live state is unavailable", async () => {
    // A supplied summary is a complete input on its own; it must not need engines.
    const res = await handleSignalsRequest({ summary: { markets: [market("solo", 2, 100)] } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "summary");
  });
});
