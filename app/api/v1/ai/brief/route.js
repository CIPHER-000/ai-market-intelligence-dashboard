import { NextResponse } from "next/server";
import { handleBriefRawBody } from "../../../../../lib/aiBriefHandler.js";

/**
 * /api/v1/ai/brief
 *
 * Thin adapter only: body parsing, validation, universe selection, signal
 * scoring and brief composition all live in lib/ (see lib/aiBriefHandler.js),
 * so they are covered by node:test. Errors are plain text, never JSON and never
 * stack traces.
 *
 * The raw body is forwarded so the handler can distinguish an absent body
 * ("use server state") from malformed JSON (400).
 */
function toResponse(result) {
  if (result.json !== undefined) return NextResponse.json(result.json, { status: result.status });
  return new NextResponse(result.text, { status: result.status });
}

export async function POST(req) {
  const raw = await req.text().catch(() => "");
  return toResponse(await handleBriefRawBody(raw));
}

export async function GET() {
  return toResponse(await handleBriefRawBody(""));
}
