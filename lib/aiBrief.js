/**
 * Carmlize grounded market brief.
 *
 * Pipeline
 * --------
 *   structured market data -> lib/aiSignals.js -> THIS MODULE -> brief text
 *
 * The brief never derives numbers itself. Every figure it prints is copied from
 * a validated signal's `evidence`, so a brief cannot state a metric that the
 * signal set does not already contain.
 *
 * Grounding guarantees (enforced in code, not just in a prompt)
 * ------------------------------------------------------------
 *   1. `citations` are exactly the (market_id, field, value) triples the brief
 *      prints, with values copied verbatim from signal evidence.
 *   2. `signals_used` lists the real ids of the signals the brief is built from.
 *   3. No market pair appears in the text unless it came from a signal.
 *   4. Optional model output is treated as UNTRUSTED: it may only reword the
 *      deterministic brief, and it is rejected outright if it references a pair
 *      that is not in the signal set (see validateBriefText). Rejection degrades
 *      to the deterministic brief with source "heuristic_fallback".
 *
 * The deterministic path is the baseline and needs no API key.
 */

import {
  generateSignals,
  fmtAbsPct,
  fmtPrice,
  fmtVol,
  SIGNALS_RULE_VERSION,
} from "./aiSignals.js";

/** Identifies the wording/prompt contract used for a brief payload. */
export const BRIEF_PROMPT_VERSION = "brief-v1";

/** Question cap, matching the previous route-level truncation. */
export const MAX_QUESTION_LENGTH = 500;

/** How many signals per type the brief cites (signals are score-ordered). */
export const CITED_SIGNALS_PER_TYPE = 5;

const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Completion budget. Reasoning models spend part of this on reasoning tokens
 * before writing any prose, so the old 450 was easy to exhaust and produced
 * truncated or empty completions.
 */
const DEFAULT_MAX_TOKENS = 900;

/** OPENAI_MAX_TOKENS when it parses to a positive integer, else the default. */
function resolveMaxTokens() {
  const raw = process.env.OPENAI_MAX_TOKENS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_TOKENS;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : DEFAULT_MAX_TOKENS;
}

