/**
 * Carmlize deterministic signal engine.
 *
 * Contract: structured market data -> scored, evidence-backed signals.
 *
 * This module is deliberately PURE and DEPENDENCY-FREE:
 *   - no network, no LLM, no filesystem, no Date.now(), no Math.random()
 *   - no locale-dependent formatting (no toLocaleString / localeCompare)
 *   - identical inputs always produce identical `signals`
 * The HTTP route owns the clock (`generated_at`) and any logging, so the
 * engine itself stays reproducible and independently testable.
 *
 * Input
 * -----
 * A dashboard summary (see lib/dashboardSummary.js), optionally carrying the
 * full market array:
 *   { markets?: Market[], top_gainers?: Market[], top_losers?: Market[] }
 * Candidate universe: `markets` when it is a non-empty array, otherwise the
 * union of `top_gainers` and `top_losers`, de-duplicated by `id`.
 *
 * DIRECTION IS ALWAYS DERIVED FROM METRICS, NEVER FROM THE BUCKET LABEL.
 * `top_gainers` / `top_losers` are positional slices produced by
 * buildDashboardSummary, not direction-filtered sets: with fewer than six
 * markets they overlap, and `top_gainers` can contain a market whose
 * change_24h_pct is negative.
 *
 * Required market fields, validated (never coerced, never defaulted):
 *   id                 non-empty string
 *   pair               non-empty string
 *   mark_price         number, finite and > 0
 *   change_24h_pct     number, finite
 *   volume_24h         number, finite and >= 0
 * A record failing any check is skipped and reported in `warnings`. Missing or
 * invalid values are never treated as zero, and are never substituted.
 *
 * Scoring — documented, bounded, deterministic
 * -------------------------------------------
 *   magnitude    = |change_24h_pct| / (|change_24h_pct| + 5)              in [0,1)
 *                  Saturating and monotonic in |change|, so ranking always
 *                  follows move size. `+5` means "a 5% move scores 0.5 on the
 *                  magnitude component"; the constant is stated rather than
 *                  tuned, and works for both the ~+-2% seeded markets and
 *                  larger real moves.
 *   volumeWeight = volume_24h / maxVolume                                 in [0,1]
 *                  Relative liquidity inside the same evaluated universe,
 *                  where maxVolume is the largest 24h volume among the
 *                  field-valid markets of that universe. 0 when maxVolume is
 *                  not positive (all-zero volumes).
 *   score        = clamp01(0.70 * magnitude + 0.30 * volumeWeight), 4 dp
 *
 * `score` is NORMALIZED SIGNAL STRENGTH. It is not a probability, not an
 * expected return, and not a profit forecast. Scores are relative to the
 * universe evaluated in a single call.
 *
 * Confidence — documented, bounded, deterministic
 * ----------------------------------------------
 * Confidence describes how well the signal's inputs are supported, using only
 * measurable properties of the record:
 *   +0.5  required fields validated and in range (true for every emitted signal)
 *   +0.5  volume_24h > 0, i.e. the move is backed by actual trading activity
 * => 1 for markets with traded volume, 0.5 for zero-volume markets.
 *
 * Freshness and feed provenance are deliberately NOT scored. `feed_connected`
 * describes the upstream connector, not the validity of these numbers, and no
 * per-market staleness metadata exists in the data model. Scoring wall-clock
 * staleness would also require Date.now() and would break determinism.
 * Confidence is NOT a probability of profit and NOT a prediction.
 *
 * Output
 * ------
 *   { signals, source: "heuristic", model: null, warnings: string[], universe }
 * `signals` lists opportunities first, then risks, each ordered by score desc,
 * then |change_24h_pct| desc, then market_id asc (a total, stable order).
 * Signal ids are stable: `${type}-${market_id}`, and each market yields at most
 * one signal.
 * `warnings` records every skipped or adjusted record in a deterministic order;
 * it is `[]` when the whole universe was scored cleanly. It is additive: the
 * required response fields are unchanged.
 * `universe` ("markets" | "summary_buckets") reports which array supplied the
 * candidate universe, so the provenance of a payload is inspectable.
 * `generated_at` is added by the route, not here.
 */

/** Version id for server-side logging (which rule set produced a payload). */
export const SIGNALS_RULE_VERSION = "signals-heuristic-v1";

const SCORE_DECIMALS = 4;
/** |change| at which the magnitude component reaches 0.5. */
const MAGNITUDE_HALF_SATURATION_PCT = 5;
const MAGNITUDE_WEIGHT = 0.7;
const VOLUME_WEIGHT = 0.3;
/** Confidence rubric weights. */
const CONFIDENCE_VALIDITY_WEIGHT = 0.5;
const CONFIDENCE_VOLUME_WEIGHT = 0.5;

const SOURCE_HEURISTIC = "heuristic";

/** Mirrors the MatchError convention in lib/matchingEngine.js. */
export class SignalsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SignalsError";
    this.code = code;
  }
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** Locale-independent rounding; normalises -0 to 0. */
function round(n, decimals) {
  return Number(n.toFixed(decimals)) + 0;
}

