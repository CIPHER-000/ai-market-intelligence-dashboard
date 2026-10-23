import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_PROMPT_VERSION,
  MAX_QUESTION_LENGTH,
  buildGroundedBrief,
  buildHeuristicBrief,
  findReferencedPairs,
  generateMarketBrief,
  normaliseQuestion,
  validateBriefText,
} from "../lib/aiBrief.js";
import { generateSignals, fmtAbsPct, fmtPrice, fmtVol } from "../lib/aiSignals.js";

/**
 * Grounding tests for the brief layer.
 *
 * The brief must never invent market pairs, metrics, evidence values, or signal
 * references. These tests assert that every claim is traceable to a validated
 * signal, and that untrusted (model) text is rejected when it is not.
 */

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

/** 4 up / 4 down, distinct volumes and prices. */
function summaryFixture() {
  return {
    active_markets: 8,
    volume_24h_total: 8_000_000,
    open_orders_count: 3,
    feed_connected: true,
    markets: [
      market("btc", 2.0054005480801913, 1297474.1427741423, 66420),
      market("eth", 1.5, 500_000, 3245.5),
      market("sol", 0.8, 250_000, 142.8),
      market("xrp", 0.25, 100_000, 0.512),
      market("avax", -1.9, 380_000, 34.5),
      market("matic", -1.2, 200_000, 0.72),
      market("inj", -0.6, 120_000, 24.5),
      market("pepe", -0.00002, 90_000, 0.0000098),
    ],
  };
}