/**
 * Provider endpoint. Defaults to the OpenAI API, and can be pointed at any
 * OpenAI-compatible provider with OPENAI_BASE_URL, e.g. OpenRouter:
 *   OPENAI_BASE_URL=https://openrouter.ai/api/v1
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** OPENAI_BASE_URL with trailing slashes removed, or the default endpoint. */
function resolveBaseUrl() {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/**
 * Quote currencies used when no signal set is available. The data model quotes
 * everything in USDT, and hardcoding base assets such as BTC or ETH here made
 * "OPPORTUNITY-BTC" (from a signal id) look like a market pair.
 */
const FALLBACK_QUOTE_CURRENCIES = ["USDT"];

/** Quote currencies actually present in the signal set, longest first. */
function quoteCurrenciesFrom(signals) {
  const quotes = new Set();
  for (const s of signals ?? []) {
    const pair = String(s?.pair ?? "");
    const at = pair.lastIndexOf("-");
    if (at > 0) {
      const q = pair.slice(at + 1).toUpperCase();
      if (q) quotes.add(q);
    }
  }
  const list = quotes.size ? [...quotes] : FALLBACK_QUOTE_CURRENCIES;
  // Longest first so "USDT" is preferred over a shorter prefix like "USD".
  return list.sort((a, b) => b.length - a.length);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches BASE-QUOTE tokens using the quote currencies supplied. */
function pairPatternFor(quotes) {
  const alt = quotes.map(escapeRegex).join("|");
  return new RegExp(`\\b[A-Z0-9]{2,12}-(?:${alt})\\b`, "g");
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Truncates and sanitises the optional analyst question. */
export function normaliseQuestion(question) {
  if (typeof question !== "string") return "";
  return question.trim().slice(0, MAX_QUESTION_LENGTH);
}

/**
 * Feed state, reported straight from the `feed_connected` field. Deliberately
 * does not claim the data is "simulated" or stale: that field describes the
 * upstream connector, not the provenance or freshness of these numbers.
 */
function feedLabel(summary) {
  if (summary?.feed_connected === true) return "connected";
  if (summary?.feed_connected === false) return "not connected";
  return "unknown";
}

/** Aggregate desk context, including only the fields actually supplied. */
function deskContextLine(summary) {
  const parts = [];
  if (isFiniteNumber(summary?.active_markets)) parts.push(`${summary.active_markets} markets`);
  if (isFiniteNumber(summary?.volume_24h_total)) {
    parts.push(`${fmtVol(summary.volume_24h_total)} combined 24h volume`);
  }
  if (isFiniteNumber(summary?.open_orders_count)) {
    parts.push(`${summary.open_orders_count} open orders`);
  }
  return parts.length ? `Tracking ${parts.join(", ")}.` : null;
}

function directionWord(type) {
  return type === "opportunity" ? "up" : "down";
}

/** One cited line, rendered only from the signal's own evidence. */
function signalLine(signal) {
  const e = signal.evidence;
  return (
    `- ${signal.pair} ${directionWord(signal.type)} ${fmtAbsPct(e.change_24h_pct)} over 24h, ` +
    `mark price ${fmtPrice(e.mark_price)}, ${fmtVol(e.volume_24h)} 24h volume, ` +
    `score ${signal.score}, confidence ${signal.confidence}`
  );
}

/** Citations are exactly the evidence fields the brief prints, verbatim. */
function buildCitations(signals) {
  const out = [];
  for (const s of signals) {
    out.push({ market_id: s.market_id, field: "change_24h_pct", value: s.evidence.change_24h_pct });
    out.push({ market_id: s.market_id, field: "volume_24h", value: s.evidence.volume_24h });
    out.push({ market_id: s.market_id, field: "mark_price", value: s.evidence.mark_price });
  }
  return out;
}

function describeFor(list) {
  return list
    .map((s) => `${s.pair} ${directionWord(s.type)} ${fmtAbsPct(s.evidence.change_24h_pct)}`)
    .join(", ");
}

/** Answer composed only from the signals already cited — nothing else. */
function answerQuestion(opportunities, risks) {
  const parts = [];
  if (risks.length) parts.push(`top ${risks.length} risk signal(s): ${describeFor(risks)}`);
  if (opportunities.length) {
    parts.push(`top ${opportunities.length} opportunity signal(s): ${describeFor(opportunities)}`);
  }
  if (!parts.length) {
    return "Answer: no directional signals were generated from the evaluated markets, so this question cannot be answered from the current evidence.";
  }
  return `Answer from the current signal set — ${parts.join("; ")}.`;
}

/**
 * Build a grounded brief plus the evidence it cites.
 *
 * @param {any} summary dashboard summary (optionally carrying `markets`)
 * @param {string} [question] optional analyst question
 * @param {{ signals?: any }} [opts] reuse an existing signals result
 * @returns {{ brief: string; citations: any[]; signals_used: string[] }}
 */
export function buildGroundedBrief(summary, question, opts = {}) {
  const signalsResult = opts.signals ?? generateSignals(summary);
  const all = signalsResult.signals;

  const opportunities = all.filter((s) => s.type === "opportunity").slice(0, CITED_SIGNALS_PER_TYPE);
  const risks = all.filter((s) => s.type === "risk").slice(0, CITED_SIGNALS_PER_TYPE);
  const cited = [...opportunities, ...risks];

  const oppTotal = all.filter((s) => s.type === "opportunity").length;
  const riskTotal = all.filter((s) => s.type === "risk").length;

  const lines = [`Carmlize desk brief (upstream feed: ${feedLabel(summary)}).`];

  const context = deskContextLine(summary);
  if (context) lines.push(context);

  if (all.length === 0) {
    lines.push(
      "No directional signals were generated from the evaluated markets, so no opportunity or risk calls are reported.",
    );
  } else {
    lines.push(
      `Signal set (rule ${SIGNALS_RULE_VERSION}): ${oppTotal} opportunity and ${riskTotal} risk signal(s).`,
    );
  }

  if (opportunities.length) {
    lines.push(`Opportunity signals (top ${opportunities.length} of ${oppTotal} by strength score):`);
    for (const s of opportunities) lines.push(signalLine(s));
  }
  if (risks.length) {
    lines.push(`Risk signals (top ${risks.length} of ${riskTotal} by strength score):`);
    for (const s of risks) lines.push(signalLine(s));
  }

  lines.push(
    "Scores are normalized heuristic strength, not probabilities of profit, and confidence reflects input completeness, not predictive certainty. Every figure above is listed in citations.",
  );

  const q = normaliseQuestion(question);
  if (q) {
    lines.push(`Question: "${q}"`);
    lines.push(answerQuestion(opportunities, risks));
  }

  return {
    brief: lines.join("\n"),
    citations: buildCitations(cited),
    signals_used: cited.map((s) => s.id),
  };
}

/**
 * Backwards-compatible text-only brief.
 *
 * Preserved for existing callers/tests; it is now composed from grounded
 * signals rather than from raw gainers/losers prose.
 *
 * @param {any} summary
 * @param {string} [question]
 * @returns {string}
 */
export function buildHeuristicBrief(summary, question) {
  return buildGroundedBrief(summary, question).brief;
}

/**
 * Pair-shaped tokens present in a piece of text, e.g. "BTC-USDT".
 * Only tokens whose quote currency is one of `quotes` count, so a signal id in
 * prose ("opportunity-btc-usdt") is read as "BTC-USDT" rather than as a bogus
 * "OPPORTUNITY-BTC" market, and version ids such as "signals-heuristic-v1" are
 * not mistaken for markets at all.
 *
 * @param {unknown} text
 * @param {string[]} [quotes] quote currencies to recognise
 * @returns {string[]}
 */
export function findReferencedPairs(text, quotes = FALLBACK_QUOTE_CURRENCIES) {
  if (typeof text !== "string") return [];
  const matches = text.toUpperCase().match(pairPatternFor(quotes)) ?? [];
  return [...new Set(matches)];
}

/**
 * Validate untrusted (model-generated) brief text against the signal set.
 *
 * Rejects text that references a pair no signal supports, and also text that
 * mentions none of the supported pairs at all. The second rule matters because
 * a generic or unrelated completion (a safety verdict, a refusal, boilerplate)
 * is otherwise "valid" and would replace a perfectly good deterministic brief.
 *
 * @param {unknown} text
 * @param {any[]} signals
 * @returns {{ ok: boolean; unknownPairs: string[] }}
 */
export function validateBriefText(text, signals) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, unknownPairs: [] };
  }
  const allowed = new Set((signals ?? []).map((s) => String(s.pair).toUpperCase()));
  const referenced = findReferencedPairs(text, quoteCurrenciesFrom(signals));
  const unknownPairs = referenced.filter((p) => !allowed.has(p));
  if (unknownPairs.length) return { ok: false, unknownPairs };

  // With no signals there is nothing to mention, so the pair rule does not apply.
  if (allowed.size === 0) return { ok: true, unknownPairs: [] };
  const mentionsSupportedPair = referenced.some((p) => allowed.has(p));
  return { ok: mentionsSupportedPair, unknownPairs: [] };
}

