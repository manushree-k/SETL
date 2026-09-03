// Reads and validates environment variables lazily.
// Import this from any entrypoint before touching process.env directly.
// Lazy design: no throw at import time, so `next build` and `npm run evaluate`
// (which must work offline with no DATABASE_URL) can import lib/normalize
// without requiring a database. Each getter validates on first access.

if (typeof (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile === 'function') {
  try {
    (process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env.local');
  } catch {
    // .env.local not present — fall through to required checks on access.
  }
}
// Next.js already loads .env.local automatically in dev/build; standalone
// scripts use Node's loadEnvFile above. No dotenv dependency needed.

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
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(
    `Invalid value for environment variable: ${name}. Expected "true" or "false".`
  );
}

export interface Env {
  DATABASE_URL: string;
  LLM_ENABLED: boolean;
  LLM_MODEL: string | null;
  LLM_API_KEY: string | null;
}

let _cache: Partial<Env> = {};
let _llmEnabledCache: boolean | undefined;

function getLlmEnabled(): boolean {
  if (_llmEnabledCache !== undefined) return _llmEnabledCache;
  const raw = process.env.LLM_ENABLED;
  if (raw === undefined || raw === '') {
    // Default to false for true offline evaluate (no env file) — avoids forcing
    // judges to create .env.local just to run `npm run evaluate`.
    _llmEnabledCache = false;
    return _llmEnabledCache;
  }
  _llmEnabledCache = parseBoolean('LLM_ENABLED', raw);
  return _llmEnabledCache;
}

function getDatabaseUrl(): string {
  if (_cache.DATABASE_URL !== undefined) return _cache.DATABASE_URL;
  const v = required('DATABASE_URL');
  _cache.DATABASE_URL = v;
  return v;
}

function getLlmModel(): string | null {
  if (_cache.LLM_MODEL !== undefined) return _cache.LLM_MODEL;
  const enabled = getLlmEnabled();
  const v = enabled ? required('LLM_MODEL') : (process.env.LLM_MODEL || null);
  _cache.LLM_MODEL = v;
  return v;
}

function getLlmApiKey(): string | null {
  if (_cache.LLM_API_KEY !== undefined) return _cache.LLM_API_KEY;
  const enabled = getLlmEnabled();
  const v = enabled ? required('LLM_API_KEY') : (process.env.LLM_API_KEY || null);
  _cache.LLM_API_KEY = v;
  return v;
}

export const env: Env = {
  get DATABASE_URL() {
    return getDatabaseUrl();
  },
  get LLM_ENABLED() {
    return getLlmEnabled();
  },
  get LLM_MODEL() {
    return getLlmModel();
  },
  get LLM_API_KEY() {
    return getLlmApiKey();
  },
} as Env;

/** Reset cache — for tests only. */
export function _resetEnvCache(): void {
  _cache = {};
  _llmEnabledCache = undefined;
}
