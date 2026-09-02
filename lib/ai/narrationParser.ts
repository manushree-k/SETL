// Job 1 — narration parsing. SETL_BLUEPRINT.md section 13.
//
// Only ever called for bank lines Pass 0's regex already marked
// 'pending_llm' (zero or multiple shape-matching UTR candidates found —
// see lib/normalize/narration.ts). Sends ONLY the narration string, via
// lib/ai/client.ts's forced-tool-call JSON output.
//
// Post-validation is NON-NEGOTIABLE and happens entirely in this file,
// after the LLM call returns: the proposed UTR is checked against the
// batch's own known settlement UTRs by normalized comparison, then by a
// bounded Levenshtein distance (≤ 2, to catch 0/O and 1/l OCR-style
// corruption). If it does not resolve to EXACTLY one known UTR, the parse
// is discarded and the line proceeds as parse_source: 'failed' — never a
// guess. "The LLM proposes; deterministic code disposes."

import { callLlm, type LlmToolSchema } from './client';
import { NARRATION_PARSER_SYSTEM_PROMPT } from './prompts';

const EXTRACT_UTR_TOOL: LlmToolSchema = {
  name: 'extract_utr',
  description: "Report the UTR, payment channel, and counterparty extracted from a bank narration, or an empty utr if none is present.",
  input_schema: {
    type: 'object',
    properties: {
      utr: {
        type: 'string',
        description: 'The UTR as it appears in the narration, or an empty string if none is present.',
      },
      channel: {
        type: 'string',
        description: 'The payment channel/rail mentioned (e.g. NEFT, RTGS, IMPS, UPI), or an empty string if unclear.',
      },
      counterparty: {
        type: 'string',
        description: 'The counterparty/beneficiary name mentioned, or an empty string if unclear.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence in the UTR extraction specifically, from 0 to 1.',
      },
    },
    required: ['utr', 'channel', 'counterparty', 'confidence'],
    additionalProperties: false,
  },
};

export type NarrationLlmParseSource = 'llm' | 'failed';

export interface NarrationLlmResult {
  /** The RESOLVED, validated known UTR — null unless it matched exactly one. */
  utr: string | null;
  parse_source: NarrationLlmParseSource;
  latencyMs: number;
  /** What the model proposed before validation — kept for the (currently deferred; see FAILURES.md) llm_calls log. */
  rawUtr: string | null;
}

/** Uppercase, alphanumeric-only — the same normalized comparison form used throughout the engine (e.g. lib/engine/pass1-utr.ts). */
function normalizeUtr(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Standard DP Levenshtein distance — no new dependency for a ~15-line algorithm. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[rows - 1][cols - 1];
}

const FUZZY_MATCH_MAX_DISTANCE = 2;

/**
 * Parse one bank narration via the LLM, then validate the result against
 * the batch's known settlement UTRs before trusting it at all.
 */
export async function parseNarrationWithLlm(
  narration: string,
  knownUtrs: readonly string[]
): Promise<NarrationLlmResult> {
  const call = await callLlm({
    system: NARRATION_PARSER_SYSTEM_PROMPT,
    userContent: JSON.stringify({ narration }),
    tool: EXTRACT_UTR_TOOL,
  });

  if (!call.ok || call.output === null) {
    return { utr: null, parse_source: 'failed', latencyMs: call.latencyMs, rawUtr: null };
  }

  const rawUtrField = call.output.utr;
  const rawUtr = typeof rawUtrField === 'string' && rawUtrField.length > 0 ? rawUtrField : null;
  if (rawUtr === null) {
    return { utr: null, parse_source: 'failed', latencyMs: call.latencyMs, rawUtr: null };
  }

  const normalizedCandidate = normalizeUtr(rawUtr);
  const matches = knownUtrs.filter(
    (known) => levenshteinDistance(normalizedCandidate, normalizeUtr(known)) <= FUZZY_MATCH_MAX_DISTANCE
  );

  if (matches.length === 1) {
    return { utr: matches[0], parse_source: 'llm', latencyMs: call.latencyMs, rawUtr };
  }
  // Zero matches, or 2+ (genuine ambiguity) — discard either way, never guess.
  return { utr: null, parse_source: 'failed', latencyMs: call.latencyMs, rawUtr };
}
