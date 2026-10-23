import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { handleBriefRawBody, handleBriefRequest } from "../lib/aiBriefHandler.js";
import { validateBriefText } from "../lib/aiBrief.js";

/**
 * Tests for the /api/v1/ai/brief request layer (lib/aiBriefHandler.js), driven
 * exactly as the route calls it. Engine singletons are placed on `globalThis`
 * the same way client/server.js does.
 */

const REQUIRED_FIELDS = ["brief", "citations", "signals_used", "source", "model", "generated_at"];
const ADDITIVE_FIELDS = ["warnings", "universe", "data_source"];

const realKey = process.env.OPENAI_API_KEY;

function clearEngines() {
  delete globalThis._marketEngine;
  delete globalThis._matchingEngine;
}

function market(id, change, volume, price) {
  return {
    id,
    pair: `${id.toUpperCase()}-USDT`,
    base: id.toUpperCase(),
    quote: "USDT",
    mark_price: price,
    change_24h_pct: change,
    volume_24h: volume,
  };
}

function universe(size = 8) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const change = i % 2 === 0 ? (i + 1) / 2 : -((i + 1) / 2);
    out.push(market(`m${i}`, change, 1_000_000 + i * 1000, 10 + i));
  }
  return out;
}

/** Both engines, as the brief's desk context needs the matching engine too. */
function installEngines(markets = universe()) {
  globalThis._marketEngine = {
    overview: () => ({ volume_24h_total: 5_000_000, server_ts: 1, markets }),
    isFeedConnected: () => true,
  };
  globalThis._matchingEngine = { listOrders: async () => [] };
}

beforeEach(() => {
  clearEngines();
  delete process.env.OPENAI_API_KEY;
});

after(() => {
  clearEngines();
  if (realKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = realKey;
});

describe("POST /api/v1/ai/brief — success", () => {
  it("returns the required fields plus grounded citations", async () => {
    installEngines();
    const res = await handleBriefRequest({});

    assert.equal(res.status, 200);
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in res.json, `missing required field: ${field}`);
    }
    for (const field of ADDITIVE_FIELDS) {
      assert.ok(field in res.json, `missing additive field: ${field}`);
    }
    assert.equal(res.json.source, "heuristic");
    assert.equal(res.json.model, null);
    assert.equal(res.json.data_source, "server");
    assert.ok(Number.isInteger(res.json.generated_at));
    assert.ok(Array.isArray(res.json.citations));
    assert.ok(Array.isArray(res.json.signals_used));
    assert.ok(res.json.citations.length > 0);
    assert.ok(res.json.signals_used.length > 0);
  });

  it("uses the full live universe and cites its real values", async () => {
    const markets = universe(8);
    installEngines(markets);
    const res = await handleBriefRequest({});

    assert.ok(res.json.citations.length > 0);
    const byId = new Map(markets.map((m) => [m.id, m]));
    for (const c of res.json.citations) {
      const src = byId.get(c.market_id);
      assert.ok(src, `citation for unknown market ${c.market_id}`);
      assert.equal(c.value, src[c.field], `citation ${c.field} must be verbatim`);
    }
    assert.match(res.json.brief, /Tracking 8 markets/);
  });

  it("mentions no market pair outside the cited signals", async () => {
    installEngines();
    const res = await handleBriefRequest({});
    const allowed = res.json.signals_used.map((id) => ({ id, pair: id.replace(/^\w+-/, "").toUpperCase() + "-USDT" }));
    assert.equal(validateBriefText(res.json.brief, allowed).ok, true);
  });

  it("supports the optional question", async () => {
    installEngines();
    const res = await handleBriefRequest({ question: "What is the biggest risk?" });
    assert.equal(res.status, 200);
    assert.match(res.json.brief, /Question: "What is the biggest risk\?"/);
  });

  it("serves the bodyless GET path", async () => {
    installEngines();
    const res = await handleBriefRawBody("");
    assert.equal(res.status, 200);
    assert.match(res.json.brief, /Carmlize desk brief/);
  });

  it("keeps signatures/ids in the documented shape", async () => {
    installEngines();
    const res = await handleBriefRequest({});
    for (const c of res.json.citations) {
      assert.deepEqual(Object.keys(c), ["market_id", "field", "value"]);
      assert.ok(["change_24h_pct", "volume_24h", "mark_price"].includes(c.field));
    }
  });
});

describe("POST /api/v1/ai/brief — caller-supplied summary", () => {
  it("uses the supplied summary and never merges server state", async () => {
    installEngines();
    const res = await handleBriefRequest({
      summary: { markets: [market("solo", 3, 12345, 7.5)] },
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "summary");
    assert.deepEqual(res.json.signals_used, ["opportunity-solo"]);
    assert.match(res.json.brief, /SOLO-USDT/);
    assert.doesNotMatch(res.json.brief, /M0-USDT|M1-USDT/);
    assert.deepEqual(res.json.citations, [
      { market_id: "solo", field: "change_24h_pct", value: 3 },
      { market_id: "solo", field: "volume_24h", value: 12345 },
      { market_id: "solo", field: "mark_price", value: 7.5 },
    ]);
  });

  it("works without any engine when a summary is supplied", async () => {
    const res = await handleBriefRequest({ summary: { markets: [market("solo", -2, 10, 1)] } });
    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "summary");
    assert.equal(res.json.signals_used.length, 1);
  });
});

describe("POST /api/v1/ai/brief — validation and failure", () => {
  it("returns 400 for malformed JSON instead of falling back to server state", async () => {
    installEngines();
    const res = await handleBriefRawBody("not-json-at-all");
    assert.equal(res.status, 400);
    assert.equal(res.text, "request body must be valid JSON");
    assert.equal(res.json, undefined);
  });

  it("returns 400 for a malformed summary", async () => {
    installEngines();
    for (const summary of ["garbage", 42, []]) {
      const res = await handleBriefRequest({ summary });
      assert.equal(res.status, 400, `summary ${JSON.stringify(summary)}`);
      assert.equal(res.text, "summary must be an object");
    }
  });

  it("returns 400 for a summary with no usable market array", async () => {
    installEngines();
    const res = await handleBriefRequest({ summary: { active_markets: 8 } });
    assert.equal(res.status, 400);
    assert.match(res.text, /summary must include a markets, top_gainers, or top_losers array/);
  });

  it("creates both engines on demand when nothing has primed them", async () => {
    // The accessors build the engines lazily, which is what lets the app serve
    // requests on a platform with no long-lived process to boot them.
    clearEngines();
    const res = await handleBriefRequest({});
    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "server");
    assert.ok(res.json.citations.length > 0);
  });

  it("creates the matching engine on demand for the desk context", async () => {
    globalThis._marketEngine = { overview: () => ({ markets: universe() }) };
    const res = await handleBriefRequest({});
    assert.equal(res.status, 200);
    assert.equal(res.json.data_source, "server");
  });

  it("returns 503 rather than a fabricated empty brief", async () => {
    installEngines([]);
    const res = await handleBriefRequest({});
    assert.equal(res.status, 503);
    assert.equal(res.text, "market state unavailable");
    assert.equal(res.json, undefined);
  });

  it("returns 500 without leaking a stack trace", async () => {
    globalThis._marketEngine = {
      overview: () => {
        throw new Error("boom internal detail");
      },
    };
    const res = await handleBriefRequest({});
    assert.equal(res.status, 500);
    assert.equal(res.text, "failed to generate AI brief");
    assert.doesNotMatch(res.text, /boom|Error:|at\s+\S+:\d+:\d+/);
  });
});
