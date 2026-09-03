// The single Postgres client for the whole application.
//
// ALL SQL goes through postgres.js tagged templates:
//
//     sql`SELECT * FROM runs WHERE id = ${runId}`
//
// The tagged template is not string interpolation. postgres.js sends the
// query and the values separately, so ${runId} becomes a bound parameter
// and can never be parsed as SQL. Never build a query by concatenating
// strings, and never use sql.unsafe() on anything derived from user input.

import postgres from 'postgres';
import { env } from './env';

// Next.js dev mode re-evaluates modules on hot reload, which would open a
// new pool on every edit until the database refuses connections. Stashing
// the client on globalThis keeps exactly one pool across reloads. In
// production this branch is never taken.
const globalForDb = globalThis as unknown as {
  setlSql: ReturnType<typeof postgres> | undefined;
};

function createClient() {
  const isPooled = env.DATABASE_URL.includes("-pooler.") || env.DATABASE_URL.includes("pooler");
  return postgres(env.DATABASE_URL, {
    // Neon's free tier sleeps. A cold connection needs room to wake up,
    // but not so much that a Vercel function sits until it is killed.
    connect_timeout: 15,
    // Serverless functions are short-lived and numerous; a small pool per
    // instance avoids exhausting Neon's connection limit. Hobby/free: keep 1.
    max: 1,
    idle_timeout: 20,
    // Neon pooler (pgbouncer) requires prepare:false, otherwise transaction mode fails
    prepare: isPooled ? false : true,
    // Amounts are BIGINT paise. postgres.js would hand these back as
    // strings to avoid precision loss, but every amount in this system is
    // well inside 2^53, so we parse INT8 (oid 20) to a JS number and
    // assert that it survived exactly. Silent precision loss on money is
    // the failure this guards against.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => v.toString(),
        parse: (v: string) => {
          const n = Number(v);
          if (!Number.isSafeInteger(n)) {
            throw new Error(
              `BIGINT ${v} from the database exceeds the safe integer range; ` +
                `reading it as a number would lose precision.`
            );
          }
          return n;
        },
      },
      // Confidence scores are NUMERIC(5,4) — a ratio in [0,1], never money.
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (v: number) => v.toString(),
        parse: (v: string) => {
          const n = Number(v);
          if (!Number.isFinite(n)) {
            throw new Error(`NUMERIC ${v} from the database did not parse to a finite number.`);
          }
          return n;
        },
      },
    },
  });
}

let _sql: ReturnType<typeof postgres> | undefined;

function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql;
  if (globalForDb.setlSql) {
    _sql = globalForDb.setlSql;
    return _sql;
  }
  _sql = createClient();
  if (process.env.NODE_ENV !== 'production') {
    globalForDb.setlSql = _sql;
  }
  return _sql;
}

// Lazy proxy — defers env.DATABASE_URL read until first query, so
// `next build` can import this file without DATABASE_URL set.
// Cast through unknown to satisfy postgres.js type which is both callable and object.
export const sql = new Proxy(
  ((...args: unknown[]) => (getSql() as unknown as (...a: unknown[]) => unknown)(...args)) as unknown as ReturnType<typeof postgres>,
  {
    get(_target, prop) {
      return (getSql() as unknown as Record<string | symbol, unknown>)[prop];
    },
    apply(_target, _thisArg, args) {
      return (getSql() as unknown as (...a: unknown[]) => unknown)(...args);
    },
  }
);

export default sql;