describe("aiBrief grounding", () => {
  it("cites exactly the evidence values it prints, verbatim", () => {
    const summary = summaryFixture();
    const signals = generateSignals(summary).signals;
    const { citations, signals_used } = buildGroundedBrief(summary, "");

    assert.ok(citations.length > 0);
    for (const c of citations) {
      const signal = signals.find((s) => s.market_id === c.market_id);
      assert.ok(signal, `citation references unknown market ${c.market_id}`);
      assert.equal(c.value, signal.evidence[c.field], `citation ${c.field} must be verbatim`);
    }
    // Every cited signal is referenced and vice versa.
    const citedIds = new Set(citations.map((c) => c.market_id));
    assert.deepEqual([...citedIds].sort(), [...new Set(signals_used.map((id) => id.replace(/^\w+-/, "")))].sort());
  });

  it("never references a signal id that does not exist", () => {
    const summary = summaryFixture();
    const signals = generateSignals(summary).signals;
    const validIds = new Set(signals.map((s) => s.id));
    const { signals_used } = buildGroundedBrief(summary, "");

    assert.ok(signals_used.length > 0);
    for (const id of signals_used) {
      assert.ok(validIds.has(id), `invented signal reference: ${id}`);
    }
  });

  it("mentions no market pair outside the signal set", () => {
    const summary = summaryFixture();
    const signals = generateSignals(summary).signals;
    const { brief } = buildGroundedBrief(summary, "");

    const check = validateBriefText(brief, signals);
    assert.deepEqual(check.unknownPairs, []);
    assert.equal(check.ok, true);

    // Sanity: a pair that is genuinely absent is detected.
    assert.deepEqual(findReferencedPairs("DOGE-USDT rallied"), ["DOGE-USDT"]);
    assert.equal(validateBriefText("DOGE-USDT rallied", signals).ok, false);
  });

  it("prints only values copied from signal evidence", () => {
    const summary = summaryFixture();
    const signals = generateSignals(summary).signals;
    const { brief, signals_used } = buildGroundedBrief(summary, "");

    for (const id of signals_used) {
      const s = signals.find((x) => x.id === id);
      assert.ok(brief.includes(s.pair), `missing pair ${s.pair}`);
      assert.ok(brief.includes(fmtAbsPct(s.evidence.change_24h_pct)), `missing change for ${s.pair}`);
      assert.ok(brief.includes(fmtPrice(s.evidence.mark_price)), `missing price for ${s.pair}`);
      assert.ok(brief.includes(fmtVol(s.evidence.volume_24h)), `missing volume for ${s.pair}`);
      assert.ok(brief.includes(String(s.score)));
    }
  });

  it("preserves raw evidence values rather than rounded display values", () => {
    const summary = summaryFixture();
    const signals = generateSignals(summary).signals;
    const { citations } = buildGroundedBrief(summary, "");

    const btc = citations.find((c) => c.market_id === "btc" && c.field === "change_24h_pct");
    assert.equal(btc.value, 2.0054005480801913);
    const pepe = citations.find((c) => c.market_id === "pepe" && c.field === "mark_price");
    assert.equal(pepe.value, 0.0000098);
    assert.ok(signals.length > 0);
  });

  it("makes no causal or predictive claims", () => {
    const { brief } = buildGroundedBrief(summaryFixture(), "should I buy?");
    assert.doesNotMatch(brief, /\b(because|due to|caused by|driven by|as a result)\b/i);
    assert.doesNotMatch(brief, /\b(will|expect(ed)? to|forecast|predict|guarantee|sure to)\b/i);
    assert.doesNotMatch(brief, /\b(buy|sell|long|short) (now|today)\b/i);
    assert.match(brief, /not probabilities of profit/);
    assert.match(brief, /not predictive certainty/);
  });

  it("reports feed state from the field without claiming the data is simulated", () => {
    const connected = buildGroundedBrief({ ...summaryFixture(), feed_connected: true }, "").brief;
    const notConnected = buildGroundedBrief({ ...summaryFixture(), feed_connected: false }, "").brief;
    const unknown = buildGroundedBrief({ markets: [market("btc", 1, 10, 2)] }, "").brief;

    assert.match(connected, /upstream feed: connected/);
    assert.match(notConnected, /upstream feed: not connected/);
    assert.match(unknown, /upstream feed: unknown/);
    assert.doesNotMatch(notConnected, /simulated|stale/i);
  });

  it("omits desk aggregates that were not supplied instead of defaulting them", () => {
    const withoutContext = buildGroundedBrief({ markets: [market("btc", 1, 10, 2)] }, "").brief;
    assert.doesNotMatch(withoutContext, /Tracking/);
    assert.doesNotMatch(withoutContext, /open orders/);

    const withContext = buildGroundedBrief(summaryFixture(), "").brief;
    assert.match(withContext, /Tracking 8 markets/);
    assert.match(withContext, /3 open orders/);
  });

  it("handles an empty signal set without inventing signals or citations", () => {
    const empty = { markets: [market("btc", 0, 10, 2)] };
    const out = buildGroundedBrief(empty, "");
    assert.deepEqual(out.citations, []);
    assert.deepEqual(out.signals_used, []);
    assert.match(out.brief, /No directional signals were generated/);
    assert.doesNotMatch(out.brief, /BTC-USDT/);
  });

  it("is deterministic for identical input", () => {
    const a = buildGroundedBrief(summaryFixture(), "what is the risk?");
    const b = buildGroundedBrief(summaryFixture(), "what is the risk?");
    assert.deepEqual(a, b);
  });

  it("keeps the legacy string-returning helper working", () => {
    const text = buildHeuristicBrief(summaryFixture(), "What is the risk?");
    assert.equal(typeof text, "string");
    assert.match(text, /Carmlize desk brief/);
    assert.match(text, /risk/i);
  });

  it("exposes a prompt/version id for logging", () => {
    assert.equal(BRIEF_PROMPT_VERSION, "brief-v1");
  });
});

describe("aiBrief question handling", () => {
  it("echoes a normal question and answers only from cited signals", () => {
    const summary = summaryFixture();
    const { brief } = buildGroundedBrief(summary, "What is the biggest risk?");
    assert.match(brief, /Question: "What is the biggest risk\?"/);
    assert.match(brief, /Answer from the current signal set/);
    // The answer names real pairs only.
    const signals = generateSignals(summary).signals;
    assert.equal(validateBriefText(brief, signals).ok, true);
  });

  it("truncates an oversized question to the documented cap", () => {
    const long = "x".repeat(MAX_QUESTION_LENGTH + 250);
    assert.equal(normaliseQuestion(long).length, MAX_QUESTION_LENGTH);
    assert.ok(!buildGroundedBrief(summaryFixture(), long).brief.includes("x".repeat(MAX_QUESTION_LENGTH + 1)));
  });

  it("ignores a non-string question", () => {
    for (const q of [undefined, null, 42, { text: "hi" }, ["hi"]]) {
      assert.equal(normaliseQuestion(q), "");
      assert.doesNotMatch(buildGroundedBrief(summaryFixture(), q).brief, /Question:/);
    }
  });
});

