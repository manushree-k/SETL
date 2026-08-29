// Pass 0's narration parser. SETL_BLUEPRINT.md section 10 and section 13
// job 1 (the LLM's narrow narration-parsing job, which only runs on
// whatever this regex marks 'pending_llm' — no LLM call here).
//
// The design in two layers:
//
//   1. CANDIDATE_TOKEN finds alphanumeric runs of plausible UTR length,
//      bounded by `\b` on both sides. A glued-together run (no separator
//      around the UTR, e.g. 'UTR<utr>' or '<utr>HDFC0000060') has no
//      internal word boundary, so the whole run only matches here if its
//      TOTAL length happens to fall in the window — which the shape
//      check below then rules out.
//
//   2. KNOWN_UTR_SHAPE is the actual UTR format used throughout this
//      system: a 10-digit prefix followed by a 6-character alphabetic
//      suffix, e.g. '8659945258yqimbl' (section 1's own example,
//      '1568176960vxp0rj', is this exact shape). This EXACT length
//      requirement is what makes a truncated UTR fail — a truncated
//      one is 14 characters, not 16, so it cannot pass even though it
//      looks superficially plausible. A looser "12-22 characters, starts
//      with digits" check would wrongly accept a truncated UTR; getting
//      that acceptance criterion wrong is worse than rejecting a real one,
//      per the blueprint's own warning about an over-greedy regex.
//
// A narration with zero or more-than-one shape-matching candidate is
// handed to the LLM layer (parse_source: 'pending_llm') rather than
// guessed at — the LLM proposes, deterministic validation against known
// settlement UTRs (prompt 12) disposes.

const CANDIDATE_TOKEN = /\b[0-9a-zA-Z]{12,22}\b/g;
const KNOWN_UTR_SHAPE = /^\d{10}[a-zA-Z]{6}$/;

export type ParseSource = 'regex' | 'pending_llm';

export interface NarrationParseResult {
  utr: string | null;
  parse_source: ParseSource;
}

/**
 * Extract a UTR from a bank narration string via regex only. Returns
 * `parse_source: 'regex'` only when exactly one shape-matching candidate
 * is found — zero candidates (no UTR present, or it's unrecoverably
 * mangled) and multiple candidates (genuine ambiguity) both defer to
 * 'pending_llm' rather than guessing.
 */
export function extractUtr(narration: string): NarrationParseResult {
  const candidates = narration.match(CANDIDATE_TOKEN) ?? [];
  const plausible = candidates.filter((token) => KNOWN_UTR_SHAPE.test(token));

  if (plausible.length === 1) {
    return { utr: plausible[0], parse_source: 'regex' };
  }
  return { utr: null, parse_source: 'pending_llm' };
}
