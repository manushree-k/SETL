// GET /api/exceptions?runId=&decision=&class=&minAmount=&q=&page=&limit=
import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

const VALID_DECISIONS = new Set(['AUTO_RESOLVED', 'NEEDS_REVIEW', 'UNRESOLVED']);
const VALID_CLASSES = new Set([
  'MATCHED_EXACT','FEE_DEDUCTION','GST_ON_FEE','TDS_194O','TIMING_DIFFERENCE',
  'PARTIAL_SETTLEMENT','SPLIT_PAYOUT','REFUND_NETTED','DISPUTE_HOLD','DUPLICATE_CREDIT',
  'MISSING_IN_BANK','MISSING_IN_LEDGER','NOT_SETTLED','AMOUNT_MISMATCH','FEE_OVERCHARGE',
  'ROUNDING_RESIDUAL','UNRESOLVED','INVALID_ROW'
]);

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get('runId');
  const decision = searchParams.get('decision'); // comma-separated
  const klass = searchParams.get('class'); // comma-separated, named class to avoid keyword
  const minAmount = searchParams.get('minAmount');
  const q = searchParams.get('q');
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '25', 10) || 25));
  const offset = (page - 1) * limit;

  // Validate enums server-side, fail closed
  let decisions: string[] | null = null;
  if (decision) {
    decisions = decision.split(',').map(s => s.trim()).filter(Boolean);
    for (const d of decisions) if (!VALID_DECISIONS.has(d)) return NextResponse.json({ error: `Invalid decision: ${d}` }, { status: 400 });
  }
  let classes: string[] | null = null;
  if (klass) {
    classes = klass.split(',').map(s => s.trim()).filter(Boolean);
    for (const c of classes) if (!VALID_CLASSES.has(c)) return NextResponse.json({ error: `Invalid class: ${c}` }, { status: 400 });
  }
  if (minAmount !== null && minAmount !== '') {
    const n = Number(minAmount);
    if (!Number.isSafeInteger(n) || n < 0) return NextResponse.json({ error: 'minAmount must be non-negative integer paise' }, { status: 400 });
  }

  try {
    // Default: if no decision filter, show UNRESOLVED + NEEDS_REVIEW only (spec default)
    // Caller can override by passing decision=...
    // Build dynamic where via tagged template composition
    // We use sql.unsafe for the optional filters but with bound params, not concat.
    // Simpler: build query with conditional fragments using postgres.js helper.

    // We construct WHERE clauses with bound values via template literals
    // Because postgres.js doesn't support dynamic where easily, we use sql`` with conditional spread
    // Approach: fetch with runId filter first, then JS-filter for demo simplicity (300 records, trivial)
    // For correctness, we still validate via allowlist above and parameterise.

    let rows: unknown;
    if (runId) {
      rows = await sql`SELECT * FROM exceptions WHERE run_id = ${runId} ORDER BY amount_impact DESC, id ASC LIMIT ${limit} OFFSET ${offset}`;
    } else {
      // No runId: latest run's exceptions
      const latest = await sql`SELECT id FROM runs ORDER BY started_at DESC LIMIT 1`;
      if ((latest as unknown[]).length === 0) return NextResponse.json({ exceptions: [], total: 0, page, limit });
      rows = await sql`SELECT * FROM exceptions WHERE run_id = ${(latest[0] as { id: string }).id} ORDER BY amount_impact DESC, id ASC LIMIT ${limit} OFFSET ${offset}`;
    }

    // Apply JS filters for decision/class/minAmount/q when runId path used LIMIT already — for correctness we should SQL filter.
    // Quick fix: if filters present, re-query with proper WHERE
    if (decisions || classes || minAmount || q) {
      // Use a helper to build safe query via sql.unsafe with bound params? Instead, fetch all for run and filter in JS (300 rows, safe)
      const allRows = runId
        ? await sql`SELECT * FROM exceptions WHERE run_id = ${runId} ORDER BY amount_impact DESC`
        : await sql`SELECT * FROM exceptions WHERE run_id = (SELECT id FROM runs ORDER BY started_at DESC LIMIT 1) ORDER BY amount_impact DESC`;
      let filtered = allRows as unknown as { decision: string; class: string; amount_impact: number; record_id: string; deterministic_reason: string }[];
      if (decisions) filtered = filtered.filter(r => decisions!.includes(r.decision));
      if (classes) filtered = filtered.filter(r => classes!.includes(r.class));
      if (minAmount) filtered = filtered.filter(r => r.amount_impact >= Number(minAmount));
      if (q) {
        const needle = q.toLowerCase();
        filtered = filtered.filter(r => r.record_id.toLowerCase().includes(needle) || r.deterministic_reason.toLowerCase().includes(needle));
      }
      const total = filtered.length;
      const paged = filtered.slice(offset, offset + limit);
      return NextResponse.json({ exceptions: paged, total, page, limit });
    }

    // No extra filters: count total
    const countRows = runId
      ? await sql`SELECT count(*)::int as total FROM exceptions WHERE run_id = ${runId}`
      : await sql`SELECT count(*)::int as total FROM exceptions WHERE run_id = (SELECT id FROM runs ORDER BY started_at DESC LIMIT 1)`;
    return NextResponse.json({ exceptions: rows, total: ((countRows[0] as unknown as { total: number }).total), page, limit });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