describe("aiBrief untrusted model output", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  const realModel = process.env.OPENAI_MODEL;
  const realBaseUrl = process.env.OPENAI_BASE_URL;
  const realMaxTokens = process.env.OPENAI_MAX_TOKENS;

  /** Captures the outbound request so the provider contract can be asserted. */
  let captured = null;

  function stubModel(content, ok = true, finishReason) {
    captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return {
        ok,
        status: ok ? 200 : 500,
        json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }] }),
      };
    };
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    captured = null;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    if (realModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = realModel;
    if (realBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = realBaseUrl;
    if (realMaxTokens === undefined) delete process.env.OPENAI_MAX_TOKENS;
    else process.env.OPENAI_MAX_TOKENS = realMaxTokens;
  });

  it("keeps the deterministic path when no API key is present", async () => {
    delete process.env.OPENAI_API_KEY;
    const summary = summaryFixture();
    const out = await generateMarketBrief(summary, {});

    assert.equal(out.source, "heuristic");
    assert.equal(out.model, null);
    assert.match(out.brief, /Carmlize desk brief/);
    assert.ok(out.citations.length > 0);
    assert.ok(out.signals_used.length > 0);
    assert.deepEqual(out, { ...buildGroundedBrief(summary, ""), source: "heuristic", model: null });
  });

  it("makes no provider call at all without a key", async () => {
    delete process.env.OPENAI_API_KEY;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("must not be called");
    };
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(called, false, "the deterministic path must not call the provider");
    assert.equal(out.source, "heuristic");
  });

  it("accepts model text that only uses supported pairs", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubModel("Carmlize desk brief: BTC-USDT leads to the upside while ETH-USDT is the main risk.");
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "openai");
    assert.match(out.brief, /BTC-USDT leads/);
    // Citations still come from the deterministic layer, not the model.
    assert.ok(out.citations.length > 0);
  });

  it("sends the documented request to the chat completions endpoint", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_BASE_URL;
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    await generateMarketBrief(summaryFixture(), {});

    assert.ok(captured, "expected a provider call");
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");
    assert.equal(captured.init.headers.Authorization, "Bearer test-key");
  });

  it("defaults to the OpenAI endpoint when OPENAI_BASE_URL is unset", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    delete process.env.OPENAI_BASE_URL;
    stubModel("Carmlize desk brief: BTC-USDT up.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  });

  it("treats a blank OPENAI_BASE_URL as unset", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "   ";
    stubModel("Carmlize desk brief: BTC-USDT up.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(captured.url, "https://api.openai.com/v1/chat/completions");
  });

  it("sends the request to OPENAI_BASE_URL when set, keeping key and model env-driven", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    process.env.OPENAI_MODEL = "google/gemma-4-31b-it:free";
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    const out = await generateMarketBrief(summaryFixture(), {});

    assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(captured.init.headers.Authorization, "Bearer test-key");
    assert.equal(JSON.parse(captured.init.body).model, "google/gemma-4-31b-it:free");
    assert.equal(out.model, "google/gemma-4-31b-it:free");
  });

  it("normalises trailing slashes and whitespace on OPENAI_BASE_URL", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const expected = "https://openrouter.ai/api/v1/chat/completions";
    for (const configured of [
      "https://openrouter.ai/api/v1/",
      "https://openrouter.ai/api/v1///",
      "  https://openrouter.ai/api/v1  ",
    ]) {
      process.env.OPENAI_BASE_URL = configured;
      stubModel("Carmlize desk brief: BTC-USDT up.");
      await generateMarketBrief(summaryFixture(), {});
      assert.equal(captured.url, expected, `base url ${JSON.stringify(configured)}`);
    }
  });

  it("keeps grounding validation and deterministic citations on a custom provider", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    const summary = summaryFixture();
    const deterministic = buildGroundedBrief(summary, "");

    // A model on another provider still cannot smuggle in an unsupported pair.
    stubModel("Carmlize desk brief: DOGE-USDT is about to explode, buy now.");
    const rejected = await generateMarketBrief(summary, {});
    assert.equal(rejected.source, "heuristic_fallback");
    assert.equal(rejected.brief, deterministic.brief);

    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    const accepted = await generateMarketBrief(summary, {});
    assert.equal(accepted.source, "openai");
    assert.deepEqual(accepted.citations, deterministic.citations);
    assert.deepEqual(accepted.signals_used, deterministic.signals_used);
  });

  it("rejects a provider safety verdict instead of replacing the brief", async () => {
    // Observed for real from openrouter/free: a 17-char safety verdict used to
    // pass validation and overwrite a ~1000-char grounded brief.
    process.env.OPENAI_API_KEY = "test-key";
    const summary = summaryFixture();
    stubModel("User Safety: safe");
    const out = await generateMarketBrief(summary, {});
    assert.equal(out.source, "heuristic_fallback");
    assert.equal(out.brief, buildGroundedBrief(summary, "").brief);
  });

  it("rejects a model refusal", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubModel("I cannot assist with market predictions.");
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "heuristic_fallback");
    assert.match(out.brief, /Carmlize desk brief/);
  });

  it("rejects a completion truncated by the token budget", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const summary = summaryFixture();
    // Content looks plausible but the provider says it was cut off at the limit.
    stubModel("Carmlize desk brief: BTC-USDT up 2.00% and ETH-USDT down 2", true, "length");
    const out = await generateMarketBrief(summary, {});
    assert.equal(out.source, "heuristic_fallback");
    assert.equal(out.brief, buildGroundedBrief(summary, "").brief);
  });

  it("rejects a provider-filtered completion", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.", true, "content_filter");
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "heuristic_fallback");
  });

  it("accepts a normal completion, with or without a finish reason", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.", true, "stop");
    assert.equal((await generateMarketBrief(summaryFixture(), {})).source, "openai");

    // Providers that omit finish_reason must not be treated as truncated.
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    assert.equal((await generateMarketBrief(summaryFixture(), {})).source, "openai");
  });

  it("defaults max_tokens above the old cap and honours OPENAI_MAX_TOKENS", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    delete process.env.OPENAI_MAX_TOKENS;
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(JSON.parse(captured.init.body).max_tokens, 900);

    process.env.OPENAI_MAX_TOKENS = "1500";
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(JSON.parse(captured.init.body).max_tokens, 1500);
  });

  it("falls back to the default max_tokens for unusable values", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    for (const bad of ["", "   ", "abc", "0", "-5", "12.7", "NaN"]) {
      process.env.OPENAI_MAX_TOKENS = bad;
      stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
      await generateMarketBrief(summaryFixture(), {});
      assert.equal(JSON.parse(captured.init.body).max_tokens, 900, `value ${JSON.stringify(bad)}`);
    }
  });

  it("builds the authorization header from the environment, not a literal", async () => {
    process.env.OPENAI_API_KEY = "  another-key  ";
    stubModel("Carmlize desk brief: BTC-USDT up.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(captured.init.headers.Authorization, "Bearer another-key");
  });

  it("honours the OPENAI_MODEL override and defaults to gpt-4o-mini", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    process.env.OPENAI_MODEL = "gpt-4o-mini";
    stubModel("Carmlize desk brief: BTC-USDT up.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(JSON.parse(captured.init.body).model, "gpt-4o-mini");

    process.env.OPENAI_MODEL = "gpt-4.1-nano";
    stubModel("Carmlize desk brief: BTC-USDT up.");
    await generateMarketBrief(summaryFixture(), {});
    assert.equal(JSON.parse(captured.init.body).model, "gpt-4.1-nano");

    delete process.env.OPENAI_MODEL;
    stubModel("Carmlize desk brief: BTC-USDT up.");
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(JSON.parse(captured.init.body).model, "gpt-4o-mini");
    assert.equal(out.model, "gpt-4o-mini");
  });

  it("sends a grounded prompt that forbids changing figures", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const summary = summaryFixture();
    stubModel("Carmlize desk brief: BTC-USDT up, ETH-USDT down.");
    await generateMarketBrief(summary, {});

    const body = JSON.parse(captured.init.body);
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].role, "user");

    // The deterministic brief is the source material, not the raw summary alone.
    assert.ok(body.messages[1].content.includes(buildGroundedBrief(summary, "").brief));
    assert.match(body.messages[1].content, /Do not add, remove, round, or alter any number/);
    // The system prompt carries the no-invention rule too.
    assert.match(body.messages[0].content, /never invent/i);
    assert.ok(Number.isFinite(body.temperature));
    assert.ok(Number.isFinite(body.max_tokens));
  });

  it("keeps citations and signals_used deterministic when model text is accepted", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const summary = summaryFixture();
    const deterministic = buildGroundedBrief(summary, "");

    stubModel("Carmlize desk brief (rewritten): BTC-USDT up, ETH-USDT down.");
    const out = await generateMarketBrief(summary, {});

    assert.equal(out.source, "openai", "model text is used for the prose");
    assert.notEqual(out.brief, deterministic.brief, "prose may be rewritten");
    // ... but the evidence layer must be untouched by the model.
    assert.deepEqual(out.citations, deterministic.citations);
    assert.deepEqual(out.signals_used, deterministic.signals_used);
  });

  it("REJECTS model text referencing an unsupported market pair", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const summary = summaryFixture();
    stubModel("Carmlize desk brief: DOGE-USDT is about to explode, buy now.");

    const out = await generateMarketBrief(summary, {});
    assert.equal(out.source, "heuristic_fallback");
    assert.equal(out.brief, buildGroundedBrief(summary, "").brief);
    assert.doesNotMatch(out.brief, /DOGE-USDT/);
    assert.match(out.brief, /Carmlize desk brief/);
  });

  it("falls back cleanly when the model call fails", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "heuristic_fallback");
    assert.match(out.brief, /Carmlize desk brief/);
  });

  it("falls back cleanly on a non-OK HTTP response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubModel("unused", false);
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "heuristic_fallback");
    assert.match(out.brief, /Carmlize desk brief/);
  });

  it("falls back cleanly on an empty model response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    stubModel("   ");
    const out = await generateMarketBrief(summaryFixture(), {});
    assert.equal(out.source, "heuristic_fallback");
    assert.match(out.brief, /Carmlize desk brief/);
  });
});

