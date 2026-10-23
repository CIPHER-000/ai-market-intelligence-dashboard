import { NextResponse } from "next/server";
import { getMarketEngine } from "../../../../lib/engines.js";

// Reads runtime MarketEngine state, so it must never be statically prerendered:
// the engine singletons only exist once client/server.js has booted, and a
// build-time evaluation would throw "MarketEngine not ready".
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getMarketEngine().overview());
}
