"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useMarketsStream } from "../context/MarketsStreamContext";

type CompactMarket = {
  id: string;
  pair: string;
  base: string;
  quote: string;
  mark_price: number;
  change_24h_pct: number;
  volume_24h: number;
};

type DashboardSummary = {
  active_markets: number;
  volume_24h_total: number;
  top_gainers: CompactMarket[];
  top_losers: CompactMarket[];
  open_orders_count: number;
  feed_connected: boolean;
  server_ts: number;
};

type AiBriefResponse = {
  brief: string;
  citations: { market_id: string; field: string; value: number }[];
  signals_used: string[];
  source: string;
  model: string | null;
  generated_at: number;
  warnings?: string[];
  universe?: string;
  data_source?: string;
};

/** Mirrors the JSON returned by POST /api/v1/ai/signals. */
type Signal = {
  id: string;
  pair: string;
  market_id: string;
  type: "opportunity" | "risk";
  score: number;
  confidence: number;
  headline: string;
  reason: string;
  evidence: {
    change_24h_pct: number;
    volume_24h: number;
    mark_price: number;
  };
};

type SignalsResponse = {
  signals: Signal[];
  source: string;
  model: string | null;
  generated_at: number;
  warnings: string[];
  universe: string;
  data_source: string;
};

/** How many cards to show per side before the "show all" toggle. */
const SIGNAL_PREVIEW_COUNT = 6;

function fmtVol(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(n: number) {
  if (n < 0.000001) return n.toFixed(10);
  if (n < 0.01) return n.toFixed(8);
  if (n < 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Display only — the server owns all scoring. */
function fmtPct(n: number) {
  const a = Math.abs(n);
  const dp = a > 0 && a < 0.01 ? 4 : 2;
  return `${n >= 0 ? "+" : "-"}${a.toFixed(dp)}%`;
}

/**
 * Feed provenance for the signals panel. `feed_connected` reports whether the
 * upstream exchange socket is open, so when it is false the desk is running on
 * the engine's simulated fallback and the values must not read as live data.
 */
function feedProvenanceLabel(feedConnected: boolean | undefined) {
  if (feedConnected === true) return "live feed connected";
  if (feedConnected === false) return "simulated feed · not live exchange data";
  return "feed state unknown";
}

function StatusDot(props: { label: string; tone: "ok" | "warn" | "bad" }) {
  const color = props.tone === "ok" ? "#3b82f6" : props.tone === "warn" ? "#e8b84a" : "#f07178";
  return (
    <span
      className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]"
      style={{ color }}
    >
      <span
        className={props.tone === "ok" ? "dash-live-dot" : undefined}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: color,
          boxShadow: props.tone === "ok" ? `0 0 12px ${color}` : undefined,
        }}
      />
      {props.label}
    </span>
  );
}

function MetricTile(props: { label: string; value: string; hint?: string; delay: number }) {
  return (
    <div
      className="dash-rise relative overflow-hidden px-5 py-5"
      style={{
        animationDelay: `${props.delay}ms`,
        background: "linear-gradient(160deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.015) 100%)",
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.55), transparent)" }}
      />
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">{props.label}</p>
      <p className="mt-3 font-display text-3xl font-semibold tracking-tight text-white">{props.value}</p>
      {props.hint ? <p className="mt-2 text-xs text-white/35">{props.hint}</p> : null}
    </div>
  );
}

