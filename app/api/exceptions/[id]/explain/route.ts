// POST /api/exceptions/:id/explain — SETL_BLUEPRINT.md section 13 job 2,
// section 18. Generates (or regenerates) the AI explanation for one
// exception, on demand, and persists it. Never called for a whole batch —
// this is a per-record, Investigation-screen action.
//
// deterministic_reason is never touched here — it's written once, by
// classify.ts, at reconciliation time, and is NOT NULL in the schema
// (db/schema.sql). The UI's fallback when ai_status isn't 'ok' relies on
// that column always already being populated, which this route neither
// depends on nor could break.

import { NextResponse } from 'next/server';
import { explainException } from '@/lib/ai/explainer';
import { sql } from '@/lib/db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  let result;
  try {
    result = await explainException(id);
  } catch {
    // explainException throws only when the exception id itself doesn't
    // exist — every other failure mode (LLM disabled, network error,
    // malformed output) resolves to status: 'error' instead, so it can
    // still be persisted below.
    return NextResponse.json({ error: `Exception ${id} not found` }, { status: 404 });
  }

  await sql`
    UPDATE exceptions
    SET ai_explanation = ${result.explanation}, ai_status = ${result.status}
    WHERE id = ${id}
  `;

  return NextResponse.json({ ai_explanation: result.explanation, ai_status: result.status });
}
