// Classification. SETL_BLUEPRINT.md section 11 — the exception taxonomy.
//
// Pure function, split into one classifier per record kind, since the
// taxonomy's own "Detection" column is scoped that way (a bank line's
// failure modes are not a settlement line's). `run.ts` (prompt 09c) calls
// whichever of these fits each record, using the outputs Passes 1–6 already
// produced. No links are made here — this only reads pass output and
// assigns exactly one class, one reason, and a confidence for `decide.ts`
// to turn into AUTO_RESOLVED / NEEDS_REVIEW / UNRESOLVED.
//
// Two things this file does NOT do, both by design and both explained in
// SETL_BLUEPRINT.md:
//   - It does not compute `discrepancy_component`. That is Pass 6B (prompt
//     09B), which hasn't been written yet — FEE_DEDUCTION and GST_ON_FEE
//     below are assigned from Pass 6's line-level verdict only, and will
//     likely get refined once composition buckets exist to attribute a
//     settlement's difference precisely.
//   - A single settlement_line with a nonzero, in-tolerance fee produces
//     ONE class (FEE_DEDUCTION), not two. GST on that fee is always a fixed
//     18% of it, so it carries no independent information at line grain —
//     GST_ON_FEE's own detection is written for when composition math can
//     isolate the GST bucket specifically (Pass 6B), and until then this
//     classifier will not emit it from a bare line verdict.

import type { NormalizedBankLine, NormalizedSettlementLine } from '../normalize';
import type { ExceptionClass, Link, Order, Settlement } from '../types';
import type { UtrAmountMismatch } from './pass1-utr';
import type { Pass2AmbiguousMatch } from './pass2-amountDate';
import type { Pass3Ambiguity } from './pass3-aggregate';
import type { Pass4Verdict } from './pass4-balance';
import type { Pass5AmbiguousMatch, Pass5OrderVerdict } from './pass5-orderMatch';
import type { Pass6LineVerdict } from './pass6-feeAudit';
import { computeConfidence } from './confidence';
import { daysBetweenIST } from '../dates';

export interface Classification {
  exceptionClass: ExceptionClass;
  confidence: number;
  reason: string;
  /** Paise — "the size of the break." Zero for a class with nothing broken. */
  amountImpactPaise: number;
  /** Section 11's "Next action" column, verbatim where it names one; null where the table says "None." */
  nextAction: string | null;
}

/** Section 11's "Next action" column, one entry per class it names an action for. */
const NEXT_ACTION: Record<ExceptionClass, string | null> = {
  MATCHED_EXACT: null,
  FEE_DEDUCTION: 'Post to fee expense',
  GST_ON_FEE: 'Claim as input tax credit',
  TDS_194O: 'Verify against Form 26AS within 2 business days',
  TIMING_DIFFERENCE: 'Carry forward to next period',
  PARTIAL_SETTLEMENT: null,
  SPLIT_PAYOUT: null,
  REFUND_NETTED: 'Post refund against revenue',
  DISPUTE_HOLD: 'Track dispute; do not treat as receivable',
  DUPLICATE_CREDIT: 'Confirm with bank within 1 business day',
  MISSING_IN_BANK: 'Contact bank with UTR within 1 business day',
  MISSING_IN_LEDGER: 'Investigate source; possible unrecorded sale',
  // Not one of section 11's 15 classes — see the ExceptionClass note in lib/types.ts.
  NOT_SETTLED: 'Confirm the order was actually captured; escalate to Razorpay if so',
  AMOUNT_MISMATCH: 'Escalate to finance manager if > ₹10,000; 3 business days',
  FEE_OVERCHARGE: 'Raise with Razorpay support, cite entity_id',
  ROUNDING_RESIDUAL: 'Write off below materiality',
  UNRESOLVED: 'Manual investigation',
  INVALID_ROW: 'Fix the source row and re-ingest',
};

/** Assemble a Classification, filling next_action from the table above. */
function classified(
  exceptionClass: ExceptionClass,
  confidence: number,
  reason: string,
  amountImpactPaise: number
): Classification {
  return { exceptionClass, confidence, reason, amountImpactPaise, nextAction: NEXT_ACTION[exceptionClass] };
}

/** Adjustment lines carrying a TDS-under-194O signature in free text. */
const TDS_SIGNATURE = /\bTDS\b|\b194\s*-?O\b|SECTION\s*194\s*O/i;

// ---------------------------------------------------------------------------
// Bank lines
// ---------------------------------------------------------------------------