function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return null;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new SignalsError("BAD_REQUEST", "limit must be a positive integer");
  }
  return limit;
}

/**
 * Candidate universe.
 *
 * Structural rules:
 *   - `summary` must be a plain object.
 *   - At least one of `markets` / `top_gainers` / `top_losers` must be an array,
 *     otherwise the caller has not supplied a dashboard summary -> BAD_REQUEST.
 *   - An array that is present but EMPTY is valid input describing no markets.
 *   - A market is identified by `id`; duplicates are collapsed to a single
 *     evaluation (first record wins) so a market can never produce two
 *     contradictory signals. Genuine duplicate records are reported.
 */
function extractCandidates(summary) {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new SignalsError("BAD_REQUEST", "summary must be an object");
  }

  const hasMarkets = Array.isArray(summary.markets);
  const hasGainers = Array.isArray(summary.top_gainers);
  const hasLosers = Array.isArray(summary.top_losers);

  if (!hasMarkets && !hasGainers && !hasLosers) {
    throw new SignalsError(
      "BAD_REQUEST",
      "summary must include a markets, top_gainers, or top_losers array",
    );
  }

  // One unified pass for both paths, so duplicate handling is identical either
  // way. A market is identified by `id`:
  //   - the same id seen twice from the SAME origin is a duplicate record: the
  //     first is kept and the rest are reported;
  //   - the same id seen from DIFFERENT origins is the documented bucket
  //     overlap: the origins are merged so both contradictions can be reported,
  //     and the market is still evaluated once.
  const items =
    hasMarkets && summary.markets.length > 0
      ? summary.markets.map((m) => ({ market: m, origin: "markets" }))
      : [
          ...(hasGainers ? summary.top_gainers.map((m) => ({ market: m, origin: "top_gainers" })) : []),
          ...(hasLosers ? summary.top_losers.map((m) => ({ market: m, origin: "top_losers" })) : []),
        ];

  const universe = hasMarkets && summary.markets.length > 0 ? "markets" : "summary_buckets";
  const byId = new Map();
  const entries = [];
  const duplicates = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const id = item.market && typeof item.market === "object" ? item.market.id : undefined;
    if (!isNonEmptyString(id)) {
      entries.push({ market: item.market, origins: [item.origin] });
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      if (existing.origins.includes(item.origin)) {
        duplicates.push({ id, index: i });
      } else {
        existing.origins.push(item.origin);
      }
      continue;
    }
    const created = { market: item.market, origins: [item.origin] };
    byId.set(id, created);
    entries.push(created);
  }

  return { entries, universe, duplicates };
}

/**
 * Field validation. Returns either the accepted metrics or a reason string.
 * Values are read as-is: no parsing, no coercion, no defaults.
 */
function validateMarket(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "record is not an object" };
  }
  if (!isNonEmptyString(record.id)) {
    return { ok: false, reason: "id must be a non-empty string" };
  }
  if (!isNonEmptyString(record.pair)) {
    return { ok: false, reason: "pair must be a non-empty string" };
  }
  if (!isFiniteNumber(record.mark_price) || record.mark_price <= 0) {
    return { ok: false, reason: "mark_price must be a positive finite number" };
  }
  if (!isFiniteNumber(record.change_24h_pct)) {
    return { ok: false, reason: "change_24h_pct must be a finite number" };
  }
  if (!isFiniteNumber(record.volume_24h) || record.volume_24h < 0) {
    return { ok: false, reason: "volume_24h must be a non-negative finite number" };
  }
  return {
    ok: true,
    market: {
      id: record.id,
      pair: record.pair,
      mark_price: record.mark_price,
      change_24h_pct: record.change_24h_pct,
      volume_24h: record.volume_24h,
    },
  };
}

function describeRecord(record, index) {
  if (record && typeof record === "object" && isNonEmptyString(record.id)) {
    return `market "${record.id}"`;
  }
  return `market at index ${index}`;
}

/* ── display formatting (presentation only; never feeds evidence) ────────── */

function pctDecimals(absPct) {
  return absPct > 0 && absPct < 0.01 ? 4 : 2;
}

/**
 * Display formatters. Exported so the brief renders metrics exactly the way
 * signals do — one source of truth for units and precision. They format for
 * humans only; evidence always carries raw source values.
 */

/** Signed percentage with its unit, e.g. "+2.01%" / "-1.90%". */
export function fmtPct(v) {
  const a = Math.abs(v);
  return `${v >= 0 ? "+" : "-"}${a.toFixed(pctDecimals(a))}%`;
}

/** Unsigned percentage with its unit, e.g. "2.01%". */
export function fmtAbsPct(v) {
  const a = Math.abs(v);
  return `${a.toFixed(pctDecimals(a))}%`;
}

/** Locale-independent price ladder; keeps sub-cent prices readable. */
export function fmtPrice(n) {
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a < 0.000001) return n.toFixed(10);
  if (a < 0.01) return n.toFixed(8);
  if (a < 1000) return n.toFixed(4);
  return n.toFixed(2);
}

