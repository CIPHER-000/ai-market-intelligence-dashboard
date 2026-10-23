import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { MatchingEngine, MatchError } from "../lib/matchingEngine.js";
import { formatPrice, quoteDp } from "../lib/merge.js";
import { buildDashboardSummary } from "../lib/dashboardSummary.js";
import { buildHeuristicBrief, generateMarketBrief } from "../lib/aiBrief.js";

describe("merge.formatPrice", () => {
  it("formats prices to the requested decimals", () => {
    assert.equal(formatPrice(1234.56789, 2), "1234.57");
    assert.equal(formatPrice(0.01234567, 4), "0.0123");
    assert.equal(quoteDp("ETH"), 8);
  });
});

describe("MatchingEngine", () => {
  async function tempEngine() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "carmlize-match-"));
    const file = path.join(dir, "orders.json");
    return { engine: new MatchingEngine(file), dir };
  }

  it("submits and lists an open limit order (happy path)", async () => {
    const { engine, dir } = await tempEngine();
    const now = Math.floor(Date.now() / 1000);
    const { order } = await engine.submit("btc-usdt", "buy", "limit", 64000, 0.5, now);
    assert.equal(order.market_id, "btc-usdt");
    assert.equal(order.status, "open");
    assert.equal(order.size_remaining, 0.5);

    const listed = await engine.listOrders("btc-usdt", true);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, order.id);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects non-positive size (validation error)", async () => {
    const { engine, dir } = await tempEngine();
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(
      () => engine.submit("btc-usdt", "buy", "limit", 64000, 0, now),
      (err) => {
        assert.ok(err instanceof MatchError);
        assert.equal(err.code, "BAD_REQUEST");
        assert.match(err.message, /size must be positive/i);
        return true;
      },
    );
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("fails cancelling a non-existent order", async () => {
    const { engine, dir } = await tempEngine();
    await assert.rejects(
      () => engine.cancel("00000000-0000-4000-8000-000000000000"),
      (err) => {
        assert.ok(err instanceof MatchError);
        assert.equal(err.code, "NOT_FOUND");
        return true;
      },
    );
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("buildDashboardSummary", () => {
  it("aggregates markets, gainers/losers, and open orders", async () => {
    const marketEngine = {
      overview() {
        return {
          volume_24h_total: 150,
          server_ts: 1,
          markets: [
            { id: "a", pair: "A-USDT", base: "A", quote: "USDT", mark_price: 1, change_24h_pct: 5, volume_24h: 50 },
            { id: "b", pair: "B-USDT", base: "B", quote: "USDT", mark_price: 2, change_24h_pct: -3, volume_24h: 100 },
            { id: "c", pair: "C-USDT", base: "C", quote: "USDT", mark_price: 3, change_24h_pct: 1, volume_24h: 0 },
          ],
        };
      },
      isFeedConnected() {
        return true;
      },
    };
    const matchingEngine = {
      async listOrders() {
        return [{ id: "1" }, { id: "2" }];
      },
    };

    const summary = await buildDashboardSummary(marketEngine, matchingEngine);
    assert.equal(summary.active_markets, 3);
    assert.equal(summary.volume_24h_total, 150);
    assert.equal(summary.open_orders_count, 2);
    assert.equal(summary.feed_connected, true);
    assert.equal(summary.top_gainers[0].id, "a");
    assert.equal(summary.top_losers[0].id, "b");
  });
});

describe("aiBrief", () => {
  const sample = {
    active_markets: 2,
    volume_24h_total: 1_000_000,
    open_orders_count: 1,
    feed_connected: false,
    top_gainers: [
      { id: "btc-usdt", pair: "BTC-USDT", base: "BTC", quote: "USDT", mark_price: 1, change_24h_pct: 4.2, volume_24h: 500000 },
    ],
    top_losers: [
      { id: "eth-usdt", pair: "ETH-USDT", base: "ETH", quote: "USDT", mark_price: 1, change_24h_pct: -2.1, volume_24h: 400000 },
    ],
  };

  it("builds a heuristic brief from desk metrics", () => {
    const brief = buildHeuristicBrief(sample, "What is the risk?");
    assert.match(brief, /BTC-USDT/);
    assert.match(brief, /ETH-USDT/);
    assert.match(brief, /risk/i);
  });

  it("generateMarketBrief falls back without OPENAI_API_KEY", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const out = await generateMarketBrief(sample, {});
    assert.equal(out.source, "heuristic");
    assert.match(out.brief, /Carmlize desk brief/);
    if (prev != null) process.env.OPENAI_API_KEY = prev;
  });
});