function MoversTable(props: {
  title: string;
  accent: string;
  rows: CompactMarket[];
  empty: string;
}) {
  return (
    <section
      className="dash-rise overflow-hidden"
      style={{
        border: "1px solid rgba(255,255,255,0.07)",
        background: "rgba(8,12,18,0.72)",
      }}
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
        <h2 className="font-display text-lg font-semibold tracking-tight text-white">{props.title}</h2>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: props.accent }} />
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {["Market", "Last", "24h", "Volume"].map((h) => (
              <th
                key={h}
                className={
                  h === "Market"
                    ? "px-5 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-white/30"
                    : "px-5 py-3 text-right font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-white/30"
                }
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-5 py-12 text-center text-sm text-white/35">
                {props.empty}
              </td>
            </tr>
          ) : (
            props.rows.map((m, i) => {
              const pos = m.change_24h_pct >= 0;
              return (
                <tr
                  key={m.id}
                  className="dash-row border-t border-white/[0.04] transition-colors"
                  style={{ animationDelay: `${120 + i * 60}ms` }}
                >
                  <td className="px-5 py-3.5">
                    <Link href={`/trade/${m.id}`} className="group inline-flex items-baseline gap-0.5">
                      <span className="text-sm font-semibold text-white group-hover:text-[#3b82f6]">{m.base}</span>
                      <span className="text-sm text-white/30">/{m.quote}</span>
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums text-white/85">
                    {fmtPrice(m.mark_price)}
                  </td>
                  <td
                    className="px-5 py-3.5 text-right font-mono text-sm font-semibold tabular-nums"
                    style={{ color: pos ? "#3b82f6" : "#f07178" }}
                  >
                    {pos ? "+" : ""}
                    {m.change_24h_pct.toFixed(2)}%
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono text-sm tabular-nums text-white/40">
                    {fmtVol(m.volume_24h)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </section>
  );
}

/**
 * One server-generated signal, rendered exactly as returned.
 * The client performs no scoring and invents no references.
 */
function SignalCard(props: { signal: Signal; cited: boolean; delay: number }) {
  const s = props.signal;
  const accent = s.type === "opportunity" ? "#3b82f6" : "#f07178";

  return (
    <article
      className="dash-row px-4 py-4"
      style={{
        animationDelay: `${props.delay}ms`,
        border: "1px solid rgba(255,255,255,0.07)",
        background: "rgba(8,12,18,0.72)",
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.16em]"
              style={{ color: accent }}
            >
              {s.type}
            </span>
            {props.cited ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                cited in brief
              </span>
            ) : null}
          </div>
          <Link href={`/trade/${s.market_id}`} className="mt-1.5 block group">
            <span className="font-display text-base font-semibold text-white group-hover:text-[#3b82f6]">
              {s.pair}
            </span>
          </Link>
          <p className="mt-1 text-sm text-white/70">{s.headline}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">score</p>
          <p className="font-mono text-sm tabular-nums text-white/85">{s.score.toFixed(4)}</p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
            confidence
          </p>
          <p className="font-mono text-sm tabular-nums text-white/85">{s.confidence.toFixed(2)}</p>
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-white/50">{s.reason}</p>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">24h change</dt>
          <dd className="font-mono text-[11px] tabular-nums" style={{ color: accent }}>
            {fmtPct(s.evidence.change_24h_pct)}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">24h volume</dt>
          <dd className="font-mono text-[11px] tabular-nums text-white/70">
            {fmtVol(s.evidence.volume_24h)}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">mark price</dt>
          <dd className="font-mono text-[11px] tabular-nums text-white/70">
            {fmtPrice(s.evidence.mark_price)}
          </dd>
        </div>
      </dl>
    </article>
  );
}

/** Live signals from POST /api/v1/ai/signals, with loading/empty/error states. */
function SignalsPanel(props: {
  data: SignalsResponse | null;
  loading: boolean;
  error: string | null;
  citedIds: Set<string>;
  feedConnected: boolean | undefined;
  onRetry: () => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const signals = props.data?.signals ?? [];
  const opportunities = signals.filter((s) => s.type === "opportunity");
  const risks = signals.filter((s) => s.type === "risk");
  const limit = showAll ? signals.length : SIGNAL_PREVIEW_COUNT;
  const hidden = Math.max(0, opportunities.length - limit) + Math.max(0, risks.length - limit);

  const dataSourceLabel =
    props.data?.data_source === "server" ? "full server market state" : "caller-supplied summary";

  return (
    <section
      className="dash-rise mb-8 border border-white/[0.07] p-5"
      style={{ background: "rgba(8,12,18,0.72)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#3b82f6]">AI signals</p>
          <h2 className="mt-1 font-display text-lg font-semibold text-white">Signals</h2>
          <p className="mt-1 max-w-2xl text-sm text-white/45">
            Scored opportunity and risk signals from the live desk, with the metrics behind each call.
            Scores are normalized heuristic strength and confidence reflects input completeness —
            neither is a probability of profit.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1.5 lg:items-end">
          {props.data ? (
            <>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                source · {props.data.source}
                {props.data.model ? ` · ${props.data.model}` : ""}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/25">
                {dataSourceLabel} · {props.data.universe}
              </span>
            </>
          ) : null}
          <span
            className="font-mono text-[10px] uppercase tracking-[0.14em]"
            style={{ color: props.feedConnected === false ? "#e8b84a" : "rgba(255,255,255,0.25)" }}
          >
            {feedProvenanceLabel(props.feedConnected)}
          </span>
          <button
            type="button"
            disabled={props.loading}
            onClick={props.onRetry}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#3b82f6] disabled:opacity-40"
          >
            {props.loading ? "Refreshing…" : "Refresh signals"}
          </button>
        </div>
      </div>

      {props.loading && !props.data ? (
        <div className="mt-4 border border-white/[0.07] px-4 py-12 text-center text-sm text-white/35">
          <span className="inline-flex items-center gap-2">
            <span className="dash-live-dot h-2 w-2 rounded-full bg-[#3b82f6]" />
            Scoring live market signals…
          </span>
        </div>
      ) : null}

      {props.error && !props.data ? (
        <div
          className="mt-4 px-4 py-10 text-center"
          style={{ border: "1px solid rgba(240,113,120,0.35)", background: "rgba(240,113,120,0.06)" }}
        >
          <p className="text-sm text-[#f07178]">{props.error}</p>
          <p className="mt-2 text-xs text-white/35">
            Signals are unavailable right now. Market data below is unaffected.
          </p>
          <button
            type="button"
            onClick={props.onRetry}
            className="mt-4 bg-[#3b82f6] px-4 py-2 text-sm font-semibold text-[#0b1220]"
          >
            Retry
          </button>
        </div>
      ) : null}

      {props.data ? (
        <>
          {props.error ? (
            <p className="mt-3 text-xs text-[#e8b84a]">Last signals refresh failed: {props.error}</p>
          ) : null}

          {signals.length === 0 ? (
            <div className="mt-4 border border-white/[0.07] px-4 py-12 text-center text-sm text-white/35">
              No directional signals for the current market state.
            </div>
          ) : (
            <>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                    Opportunity · {opportunities.length}
                  </p>
                  <div className="space-y-2">
                    {opportunities.slice(0, limit).map((s, i) => (
                      <SignalCard key={s.id} signal={s} cited={props.citedIds.has(s.id)} delay={i * 40} />
                    ))}
                    {opportunities.length === 0 ? (
                      <p className="border border-white/[0.07] px-4 py-6 text-center text-sm text-white/30">
                        No opportunity signals.
                      </p>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                    Risk · {risks.length}
                  </p>
                  <div className="space-y-2">
                    {risks.slice(0, limit).map((s, i) => (
                      <SignalCard key={s.id} signal={s} cited={props.citedIds.has(s.id)} delay={i * 40} />
                    ))}
                    {risks.length === 0 ? (
                      <p className="border border-white/[0.07] px-4 py-6 text-center text-sm text-white/30">
                        No risk signals.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              {hidden > 0 || showAll ? (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-[#3b82f6]"
                >
                  {showAll ? "Show fewer" : `Show all ${signals.length} signals`}
                </button>
              ) : null}
            </>
          )}

          {props.data.warnings.length ? (
            <details className="mt-3">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                {props.data.warnings.length} data warning(s)
              </summary>
              <ul className="mt-2 space-y-1">
                {props.data.warnings.map((w) => (
                  <li key={w} className="text-xs text-white/40">
                    {w}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function DashboardPage() {
  const { connected, status } = useMarketsStream();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiBrief, setAiBrief] = useState<AiBriefResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [signals, setSignals] = useState<SignalsResponse | null>(null);
  const [signalsLoading, setSignalsLoading] = useState(true);
  const [signalsError, setSignalsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/v1/dashboard/summary");
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as DashboardSummary;
      setSummary(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [load]);

  /**
   * Signals come from the API, never from client-side scoring. The body is
   * empty on purpose: the endpoint then evaluates the full canonical
   * server-side market state instead of this page's six-market summary.
   */
  const loadSignals = useCallback(async () => {
    setSignalsLoading(true);
    try {
      const r = await fetch("/api/v1/ai/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text || `HTTP ${r.status}`);
      }
      setSignals((await r.json()) as SignalsResponse);
      setSignalsError(null);
    } catch (e) {
      setSignalsError(e instanceof Error ? e.message : "Failed to load AI signals");
    } finally {
      setSignalsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSignals();
  }, [loadSignals]);

  const runAiBrief = useCallback(async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const r = await fetch("/api/v1/ai/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No `summary`: the brief must use the same full server-side universe
        // as the signals above, so the two always refer to the same data.
        body: JSON.stringify({
          question: aiQuestion.trim() || undefined,
        }),
      });
      if (!r.ok) {
        throw new Error((await r.text()) || `HTTP ${r.status}`);
      }
      setAiBrief((await r.json()) as AiBriefResponse);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI brief failed");
    } finally {
      setAiLoading(false);
    }
  }, [aiQuestion]);

  const citedSignalIds = new Set(aiBrief?.signals_used ?? []);
  const citedNotInView = aiBrief
    ? aiBrief.signals_used.filter((id) => !(signals?.signals ?? []).some((s) => s.id === id)).length
    : 0;

  let wsTone: "ok" | "warn" | "bad" = "bad";
  let wsLabel = "Stream down";
  if (status === "connected") {
    wsTone = "ok";
    wsLabel = "Stream live";
  } else if (status === "reconnecting") {
    wsTone = "warn";
    wsLabel = "Reconnecting";
  }

  const feedTone: "ok" | "warn" = summary?.feed_connected ? "ok" : "warn";
  const feedLabel = summary?.feed_connected ? "Feed online" : "Simulated feed";

  let linkValue = "Offline";
  if (connected) linkValue = "Online";
  else if (status === "reconnecting") linkValue = "Retry";

  return (
    <div className="relative min-h-screen overflow-hidden text-white" style={{ minHeight: "calc(100dvh - 3.25rem)" }}>
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 55% at 12% -10%, rgba(59,130,246,0.14), transparent 55%), radial-gradient(ellipse 60% 45% at 90% 10%, rgba(56,140,180,0.12), transparent 50%), linear-gradient(180deg, #071019 0%, #05080d 48%, #030507 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "linear-gradient(180deg, rgba(0,0,0,0.55), transparent 75%)",
        }}
      />

      <div className="relative mx-auto max-w-[1400px] px-5 pb-20 pt-10 sm:px-8">
        <header className="dash-rise mb-10 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#3b82f6]">
              Market intelligence · deterministic signals · grounded brief
            </p>
            <h1 className="mt-3 font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Understand the market faster
            </h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-white/45">
              Every signal here is computed from market numbers by fixed rules, never written by a
              model. The AI layer only narrates those signals, and every figure it states has to
              trace back to a citation or the brief is rejected before it reaches you.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/trade/btc-usdt"
                className="inline-flex items-center justify-center bg-[#3b82f6] px-5 py-2.5 text-sm font-semibold text-[#0b1220] transition hover:brightness-110"
              >
                Open markets
              </Link>
              <Link
                href="/markets"
                className="inline-flex items-center justify-center border border-white/15 px-5 py-2.5 text-sm font-medium text-white/75 transition hover:border-white/30 hover:text-white"
              >
                Browse pairs
              </Link>
            </div>
          </div>
          <div className="flex flex-col items-start gap-3 lg:items-end">
            <StatusDot label={wsLabel} tone={wsTone} />
            {summary ? <StatusDot label={feedLabel} tone={feedTone} /> : null}
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/25">
              Refresh every 5s
            </p>
          </div>
        </header>

        {loading && !summary ? (
          <div className="border border-white/[0.07] px-4 py-16 text-center text-sm text-white/35">
            <span className="inline-flex items-center gap-2">
              <span className="dash-live-dot h-2 w-2 rounded-full bg-[#3b82f6]" />
              Syncing intelligence feed...
            </span>
          </div>
        ) : null}

        {error && !summary ? (
          <div
            className="px-4 py-12 text-center"
            style={{ border: "1px solid rgba(240,113,120,0.35)", background: "rgba(240,113,120,0.06)" }}
          >
            <p className="text-sm text-[#f07178]">{error}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                void load();
              }}
              className="mt-4 bg-[#3b82f6] px-4 py-2 text-sm font-semibold text-[#0b1220]"
            >
              Retry
            </button>
          </div>
        ) : null}

        {summary ? (
          <>
            {error ? <p className="mb-4 text-xs text-[#e8b84a]">Last refresh failed: {error}</p> : null}

            <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricTile label="Tracked markets" value={String(summary.active_markets)} delay={40} />
              <MetricTile label="24h volume" value={fmtVol(summary.volume_24h_total)} delay={100} />
              <MetricTile label="Open orders" value={String(summary.open_orders_count)} delay={160} />
              <MetricTile
                label="Live link"
                value={linkValue}
                hint={connected ? "WebSocket attached" : "Polling fallback may be active"}
                delay={220}
              />
            </div>

            <section
              className="dash-rise mb-8 grid gap-4 border border-white/[0.07] p-5 md:grid-cols-3"
              style={{ background: "rgba(8,12,18,0.55)" }}
            >
              {[
                {
                  title: "Collect",
                  body: "Market ticks, order flow, and desk state in one live surface.",
                },
                {
                  title: "Derive",
                  body: "Fixed rules turn those numbers into ranked signals. No model invents a figure.",
                },
                {
                  title: "Ground",
                  body: "The AI only narrates those signals. Anything it cannot cite is rejected before you see it.",
                },
              ].map((item) => (
                <div key={item.title}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#3b82f6]">{item.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-white/50">{item.body}</p>
                </div>
              ))}
            </section>

            <SignalsPanel
              data={signals}
              loading={signalsLoading}
              error={signalsError}
              citedIds={citedSignalIds}
              feedConnected={summary?.feed_connected}
              onRetry={() => void loadSignals()}
            />

            <section
              className="dash-rise mb-8 border border-white/[0.07] p-5"
              style={{ background: "rgba(8,12,18,0.72)" }}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#3b82f6]">AI brief</p>
                  <h2 className="mt-1 font-display text-lg font-semibold text-white">Market intelligence</h2>
                  <p className="mt-1 max-w-2xl text-sm text-white/45">
                    The AI narrates the signals above and every figure it states is checked against a
                    citation. Without OPENAI_API_KEY a deterministic brief runs instead, so the panel
                    always has something to show.
                  </p>
                </div>
                {aiBrief ? (
                  <div className="flex flex-col items-start gap-1.5 lg:items-end">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/35">
                      source · {aiBrief.source}
                      {aiBrief.model ? ` · ${aiBrief.model}` : ""}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/25">
                      {aiBrief.data_source === "server"
                        ? "full server market state"
                        : "caller-supplied summary"}
                      {aiBrief.universe ? ` · ${aiBrief.universe}` : ""}
                    </span>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  placeholder="Optional: ask about risk, opportunity, or a pair…"
                  className="min-w-0 flex-1 border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-[#3b82f6]/60"
                />
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void runAiBrief()}
                  className="bg-[#3b82f6] px-4 py-2 text-sm font-semibold text-[#0b1220] disabled:opacity-50"
                >
                  {aiLoading ? "Generating…" : "Generate AI brief"}
                </button>
              </div>

              {aiError ? <p className="mt-3 text-sm text-[#f07178]">{aiError}</p> : null}

              {aiBrief ? (
                <>
                  <pre className="mt-4 whitespace-pre-wrap border border-white/[0.06] bg-black/25 p-4 font-sans text-sm leading-relaxed text-white/75">
                    {aiBrief.brief}
                  </pre>

                  <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                      signals used · {aiBrief.signals_used.length}
                    </span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                      citations · {aiBrief.citations.length}
                    </span>
                    {citedNotInView > 0 ? (
                      <span className="text-xs text-[#e8b84a]">
                        {citedNotInView} cited signal(s) are not in the current signal set — market data
                        refreshed between requests.
                      </span>
                    ) : null}
                  </div>

                  {aiBrief.citations.length ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-white/30">
                        Evidence used
                      </summary>
                      <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                        {aiBrief.citations.map((c) => (
                          <li
                            key={`${c.market_id}-${c.field}`}
                            className="font-mono text-[11px] tabular-nums text-white/45"
                          >
                            {c.market_id} · {c.field} · {c.value}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </>
              ) : (
                <p className="mt-4 text-sm text-white/35">
                  Click generate to turn the signals above and their evidence into a grounded AI desk brief.
                </p>
              )}
            </section>

            {summary.active_markets === 0 ? (
              <div className="border border-white/[0.07] px-4 py-16 text-center text-sm text-white/35">
                No active markets yet.
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <MoversTable
                  title="Opportunity signals"
                  accent="#3b82f6"
                  rows={summary.top_gainers}
                  empty="No gainers available."
                />
                <MoversTable
                  title="Risk signals"
                  accent="#f07178"
                  rows={summary.top_losers}
                  empty="No losers available."
                />
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