/** Quote-currency (USDT) volume. */
export function fmtVol(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function magnitudeComponent(changePct) {
  const a = Math.abs(changePct);
  return a / (a + MAGNITUDE_HALF_SATURATION_PCT);
}

function volumeComponent(volume, maxVolume) {
  if (!(maxVolume > 0)) return 0;
  return volume / maxVolume;
}

function toSignal(scored, maxVolume) {
  const change = scored.change_24h_pct;
  const type = change > 0 ? "opportunity" : "risk";

  const magnitude = magnitudeComponent(change);
  const volumeWeight = volumeComponent(scored.volume_24h, maxVolume);
  const score = round(clamp01(MAGNITUDE_WEIGHT * magnitude + VOLUME_WEIGHT * volumeWeight), SCORE_DECIMALS);

  // Required fields were validated, so the validity half of the rubric holds.
  const confidence = round(
    CONFIDENCE_VALIDITY_WEIGHT * 1 +
      CONFIDENCE_VOLUME_WEIGHT * (scored.volume_24h > 0 ? 1 : 0),
    SCORE_DECIMALS,
  );

  const directionWord = type === "opportunity" ? "up" : "down";
  const shareClause =
    maxVolume > 0
      ? ` (${((scored.volume_24h / maxVolume) * 100).toFixed(1)}% of the largest 24h volume in the evaluated universe)`
      : "";

  return {
    id: `${type}-${scored.id}`,
    pair: scored.pair,
    market_id: scored.id,
    type,
    score,
    confidence,
    headline: `${scored.pair} ${directionWord} ${fmtAbsPct(change)} over 24h`,
    reason:
      `24h change ${fmtPct(change)} at a mark price of ${fmtPrice(scored.mark_price)} ` +
      `with ${fmtVol(scored.volume_24h)} of 24h volume${shareClause}. ` +
      `Metrics only; no cause is inferred.`,
    // Evidence carries the SOURCE VALUES VERBATIM: no rounding, no reformatting,
    // no derived or substituted numbers.
    evidence: {
      change_24h_pct: change,
      volume_24h: scored.volume_24h,
      mark_price: scored.mark_price,
    },
  };
}

function compareSignals(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const am = Math.abs(a.evidence.change_24h_pct);
  const bm = Math.abs(b.evidence.change_24h_pct);
  if (bm !== am) return bm - am;
  if (a.market_id === b.market_id) return 0;
  return a.market_id < b.market_id ? -1 : 1;
}

/**
 * Score a dashboard summary into grounded opportunity/risk signals.
 *
 * @param {any} summary dashboard summary, optionally with a full `markets` array
 * @param {{ limit?: number }} [opts] `limit` caps signals PER TYPE (opportunity, risk)
 * @returns {{ signals: any[]; source: string; model: null; warnings: string[] }}
 * @throws {SignalsError} code BAD_REQUEST when `summary` or `limit` is unusable
 */
export function generateSignals(summary, opts = {}) {
  const limit = normalizeLimit(opts?.limit);
  const { entries, universe, duplicates } = extractCandidates(summary);
  const warnings = [];
  const scored = [];

  for (const dup of duplicates) {
    warnings.push(`ignored duplicate record for market "${dup.id}" at index ${dup.index}`);
  }

  for (let i = 0; i < entries.length; i++) {
    const { market, origins } = entries[i];
    const check = validateMarket(market);
    if (!check.ok) {
      warnings.push(`skipped ${describeRecord(market, i)}: ${check.reason}`);
      continue;
    }

    const record = check.market;
    if (record.change_24h_pct === 0) {
      warnings.push(`skipped market "${record.id}": change_24h_pct is 0 and carries no direction`);
      continue;
    }

    const type = record.change_24h_pct > 0 ? "opportunity" : "risk";
    if (origins.includes("top_gainers") && type === "risk") {
      warnings.push(
        `market "${record.id}" was listed in top_gainers but change_24h_pct is negative; classified as risk from its metrics`,
      );
    }
    if (origins.includes("top_losers") && type === "opportunity") {
      warnings.push(
        `market "${record.id}" was listed in top_losers but change_24h_pct is positive; classified as opportunity from its metrics`,
      );
    }

    scored.push(record);
  }

  // Reference volume for relative weighting: field-valid markets in this universe.
  let maxVolume = 0;
  for (const record of scored) {
    if (record.volume_24h > maxVolume) maxVolume = record.volume_24h;
  }

  const all = scored.map((record) => toSignal(record, maxVolume));
  const opportunities = all.filter((s) => s.type === "opportunity").sort(compareSignals);
  const risks = all.filter((s) => s.type === "risk").sort(compareSignals);

  const signals = [
    ...(limit === null ? opportunities : opportunities.slice(0, limit)),
    ...(limit === null ? risks : risks.slice(0, limit)),
  ];

  if (signals.length === 0) {
    warnings.push(
      entries.length === 0
        ? "summary contained no market records to evaluate"
        : `no signals generated from ${entries.length} candidate market record(s)`,
    );
  }

  return {
    signals,
    source: SOURCE_HEURISTIC,
    model: null,
    warnings,
    // Which array supplied the universe; useful for inspecting provenance.
    universe,
  };
}
