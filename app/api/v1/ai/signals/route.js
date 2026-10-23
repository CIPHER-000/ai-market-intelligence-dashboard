import { NextResponse } from "next/server";
import { handleSignalsRawBody } from "../../../../../lib/aiSignalsHandler.js";

/**
 * POST /api/v1/ai/signals
 *
 * Thin adapter only: the request logic (body parsing, validation, universe
 * selection, error mapping) lives in lib/aiSignalsHandler.js so it is covered by
 * node:test. Errors are plain text, never JSON and never stack traces.
 *
 * The raw body is forwarded so the handler can distinguish an absent body
 * ("use server state") from malformed JSON (400).
 */
export async function POST(req) {
  const raw = await req.text().catch(() => "");
  const result = await handleSignalsRawBody(raw);
  if (result.json !== undefined) return NextResponse.json(result.json, { status: result.status });
  return new NextResponse(result.text, { status: result.status });
}