function buildPrompt(groundedBrief, signalsResult, question) {
  const ids = signalsResult.signals.map((s) => s.id);
  return [
    "Rewrite the deterministic desk brief below so it reads naturally. You may improve wording and flow ONLY.",
    "",
    "Hard rules:",
    "- Do not add, remove, round, or alter any number, price, percentage, volume, or market pair.",
    "- Do not introduce a market that is not already present.",
    "- Do not claim causes, predictions, or investment advice.",
    "- Keep it under 12 short sentences.",
    "",
    "Deterministic brief:",
    groundedBrief,
    "",
    `Signals available: ${ids.length ? ids.join(", ") : "(none)"}`,
    question ? `Analyst question: ${question}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Generate the market brief.
 *
 * Without OPENAI_API_KEY this returns the deterministic grounded brief
 * (source "heuristic") — the required baseline. With a key, the model may only
 * reword that brief; citations and signals_used always come from the
 * deterministic layer, never from the model.
 *
 * OPENAI_BASE_URL picks the provider (default: the OpenAI API), OPENAI_MODEL
 * picks the model, OPENAI_API_KEY supplies the bearer token and
 * OPENAI_MAX_TOKENS sets the completion budget. Any OpenAI-compatible
 * chat-completions endpoint works, including OpenRouter.
 *
 * @param {any} summary dashboard summary (optionally carrying `markets`)
 * @param {{ question?: string; signals?: any }} [opts]
 * @returns {Promise<{ brief: string; citations: any[]; signals_used: string[]; source: string; model: string | null }>}
 */
export async function generateMarketBrief(summary, opts = {}) {
  const question = normaliseQuestion(opts.question);
  const signalsResult = opts.signals ?? generateSignals(summary);
  const grounded = buildGroundedBrief(summary, question, { signals: signalsResult });

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const baseUrl = resolveBaseUrl();
  const maxTokens = resolveMaxTokens();

  if (!apiKey) {
    return { ...grounded, source: "heuristic", model: null };
  }

  const prompt = buildPrompt(grounded.brief, signalsResult, question);

  try {
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content:
              "You rewrite crypto market briefs without changing a single figure. " +
              "You never invent prices, volumes, pairs, or causes. Plain text paragraphs only.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!r.ok) {
      console.warn(`[ai] brief: model unavailable (HTTP ${r.status}); using deterministic brief`);
      return { ...grounded, source: "heuristic_fallback", model };
    }

    const data = await r.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      console.warn("[ai] brief: empty model response; using deterministic brief");
      return { ...grounded, source: "heuristic_fallback", model };
    }

    // A completion cut short by the token budget, or filtered by the provider,
    // is not usable prose even though it looks like a string.
    const finish = choice?.finish_reason;
    if (finish === "length" || finish === "content_filter") {
      console.warn(`[ai] brief: incomplete model response (${finish}); using deterministic brief`);
      return { ...grounded, source: "heuristic_fallback", model };
    }

    // Model output is untrusted: it must stay inside the signal set and must
    // actually talk about it. Generic or unrelated completions are rejected.
    const check = validateBriefText(text, signalsResult.signals);
    if (!check.ok) {
      const detail = check.unknownPairs.length
        ? `unsupported pairs: ${check.unknownPairs.join(", ")}`
        : "no supported market mentioned";
      console.warn(`[ai] brief: model output rejected (${detail}); using deterministic brief`);
      return { ...grounded, source: "heuristic_fallback", model };
    }

    return { ...grounded, brief: text, source: "openai", model };
  } catch (e) {
    console.warn(`[ai] brief: model call failed (${e?.message ?? String(e)}); using deterministic brief`);
    return { ...grounded, source: "heuristic_fallback", model };
  }
}
