#!/usr/bin/env node
/**
 * Carmlize AI evaluation harness — `npm run eval:ai`.
 *
 * A small, dependency-free golden-set evaluation of the deterministic AI
 * pipeline (lib/aiSignals.js -> lib/aiBrief.js). It runs entirely offline:
 * no HTTP server, no API key, no network, no ML framework.
 *
 * What it checks, per fixture in client/test/fixtures/ai/:
 *   schema      required keys, value types, score/confidence within [0, 1]
 *   grounding   every evidence value equals the fixture's source market, and no
 *               evidence exists for a market that is not in the fixture
 *   direction   opportunity signals have change > 0, risk signals have change < 0
 *   brief       citations equal the source values verbatim; signals_used are
 *               real signal ids; the brief text names no unsupported pair
 *   no-key path generateMarketBrief returns source "heuristic" with no API key
 *   stability   two runs over identical input produce identical signals
 *   latency     heuristic scoring stays under a soft per-fixture budget
 *
 * Exits non-zero if any check fails, so it is usable in CI.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateSignals } from "../lib/aiSignals.js";
import { buildGroundedBrief, generateMarketBrief, validateBriefText } from "../lib/aiBrief.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "..", "test", "fixtures", "ai");

/** Soft budget for the heuristic path, per fixture. */
const LATENCY_BUDGET_MS = 200;

const SIGNAL_KEYS = [
  "id",
  "pair",
  "market_id",
  "type",
  "score",
  "confidence",
  "headline",
  "reason",
  "evidence",
];
const EVIDENCE_KEYS = ["change_24h_pct", "volume_24h", "mark_price"];
const RESPONSE_KEYS = ["signals", "source", "model", "warnings"];
/** Contract of the deterministic composition layer (buildGroundedBrief). */
const BRIEF_KEYS = ["brief", "citations", "signals_used"];
/** Contract of the full generated brief, once generation metadata is attached. */
const GENERATED_BRIEF_KEYS = ["brief", "citations", "signals_used", "source", "model"];

let passed = 0;
const failures = [];

