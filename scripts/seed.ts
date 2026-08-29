// Loads a batch's CSVs (data/main or data/holdout) into Postgres under a
// fresh run_id.
//
//     npm run seed -- --batch main
//     npm run seed -- --batch holdout
//
// Every seed creates a NEW run — runs are append-only, matching the
// blueprint's stated design (section 26): re-seeding never overwrites or
// upserts, it just adds another complete, independent run row plus its
// own copies of every record. The whole load is one transaction: either
// every table gets its rows, or none do.
//
// ground_truth.json is deliberately NOT loaded here — it has no table in
// the schema and stays a file-based artifact that scripts/evaluate.ts
// (prompt 10) reads directly.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { env } from '../lib/env';
import { toPaise } from '../lib/money';
import { parseIST } from '../lib/dates';

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

type Batch = 'main' | 'holdout';

function parseArgs(argv: string[]): { batch: Batch } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Flag --${name} is missing its value.`);
      }
      flags.set(name, value);
      i += 1;
    }
  }

  const batch = flags.get('batch');
  if (batch !== 'main' && batch !== 'holdout') {
    throw new Error(
      `--batch must be 'main' or 'holdout', received ${JSON.stringify(batch)}. Usage: seed.ts --batch <main|holdout>`
    );
  }
  return { batch };
}

// ---------------------------------------------------------------------------
// A small, correct CSV parser (RFC4180-style), symmetric to the writer in
// scripts/generate.ts. No new dependency: the file format is simple and
// fully under our own control, and this is ~20 lines to get right.
// ---------------------------------------------------------------------------

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsvRecords(path: string): Record<string, string>[] {
  const raw = parseCsv(readFileSync(path, 'utf8')).filter((r) => !(r.length === 1 && r[0] === ''));
  const [header, ...dataRows] = raw;
  return dataRows.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((col, idx) => {
      record[col] = row[idx] ?? '';
    });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Field conversion helpers.
//
// A CSV `_paise` column is a bare integer-digit string ('85900'), never a
// rupee-decimal display string ('₹859.00'). Number() on a bare integer
// string is exact — no precision loss is possible for any value in the
// safe-integer range — which is a different situation from the money.ts
// rule's real target: parsing a FORMATTED currency string, where a
// fraction or a rupee/paise unit mix-up is the actual risk. parseMoney()
// would in fact be WRONG here: it expects rupee-decimal input, so
// parseMoney('85900') would read 85900 as RUPEES and return 8590000
// paise — 100x too large. toPaise() still validates the integer and
// tags it, so nothing skips the type system.
function paiseField(value: string): number {
  return toPaise(Number(value));
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}

function boolField(value: string): boolean {
  return value === 'true';
}

// ---------------------------------------------------------------------------
// Row builders — CSV column names (section 7) to DB column names
// (db/schema.sql) are NOT identical; the `_paise` suffix is dropped and a
// few names differ (utr_number -> utr, amount_paise -> amount, etc).
// ---------------------------------------------------------------------------

function buildOrderRows(records: Record<string, string>[], runId: string) {
  return records.map((r) => ({
    id: `${runId}_${r.order_id}`,
    run_id: runId,
    order_id: r.order_id,
    order_ref: r.order_ref,
    customer_ref: r.customer_ref,
    order_amount: paiseField(r.order_amount_paise),
    currency: r.currency,
    created_at: parseIST(r.created_at),
    order_status: r.order_status,
    refund_issued: paiseField(r.refund_issued_paise),
  }));
}

function buildSettlementRows(records: Record<string, string>[], runId: string) {
  return records.map((r) => ({
    id: `${runId}_${r.settlement_id}`,
    run_id: runId,
    settlement_id: r.settlement_id,
    amount: paiseField(r.amount_paise),
    fees: paiseField(r.fees_paise),
    tax: paiseField(r.tax_paise),
    utr: r.utr_number,
    status: r.status,
    created_at: parseIST(r.created_at),
  }));
}

function buildSettlementLineRows(records: Record<string, string>[], runId: string) {
  return records.map((r) => ({
    id: `${runId}_${r.entity_id}`,
    run_id: runId,
    entity_id: r.entity_id,
    type: r.type,
    debit: paiseField(r.debit_paise),
    credit: paiseField(r.credit_paise),
    amount: paiseField(r.amount_paise),
    fee: paiseField(r.fee_paise),
    tax: paiseField(r.tax_paise),
    on_hold: boolField(r.on_hold),
    settled: boolField(r.settled),
    created_at: parseIST(r.created_at),
    settled_at: r.settled_at === '' ? null : parseIST(r.settled_at),
    settlement_id: emptyToNull(r.settlement_id),
    settlement_utr: emptyToNull(r.settlement_utr),
    order_id: emptyToNull(r.order_id),
    method: emptyToNull(r.method),
    card_network: emptyToNull(r.card_network),
    card_type: emptyToNull(r.card_type),
    international: boolField(r.international),
    dispute_id: emptyToNull(r.dispute_id),
    description: r.description,
  }));
}

function buildBankLineRows(records: Record<string, string>[], runId: string) {
  return records.map((r, index) => ({
    id: `${runId}_bank_${String(index + 1).padStart(4, '0')}`,
    run_id: runId,
    line_no: Number(r.line_no),
    value_date: r.value_date, // 'YYYY-MM-DD' — a bare date string is valid for a DATE column
    narration: r.narration,
    ref_no: emptyToNull(r.ref_no),
    debit: paiseField(r.debit_paise),
    credit: paiseField(r.credit_paise),
    closing_balance: paiseField(r.closing_balance_paise),
    // Populated later by the normalization layer (prompt 07), not at seed time.
    parsed_utr: null as string | null,
    parse_source: null as string | null,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function seed(): Promise<void> {
  const { batch } = parseArgs(process.argv.slice(2));
  const dir = join(process.cwd(), 'data', batch);

  console.log(`Reading batch '${batch}' from ${dir} ...`);
  const orderRecords = readCsvRecords(join(dir, 'orders.csv'));
  const settlementRecords = readCsvRecords(join(dir, 'settlements.csv'));
  const settlementLineRecords = readCsvRecords(join(dir, 'settlement_lines.csv'));
  const bankLineRecords = readCsvRecords(join(dir, 'bank_statement.csv'));

  const runId = `run_${randomUUID()}`;
  const startedAt = new Date();

  const orderRows = buildOrderRows(orderRecords, runId);
  const settlementRows = buildSettlementRows(settlementRecords, runId);
  const settlementLineRows = buildSettlementLineRows(settlementLineRecords, runId);
  const bankLineRows = buildBankLineRows(bankLineRecords, runId);

  // Matches section 16's N = orders + settlement_lines + bank_lines.
  const recordCount = orderRows.length + settlementLineRows.length + bankLineRows.length;

  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 30, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO runs ${tx(
          [
            {
              id: runId,
              batch,
              started_at: startedAt,
              finished_at: new Date(),
              status: 'complete',
              config: tx.json({ seeded_from: batch }),
              record_count: recordCount,
            },
          ],
          'id',
          'batch',
          'started_at',
          'finished_at',
          'status',
          'config',
          'record_count'
        )}
      `;

      if (orderRows.length > 0) {
        await tx`
          INSERT INTO orders ${tx(
            orderRows,
            'id',
            'run_id',
            'order_id',
            'order_ref',
            'customer_ref',
            'order_amount',
            'currency',
            'created_at',
            'order_status',
            'refund_issued'
          )}
        `;
      }

      if (settlementRows.length > 0) {
        await tx`
          INSERT INTO settlements ${tx(
            settlementRows,
            'id',
            'run_id',
            'settlement_id',
            'amount',
            'fees',
            'tax',
            'utr',
            'status',
            'created_at'
          )}
        `;
      }

      if (settlementLineRows.length > 0) {
        await tx`
          INSERT INTO settlement_lines ${tx(
            settlementLineRows,
            'id',
            'run_id',
            'entity_id',
            'type',
            'debit',
            'credit',
            'amount',
            'fee',
            'tax',
            'on_hold',
            'settled',
            'created_at',
            'settled_at',
            'settlement_id',
            'settlement_utr',
            'order_id',
            'method',
            'card_network',
            'card_type',
            'international',
            'dispute_id',
            'description'
          )}
        `;
      }

      if (bankLineRows.length > 0) {
        await tx`
          INSERT INTO bank_lines ${tx(
            bankLineRows,
            'id',
            'run_id',
            'line_no',
            'value_date',
            'narration',
            'ref_no',
            'debit',
            'credit',
            'closing_balance',
            'parsed_utr',
            'parse_source'
          )}
        `;
      }
    });

    console.log(`Seeded run ${runId} (batch=${batch}):`);
    console.log(`  orders:           ${orderRows.length}`);
    console.log(`  settlements:      ${settlementRows.length}`);
    console.log(`  settlement_lines: ${settlementLineRows.length}`);
    console.log(`  bank_lines:       ${bankLineRows.length}`);
    console.log(`  record_count (N): ${recordCount}`);
  } finally {
    await sql.end();
  }
}

seed().catch((error: unknown) => {
  // Message only — never let a postgres.js error object's connection
  // details (which can embed DATABASE_URL) reach a log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Seed failed: ${message}`);
  process.exit(1);
});
