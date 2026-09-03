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
import thresholdsJson from '../../config/thresholds.json';

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

function isValidThresholds(v: unknown): v is DecisionThresholds {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.t_auto === 'number' &&
    typeof t.t_review === 'number' &&
    Number.isFinite(t.t_auto) &&
    Number.isFinite(t.t_review) &&
    t.t_auto >= 0 &&
    t.t_auto <= 1 &&
    t.t_review >= 0 &&
    t.t_review <= 1 &&
    t.t_review <= t.t_auto &&
    t.t_review >= 0.3
  );
}

/**
 * Read once, at module load — bundled import first (ensures Vercel tracing),
 * then filesystem (local dev override). Falls back to placeholders if invalid.
 */
function loadThresholds(): DecisionThresholds {
  if (isValidThresholds(thresholdsJson)) return thresholdsJson as DecisionThresholds;
  // Filesystem override for local dev where config may have been re-swept
  try {
    const raw = readFileSync(join(process.cwd(), 'config', 'thresholds.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isValidThresholds(parsed)) return parsed;
    console.warn(`[decide] invalid thresholds.json ${JSON.stringify(parsed)} — using bundled value`);
    if (isValidThresholds(thresholdsJson)) return thresholdsJson as DecisionThresholds;
  } catch {
    // missing — use bundled
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
  if (!isValidThresholds(thresholds)) {
    throw new Error(`Invalid thresholds ${JSON.stringify(thresholds)} — must satisfy 0.3 ≤ t_review ≤ t_auto ≤ 1`);
  }
  if (ALWAYS_UNRESOLVED.has(exceptionClass)) return 'UNRESOLVED';

  if (AUTO_RESOLVE_ELIGIBLE.has(exceptionClass) && confidence >= thresholds.t_auto) {
    return 'AUTO_RESOLVED';
  }
  if (confidence >= thresholds.t_review) return 'NEEDS_REVIEW';
  return 'UNRESOLVED';
}
