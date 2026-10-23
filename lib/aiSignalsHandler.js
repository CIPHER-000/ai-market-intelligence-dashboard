/**
 * Request handling for POST /api/v1/ai/signals.
 *
 * Why this lives in lib/ rather than in the route file
 * ---------------------------------------------------
 * Route files must import `next/server` to build a NextResponse. Next 14.2.33
 * ships no `exports` map in its package.json, so the extensionless `next/server`
 * specifier only resolves inside Next's bundler — plain `node --test` cannot
 * import a route module (verified: ERR_MODULE_NOT_FOUND). Keeping the request
 * logic here, free of any Next import, lets the existing `node:test` suite cover
 * request validation, universe selection, grounding and failure handling
 * directly. `app/api/v1/ai/signals/route.js` is then a thin adapter that only
 * maps this result onto NextResponse.
 *
 * Responsibilities (and nothing else):
 *   - delegate body parsing / validation / universe selection to lib/aiRequest.js,
 *   - delegate ALL scoring to lib/aiSignals.js,
 *   - map outcomes onto status codes following this repo's conventions.
 *
 * Error conventions (mirroring the dashboard-summary and brief routes):
 *   - plain-text bodies, never JSON errors, never stack traces,
 *   - 400 for a bad request, 503 while engines warm up / state is unavailable,
 *     500 for anything unexpected.
 */

import { generateSignals, SignalsError, SIGNALS_RULE_VERSION } from "./aiSignals.js";
import { parseJsonBody, resolveMarketUniverse } from "./aiRequest.js";

function textResponse(status, message) {
  return { status, text: message };
}

function jsonResponse(status, payload) {
  return { status, json: payload };
}

/**
 * Route entry point: parse the raw body, then handle it.
 *
 * @param {unknown} raw raw request body text
 * @returns {Promise<{ status: number; json?: any; text?: string }>}
 */
export async function handleSignalsRawBody(raw) {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return textResponse(400, parsed.reason);
  return handleSignalsRequest(parsed.body);
}

/**
 * Build the response for POST /api/v1/ai/signals from an already-parsed body.
 *
 * @param {any} body parsed JSON request body
 * @returns {Promise<{ status: number; json?: any; text?: string }>}
 */
export async function handleSignalsRequest(body) {
  const startedAt = Date.now();

  try {
    const universe = await resolveMarketUniverse(body);
    if (!universe.ok) return textResponse(universe.status, universe.text);

    const result = generateSignals(universe.summary);

    console.log(
      `[ai] signals source=${result.source} model=${result.model} rule=${SIGNALS_RULE_VERSION} ` +
        `data_source=${universe.dataSource} universe=${result.universe} signals=${result.signals.length} ` +
        `warnings=${result.warnings.length} latency_ms=${Date.now() - startedAt}`,
    );

    return jsonResponse(200, {
      signals: result.signals,
      source: result.source,
      model: result.model,
      generated_at: Math.floor(Date.now() / 1000),
      warnings: result.warnings,
      universe: result.universe,
      data_source: universe.dataSource,
    });
  } catch (e) {
    // Invalid summary structure surfaced by the engine is a client error.
    if (e instanceof SignalsError) return textResponse(400, e.message);

    const message = e?.message ?? "ai signals unavailable";
    if (String(message).includes("not ready")) return textResponse(503, "service warming up");

    console.error("[ai] signals failed:", message);
    return textResponse(500, "failed to generate AI signals");
  }
}
