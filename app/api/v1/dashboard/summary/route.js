import { NextResponse } from "next/server";
import { getMarketEngine, getMatchingEngine } from "../../../../../lib/engines.js";
import { buildDashboardSummary } from "../../../../../lib/dashboardSummary.js";

export async function GET() {
  try {
    const summary = await buildDashboardSummary(getMarketEngine(), getMatchingEngine());
    return NextResponse.json(summary);
  } catch (e) {
    const message = e?.message ?? "dashboard summary unavailable";
    // Engines may not be ready during early boot; never leak stacks.
    if (String(message).includes("not ready")) {
      return new NextResponse("service warming up", { status: 503 });
    }
    console.error("dashboard summary failed:", message);
    return new NextResponse("failed to build dashboard summary", { status: 500 });
  }
}
