// GET /api/runs/:id — one run + its metrics
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 100) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  try {
    const runs = await sql`SELECT id, batch, started_at, finished_at, status, config, record_count FROM runs WHERE id = ${id} LIMIT 1`;
    if (runs.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const metrics = await sql`SELECT payload FROM run_metrics WHERE run_id = ${id} LIMIT 1`;
    const compositions = await sql`SELECT * FROM settlement_composition WHERE run_id = ${id} ORDER BY diff_total DESC NULLS LAST`;
    const exceptionsSummary = await sql`
      SELECT decision, count(*)::int as count FROM exceptions WHERE run_id = ${id} GROUP BY decision
    `;
    return NextResponse.json({ run: runs[0], metrics: metrics[0]?.payload ?? null, compositions, exceptionsSummary });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
