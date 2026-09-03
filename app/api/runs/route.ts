// GET /api/runs — list runs
// POST /api/runs — create and execute a reconciliation for a batch
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { runReconciliation } from '@/lib/engine/run';

const VALID_BATCHES = new Set(['main', 'holdout']);

export async function GET() {
  try {
    const runs = await sql`
      SELECT id, batch, started_at, finished_at, status, config, record_count
      FROM runs ORDER BY started_at DESC LIMIT 20
    `;
    return NextResponse.json({ runs });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const batch = (body as { batch?: string })?.batch;
  if (!batch || !VALID_BATCHES.has(batch)) {
    return NextResponse.json({ error: 'batch must be one of: main, holdout' }, { status: 400 });
  }
  try {
    const result = await runReconciliation(batch as 'main' | 'holdout');
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Never leak DATABASE_URL — sanitize
    const safe = msg.replace(/postgresql:\/\/\S+/g, '[DATABASE_URL]');
    return NextResponse.json({ error: safe }, { status: 500 });
  }
}
