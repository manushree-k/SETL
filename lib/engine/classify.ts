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

export interface Classification {
  exceptionClass: ExceptionClass;
  confidence: number;
  reason: string;
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
    return {
      exceptionClass: 'DUPLICATE_CREDIT',
      confidence: 1.0, // the duplication itself is certain; the decision to auto-resolve is a separate, business gate
      reason: `Bank line ${bankLine.line_no} shares its UTR with line ${duplicateOf.first_bank_line_no}, credited twice at ${bankLine.credit_paise} paise.`,
    };
  }

  if (utrAmountMismatch !== undefined) {
    const { confidence } = computeConfidence({
      keyStrength: 'utr_exact',
      amountDeltaPaise: utrAmountMismatch.amount_delta_paise,
      basePaise: utrAmountMismatch.settlement_amount_paise,
      dateDeltaDays: 0,
      candidateCount: 1,
    });
    return {
      exceptionClass: 'AMOUNT_MISMATCH',
      confidence,
      reason: `Bank line ${bankLine.line_no} matches settlement ${utrAmountMismatch.settlement_id} by UTR, but the amount differs by ${utrAmountMismatch.amount_delta_paise} paise.`,
    };
  }

  if (link !== undefined) {
    if (link.pass === 3) {
      const direction = link.evidence.direction;
      const exceptionClass: ExceptionClass =
        direction === 'many_settlements_one_credit' ? 'PARTIAL_SETTLEMENT' : 'SPLIT_PAYOUT';
      return {
        exceptionClass,
        confidence: link.confidence,
        reason:
          exceptionClass === 'PARTIAL_SETTLEMENT'
            ? `Bank credit ${bankLine.line_no} (${bankLine.credit_paise} paise) is one payment split across ${String((link.evidence.members as string[]).length)} settlements.`
            : `Settlement ${link.right_id} arrived as multiple bank credits, this line among them.`,
      };
    }
    return {
      exceptionClass: 'MATCHED_EXACT',
      confidence: link.confidence,
      reason: `Bank line ${bankLine.line_no} reconciles to settlement ${link.right_id} (pass ${link.pass}).`,
    };
  }

  if (ambiguousMatch !== undefined) {
    return {
      exceptionClass: 'UNRESOLVED',
      confidence: ambiguousMatch.confidence,
      reason: `Bank line ${bankLine.line_no} has ${ambiguousMatch.candidate_count} equally plausible settlement candidates; refusing to guess.`,
    };
  }

  return {
    exceptionClass: 'MISSING_IN_LEDGER',
    confidence: 0,
    reason: `Bank line ${bankLine.line_no} (${bankLine.credit_paise} paise) has no matching settlement after Passes 1–3.`,
  };
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
      return {
        exceptionClass: 'UNRESOLVED',
        confidence: 0.3 / ambiguousMatch.alternatives_found,
        reason: `Settlement ${settlement.settlement_id} has ${ambiguousMatch.alternatives_found} equally plausible bank-side subsets; refusing to guess.`,
      };
    }
    return {
      exceptionClass: 'MISSING_IN_BANK',
      confidence: 0,
      reason: `Settlement ${settlement.settlement_id} (${settlement.amount_paise} paise) has no bank credit linked after Passes 1–3.`,
    };
  }

  if (link.pass === 3) {
    const direction = link.evidence.direction;
    const exceptionClass: ExceptionClass =
      direction === 'many_settlements_one_credit' ? 'PARTIAL_SETTLEMENT' : 'SPLIT_PAYOUT';
    return {
      exceptionClass,
      confidence: link.confidence,
      reason:
        exceptionClass === 'PARTIAL_SETTLEMENT'
          ? `Settlement ${settlement.settlement_id} is one of several settlements paid by a single bank credit.`
          : `Settlement ${settlement.settlement_id} arrived as ${String((link.evidence.members as string[]).length)} separate bank credits.`,
    };
  }

  switch (pass4Verdict.classification) {
    case 'BALANCED':
      return {
        exceptionClass: 'MATCHED_EXACT',
        confidence: link.confidence,
        reason: `Settlement ${settlement.settlement_id} balances internally and reconciles to the bank to the paise.`,
      };
    case 'ROUNDING_RESIDUAL':
      return {
        exceptionClass: 'ROUNDING_RESIDUAL',
        confidence: 0.95,
        reason: `Settlement ${settlement.settlement_id} has a ${pass4Verdict.residual_paise} paise residual — below materiality, written off.`,
      };
    case 'AMOUNT_MISMATCH':
      return {
        exceptionClass: 'AMOUNT_MISMATCH',
        confidence: 0.5,
        reason: `Settlement ${settlement.settlement_id}'s lines net to ${pass4Verdict.computed_net_paise} paise against a header of ${pass4Verdict.header_amount_paise} paise — a ${pass4Verdict.residual_paise} paise residual beyond rounding.`,
      };
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
}

