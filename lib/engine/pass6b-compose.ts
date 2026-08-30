// Pass 6B — Settlement composition. SETL_BLUEPRINT.md section 10, Pass 6B.
//
// Pure function: settlement headers + their lines + the bank links from
// Passes 1–3 + Pass 6's fee verdicts in, one composition row per settlement
// out, plus a signed contribution for every settlement line. Runs for
// EVERY settlement, reconciled or not, including ones with no bank link
// and ones with zero lines — "it tied out" and "here is what it was made
// of" are different answers, and the merchant needs both.
//
// Not this file's job: `discrepancy_component` does not get attached to
// any exception row here — classify.ts is out of this prompt's scope.
// `run.ts` folds it into the settlement exception's evidence instead.

import type { NormalizedBankLine, NormalizedSettlementLine } from '../normalize';
import type { Link, Settlement } from '../types';
import type { Pass6LineVerdict } from './pass6-feeAudit';

export type ContributionBucket = 'gross' | 'refund' | 'dispute' | 'adjustment';

/** One settlement line's signed effect on its settlement's payout. */
export interface LineContribution {
  entity_id: string;
  contribution_paise: number;
  contribution_bucket: ContributionBucket;
  contribution_reason: string;
}

export type CompositionStatus =
  | 'FULLY_RECONCILED'
  | 'RECONCILED_WITH_ROUNDING'
  | 'DISCREPANCY'
  | 'UNMATCHED_TO_BANK';

export type DiscrepancyComponent =
  | 'NONE'
  | 'FEES'
  | 'GST'
  | 'REFUNDS'
  | 'DISPUTES'
  | 'ADJUSTMENTS'
  | 'BANK_CREDIT'
  | 'ROUNDING'
  | 'UNATTRIBUTED';

export interface SettlementComposition {
  settlement_id: string;
  gross_payments_paise: number;
  fees_total_paise: number;
  gst_total_paise: number;
  refunds_total_paise: number;
  disputes_total_paise: number;
  adjustments_net_paise: number; // signed
  expected_payout_paise: number;
  header_amount_paise: number;
  bank_credit_total_paise: number | null; // null if unlinked
  diff_expected_vs_header_paise: number;
  diff_header_vs_bank_paise: number | null;
  diff_total_paise: number | null;
  payment_count: number;
  refund_count: number;
  dispute_count: number;
  adjustment_count: number; // adjustment + transfer lines together
  status: CompositionStatus;
  discrepancy_component: DiscrepancyComponent;
  evidence: Record<string, unknown>;
}

export interface Pass6BResult {
  compositions: SettlementComposition[];
  lineContributions: LineContribution[];
}

/** 1–99 paise, inclusive — the same rounding tolerance Pass 4 uses. */
const ROUNDING_MIN_PAISE = 1;
const ROUNDING_MAX_PAISE = 99;

/**
 * The eight-step discrepancy attribution ladder. First hit wins; falling
 * through every step is a legitimate outcome (`UNATTRIBUTED`), never a bug
 * to paper over by forcing a guess.
 */
function attributeDiscrepancy(input: {
  diffTotal: number;
  diffExpectedVsHeader: number;
  diffHeaderVsBank: number;
  lines: readonly NormalizedSettlementLine[];
  pass6Verdicts: readonly Pass6LineVerdict[];
  links: readonly Link[];
}): DiscrepancyComponent {
  const { diffTotal, diffExpectedVsHeader, diffHeaderVsBank, lines, pass6Verdicts, links } = input;
  const absDiff = Math.abs(diffTotal);

  const feeVerdicts = lines
    .filter((l) => l.type === 'payment')
    .map((l) => pass6Verdicts.find((v) => v.entity_id === l.entity_id))
    .filter((v): v is Pass6LineVerdict => v !== undefined);

  // 1. Fees
  const sumFeeDelta = feeVerdicts.reduce((acc, v) => acc + (v.fee_delta_paise ?? 0), 0);
  if (absDiff === Math.abs(sumFeeDelta)) return 'FEES';

  // 2. GST
  const sumGstDelta = feeVerdicts.reduce((acc, v) => acc + (v.gst_delta_paise ?? 0), 0);
  if (absDiff === Math.abs(sumGstDelta)) return 'GST';

  // 3. A refund line with no linked order, whose debit equals the difference
  const linkedLineEntityIds = new Set(
    links.filter((l) => l.left_source === 'settlement_line').map((l) => l.left_id)
  );
  const unmatchedRefund = lines.find(
    (l) => l.type === 'refund' && !linkedLineEntityIds.has(l.entity_id) && l.debit_paise === absDiff
  );
  if (unmatchedRefund !== undefined) return 'REFUNDS';

  // 4. A dispute line whose debit equals the difference
  const disputeLine = lines.find((l) => l.type === 'dispute' && l.debit_paise === absDiff);
  if (disputeLine !== undefined) return 'DISPUTES';

  // 5. An adjustment/transfer line whose own net equals the difference
  const adjustmentLine = lines.find(
    (l) => (l.type === 'adjustment' || l.type === 'transfer') && Math.abs(l.credit_paise - l.debit_paise) === absDiff
  );
  if (adjustmentLine !== undefined) return 'ADJUSTMENTS';

  // 6. Razorpay's own numbers tie out; the bank is the odd one out
  if (diffExpectedVsHeader === 0 && diffHeaderVsBank !== 0) return 'BANK_CREDIT';

  // 7. Small residual that didn't already resolve to RECONCILED_WITH_ROUNDING
  if (absDiff < 100) return 'ROUNDING';

  // 8. No forced attribution.
  return 'UNATTRIBUTED';
}

