// Reads and validates environment variables once, at module load ("startup").
// Import this from any entrypoint (API route, script, migration) before
// touching process.env directly, so a missing variable fails loudly and
// close to the cause instead of surfacing as a confusing downstream error.
//
// Values of secrets (LLM_API_KEY, DATABASE_URL) are never logged, returned
// in error messages, or included in any thrown Error — only the variable
// NAME appears in failure output.

// `next dev` / `next build` load .env.local automatically, but standalone
// scripts run via `tsx scripts/*.ts` do not. process.loadEnvFile is a
// native Node API (20.6+) — not a new dependency — so we use it here to
// populate process.env for those scripts too. It is idempotent to call
// when Next has already loaded the same file, and harmless if the file
// does not exist yet.
try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local not present or not readable — fall through and let the
  // required-variable checks below report exactly what is missing.
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env.local (see .env.example for the expected keys).`
    );
  }
  return value;
}

function parseBoolean(name: string, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(
    `Invalid value for environment variable: ${name}. Expected "true" or "false".`
  );
}

export interface Env {
  DATABASE_URL: string;
  LLM_ENABLED: boolean;
  // Only present when LLM_ENABLED is true — the LLM layer is fully
  // optional, and requiring a model/key when it is switched off would
  // block the deterministic-only path the engine must support.
  LLM_MODEL: string | null;
  LLM_API_KEY: string | null;
}

function loadEnv(): Env {
  const DATABASE_URL = required('DATABASE_URL');
  const LLM_ENABLED = parseBoolean('LLM_ENABLED', required('LLM_ENABLED'));

  const LLM_MODEL = LLM_ENABLED ? required('LLM_MODEL') : (process.env.LLM_MODEL || null);
  const LLM_API_KEY = LLM_ENABLED ? required('LLM_API_KEY') : (process.env.LLM_API_KEY || null);

  return { DATABASE_URL, LLM_ENABLED, LLM_MODEL, LLM_API_KEY };
}

export const env: Env = loadEnv();