export interface BankLineClassificationInput {
  bankLine: NormalizedBankLine;
  /** Set only if Pass 1 flagged this as the second+ credit sharing a UTR. */
  duplicateOf?: { first_bank_line_no: number };
  /** Set only if Pass 1's UTR matched a settlement but the amount didn't. */
  utrAmountMismatch?: UtrAmountMismatch;
  /** Set only if this credit ended in Pass 2's or Pass 3's refusal. */
  ambiguousMatch?: { candidate_count: number; confidence: number };
  /** The link Pass 1/2/3 produced for this credit, if any. */
  link?: Link;
}

/**
 * Bank lines. Taxonomy rows covered: MATCHED_EXACT, DUPLICATE_CREDIT,
 * AMOUNT_MISMATCH, PARTIAL_SETTLEMENT, SPLIT_PAYOUT, MISSING_IN_LEDGER,
 * UNRESOLVED.
 */
export function classifyBankLine(input: BankLineClassificationInput): Classification {
  const { bankLine, duplicateOf, utrAmountMismatch, ambiguousMatch, link } = input;

  if (duplicateOf !== undefined) {
    return classified(
      'DUPLICATE_CREDIT',
      1.0, // the duplication itself is certain; the decision to auto-resolve is a separate, business gate
      `Bank line ${bankLine.line_no} shares its UTR with line ${duplicateOf.first_bank_line_no}, credited twice at ${bankLine.credit_paise} paise.`,
      bankLine.credit_paise
    );
  }

  if (utrAmountMismatch !== undefined) {
    const { confidence } = computeConfidence({
      keyStrength: 'utr_exact',
      amountDeltaPaise: utrAmountMismatch.amount_delta_paise,
      basePaise: utrAmountMismatch.settlement_amount_paise,
      dateDeltaDays: 0,
      candidateCount: 1,
    });
    return classified(
      'AMOUNT_MISMATCH',
      confidence,
      `Bank line ${bankLine.line_no} matches settlement ${utrAmountMismatch.settlement_id} by UTR, but the amount differs by ${utrAmountMismatch.amount_delta_paise} paise.`,
      Math.abs(utrAmountMismatch.amount_delta_paise)
    );
  }

  if (link !== undefined) {
    if (link.pass === 3) {
      const direction = link.evidence.direction;
      const exceptionClass: ExceptionClass =
        direction === 'many_settlements_one_credit' ? 'PARTIAL_SETTLEMENT' : 'SPLIT_PAYOUT';
      return classified(
        exceptionClass,
        link.confidence,
        exceptionClass === 'PARTIAL_SETTLEMENT'
          ? `Bank credit ${bankLine.line_no} (${bankLine.credit_paise} paise) is one payment split across ${String((link.evidence.members as string[]).length)} settlements.`
          : `Settlement ${link.right_id} arrived as multiple bank credits, this line among them.`,
        0
      );
    }
    return classified(
      'MATCHED_EXACT',
      link.confidence,
      `Bank line ${bankLine.line_no} reconciles to settlement ${link.right_id} (pass ${link.pass}).`,
      0
    );
  }

  if (ambiguousMatch !== undefined) {
    return classified(
      'UNRESOLVED',
      ambiguousMatch.confidence,
      `Bank line ${bankLine.line_no} has ${ambiguousMatch.candidate_count} equally plausible settlement candidates; refusing to guess.`,
      bankLine.credit_paise
    );
  }

  return classified(
    'MISSING_IN_LEDGER',
    0,
    `Bank line ${bankLine.line_no} (${bankLine.credit_paise} paise) has no matching settlement after Passes 1–3.`,
    bankLine.credit_paise
  );
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export interface SettlementClassificationInput {
  settlement: Settlement;
  pass4Verdict: Pass4Verdict;
  /** The bank-side link this settlement resolved through, if any. */
  link?: Link;
  ambiguousMatch?: Pass3Ambiguity;
}

/**
 * Settlements. Taxonomy rows covered: MATCHED_EXACT, PARTIAL_SETTLEMENT,
 * SPLIT_PAYOUT, MISSING_IN_BANK, ROUNDING_RESIDUAL, AMOUNT_MISMATCH,
 * UNRESOLVED.
 */
export function classifySettlement(input: SettlementClassificationInput): Classification {
  const { settlement, pass4Verdict, link, ambiguousMatch } = input;

  if (link === undefined) {
    if (ambiguousMatch !== undefined) {
      return classified(
        'UNRESOLVED',
        0.3 / ambiguousMatch.alternatives_found,
        `Settlement ${settlement.settlement_id} has ${ambiguousMatch.alternatives_found} equally plausible bank-side subsets; refusing to guess.`,
        settlement.amount_paise
      );
    }
    return classified(
      'MISSING_IN_BANK',
      0,
      `Settlement ${settlement.settlement_id} (${settlement.amount_paise} paise) has no bank credit linked after Passes 1–3.`,
      settlement.amount_paise
    );
  }

  if (link.pass === 3) {
    const direction = link.evidence.direction;
    const exceptionClass: ExceptionClass =
      direction === 'many_settlements_one_credit' ? 'PARTIAL_SETTLEMENT' : 'SPLIT_PAYOUT';
    return classified(
      exceptionClass,
      link.confidence,
      exceptionClass === 'PARTIAL_SETTLEMENT'
        ? `Settlement ${settlement.settlement_id} is one of several settlements paid by a single bank credit.`
        : `Settlement ${settlement.settlement_id} arrived as ${String((link.evidence.members as string[]).length)} separate bank credits.`,
      0
    );
  }

  switch (pass4Verdict.classification) {
    case 'BALANCED':
      return classified(
        'MATCHED_EXACT',
        link.confidence,
        `Settlement ${settlement.settlement_id} balances internally and reconciles to the bank to the paise.`,
        0
      );
    case 'ROUNDING_RESIDUAL':
      return classified(
        'ROUNDING_RESIDUAL',
        0.95,
        `Settlement ${settlement.settlement_id} has a ${pass4Verdict.residual_paise} paise residual — below materiality, written off.`,
        Math.abs(pass4Verdict.residual_paise)
      );
    case 'AMOUNT_MISMATCH':
      return classified(
        'AMOUNT_MISMATCH',
        0.5,
        `Settlement ${settlement.settlement_id}'s lines net to ${pass4Verdict.computed_net_paise} paise against a header of ${pass4Verdict.header_amount_paise} paise — a ${pass4Verdict.residual_paise} paise residual beyond rounding.`,
        Math.abs(pass4Verdict.residual_paise)
      );
  }
}

// ---------------------------------------------------------------------------
// Settlement lines
// ---------------------------------------------------------------------------

export interface SettlementLineClassificationInput {
  line: NormalizedSettlementLine;
  /** Pass 5's link for this line (line_to_order or refund_to_order), if any. */
  orderLink?: Link;
  ambiguousOrderMatch?: Pass5AmbiguousMatch;
  /** Pass 6's fee verdict — payment lines only. */
  feeVerdict?: Pass6LineVerdict;
  /**
   * The created_at of the settlement this line actually ended up in, if
   * any — the signal TIMING_DIFFERENCE detection needs. Deliberately NOT
   * the line-to-order date delta (Pass 5's evidence): injectTimingDifference
   * (scripts/generate.ts) moves a line to a different SETTLEMENT, never
   * touches its relationship to its own order, so the order-date delta
   * never changes for a genuine timing-difference case.
   */
  actualSettlementCreatedAt?: Date | null;
  /**
   * The order's own order_amount_paise, if this line has an order_id and
   * that order exists — needed to tell a genuine timing-difference line
   * (which always carries its order's FULL amount; only the settlement
   * changed) apart from a PARTIAL_SETTLEMENT half (which, by construction,
   * carries only part of the order's amount, but lands in an equally
   * "wrong-cycle" settlement — measured empirically against real data
   * before picking this guard, see FAILURES.md 2026-08-31).
   */
  orderAmountPaise?: number | null;
}

/**
 * Settlement lines. Taxonomy rows covered: MATCHED_EXACT, FEE_DEDUCTION,
 * TDS_194O, TIMING_DIFFERENCE, REFUND_NETTED, DISPUTE_HOLD, AMOUNT_MISMATCH,
 * FEE_OVERCHARGE, UNRESOLVED. PARTIAL_SETTLEMENT is not yet covered here —
 * see FAILURES.md 2026-08-31, deferred.
 *
 * Order matters: a hold takes precedence over everything else (money is
 * frozen, full stop), then TDS, then a netted refund, then the
 * settlement-cycle timing check, then order-match outcomes, then the fee
 * verdict.
 */
export function classifySettlementLine(input: SettlementLineClassificationInput): Classification {
  const { line, orderLink, ambiguousOrderMatch, feeVerdict, actualSettlementCreatedAt, orderAmountPaise } = input;

  if (line.on_hold && line.dispute_id !== null && line.settlement_id === null) {
    return classified(
      'DISPUTE_HOLD',
      1.0,
      `Line ${line.entity_id} is on hold pending dispute ${line.dispute_id} and carries no settlement.`,
      line.amount_paise
    );
  }

  if (line.type === 'adjustment' && TDS_SIGNATURE.test(line.description)) {
    return classified(
      'TDS_194O',
      0.7,
      `Adjustment line ${line.entity_id} ("${line.description}") carries a TDS-under-194O signature.`,
      Math.abs(line.debit_paise - line.credit_paise)
    );
  }

  if (line.type === 'refund' && line.debit_paise > 0) {
    return classified(
      'REFUND_NETTED',
      0.95,
      `Refund line ${line.entity_id} deducts ${line.debit_paise} paise from this settlement's payout.`,
      line.debit_paise
    );
  }

  // Settlement-cycle timing check. Guarded to the line's FULL order amount
  // (not a fraction of it) so a PARTIAL_SETTLEMENT half — which lands in an
  // equally "wrong-cycle" settlement by construction, but is a different
  // taxonomy class — can't be misread as a timing difference; verified
  // against real data (both batches) that this guard cleanly separates the
  // two: genuine timing-difference lines land at a 3+ day cycle gap, every
  // full-amount line without one lands at exactly 0 (FAILURES.md 2026-08-31).
  if (
    line.type === 'payment' &&
    line.settlement_cycle_date !== null &&
    actualSettlementCreatedAt !== null &&
    actualSettlementCreatedAt !== undefined &&
    orderAmountPaise !== null &&
    orderAmountPaise !== undefined &&
    line.amount_paise === orderAmountPaise
  ) {
    const cycleDeltaDays = daysBetweenIST(line.settlement_cycle_date, actualSettlementCreatedAt);
    if (cycleDeltaDays >= 3) {
      return classified(
        'TIMING_DIFFERENCE',
        orderLink?.confidence ?? 0.9,
        `Line ${line.entity_id} was predicted to settle ${cycleDeltaDays} days before the settlement it actually landed in.`,
        0
      );
    }
  }

  if (orderLink !== undefined) {
    if (feeVerdict === undefined || feeVerdict.classification === 'TOLERATED') {
      if (feeVerdict !== undefined && feeVerdict.actual_fee_paise > 0) {
        return classified(
          'FEE_DEDUCTION',
          1.0,
          `Line ${line.entity_id}'s payout is ${feeVerdict.actual_fee_paise} paise lower than gross, matching the contracted rate.`,
          feeVerdict.actual_fee_paise
        );
      }
      return classified(
        'MATCHED_EXACT',
        orderLink.confidence,
        `Line ${line.entity_id} matches order ${orderLink.right_id} exactly.`,
        0
      );
    }
    // fall through to the fee verdict below — matched to an order, but the
    // fee itself is the actual break.
  }

  if (feeVerdict !== undefined) {
    if (feeVerdict.classification === 'FEE_OVERCHARGE' || feeVerdict.classification === 'FEE_UNDERCHARGE') {
      const sign = feeVerdict.classification === 'FEE_OVERCHARGE' ? 'more' : 'less';
      return classified(
        'FEE_OVERCHARGE',
        0.5,
        `Line ${line.entity_id} was charged ${Math.abs(feeVerdict.fee_delta_paise ?? 0)} paise ${sign} than the ${line.method ?? 'unknown'} rate card expects.`,
        Math.abs(feeVerdict.fee_delta_paise ?? 0)
      );
    }
    if (feeVerdict.classification === 'AMOUNT_MISMATCH') {
      return classified(
        'AMOUNT_MISMATCH',
        0,
        `Line ${line.entity_id}'s method/card type cannot be resolved against the rate card — refusing to assume a fee of zero.`,
        line.fee_paise
      );
    }
  }

  if (ambiguousOrderMatch !== undefined) {
    return classified(
      'UNRESOLVED',
      ambiguousOrderMatch.confidence,
      `Line ${line.entity_id} has ${ambiguousOrderMatch.candidate_count} equally plausible orders; refusing to guess.`,
      line.amount_paise
    );
  }

  return classified(
    'UNRESOLVED',
    0,
    `Line ${line.entity_id} matches no order and carries no resolvable fee verdict.`,
    line.amount_paise
  );
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Orders. Only orders Pass 5 left unmatched need a classification at all —
 * a matched order's story is told by its settlement line's own class.
 * Taxonomy row covered: DISPUTE_HOLD. NOT_SETTLED is not one of section
 * 11's 15 classes — see the note on `ExceptionClass` in lib/types.ts.
 */
export function classifyOrder(order: Order, verdict: Pass5OrderVerdict): Classification {
  if (verdict.classification === 'DISPUTE_HOLD') {
    return classified(
      'DISPUTE_HOLD',
      1.0,
      `Order ${order.order_id} has an on-hold settlement line pending dispute and is not yet payable.`,
      order.order_amount_paise
    );
  }
  return classified(
    'NOT_SETTLED',
    0,
    `Order ${order.order_id} (${order.order_amount_paise} paise) has no settlement line referencing it at all.`,
    order.order_amount_paise
  );
}
