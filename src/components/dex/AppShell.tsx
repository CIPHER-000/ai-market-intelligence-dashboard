"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletBar } from "../WalletBar";
import { useConfig } from "../../context/ConfigContext";
import { MarketTicker } from "./MarketTicker";
import { WalletConnectModal } from "../WalletConnectModal";

export function AppShell({ children }: { children: React.ReactNode }) {
  const cfg = useConfig();
  const pathname = usePathname();
  const tradeActive = pathname?.startsWith("/trade") ?? false;

  const navLinks = [
    { href: "/dashboard", label: "Intelligence", exact: false },
    { href: "/markets", label: "Markets", exact: false },
  ];

  const isActive = (href: string, exact: boolean) => {
    if (exact) return pathname === href;
    return pathname?.startsWith(href);
  };

  return (
    <div
      className="min-h-screen font-sans text-white/90"
      style={{
        background:
          "radial-gradient(ellipse 100% 70% at 50% 0%, rgba(59,130,246,0.07), transparent 52%), radial-gradient(ellipse 130% 95% at 50% 42%, #0b1217 0%, #050a0f 52%, #020508 100%)",
      }}
    >
      <div
        className="border-b border-[rgba(56,189,248,0.25)] px-4 py-2 text-center text-xs leading-relaxed text-sky-100/80"
        style={{ background: "rgba(37,99,235,0.18)" }}
      >
        <strong className="font-semibold text-[#93c5fd]">Test project</strong>
        {" — "}
        built to evaluate developer experience and to combine AI with real-time crypto market intelligence.
      </div>
      <header
        className="sticky top-0 z-50 flex items-center justify-between border-b border-white/[0.06] bg-[rgba(11,18,23,0.88)] px-8 backdrop-blur-[10px]"
        style={{ height: "3.25rem" }}
      >
        <div className="flex items-center gap-7">
          <Link href="/dashboard" className="flex items-center gap-3 text-sm font-bold tracking-widest">
            <span
              className="inline-flex h-8 w-8 items-center justify-center font-display text-sm font-bold text-[#0b1220]"
              style={{ background: "linear-gradient(135deg,#3b82f6,#93c5fd)" }}
              aria-hidden
            >
              C
            </span>
            <span className="text-[#3b82f6]">CARMLIZE</span>
          </Link>
          <nav className="flex gap-1">
            {navLinks.map(({ href, label, exact }) => {
              const active = isActive(href, exact);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-[rgba(59,130,246,0.15)] text-[#3b82f6]"
                      : "text-white/45 hover:bg-white/[0.04] hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
            <Link
              href="/trade/btc-usdt"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tradeActive
                  ? "bg-[rgba(59,130,246,0.15)] text-[#3b82f6]"
                  : "text-white/45 hover:bg-white/[0.04] hover:text-white"
              }`}
            >
              Trade
            </Link>
            <Link
              href="/docs"
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive("/docs", true)
                  ? "bg-[rgba(59,130,246,0.15)] text-[#3b82f6]"
                  : "text-white/45 hover:bg-white/[0.04] hover:text-white"
              }`}
            >
              Docs
            </Link>
          </nav>
        </div>
        <WalletBar expectedChainId={cfg.chain_id} />
      </header>

      {children}
      <MarketTicker />
      <WalletConnectModal />
    </div>
  );
}
