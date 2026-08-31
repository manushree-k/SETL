// The AUTO/REVIEW/UNRESOLVED decision. SETL_BLUEPRINT.md section 12.
//
// Pure function: an exception class + a confidence score in, one Decision
// out. Two independent gates, both must pass for AUTO_RESOLVED:
//   1. confidence >= t_auto
//   2. the class itself is one section 11 marks "Auto-resolve? Yes"
// A class marked "No" (DISPUTE_HOLD, FEE_OVERCHARGE, ...) can still reach
// NEEDS_REVIEW or UNRESOLVED on confidence alone — it simply has no path to
// AUTO_RESOLVED, however high its confidence climbs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision, ExceptionClass } from '../types';

export type { Decision };

export interface DecisionThresholds {
  t_auto: number;
  t_review: number;
}

/**
 * Placeholders only — used before `scripts/sweepThresholds.ts` has ever
 * run, so the engine still produces a complete reconciliation on a fresh
 * clone. The real, frozen values come from that script's experiment on
 * the main batch (section 12: lowest t_auto with ≤0.5% false-match rate;
 * highest t_review, within [0.30, t_auto], with ≥90% correct-refusal
 * rate) and are read from `config/thresholds.json` below. Never tune
 * these placeholders by hand — re-run the sweep instead.
 */
const PLACEHOLDER_THRESHOLDS: DecisionThresholds = {
  t_auto: 0.9,
  t_review: 0.5,
};

/**
 * Read once, at module load — the same synchronous, load-once pattern
 * lib/env.ts uses for .env.local. Falls back to the placeholders above if
 * config/thresholds.json doesn't exist yet (before the first sweep run)
 * or is malformed; never throws for a missing file, since that would
 * block the engine from running at all on a fresh clone.
 */
function loadThresholds(): DecisionThresholds {
  try {
    const raw = readFileSync(join(process.cwd(), 'config', 'thresholds.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { t_auto?: unknown }).t_auto === 'number' &&
      typeof (parsed as { t_review?: unknown }).t_review === 'number'
    ) {
      return { t_auto: (parsed as { t_auto: number }).t_auto, t_review: (parsed as { t_review: number }).t_review };
    }
  } catch {
    // Not present yet, or unreadable — fall through to the placeholders.
  }
  return PLACEHOLDER_THRESHOLDS;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = loadThresholds();

/**
 * Section 11's "Auto-resolve?" column, Yes rows only. Everything absent
 * from this set — TDS_194O, DISPUTE_HOLD, DUPLICATE_CREDIT, MISSING_IN_BANK,
 * MISSING_IN_LEDGER, NOT_SETTLED, AMOUNT_MISMATCH, FEE_OVERCHARGE,
 * UNRESOLVED, INVALID_ROW — can reach at best NEEDS_REVIEW.
 */
const AUTO_RESOLVE_ELIGIBLE: ReadonlySet<ExceptionClass> = new Set<ExceptionClass>([
  'MATCHED_EXACT',
  'FEE_DEDUCTION',
  'GST_ON_FEE',
  'TIMING_DIFFERENCE',
  'PARTIAL_SETTLEMENT',
  'SPLIT_PAYOUT',
  'REFUND_NETTED',
  'ROUNDING_RESIDUAL',
]);

/**
 * `UNRESOLVED` and `INVALID_ROW` are decided in themselves — a record the
 * engine already refused to link, or a row that never parsed, is UNRESOLVED
 * regardless of whatever confidence number happened to be attached.
 */
const ALWAYS_UNRESOLVED: ReadonlySet<ExceptionClass> = new Set<ExceptionClass>(['UNRESOLVED', 'INVALID_ROW']);

export function decide(
  exceptionClass: ExceptionClass,
  confidence: number,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): Decision {
  if (ALWAYS_UNRESOLVED.has(exceptionClass)) return 'UNRESOLVED';

  if (AUTO_RESOLVE_ELIGIBLE.has(exceptionClass) && confidence >= thresholds.t_auto) {
    return 'AUTO_RESOLVED';
  }
  if (confidence >= thresholds.t_review) return 'NEEDS_REVIEW';
  return 'UNRESOLVED';
}