/**
 * Settlement lines. Taxonomy rows covered: MATCHED_EXACT, FEE_DEDUCTION,
 * TDS_194O, TIMING_DIFFERENCE, REFUND_NETTED, DISPUTE_HOLD, AMOUNT_MISMATCH,
 * FEE_OVERCHARGE, UNRESOLVED.
 *
 * Order matters: a hold takes precedence over everything else (money is
 * frozen, full stop), then TDS, then a netted refund, then order-match
 * outcomes, then the fee verdict.
 */
export function classifySettlementLine(input: SettlementLineClassificationInput): Classification {
  const { line, orderLink, ambiguousOrderMatch, feeVerdict } = input;

  if (line.on_hold && line.dispute_id !== null && line.settlement_id === null) {
    return {
      exceptionClass: 'DISPUTE_HOLD',
      confidence: 1.0,
      reason: `Line ${line.entity_id} is on hold pending dispute ${line.dispute_id} and carries no settlement.`,
    };
  }

  if (line.type === 'adjustment' && TDS_SIGNATURE.test(line.description)) {
    return {
      exceptionClass: 'TDS_194O',
      confidence: 0.7,
      reason: `Adjustment line ${line.entity_id} ("${line.description}") carries a TDS-under-194O signature.`,
    };
  }

  if (line.type === 'refund' && line.debit_paise > 0) {
    return {
      exceptionClass: 'REFUND_NETTED',
      confidence: 0.95,
      reason: `Refund line ${line.entity_id} deducts ${line.debit_paise} paise from this settlement's payout.`,
    };
  }

  if (orderLink !== undefined) {
    const dateDeltaDays = orderLink.evidence.date_delta_days as number;
    // T+2 business days is the normal cycle; a settlement line linked to
    // its order well beyond that captured near a cutoff, not a problem.
    if (Math.abs(dateDeltaDays) > 3) {
      return {
        exceptionClass: 'TIMING_DIFFERENCE',
        confidence: orderLink.confidence,
        reason: `Line ${line.entity_id} matches order ${orderLink.right_id} but settled ${dateDeltaDays} days later than the normal cycle.`,
      };
    }
    if (feeVerdict === undefined || feeVerdict.classification === 'TOLERATED') {
      if (feeVerdict !== undefined && feeVerdict.actual_fee_paise > 0) {
        return {
          exceptionClass: 'FEE_DEDUCTION',
          confidence: 1.0,
          reason: `Line ${line.entity_id}'s payout is ${feeVerdict.actual_fee_paise} paise lower than gross, matching the contracted rate.`,
        };
      }
      return {
        exceptionClass: 'MATCHED_EXACT',
        confidence: orderLink.confidence,
        reason: `Line ${line.entity_id} matches order ${orderLink.right_id} exactly.`,
      };
    }
    // fall through to the fee verdict below — matched to an order, but the
    // fee itself is the actual break.
  }

  if (feeVerdict !== undefined) {
    if (feeVerdict.classification === 'FEE_OVERCHARGE' || feeVerdict.classification === 'FEE_UNDERCHARGE') {
      const sign = feeVerdict.classification === 'FEE_OVERCHARGE' ? 'more' : 'less';
      return {
        exceptionClass: 'FEE_OVERCHARGE',
        confidence: 0.5,
        reason: `Line ${line.entity_id} was charged ${Math.abs(feeVerdict.fee_delta_paise ?? 0)} paise ${sign} than the ${line.method ?? 'unknown'} rate card expects.`,
      };
    }
    if (feeVerdict.classification === 'AMOUNT_MISMATCH') {
      return {
        exceptionClass: 'AMOUNT_MISMATCH',
        confidence: 0,
        reason: `Line ${line.entity_id}'s method/card type cannot be resolved against the rate card — refusing to assume a fee of zero.`,
      };
    }
  }

  if (ambiguousOrderMatch !== undefined) {
    return {
      exceptionClass: 'UNRESOLVED',
      confidence: ambiguousOrderMatch.confidence,
      reason: `Line ${line.entity_id} has ${ambiguousOrderMatch.candidate_count} equally plausible orders; refusing to guess.`,
    };
  }

  return {
    exceptionClass: 'UNRESOLVED',
    confidence: 0,
    reason: `Line ${line.entity_id} matches no order and carries no resolvable fee verdict.`,
  };
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
    return {
      exceptionClass: 'DISPUTE_HOLD',
      confidence: 1.0,
      reason: `Order ${order.order_id} has an on-hold settlement line pending dispute and is not yet payable.`,
    };
  }
  return {
    exceptionClass: 'NOT_SETTLED',
    confidence: 0,
    reason: `Order ${order.order_id} (${order.order_amount_paise} paise) has no settlement line referencing it at all.`,
  };
}
