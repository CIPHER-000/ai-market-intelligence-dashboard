import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSignals, SignalsError, SIGNALS_RULE_VERSION } from "../lib/aiSignals.js";
import { buildDashboardSummary } from "../lib/dashboardSummary.js";

/** Minimal valid compact market, mirroring dashboardSummary.compactMarket(). */
function market(over = {}) {
  return {
    id: "btc-usdt",
    pair: "BTC-USDT",
    base: "BTC",
    quote: "USDT",
    mark_price: 66420,
    change_24h_pct: 2,
    volume_24h: 1_000_000,
    ...over,
  };
}

/** Every signal must satisfy the documented bounds. */
function assertBounds(signals) {
  for (const s of signals) {
    assert.ok(s.score >= 0 && s.score <= 1, `score out of range: ${s.score}`);
    assert.ok(s.confidence >= 0 && s.confidence <= 1, `confidence out of range: ${s.confidence}`);
    assert.ok(["opportunity", "risk"].includes(s.type), `bad type: ${s.type}`);
  }
}

describe("aiSignals output contract", () => {
  const summary = {
    markets: [
      market({ id: "btc-usdt", pair: "BTC-USDT", change_24h_pct: 2, volume_24h: 1_000_000 }),
      market({ id: "eth-usdt", pair: "ETH-USDT", mark_price: 3245, change_24h_pct: -1, volume_24h: 500_000 }),
    ],
  };

  it("returns the documented top-level shape", () => {
    const out = generateSignals(summary);
    assert.equal(out.source, "heuristic");
    assert.equal(out.model, null);
    assert.ok(Array.isArray(out.signals));
    assert.ok(Array.isArray(out.warnings));
    assert.equal(out.universe, "markets");
    assert.equal(SIGNALS_RULE_VERSION, "signals-heuristic-v1");
  });

  it("emits signals with exactly the required keys", () => {
    const [first] = generateSignals(summary).signals;
    assert.deepEqual(Object.keys(first), [
      "id",
      "pair",
      "market_id",
      "type",
      "score",
      "confidence",
      "headline",
      "reason",
      "evidence",
    ]);
    assert.deepEqual(Object.keys(first.evidence), ["change_24h_pct", "volume_24h", "mark_price"]);
    assert.equal(first.id, "opportunity-btc-usdt");
  });

  it("scores with the documented rule (0.7 magnitude + 0.3 relative volume)", () => {
    const out = generateSignals(summary);
    const btc = out.signals.find((s) => s.market_id === "btc-usdt");
    const eth = out.signals.find((s) => s.market_id === "eth-usdt");
    // 2/(2+5)=0.285714.. *0.7 + 1.0*0.3 = 0.5 ; 1/(1+5)=0.166666.. *0.7 + 0.5*0.3 = 0.2667
    assert.equal(btc.score, 0.5);
    assert.equal(eth.score, 0.2667);
    assertBounds(out.signals);
  });

  it("orders opportunities before risks, each by score desc", () => {
    const out = generateSignals(summary);
    assert.deepEqual(
      out.signals.map((s) => s.type),
      ["opportunity", "risk"],
    );
  });
});

