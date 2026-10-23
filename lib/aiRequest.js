/**
 * Shared request handling for the AI endpoints (/api/v1/ai/signals and
 * /api/v1/ai/brief).
 *
 * This module exists so both AI endpoints parse bodies, validate caller input
 * and choose a market universe in exactly one place. It imports no Next.js
 * module, which keeps it testable with `node --test`.
 *
 * Request body handling
 * ---------------------
 *   - no body / whitespace only -> no summary supplied -> server state (200)
 *   - valid JSON                -> used as supplied
 *   - MALFORMED JSON            -> 400. It is never silently treated as "no
 *     summary": a broken payload must not be reinterpreted as a request to
 *     evaluate a different dataset than the caller sent.
 *
 * Market universe
 * ---------------
 * By default the universe is the server's canonical live market state — the
 * full market set, never the six-market dashboard summary. A caller may supply
 * `{ summary }` instead (the assessment's documented optional input). It is
 * strictly validated and NEVER merged with server state, so a response can
 * never blend the two; `dataSource` reports which was used.
 *
 * A successful empty result is never fabricated: if live market state is
 * missing or empty the call fails with 503 rather than reporting 200 with
 * nothing in it.
 */

import { getMarketEngine, getMatchingEngine } from "./engines.js";
import { buildDashboardSummary } from "./dashboardSummary.js";

/** Upper bound on caller-supplied records, mirroring the brief's question cap. */
export const MAX_SUMMARY_MARKETS = 500;

export const SOURCE_SERVER = "server";
export const SOURCE_SUMMARY = "summary";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse a raw request body.
 *
 * An absent body (no body / whitespace only) means "no summary supplied".
 * Malformed JSON is reported as a failure so the caller can answer 400 instead
 * of quietly evaluating server state.
 *
 * @param {unknown} raw
 * @returns {{ ok: true; body: any } | { ok: false; reason: string }}
 */
export function parseJsonBody(raw) {
  if (raw === undefined || raw === null) return { ok: true, body: {} };
  const text = String(raw).trim();
  if (text === "") return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "request body must be valid JSON" };
  }
}

/**
 * Validate the parsed body's `summary`, if present.
 *
 * `undefined` / absent / `null` all mean "no summary supplied" and select the
 * server's canonical state. Any other non-object value is a client error rather
 * than being silently ignored, so a malformed payload cannot make an endpoint
 * answer a different question than the caller asked.
 *
 * @param {any} body
 * @returns {{ ok: true; summary: any } | { ok: false; reason: string }}
 */
export function readSummaryInput(body) {
  if (body === undefined || body === null) return { ok: true, summary: undefined };
  if (!isPlainObject(body)) return { ok: false, reason: "request body must be a JSON object" };

  const summary = body.summary;
  if (summary === undefined || summary === null) return { ok: true, summary: undefined };
  if (!isPlainObject(summary)) return { ok: false, reason: "summary must be an object" };

  const sizes = [summary.markets, summary.top_gainers, summary.top_losers]
    .filter(Array.isArray)
    .map((a) => a.length);
  if (sizes.some((n) => n > MAX_SUMMARY_MARKETS)) {
    return { ok: false, reason: `summary exceeds ${MAX_SUMMARY_MARKETS} market records` };
  }

  return { ok: true, summary };
}

/**
 * Choose the market universe for a request.
 *
 * @param {any} body parsed request body
 * @param {{ withDeskContext?: boolean }} [opts] `withDeskContext` also attaches
 *   the aggregate desk metrics (market count, volume, open orders, feed state)
 *   when building from server state. It costs an extra matching-engine read and
 *   is only needed by the brief.
 * @returns {Promise<
 *   { ok: true; summary: any; dataSource: string } |
 *   { ok: false; status: number; text: string }
 * >}
 * @throws when the engines are not ready yet ("not ready"), which callers map
 *   to 503 following the dashboard-summary and brief route conventions.
 */
export async function resolveMarketUniverse(body, opts = {}) {
  const input = readSummaryInput(body);
  if (!input.ok) return { ok: false, status: 400, text: input.reason };

  if (input.summary !== undefined) {
    return { ok: true, summary: input.summary, dataSource: SOURCE_SUMMARY };
  }

  // Throws "MarketEngine not ready" while the server is still warming up.
  const marketEngine = getMarketEngine();
  const markets = marketEngine.overview()?.markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    // Refuse to report an empty success for missing upstream state.
    console.error("[ai] market state unavailable: live market state has no markets");
    return { ok: false, status: 503, text: "market state unavailable" };
  }

  if (!opts.withDeskContext) {
    return { ok: true, summary: { markets }, dataSource: SOURCE_SERVER };
  }

  const desk = await buildDashboardSummary(marketEngine, getMatchingEngine());
  return { ok: true, summary: { ...desk, markets }, dataSource: SOURCE_SERVER };
}
