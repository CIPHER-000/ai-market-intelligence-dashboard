/**
 * Request handling for GET/POST /api/v1/ai/brief.
 *
 * Lives in lib/ for the same reason as lib/aiSignalsHandler.js: a Next route
 * module cannot be imported by `node --test` (Next 14.2.33 has no `exports` map,
 * so `next/server` only resolves inside Next's bundler). Keeping the request
 * logic here, free of any Next import, keeps it covered by the test suite.
 *
 * Flow: resolve the market universe (lib/aiRequest.js) -> score it
 * (lib/aiSignals.js) -> compose a grounded brief (lib/aiBrief.js). The signals
 * are generated once and passed to the brief so the two can never disagree.
 *
 * Error conventions match the signals endpoint: plain-text bodies, 400 for a
 * bad request, 503 while engines warm up or state is unavailable, 500
 * otherwise, and never a stack trace.
 */

import { generateSignals, SignalsError, SIGNALS_RULE_VERSION } from "./aiSignals.js";
import { BRIEF_PROMPT_VERSION, generateMarketBrief } from "./aiBrief.js";
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
 * @param {unknown} raw raw request body text ("" for a bodyless GET)
 * @returns {Promise<{ status: number; json?: any; text?: string }>}
 */
export async function handleBriefRawBody(raw) {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) return textResponse(400, parsed.reason);
  return handleBriefRequest(parsed.body);
}

/**
 * Build the response for the AI brief endpoint from an already-parsed body.
 *
 * @param {any} body parsed JSON request body
 * @returns {Promise<{ status: number; json?: any; text?: string }>}
 */
export async function handleBriefRequest(body) {
  const startedAt = Date.now();

  try {
    const universe = await resolveMarketUniverse(body, { withDeskContext: true });
    if (!universe.ok) return textResponse(universe.status, universe.text);

    // Scored once, then shared with the brief so both agree by construction.
    const signalsResult = generateSignals(universe.summary);

    const result = await generateMarketBrief(universe.summary, {
      question: body?.question,
      signals: signalsResult,
    });

    console.log(
      `[ai] brief source=${result.source} model=${result.model} rule=${SIGNALS_RULE_VERSION} ` +
        `prompt=${BRIEF_PROMPT_VERSION} data_source=${universe.dataSource} universe=${signalsResult.universe} ` +
        `signals_used=${result.signals_used.length} citations=${result.citations.length} ` +
        `latency_ms=${Date.now() - startedAt}`,
    );

    return jsonResponse(200, {
      brief: result.brief,
      citations: result.citations,
      signals_used: result.signals_used,
      source: result.source,
      model: result.model,
      generated_at: Math.floor(Date.now() / 1000),
      warnings: signalsResult.warnings,
      universe: signalsResult.universe,
      data_source: universe.dataSource,
    });
  } catch (e) {
    // A structurally unusable summary is a client error.
    if (e instanceof SignalsError) return textResponse(400, e.message);

    const message = e?.message ?? "ai brief unavailable";
    if (String(message).includes("not ready")) return textResponse(503, "service warming up");

    console.error("[ai] brief failed:", message);
    return textResponse(500, "failed to generate AI brief");
  }
}
