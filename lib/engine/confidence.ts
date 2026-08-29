// Confidence scoring. SETL_BLUEPRINT.md section 12.
//
// Pure function: evidence quality in, a score in [0, 1] out, with every
// multiplicand preserved so the UI can show "why 0.87?" as four numbers
// instead of a black box. This is the SAME reason the ML gate in section 15
// has to earn its place — a formula this inspectable is a high bar to beat.
//
// confidence = key_strength × amount_factor × date_factor × ambiguity_factor

/** Which kind of evidence key produced a candidate match. */
export type KeyStrength =
  | 'utr_exact'
  | 'order_id_exact'
  | 'subset_sum_unique'
  | 'amount_date_unique'
  | 'amount_date_ambiguous';

const KEY_STRENGTH_VALUE: Record<KeyStrength, number> = {
  utr_exact: 1.0,
  order_id_exact: 0.95,
  subset_sum_unique: 0.9,
  amount_date_unique: 0.8,
  amount_date_ambiguous: 0.3,
};

export interface ConfidenceInput {
  keyStrength: KeyStrength;
  /** Bank/settlement (or line/order) amount delta, in paise. Sign ignored. */
  amountDeltaPaise: number;
  /**
   * The reference amount the delta is judged against, in paise — needed
   * only to evaluate the "delta ≤ 0.1%" tier. When omitted, that tier is
   * skipped (a delta over 100 paise falls straight to the 0.50 tier), since
   * a percentage cannot be computed without a base to divide by.
   */
  basePaise?: number;
  /** Days between the two records' dates. Sign ignored; 0 = same day. */
  dateDeltaDays: number;
  /** How many equally-plausible candidates this match competed against. 1 = unique. */
  candidateCount: number;
}

export interface ConfidenceBreakdown {
  key_strength: number;
  amount_factor: number;
  date_factor: number;
  ambiguity_factor: number;
  /** The product of the four factors above — the score actually used. */
  confidence: number;
}

function amountFactor(absDeltaPaise: number, basePaise: number | undefined): number {
  if (absDeltaPaise === 0) return 1.0;
  if (absDeltaPaise <= 100) return 0.95;
  if (basePaise !== undefined && basePaise > 0) {
    // delta ≤ 0.1% of the base amount. Compared as delta*1000 <= base to
    // stay in integer arithmetic — no fraction is ever formed.
    if (absDeltaPaise * 1000 <= basePaise) return 0.85;
  }
  return 0.5;
}

function dateFactor(absDeltaDays: number): number {
  if (absDeltaDays === 0) return 1.0; // within cycle
  if (absDeltaDays === 1) return 0.95;
  if (absDeltaDays <= 3) return 0.85; // +2–3 days
  return 0.7; // beyond
}

/**
 * Score a candidate match per section 12's four-factor formula.
 *
 * `ambiguity_factor` is `1 / candidateCount` throughout — the table's
 * listed values (1.00, 0.50, 0.33, 1/n) are exactly that fraction, the
 * middle two just shown rounded to two decimals.
 */
export function computeConfidence(input: ConfidenceInput): ConfidenceBreakdown {
  if (!Number.isInteger(input.candidateCount) || input.candidateCount < 1) {
    throw new Error(`candidateCount must be a positive integer, received ${input.candidateCount}.`);
  }

  const key_strength = KEY_STRENGTH_VALUE[input.keyStrength];
  const amount_factor = amountFactor(Math.abs(input.amountDeltaPaise), input.basePaise);
  const date_factor = dateFactor(Math.abs(input.dateDeltaDays));
  const ambiguity_factor = 1 / input.candidateCount;

  return {
    key_strength,
    amount_factor,
    date_factor,
    ambiguity_factor,
    confidence: key_strength * amount_factor * date_factor * ambiguity_factor,
  };
}
