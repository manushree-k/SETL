// GET /api/exceptions/:id — one exception + full evidence + composition+lines inline
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 120) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  try {
    const rows = await sql`SELECT * FROM exceptions WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const exc = rows[0] as unknown as { run_id: string; record_source: string; record_id: string; evidence: unknown };

    // If exception is for a settlement, inline its composition + lines
    let composition: unknown = null;
    let lines: unknown[] = [];
    // settlement exceptions have record_source='settlement' and record_id is settlement_id
    // settlement_line exceptions also carry a settlement_id via evidence or via line lookup
    let settlementId: string | null = null;
    if (exc.record_source === 'settlement') {
      settlementId = exc.record_id;
    } else if (exc.record_source === 'settlement_line') {
      const lr = await sql`SELECT settlement_id FROM settlement_lines WHERE run_id = ${exc.run_id} AND entity_id = ${exc.record_id} LIMIT 1`;
      settlementId = (lr[0] as { settlement_id: string | null } | undefined)?.settlement_id ?? null;
    }

    if (settlementId) {
      const compRows = await sql`SELECT * FROM settlement_composition WHERE run_id = ${exc.run_id} AND settlement_id = ${settlementId} LIMIT 1`;
      composition = compRows[0] ?? null;
      const lineRows = await sql`SELECT entity_id, type, debit, credit, amount, fee, tax, settlement_id, order_id, method, contribution, contribution_bucket, contribution_reason FROM settlement_lines WHERE run_id = ${exc.run_id} AND settlement_id = ${settlementId} ORDER BY entity_id`;
      lines = lineRows as unknown[];
    }

    return NextResponse.json({ exception: exc, composition, lines });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