describe("aiSignals evidence integrity", () => {
  // Values captured from the live GET /api/v1/dashboard/summary response.
  const live = {
    id: "render-usdt",
    pair: "RENDER-USDT",
    base: "RENDER",
    quote: "USDT",
    mark_price: 7.2,
    change_24h_pct: 2.0054005480801913,
    volume_24h: 1297474.1427741423,
  };

  it("copies source values verbatim — no rounding or reformatting", () => {
    const [signal] = generateSignals({ markets: [live] }).signals;
    assert.deepEqual(signal.evidence, {
      change_24h_pct: 2.0054005480801913,
      volume_24h: 1297474.1427741423,
      mark_price: 7.2,
    });
    // Evidence stays exact even though the headline is rounded for display.
    assert.equal(signal.headline, "RENDER-USDT up 2.01% over 24h");
    assert.match(signal.reason, /\+2\.01%/);
  });

  it("preserves sub-cent prices exactly", () => {
    const pepe = market({ id: "pepe-usdt", pair: "PEPE-USDT", mark_price: 0.0000098, change_24h_pct: 1.5 });
    const [signal] = generateSignals({ markets: [pepe] }).signals;
    assert.equal(signal.evidence.mark_price, 0.0000098);
    assert.match(signal.reason, /0\.00000980/);
  });

  it("derives reason text from real fields and claims no causation", () => {
    const out = generateSignals({
      markets: [
        market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 2, volume_24h: 1_000_000 }),
        market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: -3, volume_24h: 500_000 }),
      ],
    });
    for (const s of out.signals) {
      assert.ok(s.headline.includes(s.pair), "headline must name its own pair");
      assert.match(s.reason, /\$\d/);
      assert.doesNotMatch(s.reason, /\b(because|due to|caused by|driven by|as a result)\b/i);
      // No other market's pair may leak into this signal's text.
      for (const other of out.signals) {
        if (other.market_id !== s.market_id) assert.ok(!s.reason.includes(other.pair));
      }
    }
  });
});

describe("aiSignals directionality", () => {
  it("classifies a positive change as an opportunity", () => {
    const [s] = generateSignals({ markets: [market({ change_24h_pct: 1.25 })] }).signals;
    assert.equal(s.type, "opportunity");
    assert.match(s.headline, /up 1\.25%/);
  });

  it("classifies a negative change as a risk", () => {
    const [s] = generateSignals({ markets: [market({ change_24h_pct: -1.9 })] }).signals;
    assert.equal(s.type, "risk");
    assert.match(s.headline, /down 1\.90%/);
  });

  it("treats a NEGATIVE mover inside top_gainers as a risk", () => {
    const out = generateSignals({
      top_gainers: [market({ id: "avax-usdt", pair: "AVAX-USDT", change_24h_pct: -1.9 })],
      top_losers: [],
    });
    assert.equal(out.signals.length, 1);
    assert.equal(out.signals[0].type, "risk");
    assert.equal(out.signals[0].id, "risk-avax-usdt");
    assert.ok(
      out.warnings.some((w) => /listed in top_gainers but change_24h_pct is negative/.test(w)),
      `expected a direction-override warning, got: ${JSON.stringify(out.warnings)}`,
    );
  });

  it("treats a POSITIVE mover inside top_losers as an opportunity", () => {
    const out = generateSignals({
      top_gainers: [],
      top_losers: [market({ id: "sui-usdt", pair: "SUI-USDT", change_24h_pct: 1.88 })],
    });
    assert.equal(out.signals.length, 1);
    assert.equal(out.signals[0].type, "opportunity");
    assert.equal(out.signals[0].id, "opportunity-sui-usdt");
    assert.ok(
      out.warnings.some((w) => /listed in top_losers but change_24h_pct is positive/.test(w)),
      `expected a direction-override warning, got: ${JSON.stringify(out.warnings)}`,
    );
  });

  it("scopes a 0% change out of both directions", () => {
    const out = generateSignals({ markets: [market({ change_24h_pct: 0 })] });
    assert.deepEqual(out.signals, []);
    assert.ok(out.warnings.some((w) => /change_24h_pct is 0 and carries no direction/.test(w)));
  });

  // Regression for the real overlap documented in the audit: with fewer than six
  // markets buildDashboardSummary's buckets overlap and each contains the other's
  // direction. Driven through the REAL summary builder, not a hand-made fixture.
  it("handles overlapping summary buckets end to end", async () => {
    const marketEngine = {
      overview() {
        return {
          volume_24h_total: 4000,
          server_ts: 1,
          markets: [
            market({ id: "m0-usdt", pair: "M0-USDT", change_24h_pct: 5, volume_24h: 100 }),
            market({ id: "m1-usdt", pair: "M1-USDT", change_24h_pct: 4, volume_24h: 200 }),
            market({ id: "m2-usdt", pair: "M2-USDT", change_24h_pct: -3, volume_24h: 300 }),
            market({ id: "m3-usdt", pair: "M3-USDT", change_24h_pct: -9, volume_24h: 400 }),
          ],
        };
      },
      isFeedConnected: () => false,
    };
    const matchingEngine = { async listOrders() { return []; } };

    const summary = await buildDashboardSummary(marketEngine, matchingEngine);
    // The producer really does put a negative market in top_gainers:
    assert.ok(summary.top_gainers.some((m) => m.change_24h_pct < 0));
    assert.ok(summary.top_losers.some((m) => m.change_24h_pct > 0));

    const out = generateSignals(summary);
    const byId = Object.fromEntries(out.signals.map((s) => [s.market_id, s.type]));

    assert.deepEqual(byId, {
      "m0-usdt": "opportunity",
      "m1-usdt": "opportunity",
      "m2-usdt": "risk",
      "m3-usdt": "risk",
    });
    // Exactly one signal per market even though m1/m2 sit in both buckets.
    assert.equal(out.signals.length, 4);
    // Both contradictions are surfaced.
    assert.ok(out.warnings.some((w) => /"m2-usdt".*top_gainers.*negative/.test(w)));
    assert.ok(out.warnings.some((w) => /"m1-usdt".*top_losers.*positive/.test(w)));
    assertBounds(out.signals);
  });
});

