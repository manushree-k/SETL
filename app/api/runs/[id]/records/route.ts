// GET /api/runs/:id/records — paginated records for a run (orders + settlement_lines + bank_lines)
// Minimal implementation — returns 25 per page, for future use.
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10) || 25));
  const offset = (page - 1) * limit;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  try {
    const orders = await sql`SELECT * FROM orders WHERE run_id = ${id} ORDER BY order_id LIMIT ${limit} OFFSET ${offset}`;
    const lines = await sql`SELECT * FROM settlement_lines WHERE run_id = ${id} ORDER BY entity_id LIMIT ${limit} OFFSET ${offset}`;
    const banks = await sql`SELECT * FROM bank_lines WHERE run_id = ${id} ORDER BY line_no LIMIT ${limit} OFFSET ${offset}`;
    return NextResponse.json({ orders, settlement_lines: lines, bank_lines: banks, page, limit });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