function expect(condition, label, detail = "") {
  if (condition) {
    passed++;
    return true;
  }
  failures.push(detail ? `${label} — ${detail}` : label);
  return false;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Every market record a fixture offers as evidence, whatever path supplies it. */
function sourceMarkets(summary) {
  const records = Array.isArray(summary.markets) && summary.markets.length > 0
    ? summary.markets
    : [...(summary.top_gainers ?? []), ...(summary.top_losers ?? [])];
  const byId = new Map();
  for (const r of records) {
    if (r && typeof r === "object" && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r);
  }
  return byId;
}

function checkSignals(label, fixture, result, latencyMs) {
  const summary = fixture.summary ?? {};
  const sources = sourceMarkets(summary);
  const { signals } = result;

  for (const key of RESPONSE_KEYS) {
    expect(key in result, `${label}: response has "${key}"`);
  }
  expect(result.source === "heuristic", `${label}: source is heuristic`, result.source);
  expect(result.model === null, `${label}: model is null`);
  expect(Array.isArray(result.warnings), `${label}: warnings is an array`);
  expect(Array.isArray(signals), `${label}: signals is an array`);
  expect(
    latencyMs < LATENCY_BUDGET_MS,
    `${label}: heuristic latency < ${LATENCY_BUDGET_MS}ms`,
    `${latencyMs.toFixed(1)}ms`,
  );

  for (const s of signals) {
    const tag = `${label}:signal(${s?.id ?? "?"})`;
    expect(
      JSON.stringify(Object.keys(s ?? {})) === JSON.stringify(SIGNAL_KEYS),
      `${tag}: has exactly the required keys`,
      Object.keys(s ?? {}).join(","),
    );
    expect(s.type === "opportunity" || s.type === "risk", `${tag}: type is opportunity|risk`, s.type);
    expect(isFiniteNumber(s.score) && s.score >= 0 && s.score <= 1, `${tag}: score in [0,1]`, String(s.score));
    expect(
      isFiniteNumber(s.confidence) && s.confidence >= 0 && s.confidence <= 1,
      `${tag}: confidence in [0,1]`,
      String(s.confidence),
    );
    expect(typeof s.headline === "string" && s.headline.length > 0, `${tag}: headline is non-empty`);
    expect(typeof s.reason === "string" && s.reason.length > 0, `${tag}: reason is non-empty`);
    expect(
      JSON.stringify(Object.keys(s.evidence ?? {})) === JSON.stringify(EVIDENCE_KEYS),
      `${tag}: evidence has exactly the documented fields`,
      Object.keys(s.evidence ?? {}).join(","),
    );
    expect(s.id === `${s.type}-${s.market_id}`, `${tag}: id is "<type>-<market_id>"`, s.id);

    // Grounding: evidence must equal the fixture's source record, verbatim.
    const src = sources.get(s.market_id);
    if (!expect(Boolean(src), `${tag}: market exists in the fixture summary`)) continue;
    for (const field of EVIDENCE_KEYS) {
      expect(
        s.evidence[field] === src[field],
        `${tag}: evidence.${field} equals the fixture summary`,
        `${s.evidence[field]} vs ${src[field]}`,
      );
    }

    // Direction always follows the metric.
    if (s.type === "opportunity") {
      expect(s.evidence.change_24h_pct > 0, `${tag}: opportunity has change > 0`);
    } else {
      expect(s.evidence.change_24h_pct < 0, `${tag}: risk has change < 0`);
    }
  }

  // No evidence for markets outside the fixture.
  for (const s of signals) {
    expect(sources.has(s.market_id), `${label}: no signal for an unknown market`, s.market_id);
  }

  // Declared expectations.
  const exp = fixture.expect ?? {};
  if (exp.signal_count !== undefined) {
    expect(signals.length === exp.signal_count, `${label}: signal_count = ${exp.signal_count}`, String(signals.length));
  }
  if (exp.opportunity_count !== undefined) {
    const n = signals.filter((s) => s.type === "opportunity").length;
    expect(n === exp.opportunity_count, `${label}: opportunity_count = ${exp.opportunity_count}`, String(n));
  }
  if (exp.risk_count !== undefined) {
    const n = signals.filter((s) => s.type === "risk").length;
    expect(n === exp.risk_count, `${label}: risk_count = ${exp.risk_count}`, String(n));
  }
  if (exp.min_warnings !== undefined) {
    expect(
      result.warnings.length >= exp.min_warnings,
      `${label}: at least ${exp.min_warnings} warning(s)`,
      String(result.warnings.length),
    );
  }
  if (exp.universe !== undefined) {
    expect(result.universe === exp.universe, `${label}: universe = ${exp.universe}`, String(result.universe));
  }
  const firstOf = (type) => signals.find((s) => s.type === type)?.pair;
  if (exp.top_opportunity_pair !== undefined) {
    expect(
      firstOf("opportunity") === exp.top_opportunity_pair,
      `${label}: top opportunity is ${exp.top_opportunity_pair}`,
      String(firstOf("opportunity")),
    );
  }
  if (exp.top_risk_pair !== undefined) {
    expect(firstOf("risk") === exp.top_risk_pair, `${label}: top risk is ${exp.top_risk_pair}`, String(firstOf("risk")));
  }
  for (const pair of exp.pairs_present ?? []) {
    expect(signals.some((s) => s.pair === pair), `${label}: signal present for ${pair}`);
  }
  for (const pair of exp.pairs_absent ?? []) {
    expect(!signals.some((s) => s.pair === pair), `${label}: no signal for excluded ${pair}`);
  }

  // Determinism.
  const again = generateSignals(fixture.summary);
  expect(
    JSON.stringify(again.signals) === JSON.stringify(signals),
    `${label}: identical input produces identical signals`,
  );

  return sources;
}

function checkBrief(label, fixture, signalsResult, sources) {
  const grounded = buildGroundedBrief(fixture.summary, "", { signals: signalsResult });

  for (const key of BRIEF_KEYS) {
    expect(key in grounded, `${label}:brief has "${key}"`);
  }
  expect(Array.isArray(grounded.citations), `${label}:brief citations is an array`);
  expect(Array.isArray(grounded.signals_used), `${label}:brief signals_used is an array`);
  expect(typeof grounded.brief === "string" && grounded.brief.length > 0, `${label}:brief is non-empty`);

  // signals_used must reference signals that actually exist.
  const validIds = new Set(signalsResult.signals.map((s) => s.id));
  for (const id of grounded.signals_used) {
    expect(validIds.has(id), `${label}:brief signals_used references a real signal`, id);
  }
  expect(
    new Set(grounded.signals_used).size === grounded.signals_used.length,
    `${label}:brief signals_used has no duplicates`,
  );

  // Citations must equal the fixture's source values, verbatim.
  for (const c of grounded.citations) {
    const src = sources.get(c.market_id);
    if (!expect(Boolean(src), `${label}:brief citation references a fixture market`, c.market_id)) continue;
    expect(
      c.value === src[c.field],
      `${label}:brief citation ${c.field} equals the fixture summary`,
      `${c.value} vs ${src[c.field]}`,
    );
  }
  expect(
    grounded.citations.length === grounded.signals_used.length * EVIDENCE_KEYS.length,
    `${label}:brief cites every evidence field of every used signal`,
    `${grounded.citations.length} citations / ${grounded.signals_used.length} signals`,
  );

  // The brief text may not name a pair the signals do not support.
  const textCheck = validateBriefText(grounded.brief, signalsResult.signals);
  expect(textCheck.ok, `${label}:brief text is grounded in the signal set`, textCheck.unknownPairs.join(","));
  expect(
    !/\b(because|due to|caused by|driven by)\b/i.test(grounded.brief),
    `${label}:brief makes no causal claim`,
  );
}

async function main() {
  if (!fs.existsSync(FIXTURE_DIR)) {
    console.error(`No fixture directory at ${FIXTURE_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`No fixtures found in ${FIXTURE_DIR}`);
    process.exit(1);
  }

  console.log(`Carmlize AI eval — ${files.length} fixture(s) from client/test/fixtures/ai/\n`);
  const rows = [];

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
    const label = fixture.name ?? file;

    const started = performance.now();
    let result;
    try {
      result = generateSignals(fixture.summary);
    } catch (e) {
      expect(false, `${label}: generateSignals must not throw`, e?.message ?? String(e));
      rows.push({ label, summary: "threw", ok: false });
      continue;
    }
    const latencyMs = performance.now() - started;

    const sources = checkSignals(label, fixture, result, latencyMs);
    checkBrief(label, fixture, result, sources);

    // No-key path: the deterministic baseline must work without credentials.
    const savedKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const noKey = await generateMarketBrief(fixture.summary, { signals: result });
      for (const key of GENERATED_BRIEF_KEYS) {
        expect(key in noKey, `${label}: generated brief has "${key}"`);
      }
      expect(noKey.source === "heuristic", `${label}: brief source is heuristic without a key`, noKey.source);
      expect(noKey.model === null, `${label}: brief model is null without a key`);
      expect(typeof noKey.brief === "string" && noKey.brief.length > 0, `${label}: brief has text without a key`);
      expect(
        Array.isArray(noKey.citations) && noKey.citations.length > 0,
        `${label}: brief carries citations without a key`,
      );
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
    }

    const opp = result.signals.filter((s) => s.type === "opportunity").length;
    const risk = result.signals.filter((s) => s.type === "risk").length;
    rows.push({
      label,
      summary: `${result.signals.length} signals (${opp} opp / ${risk} risk), ${result.warnings.length} warnings, ${latencyMs.toFixed(1)}ms`,
      ok: true,
    });
  }

  for (const row of rows) {
    console.log(`  ${row.ok ? "✓" : "✗"} ${row.label.padEnd(28)} ${row.summary}`);
  }

  console.log(`\nChecks: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("Result: PASS");
}

main().catch((e) => {
  console.error("eval crashed:", e?.message ?? String(e));
  process.exit(1);
});
