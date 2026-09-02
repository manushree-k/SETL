// A single fetch wrapper around the Anthropic Messages API. SETL_BLUEPRINT.md
// section 13 — "the LLM owns language, and only language." This file is the
// ONLY place in the codebase that makes a network call to an LLM; every
// job (narration parsing now, explanation/Q&A later) goes through it.
//
// Raw fetch, not the @anthropic-ai/sdk package: CLAUDE.md's dependency list
// is fixed (next, react, typescript, tailwind, postgres, recharts, vitest,
// tsx), and the blueprint's own prompt 12 text calls for "a single fetch
// wrapper," not a new SDK dependency.
//
// JSON output via a single FORCED tool call (tool_choice pinned to one
// tool), not free-text parsing — this guarantees the response is valid
// JSON matching the caller's schema, never something to regex out of prose.
//
// The boundary this file enforces structurally, not just by convention:
// it has no knowledge of amounts, dates, settlements, or any financial
// value. It only ever sends whatever `system`/`userContent` a caller
// supplies — callers (lib/ai/narrationParser.ts and, later, the explainer)
// are what keep numbers out of the prompt, per section 13's own rule.

import { env } from '../env';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TOKENS = 256; // classification/extraction-sized output, not prose

export interface LlmToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  userContent: string;
  /** The single tool the model is forced to call — its `input` IS the response. */
  tool: LlmToolSchema;
  maxTokens?: number;
}

export interface LlmCallResult {
  /** The forced tool call's `input`, or null if disabled, failed, or timed out. */
  output: Record<string, unknown> | null;
  latencyMs: number;
  ok: boolean;
}

interface AnthropicContentBlock {
  type: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

function buildRequestBody(request: LlmRequest): string {
  return JSON.stringify({
    model: env.LLM_MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: request.system,
    tools: [{ ...request.tool, strict: true }],
    tool_choice: { type: 'tool', name: request.tool.name },
    messages: [{ role: 'user', content: request.userContent }],
  });
}

async function postOnce(request: LlmRequest, signal: AbortSignal): Promise<Response> {
  return fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.LLM_API_KEY ?? '',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: buildRequestBody(request),
    signal,
  });
}

/**
 * Call the LLM once, with a forced single tool call for guaranteed-JSON
 * output. Hard `LLM_ENABLED=false` switch: every call is a no-op returning
 * null with zero latency — the engine must produce a complete
 * reconciliation with no LLM call at all (CLAUDE.md, section 13).
 *
 * Retries exactly once, and only on a 5xx response — a timeout or network
 * error fails immediately rather than retrying against a dead network.
 */
export async function callLlm(request: LlmRequest): Promise<LlmCallResult> {
  const start = Date.now();

  if (!env.LLM_ENABLED) {
    return { output: null, latencyMs: 0, ok: false };
  }

  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await postOnce(request, controller.signal);
      clearTimeout(timeout);
      if (response.status >= 500 && attempt === 0) continue; // one retry on 5xx
      break;
    } catch {
      clearTimeout(timeout);
      // Timeout or network error — not the "one retry on 5xx" case.
      return { output: null, latencyMs: Date.now() - start, ok: false };
    }
  }

  if (response === null || !response.ok) {
    return { output: null, latencyMs: Date.now() - start, ok: false };
  }

  const body = (await response.json()) as AnthropicMessageResponse;
  const toolUse = body.content?.find((block) => block.type === 'tool_use');
  if (toolUse?.input === undefined) {
    return { output: null, latencyMs: Date.now() - start, ok: false };
  }

  return { output: toolUse.input, latencyMs: Date.now() - start, ok: true };
}