/**
 * Pass 6B — bucket every settlement's lines, derive its expected payout,
 * compare against the header and the linked bank credit, and attach a
 * signed contribution to every line.
 */
export function runPass6B(
  settlements: readonly Settlement[],
  settlementLines: readonly NormalizedSettlementLine[],
  bankLines: readonly NormalizedBankLine[],
  links: readonly Link[],
  pass6Verdicts: readonly Pass6LineVerdict[]
): Pass6BResult {
  const compositions: SettlementComposition[] = [];
  const lineContributions: LineContribution[] = [];

  const bankLinesByLineNo = new Map<number, NormalizedBankLine>();
  for (const b of bankLines) bankLinesByLineNo.set(b.line_no, b);

  for (const settlement of settlements) {
    const lines = settlementLines.filter((l) => l.settlement_id === settlement.settlement_id);

    let gross = 0;
    let fees = 0;
    let gst = 0;
    let refunds = 0;
    let disputes = 0;
    let adjustmentsNet = 0;
    let paymentCount = 0;
    let refundCount = 0;
    let disputeCount = 0;
    let adjustmentCount = 0;
    const contributions: LineContribution[] = [];

    for (const line of lines) {
      if (line.type === 'payment') {
        gross += line.amount_paise;
        fees += line.fee_paise;
        gst += line.tax_paise;
        paymentCount += 1;
        contributions.push({
          entity_id: line.entity_id,
          contribution_paise: line.amount_paise - line.fee_paise - line.tax_paise,
          contribution_bucket: 'gross',
          contribution_reason: `Payment ${line.entity_id}: gross ${line.amount_paise} paise, minus fee ${line.fee_paise} paise, minus GST ${line.tax_paise} paise.`,
        });
      } else if (line.type === 'refund') {
        refunds += line.debit_paise;
        refundCount += 1;
        contributions.push({
          entity_id: line.entity_id,
          contribution_paise: -line.debit_paise,
          contribution_bucket: 'refund',
          contribution_reason: `Refund ${line.entity_id} deducts ${line.debit_paise} paise from the payout.`,
        });
      } else if (line.type === 'dispute') {
        disputes += line.debit_paise;
        disputeCount += 1;
        contributions.push({
          entity_id: line.entity_id,
          contribution_paise: -line.debit_paise,
          contribution_bucket: 'dispute',
          contribution_reason: `Dispute ${line.entity_id} holds ${line.debit_paise} paise out of the payout pending resolution.`,
        });
      } else {
        // 'adjustment' or 'transfer'
        const net = line.credit_paise - line.debit_paise;
        adjustmentsNet += net;
        adjustmentCount += 1;
        contributions.push({
          entity_id: line.entity_id,
          contribution_paise: net,
          contribution_bucket: 'adjustment',
          contribution_reason: `${line.type === 'adjustment' ? 'Adjustment' : 'Transfer'} ${line.entity_id} nets ${net} paise (credit − debit) into the payout.`,
        });
      }
    }

    const expectedPayout = gross - fees - gst - refunds - disputes + adjustmentsNet;

    // Identity A: recomputed independently. By construction this is the
    // same formula as expectedPayout above, so a failure here is a
    // copy-paste bug in this function, not a data finding.
    const identityA = gross - fees - gst - refunds - disputes + adjustmentsNet;
    if (identityA !== expectedPayout) {
      throw new Error(
        `Settlement ${settlement.settlement_id}: conservation identity A failed (${identityA} != ${expectedPayout}). This is a code bug.`
      );
    }
    const sumContributions = contributions.reduce((acc, c) => acc + c.contribution_paise, 0);
    if (sumContributions !== expectedPayout) {
      throw new Error(
        `Settlement ${settlement.settlement_id}: conservation identity B failed (Σ contribution ${sumContributions} != expected payout ${expectedPayout}). This is a code bug.`
      );
    }

    // Bank credit total: sum every bank line already linked to this
    // settlement (Passes 1–3). A settlement paid as several credits
    // (SPLIT_PAYOUT) sums them all; bank_line_count records how many.
    const settlementBankLinks = links.filter(
      (l) => l.relation === 'bank_to_settlement' && l.right_id === settlement.settlement_id
    );
    let bankCreditTotal: number | null = null;
    let bankLineCount = 0;
    if (settlementBankLinks.length > 0) {
      bankCreditTotal = 0;
      for (const link of settlementBankLinks) {
        const bankLine = bankLinesByLineNo.get(Number(link.left_id));
        if (bankLine !== undefined) {
          bankCreditTotal += bankLine.credit_paise;
          bankLineCount += 1;
        }
      }
    }

    const diffExpectedVsHeader = expectedPayout - settlement.amount_paise;
    const diffHeaderVsBank = bankCreditTotal === null ? null : settlement.amount_paise - bankCreditTotal;
    const diffTotal = bankCreditTotal === null ? null : expectedPayout - bankCreditTotal;

    let status: CompositionStatus;
    let discrepancyComponent: DiscrepancyComponent;

    if (lines.length === 0) {
      // A payout with no lines behind it is always a serious finding —
      // never let it disappear into UNMATCHED_TO_BANK just because it
      // also happens to be unlinked.
      status = 'DISCREPANCY';
      discrepancyComponent = 'UNATTRIBUTED';
    } else if (bankCreditTotal === null) {
      status = 'UNMATCHED_TO_BANK';
      discrepancyComponent = 'NONE';
    } else if (diffTotal === 0) {
      status = 'FULLY_RECONCILED';
      discrepancyComponent = 'NONE';
    } else {
      // diffTotal and diffHeaderVsBank are non-null here: both are derived
      // from bankCreditTotal, already checked non-null above, but TS
      // cannot follow that derivation across the separate variables.
      const nonNullDiffTotal = diffTotal as number;
      const absDiff = Math.abs(nonNullDiffTotal);
      if (absDiff >= ROUNDING_MIN_PAISE && absDiff <= ROUNDING_MAX_PAISE) {
        status = 'RECONCILED_WITH_ROUNDING';
        discrepancyComponent = 'NONE';
      } else {
        status = 'DISCREPANCY';
        discrepancyComponent = attributeDiscrepancy({
          diffTotal: nonNullDiffTotal,
          diffExpectedVsHeader,
          diffHeaderVsBank: diffHeaderVsBank as number,
          lines,
          pass6Verdicts,
          links,
        });
      }
    }

    compositions.push({
      settlement_id: settlement.settlement_id,
      gross_payments_paise: gross,
      fees_total_paise: fees,
      gst_total_paise: gst,
      refunds_total_paise: refunds,
      disputes_total_paise: disputes,
      adjustments_net_paise: adjustmentsNet,
      expected_payout_paise: expectedPayout,
      header_amount_paise: settlement.amount_paise,
      bank_credit_total_paise: bankCreditTotal,
      diff_expected_vs_header_paise: diffExpectedVsHeader,
      diff_header_vs_bank_paise: diffHeaderVsBank,
      diff_total_paise: diffTotal,
      payment_count: paymentCount,
      refund_count: refundCount,
      dispute_count: disputeCount,
      adjustment_count: adjustmentCount,
      status,
      discrepancy_component: discrepancyComponent,
      evidence: { bank_line_count: bankLineCount },
    });

    lineContributions.push(...contributions);
  }

  return { compositions, lineContributions };
}
