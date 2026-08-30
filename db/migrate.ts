// Applies db/schema.sql to the database named by DATABASE_URL.
//
//     npm run migrate
//
// schema.sql drops every table before creating it, so this is idempotent
// and safe to re-run. It is also DESTRUCTIVE: everything in those tables
// is deleted. That is the right trade here because all data is regenerable
// from the committed CSVs via `npm run seed`, but it is the reason this
// script prints what it is about to do rather than doing it silently.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { env } from '../lib/env';

const TABLES = [
  'runs',
  'orders',
  'settlements',
  'settlement_lines',
  'bank_lines',
  'settlement_composition',
  'links',
  'exceptions',
  'audit_log',
  'run_metrics',
  'llm_calls',
] as const;

async function migrate(): Promise<void> {
  const schemaPath = join(process.cwd(), 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');

  // A dedicated short-lived connection rather than the pooled app client:
  // this script runs once and exits, and `simple: true` lets a single
  // multi-statement script be sent as one command.
  // onnotice is silenced because DROP TABLE IF EXISTS emits a NOTICE for
  // every table that does not exist yet, which is the normal case on a
  // fresh database and drowns the output that matters.
  const sql = postgres(env.DATABASE_URL, {
    max: 1,
    connect_timeout: 30,
    onnotice: () => {},
  });

  try {
    console.log('Applying db/schema.sql ...');
    await sql.unsafe(schema).simple();

    // Verify against the catalog rather than trusting that no error means
    // success — a partially applied schema would otherwise look fine.
    const found = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    const foundNames = new Set(found.map((r) => r.table_name));
    const missing = TABLES.filter((t) => !foundNames.has(t));

    if (missing.length > 0) {
      throw new Error(`Schema applied but these tables are missing: ${missing.join(', ')}`);
    }

    console.log(`${found.length} tables created:`);
    for (const row of found) console.log(`  - ${row.table_name}`);
    console.log('Migration complete.');
  } finally {
    await sql.end();
  }
}

migrate().catch((error: unknown) => {
  // Print only the message. A postgres.js error object can carry the
  // connection details, and DATABASE_URL must never reach a log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Migration failed: ${message}`);
  process.exit(1);
});