describe("aiSignals input handling", () => {
  it("prefers the markets array when supplied and ignores the buckets", () => {
    const out = generateSignals({
      markets: [market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 1 })],
      top_gainers: [market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: 9 })],
      top_losers: [market({ id: "c-usdt", pair: "C-USDT", change_24h_pct: -9 })],
    });
    assert.equal(out.universe, "markets");
    assert.deepEqual(out.signals.map((s) => s.market_id), ["a-usdt"]);
  });

  it("falls back to the union of top_gainers and top_losers", () => {
    const out = generateSignals({
      top_gainers: [market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 3 })],
      top_losers: [market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: -3 })],
    });
    assert.equal(out.universe, "summary_buckets");
    assert.deepEqual(out.signals.map((s) => s.market_id).sort(), ["a-usdt", "b-usdt"]);
  });

  it("evaluates a market appearing in both buckets exactly once", () => {
    const dup = market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 3 });
    const out = generateSignals({ top_gainers: [dup], top_losers: [dup] });
    assert.equal(out.signals.length, 1);
    assert.equal(out.signals[0].market_id, "a-usdt");
  });

  it("evaluates duplicate ids in a markets array once, reporting the duplicate", () => {
    const out = generateSignals({
      markets: [
        market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 3 }),
        market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: -3 }),
      ],
    });
    // Never both "opportunity-a-usdt" and "risk-a-usdt" for one market.
    assert.equal(out.signals.length, 1);
    assert.equal(out.signals[0].type, "opportunity"); // first record wins
    assert.ok(
      out.warnings.some((w) => /ignored duplicate record for market "a-usdt" at index 1/.test(w)),
      JSON.stringify(out.warnings),
    );
  });

  it("treats empty arrays as a valid universe with no signals", () => {
    const out = generateSignals({ markets: [], top_gainers: [], top_losers: [] });
    assert.deepEqual(out.signals, []);
    assert.ok(out.warnings.some((w) => /contained no market records/.test(w)));
  });

  it("rejects a structurally unusable summary with BAD_REQUEST", () => {
    for (const bad of [undefined, null, [], "summary", 42, {}, { markets: "nope" }, { top_gainers: 3 }]) {
      assert.throws(
        () => generateSignals(bad),
        (err) => {
          assert.ok(err instanceof SignalsError, `expected SignalsError for ${JSON.stringify(bad)}`);
          assert.equal(err.code, "BAD_REQUEST");
          return true;
        },
      );
    }
  });

  it("rejects an invalid limit with BAD_REQUEST", () => {
    for (const limit of [0, -1, 1.5, "2", NaN]) {
      assert.throws(
        () => generateSignals({ markets: [market()] }, { limit }),
        (err) => {
          assert.ok(err instanceof SignalsError);
          assert.equal(err.code, "BAD_REQUEST");
          return true;
        },
      );
    }
  });

  it("caps signals per type without reordering", () => {
    const mk = (id, change) => market({ id, pair: `${id.toUpperCase()}-USDT`, change_24h_pct: change, volume_24h: 100 });
    const summary = {
      markets: [mk("a-usdt", 1), mk("b-usdt", 2), mk("c-usdt", 3), mk("d-usdt", -1), mk("e-usdt", -2)],
    };
    const all = generateSignals(summary);
    const limited = generateSignals(summary, { limit: 2 });

    assert.equal(all.signals.length, 5);
    assert.equal(limited.signals.length, 4); // 2 opportunities + 2 risks
    assert.deepEqual(
      limited.signals.map((s) => s.id),
      all.signals.slice(0, 2).map((s) => s.id).concat(all.signals.slice(3, 5).map((s) => s.id)),
    );
  });
});

