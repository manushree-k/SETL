// GET /api/runs/:id/settlements — composition + lines for every settlement in ONE payload
// No second request on drill-down — the table expands in place.
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || typeof id !== 'string' || id.length > 100) {
    return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  }
  try {
    const compositions = await sql`
      SELECT * FROM settlement_composition WHERE run_id = ${id} ORDER BY abs(diff_total) DESC NULLS LAST, settlement_id ASC
    `;
    const lines = await sql`
      SELECT entity_id, type, debit, credit, amount, fee, tax, settlement_id, order_id, method, contribution, contribution_bucket, contribution_reason
      FROM settlement_lines WHERE run_id = ${id} ORDER BY settlement_id, entity_id
    `;
    // Group lines by settlement_id for the UI
    const linesBySettlement: Record<string, unknown[]> = {};
    for (const l of lines as unknown as { settlement_id: string | null }[]) {
      const sid = l.settlement_id ?? '__unsettled__';
      if (!linesBySettlement[sid]) linesBySettlement[sid] = [];
      linesBySettlement[sid].push(l);
    }
    return NextResponse.json({ compositions, linesBySettlement, lines });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