describe("aiBrief reference validation helpers", () => {
  const signals = [{ pair: "BTC-USDT" }, { pair: "ETH-USDT" }];

  it("does not mistake version ids or words for market pairs", () => {
    assert.deepEqual(findReferencedPairs("rule signals-heuristic-v1 applied"), []);
    assert.deepEqual(findReferencedPairs("no pairs here at all"), []);
    assert.deepEqual(findReferencedPairs("BTC-USDT"), ["BTC-USDT"]);
  });

  it("deduplicates repeated pairs", () => {
    assert.deepEqual(findReferencedPairs("BTC-USDT and btc-usdt again"), ["BTC-USDT"]);
  });

  it("rejects empty and non-string text", () => {
    for (const text of ["", "   ", null, undefined, 42]) {
      assert.equal(validateBriefText(text, signals).ok, false);
    }
  });

  it("accepts text that stays within the signal set", () => {
    assert.deepEqual(validateBriefText("BTC-USDT and ETH-USDT moved.", signals), {
      ok: true,
      unknownPairs: [],
    });
  });

  it("does not read a signal id in prose as a market pair", () => {
    // Regression: with BTC/ETH in the quote list, "opportunity-btc-usdt"
    // produced a bogus "OPPORTUNITY-BTC" token and rejected valid model output.
    const found = findReferencedPairs("opportunity-btc-usdt", ["USDT"]);
    assert.deepEqual(found, ["BTC-USDT"]);
    assert.ok(!found.includes("OPPORTUNITY-BTC"));
  });

  it("accepts prose that mentions signal ids", () => {
    const withIds = [
      { id: "opportunity-btc-usdt", pair: "BTC-USDT" },
      { id: "risk-eth-usdt", pair: "ETH-USDT" },
    ];
    const text = "The strongest calls this hour are opportunity-btc-usdt and risk-eth-usdt.";
    assert.deepEqual(validateBriefText(text, withIds), { ok: true, unknownPairs: [] });
  });

  it("still catches an invented pair even when a supported one is present", () => {
    const check = validateBriefText("BTC-USDT is up while DOGE-USDT is collapsing.", signals);
    assert.equal(check.ok, false);
    assert.deepEqual(check.unknownPairs, ["DOGE-USDT"]);
  });

  it("rejects generic text that mentions no market", () => {
    for (const text of [
      "User Safety: safe",
      "I cannot help with that request.",
      "Sure, here is a summary of the market.",
      "OK",
    ]) {
      assert.equal(validateBriefText(text, signals).ok, false, JSON.stringify(text));
    }
  });

  it("does not require a pair mention when there are no signals", () => {
    assert.deepEqual(validateBriefText("No directional signals were generated.", []), {
      ok: true,
      unknownPairs: [],
    });
  });
});