describe("aiSignals invalid and missing data", () => {
  const cases = [
    ["missing mark_price", { mark_price: undefined }, /mark_price must be a positive finite number/],
    ["zero mark_price", { mark_price: 0 }, /mark_price must be a positive finite number/],
    ["negative mark_price", { mark_price: -1 }, /mark_price must be a positive finite number/],
    ["string mark_price", { mark_price: "66420" }, /mark_price must be a positive finite number/],
    ["NaN mark_price", { mark_price: NaN }, /mark_price must be a positive finite number/],
    ["infinite mark_price", { mark_price: Infinity }, /mark_price must be a positive finite number/],
    ["missing change_24h_pct", { change_24h_pct: undefined }, /change_24h_pct must be a finite number/],
    ["string change_24h_pct", { change_24h_pct: "2" }, /change_24h_pct must be a finite number/],
    ["NaN change_24h_pct", { change_24h_pct: NaN }, /change_24h_pct must be a finite number/],
    ["missing volume_24h", { volume_24h: undefined }, /volume_24h must be a non-negative finite number/],
    ["negative volume_24h", { volume_24h: -1 }, /volume_24h must be a non-negative finite number/],
    ["NaN volume_24h", { volume_24h: NaN }, /volume_24h must be a non-negative finite number/],
    ["missing id", { id: undefined }, /id must be a non-empty string/],
    ["blank id", { id: "  " }, /id must be a non-empty string/],
    ["missing pair", { pair: undefined }, /pair must be a non-empty string/],
  ];

  for (const [name, over, expected] of cases) {
    it(`skips a record with ${name}`, () => {
      const out = generateSignals({ markets: [market(over)] });
      assert.deepEqual(out.signals, []);
      assert.ok(
        out.warnings.some((w) => expected.test(w)),
        `expected ${expected} in ${JSON.stringify(out.warnings)}`,
      );
      assert.ok(out.warnings.some((w) => /no signals generated/.test(w)));
    });
  }

  it("never treats a missing volume as zero", () => {
    const out = generateSignals({
      markets: [
        market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 5, volume_24h: undefined }),
        market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: 5, volume_24h: 0 }),
      ],
    });
    // The zero-volume record IS a signal (with reduced confidence); the
    // missing-volume record is not scored at all.
    assert.deepEqual(out.signals.map((s) => s.market_id), ["b-usdt"]);
    assert.equal(out.signals[0].evidence.volume_24h, 0);
    assert.ok(out.warnings.some((w) => /"a-usdt".*volume_24h/.test(w)));
  });

  it("skips non-object records", () => {
    const out = generateSignals({ markets: [null, 42, "btc", []] });
    assert.deepEqual(out.signals, []);
    assert.equal(out.warnings.filter((w) => /record is not an object/.test(w)).length, 4);
  });

  it("keeps valid records when others are invalid", () => {
    const out = generateSignals({
      markets: [market({ id: "ok-usdt", pair: "OK-USDT", change_24h_pct: 2 }), market({ id: "bad-usdt", pair: "BAD-USDT", mark_price: NaN })],
    });
    assert.deepEqual(out.signals.map((s) => s.market_id), ["ok-usdt"]);
    assert.ok(out.warnings.some((w) => /"bad-usdt"/.test(w)));
  });
});

