"use client";

export function DocsPage() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Documentation</h1>
      <p className="mb-8 text-white/45">
        Carmlize is an AI-powered crypto market intelligence platform — real-time market data,
        blockchain context, and signals that help you decide faster.
      </p>
      <p className="mb-8 border border-[rgba(56,189,248,0.25)] bg-[rgba(37,99,235,0.12)] px-4 py-3 text-sm text-sky-100/85">
        <strong className="text-[#93c5fd]">Note:</strong> this repository is a test build for
        developer experience. The goal is to combine AI with live market intelligence APIs, streams, and UI flows.
      </p>

      <section className="mb-8 border border-white/[0.06] bg-[rgba(12,14,24,0.5)] p-6">
        <h2 className="mb-4 text-xl font-semibold text-[#3b82f6]">What Carmlize does</h2>
        <p className="mb-4 text-white/70">
          We combine market, on-chain, and external data in one place, analyze it with AI, and
          turn raw information into useful signals for traders, investors, analysts, and crypto teams.
        </p>
        <ul className="list-disc space-y-2 pl-6 text-white/70">
          <li>Collect live market ticks and desk metrics in a single intelligence view</li>
          <li>Spot trends, risks, and opportunities from movers and volume shifts</li>
          <li>Move from insight to action on Markets or Trade</li>
          <li>Keep a live connection status so you know when data is fresh</li>
        </ul>
      </section>

      <section className="mb-8 border border-white/[0.06] bg-[rgba(12,14,24,0.5)] p-6">
        <h2 className="mb-4 text-xl font-semibold text-[#3b82f6]">Getting started</h2>
        <div className="space-y-4 text-white/70">
          <div>
            <h3 className="mb-2 font-medium text-white/90">1. Open Intelligence</h3>
            <p>Start on the dashboard to see tracked markets, volume, and opportunity/risk signals.</p>
          </div>
          <div>
            <h3 className="mb-2 font-medium text-white/90">2. Browse Markets</h3>
            <p>Search and sort pairs with live WebSocket updates and an HTTP fallback when the stream is down.</p>
          </div>
          <div>
            <h3 className="mb-2 font-medium text-white/90">3. Trade</h3>
            <p>Connect a wallet when needed, then place limit/market orders from the trade desk.</p>
          </div>
        </div>
      </section>

      <section className="mb-8 border border-white/[0.06] bg-[rgba(12,14,24,0.5)] p-6">
        <h2 className="mb-4 text-xl font-semibold text-[#3b82f6]">Security</h2>
        <ul className="list-disc space-y-2 pl-6 text-white/70">
          <li><strong className="text-white/90">Non-custodial:</strong> You keep control of keys and funds.</li>
          <li><strong className="text-white/90">Live status:</strong> Stream and feed health are always visible.</li>
          <li><strong className="text-white/90">No KYC required:</strong> Explore markets without identity paperwork.</li>
        </ul>
      </section>

      <section className="border border-white/[0.06] bg-[rgba(12,14,24,0.5)] p-6">
        <h2 className="mb-4 text-xl font-semibold text-[#3b82f6]">Interview pitch</h2>
        <p className="text-white/70 italic">
          “Carmlize is building an AI-powered crypto market intelligence platform. Our goal is to
          combine real-time market data, blockchain data, and AI to help users understand what is
          happening in the market and make better decisions faster.”
        </p>
      </section>
    </div>
  );
}
