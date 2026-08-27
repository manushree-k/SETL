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
  return postgres(env.DATABASE_URL, {
    // Neon's free tier sleeps. A cold connection needs room to wake up,
    // but not so much that a Vercel function sits until it is killed.
    connect_timeout: 15,
    // Serverless functions are short-lived and numerous; a small pool per
    // instance avoids exhausting Neon's connection limit.
    max: 5,
    idle_timeout: 20,
    // Amounts are BIGINT paise. node-postgres would hand these back as
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
    },
  });
}

export const sql = globalForDb.setlSql ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.setlSql = sql;
}

export default sql;