describe("aiSignals scoring behaviour", () => {
  it("is monotonic in move size at equal volume", () => {
    const mk = (id, change) => market({ id, pair: `${id}-USDT`, change_24h_pct: change, volume_24h: 100 });
    const out = generateSignals({ markets: [mk("a", 1), mk("b", 3), mk("c", 8)] });
    const byId = Object.fromEntries(out.signals.map((s) => [s.market_id, s.score]));
    assert.ok(byId.a < byId.b && byId.b < byId.c, JSON.stringify(byId));
  });

  it("rewards relative volume at equal move size", () => {
    const mk = (id, vol) => market({ id, pair: `${id}-USDT`, change_24h_pct: 2, volume_24h: vol });
    const out = generateSignals({ markets: [mk("low", 1), mk("high", 2)] });
    const byId = Object.fromEntries(out.signals.map((s) => [s.market_id, s.score]));
    assert.ok(byId.high > byId.low, JSON.stringify(byId));
  });

  it("stays bounded for extreme inputs", () => {
    const out = generateSignals({
      markets: [
        market({ id: "pump-usdt", pair: "PUMP-USDT", change_24h_pct: 5000, volume_24h: 1e15 }),
        market({ id: "dump-usdt", pair: "DUMP-USDT", change_24h_pct: -5000, volume_24h: 1e15 }),
      ],
    });
    assertBounds(out.signals);
    assert.ok(out.signals.every((s) => s.score > 0.9));
  });

  it("handles an all-zero-volume universe without dividing by zero", () => {
    const out = generateSignals({
      markets: [
        market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 2, volume_24h: 0 }),
        market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: -2, volume_24h: 0 }),
      ],
    });
    assertBounds(out.signals);
    assert.ok(out.signals.every((s) => Number.isFinite(s.score)));
    assert.ok(out.signals.every((s) => !s.reason.includes("% of the largest")));
  });

  it("applies the documented confidence rubric", () => {
    const out = generateSignals({
      markets: [
        market({ id: "traded-usdt", pair: "T-USDT", change_24h_pct: 2, volume_24h: 1000 }),
        market({ id: "quiet-usdt", pair: "Q-USDT", change_24h_pct: 2, volume_24h: 0 }),
      ],
    });
    const byId = Object.fromEntries(out.signals.map((s) => [s.market_id, s.confidence]));
    assert.equal(byId["traded-usdt"], 1);
    assert.equal(byId["quiet-usdt"], 0.5);
  });
});

describe("aiSignals determinism", () => {
  const summary = {
    markets: [
      market({ id: "a-usdt", pair: "A-USDT", change_24h_pct: 2.0054005480801913, volume_24h: 1297474.1427741423 }),
      market({ id: "b-usdt", pair: "B-USDT", change_24h_pct: -1.9, volume_24h: 38000000 }),
      market({ id: "c-usdt", pair: "C-USDT", change_24h_pct: 0.53, volume_24h: 8500000 }),
    ],
  };

  it("produces identical output for repeated identical input", () => {
    assert.deepEqual(generateSignals(summary), generateSignals(summary));
  });

  it("produces identical output for a structurally equal clone", () => {
    const clone = JSON.parse(JSON.stringify(summary));
    assert.deepEqual(generateSignals(summary), generateSignals(clone));
  });

  it("is independent of the caller's clock", async () => {
    const first = generateSignals(summary);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(generateSignals(summary), first);
  });

  it("mutates no input", () => {
    const before = JSON.parse(JSON.stringify(summary));
    generateSignals(summary);
    assert.deepEqual(summary, before);
  });
});
