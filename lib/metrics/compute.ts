// Metrics. SETL_BLUEPRINT.md section 16.
//
// Pure function: ground truth + the engine's reconcile() output (plus the
// normalized input records reconcile() itself doesn't return, needed for
// composition/amount rollups) in, one BatchMetrics object out. No file I/O,
// no CSV parsing, no database — scripts/evaluate.ts owns all of that; this
// file only computes, so it can be unit-tested with fixtures.
//
// Three conventions this file relies on, each grounded in how the generator
// and engine actually behave (not assumptions):
//
// 1. Ground truth's bank record_id is `bank_0007` (recordId() in
//    generate.ts zero-pads bank line_no to 4 digits); the engine's own
//    links/exceptions use the bare line_no as a string ("7"). Every
//    comparison below converts through `naturalRecordId()` first.
//
// 2. A cleanly-matched order gets NO exception row at all — classify.ts's
//    own documented design is "a matched order's story is told by its
//    settlement line's own class." For metrics purposes this is treated as
//    an implicit MATCHED_EXACT / AUTO_RESOLVED, since "nothing to report"
//    is operationally what that means. See `lookupActual()`.
//
// 3. Several genuinely-resolvable records carry `expected_link_ids: []`
//    in ground truth even though the engine correctly links them —
//    `rounding_residual` doesn't bother recording its settlement's bank
//    link, and `logExactMatchCases`'s clean bank-line entries only set
//    `expected_link_ids` when the settlement's UTR appears as a narration
//    substring (missing that check entirely for bank lines resolved via
//    Pass 2's amount+date fallback). Scoring these as "incorrect" would
//    penalize the engine for resolving something ground truth simply
//    never asserted. So the link-correctness check (match rate /
//    false-match rate) only evaluates records where ground truth actually
//    commits to an answer: `expected_link_ids.length > 0` (linkable, `L`)
//    or `is_resolvable === false` (`U`, expecting no link at all).
//    Classification accuracy has no such restriction — every record gets
//    a class either way, so it's compared for the full population.

import type {
  ExceptionClass,
  GroundTruthFile,
  GroundTruthRecord,
  Link,
  Order,
  RecordSource,
  Settlement,
} from '../types';
import type { NormalizedBankLine, NormalizedSettlementLine } from '../normalize';
import type { ExceptionRow, ReconcileOutput } from '../engine/run';
import type { CompositionStatus, DiscrepancyComponent } from '../engine/pass6b-compose';

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface ConservationCheck {
  id: 'C1' | 'C2' | 'C3' | 'C4' | 'C5';
  description: string;
  holds: boolean;
  /** Present only when holds === false — the numbers that disagreed. */
  detail?: string;
}

export interface DiscrepancyComponentCount {
  component: DiscrepancyComponent;
  count: number;
}

export interface CompositionRollups {
  totalGrossProcessedPaise: number;
  totalFeesPaise: number;
  totalGstPaise: number;
  totalRefundsPaise: number;
  totalDisputesPaise: number;
  totalAdjustmentsNetPaise: number;
  totalExpectedPayoutPaise: number;
  totalBankCreditReceivedPaise: number;
  totalReconciledPayoutPaise: number;
  totalUnresolvedAmountPaise: number;
  settlementsFullyReconciled: number;
  settlementsWithDiscrepancy: number;
  settlementsUnmatchedToBank: number;
  totalSettlements: number;
  compositionCoverage: number; // 0..1; anything below 1 is a bug
  discrepancyByComponent: DiscrepancyComponentCount[];
}

export interface AccuracyMetrics {
  totalRecords: number; // N = orders + settlement_lines + bank_lines
  linkableRecords: number; // L
  unresolvableByDesign: number; // |U|
  proposedLinks: number;
  correctMatches: number;
  incorrectMatches: number;
  matchRate: number; // correct / L
  falseMatchRate: number; // incorrect / proposedLinks
  autoResolutionPrecision: number; // correct_among_auto / total_auto
  correctRefusalRate: number; // (UNRESOLVED ∩ U) / |U|
  exceptionRate: number; // unresolved / N
  classificationAccuracy: number; // correct_class / N
  reviewQueueSize: number; // count of NEEDS_REVIEW across every exception
}

export interface AmountMetrics {
  totalAmountProcessedPaise: number; // Σ gross amounts across payment settlement lines
  amountReconciledPaise: number; // Σ on AUTO_RESOLVED payment lines
  amountInReviewPaise: number; // Σ on NEEDS_REVIEW payment lines
  amountUnresolvedPaise: number; // Σ on UNRESOLVED payment lines
  feeOverchargeDetectedPaise: number; // Σ positive fee_delta
}

export interface TimingMetrics {
  totalProcessingMs: number;
  throughputRecordsPerSecond: number;
  /** Why p50/p95 per-record percentiles aren't reported — see the note in
   * scripts/evaluate.ts and CLAUDE_CODE_PROMPTS.md prompt 10's own
   * "Must not modify: lib/engine/" restriction. */
  note: string;
}

export interface BatchMetrics {
  batch: string;
  accuracy: AccuracyMetrics;
  amounts: AmountMetrics;
  timing: TimingMetrics;
  composition: CompositionRollups;
  conservation: ConservationCheck[];
}

export interface ComputeMetricsInput {
  batch: string;
  groundTruth: GroundTruthFile;
  reconcileOutput: ReconcileOutput;
  orders: readonly Order[];
  settlements: readonly Settlement[];
  settlementLines: readonly NormalizedSettlementLine[];
  bankLines: readonly NormalizedBankLine[];
  /** Wall-clock time for the reconcile() call alone, engine only, LLM excluded (there is no LLM call in this engine at all). */
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Ground-truth <-> engine id/shape reconciliation
// ---------------------------------------------------------------------------

/** Ground truth's `bank_0007` -> the engine's own bare-line_no key, `"7"`. Every other source's id passes through unchanged. */
function naturalRecordId(record: GroundTruthRecord): string {
  if (record.source === 'bank' && record.record_id.startsWith('bank_')) {
    return String(Number(record.record_id.slice('bank_'.length)));
  }
  return record.record_id;
}

/** Every link touching this record, read from whichever side the record's source appears on. */
function proposedLinkIds(source: RecordSource, naturalId: string, links: readonly Link[]): string[] {
  switch (source) {
    case 'bank':
      return links.filter((l) => l.left_source === 'bank' && l.left_id === naturalId).map((l) => l.right_id);
    case 'settlement':
      return links.filter((l) => l.right_source === 'settlement' && l.right_id === naturalId).map((l) => l.left_id);
    case 'settlement_line':
      return links.filter((l) => l.left_source === 'settlement_line' && l.left_id === naturalId).map((l) => l.right_id);
    case 'order':
      return links.filter((l) => l.right_source === 'order' && l.right_id === naturalId).map((l) => l.left_id);
  }
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** One record's actual outcome from the engine, filled in from its exception row when one exists. */
interface ActualOutcome {
  class: ExceptionClass;
  decision: 'AUTO_RESOLVED' | 'NEEDS_REVIEW' | 'UNRESOLVED';
}

/**
 * A record with no exception row — always possible for a cleanly-matched
 * order (see file header, convention 2) — is implicitly MATCHED_EXACT /
 * AUTO_RESOLVED: nothing to report is what "matched and done" looks like.
 */
function lookupActual(
  exceptionsBySourceAndId: Map<string, ExceptionRow>,
  source: RecordSource,
  naturalId: string
): ActualOutcome {
  const row = exceptionsBySourceAndId.get(`${source}|${naturalId}`);
  if (row === undefined) {
    return { class: 'MATCHED_EXACT', decision: 'AUTO_RESOLVED' };
  }
  return { class: row.exception_class, decision: row.decision };
}

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

function computeAccuracy(
  groundTruth: GroundTruthFile,
  reconcileOutput: ReconcileOutput,
  n: number
): AccuracyMetrics {
  const scoredRecords = groundTruth.records.filter((r) => r.source !== 'settlement');

  const exceptionsBySourceAndId = new Map<string, ExceptionRow>();
  for (const e of reconcileOutput.exceptions) {
    exceptionsBySourceAndId.set(`${e.record_source}|${e.record_id}`, e);
  }

  let linkableRecords = 0;
  let unresolvableByDesign = 0;
  let correctMatches = 0;
  let incorrectMatches = 0;
  let autoTotal = 0;
  let autoCorrect = 0;
  let correctRefusals = 0;
  let unresolvedCount = 0;
  let correctClass = 0;

  for (const record of scoredRecords) {
    const naturalId = naturalRecordId(record);
    const actual = lookupActual(exceptionsBySourceAndId, record.source, naturalId);

    if (actual.class === record.expected_class) correctClass += 1;
    if (actual.decision === 'UNRESOLVED') unresolvedCount += 1;
    if (actual.decision === 'AUTO_RESOLVED') {
      autoTotal += 1;
      if (record.expected_decision === 'AUTO_RESOLVED') autoCorrect += 1;
    }

    const isLinkable = record.expected_link_ids.length > 0;
    const isUnresolvableByDesign = !record.is_resolvable;
    if (isLinkable) linkableRecords += 1;
    if (isUnresolvableByDesign) unresolvableByDesign += 1;

    // Link-correctness is only evaluated where ground truth actually
    // commits to an answer (convention 3 in the file header).
    if (isLinkable || isUnresolvableByDesign) {
      const proposed = proposedLinkIds(record.source, naturalId, reconcileOutput.links);
      if (sameIdSet(proposed, record.expected_link_ids)) {
        correctMatches += 1;
        if (isUnresolvableByDesign && proposed.length === 0) correctRefusals += 1;
      } else if (proposed.length > 0) {
        incorrectMatches += 1;
      }
      // proposed.length === 0 but not matching expected (only possible
      // when isLinkable and expected is non-empty) is neither a match nor
      // an "incorrect match" per the blueprint's own definition
      // ("proposed ≠ expected AND proposed ≠ ∅") — it's a missed link,
      // already reflected in a lower match rate.
    }
  }

  const proposedLinksTotal = reconcileOutput.links.length;
  const reviewQueueSize = reconcileOutput.exceptions.filter((e) => e.decision === 'NEEDS_REVIEW').length;

  return {
    totalRecords: n,
    linkableRecords,
    unresolvableByDesign,
    proposedLinks: proposedLinksTotal,
    correctMatches,
    incorrectMatches,
    matchRate: linkableRecords > 0 ? correctMatches / linkableRecords : 0,
    falseMatchRate: proposedLinksTotal > 0 ? incorrectMatches / proposedLinksTotal : 0,
    autoResolutionPrecision: autoTotal > 0 ? autoCorrect / autoTotal : 0,
    correctRefusalRate: unresolvableByDesign > 0 ? correctRefusals / unresolvableByDesign : 0,
    exceptionRate: n > 0 ? unresolvedCount / n : 0,
    classificationAccuracy: scoredRecords.length > 0 ? correctClass / scoredRecords.length : 0,
    reviewQueueSize,
  };
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

function computeAmounts(
  settlementLines: readonly NormalizedSettlementLine[],
  reconcileOutput: ReconcileOutput
): AmountMetrics {
  const exceptionByLineId = new Map<string, ExceptionRow>();
  for (const e of reconcileOutput.exceptions) {
    if (e.record_source === 'settlement_line') exceptionByLineId.set(e.record_id, e);
  }

  let totalAmountProcessedPaise = 0;
  let amountReconciledPaise = 0;
  let amountInReviewPaise = 0;
  let amountUnresolvedPaise = 0;

  for (const line of settlementLines) {
    if (line.type !== 'payment') continue;
    totalAmountProcessedPaise += line.amount_paise;

    // No exception row is the same "implicitly matched" convention as
    // lookupActual() above.
    const decision = exceptionByLineId.get(line.entity_id)?.decision ?? 'AUTO_RESOLVED';
    if (decision === 'AUTO_RESOLVED') amountReconciledPaise += line.amount_paise;
    else if (decision === 'NEEDS_REVIEW') amountInReviewPaise += line.amount_paise;
    else amountUnresolvedPaise += line.amount_paise;
  }

  let feeOverchargeDetectedPaise = 0;
  for (const e of reconcileOutput.exceptions) {
    if (e.exception_class === 'FEE_OVERCHARGE' && e.amount_impact_paise > 0) {
      feeOverchargeDetectedPaise += e.amount_impact_paise;
    }
  }

  return {
    totalAmountProcessedPaise,
    amountReconciledPaise,
    amountInReviewPaise,
    amountUnresolvedPaise,
    feeOverchargeDetectedPaise,
  };
}

// ---------------------------------------------------------------------------
// Composition rollups
// ---------------------------------------------------------------------------

function computeComposition(
  reconcileOutput: ReconcileOutput,
  totalSettlements: number
): CompositionRollups {
  const compositions = reconcileOutput.compositions;

  let totalGrossProcessedPaise = 0;
  let totalFeesPaise = 0;
  let totalGstPaise = 0;
  let totalRefundsPaise = 0;
  let totalDisputesPaise = 0;
  let totalAdjustmentsNetPaise = 0;
  let totalExpectedPayoutPaise = 0;
  let totalBankCreditReceivedPaise = 0;
  let totalReconciledPayoutPaise = 0;
  let totalUnresolvedAmountPaise = 0;
  let settlementsFullyReconciled = 0;
  let settlementsWithDiscrepancy = 0;
  let settlementsUnmatchedToBank = 0;
  const discrepancyCounts = new Map<DiscrepancyComponent, number>();

  for (const c of compositions) {
    totalGrossProcessedPaise += c.gross_payments_paise;
    totalFeesPaise += c.fees_total_paise;
    totalGstPaise += c.gst_total_paise;
    totalRefundsPaise += c.refunds_total_paise;
    totalDisputesPaise += c.disputes_total_paise;
    totalAdjustmentsNetPaise += c.adjustments_net_paise;
    totalExpectedPayoutPaise += c.expected_payout_paise;
    if (c.bank_credit_total_paise !== null) totalBankCreditReceivedPaise += c.bank_credit_total_paise;

    const status: CompositionStatus = c.status;
    if (status === 'FULLY_RECONCILED' || status === 'RECONCILED_WITH_ROUNDING') {
      totalReconciledPayoutPaise += c.expected_payout_paise;
    }
    if (status === 'DISCREPANCY' || status === 'UNMATCHED_TO_BANK') {
      if (c.diff_total_paise !== null) totalUnresolvedAmountPaise += Math.abs(c.diff_total_paise);
    }

    if (status === 'FULLY_RECONCILED') settlementsFullyReconciled += 1;
    else if (status === 'DISCREPANCY') settlementsWithDiscrepancy += 1;
    else if (status === 'UNMATCHED_TO_BANK') settlementsUnmatchedToBank += 1;
    // RECONCILED_WITH_ROUNDING counts toward none of the three named
    // buckets above individually; section 16's worked example only names
    // these three, and a rounding write-off is reported via the
    // reconciled-payout rollup instead.

    if (c.discrepancy_component !== 'NONE') {
      discrepancyCounts.set(c.discrepancy_component, (discrepancyCounts.get(c.discrepancy_component) ?? 0) + 1);
    }
  }

  const discrepancyByComponent: DiscrepancyComponentCount[] = Array.from(discrepancyCounts.entries()).map(
    ([component, count]) => ({ component, count })
  );

  return {
    totalGrossProcessedPaise,
    totalFeesPaise,
    totalGstPaise,
    totalRefundsPaise,
    totalDisputesPaise,
    totalAdjustmentsNetPaise,
    totalExpectedPayoutPaise,
    totalBankCreditReceivedPaise,
    totalReconciledPayoutPaise,
    totalUnresolvedAmountPaise,
    settlementsFullyReconciled,
    settlementsWithDiscrepancy,
    settlementsUnmatchedToBank,
    totalSettlements,
    compositionCoverage: totalSettlements > 0 ? compositions.length / totalSettlements : 0,
    discrepancyByComponent,
  };
}

// ---------------------------------------------------------------------------
// Conservation identities — section 16. All five are exact integer
// equalities, zero tolerance. A failure is a code bug and must be visible,
// never silently tolerated or averaged away.
// ---------------------------------------------------------------------------

function computeConservation(
  reconcileOutput: ReconcileOutput,
  settlementLines: readonly NormalizedSettlementLine[],
  composition: CompositionRollups,
  amounts: AmountMetrics
): ConservationCheck[] {
  const checks: ConservationCheck[] = [];

  // C1 (per settlement): gross - fees - gst - refunds - disputes + adjustments_net == expected_payout.
  // Pass 6B already asserts this internally (its own "identity A") and
  // throws on breach before this function ever runs — this re-derives it
  // independently per settlement as the belt-and-suspenders external
  // check section 16 asks scripts/evaluate.ts itself to perform.
  {
    let holds = true;
    let firstFailure: string | undefined;
    for (const c of reconcileOutput.compositions) {
      const recomputed =
        c.gross_payments_paise -
        c.fees_total_paise -
        c.gst_total_paise -
        c.refunds_total_paise -
        c.disputes_total_paise +
        c.adjustments_net_paise;
      if (recomputed !== c.expected_payout_paise) {
        holds = false;
        firstFailure = `${c.settlement_id}: recomputed ${recomputed} != expected_payout ${c.expected_payout_paise}`;
        break;
      }
    }
    checks.push({
      id: 'C1',
      description: 'gross − fees − gst − refunds − disputes + adjustments_net == expected_payout, per settlement',
      holds,
      detail: firstFailure,
    });
  }

  // C2 (per settlement): Σ line.contribution == expected_payout.
  {
    const contributionBySettlement = new Map<string, number>();
    const settlementIdByEntityId = new Map<string, string | null>();
    for (const line of settlementLines) settlementIdByEntityId.set(line.entity_id, line.settlement_id);

    for (const contribution of reconcileOutput.lineContributions) {
      const settlementId = settlementIdByEntityId.get(contribution.entity_id);
      if (settlementId === undefined || settlementId === null) continue;
      contributionBySettlement.set(
        settlementId,
        (contributionBySettlement.get(settlementId) ?? 0) + contribution.contribution_paise
      );
    }

    let holds = true;
    let firstFailure: string | undefined;
    for (const c of reconcileOutput.compositions) {
      const sum = contributionBySettlement.get(c.settlement_id) ?? 0;
      if (sum !== c.expected_payout_paise) {
        holds = false;
        firstFailure = `${c.settlement_id}: Σ contribution ${sum} != expected_payout ${c.expected_payout_paise}`;
        break;
      }
    }
    checks.push({
      id: 'C2',
      description: 'Σ line.contribution == expected_payout, per settlement',
      holds,
      detail: firstFailure,
    });
  }

  // C3 (per settlement): expected_payout - bank_credit_total == diff_total (skipped where unlinked, both sides null by construction).
  {
    let holds = true;
    let firstFailure: string | undefined;
    for (const c of reconcileOutput.compositions) {
      if (c.bank_credit_total_paise === null || c.diff_total_paise === null) continue;
      const recomputed = c.expected_payout_paise - c.bank_credit_total_paise;
      if (recomputed !== c.diff_total_paise) {
        holds = false;
        firstFailure = `${c.settlement_id}: expected_payout - bank_credit_total ${recomputed} != diff_total ${c.diff_total_paise}`;
        break;
      }
    }
    checks.push({
      id: 'C3',
      description: 'expected_payout − bank_credit_total == diff_total, per settlement',
      holds,
      detail: firstFailure,
    });
  }

  // C4 (per run): Σ expected_payout == total_gross - total_fees - total_gst - total_refunds - total_disputes + total_adjustments_net.
  {
    const sumExpectedPayout = reconcileOutput.compositions.reduce((acc, c) => acc + c.expected_payout_paise, 0);
    const recomputed =
      composition.totalGrossProcessedPaise -
      composition.totalFeesPaise -
      composition.totalGstPaise -
      composition.totalRefundsPaise -
      composition.totalDisputesPaise +
      composition.totalAdjustmentsNetPaise;
    const holds = sumExpectedPayout === recomputed;
    checks.push({
      id: 'C4',
      description: 'Σ per-settlement expected_payout == total_gross − total_fees − total_gst − total_refunds − total_disputes + total_adjustments_net',
      holds,
      detail: holds ? undefined : `Σ expected_payout ${sumExpectedPayout} != recomputed ${recomputed}`,
    });
  }

  // C5 (per run): amount_reconciled + amount_in_review + amount_unresolved == total_amount_processed.
  {
    const sum = amounts.amountReconciledPaise + amounts.amountInReviewPaise + amounts.amountUnresolvedPaise;
    const holds = sum === amounts.totalAmountProcessedPaise;
    checks.push({
      id: 'C5',
      description: 'amount_reconciled + amount_in_review + amount_unresolved == total_amount_processed',
      holds,
      detail: holds ? undefined : `sum ${sum} != total_amount_processed ${amounts.totalAmountProcessedPaise}`,
    });
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compute every metric in section 16 for one batch. Throws if any
 * conservation identity fails — per the blueprint, that is a code bug, not
 * a data finding, and must stop the run rather than print a wrong report.
 */
export function computeMetrics(input: ComputeMetricsInput): BatchMetrics {
  const n = input.orders.length + input.settlementLines.length + input.bankLines.length;

  const accuracy = computeAccuracy(input.groundTruth, input.reconcileOutput, n);
  const amounts = computeAmounts(input.settlementLines, input.reconcileOutput);
  const composition = computeComposition(input.reconcileOutput, input.settlements.length);
  const conservation = computeConservation(input.reconcileOutput, input.settlementLines, composition, amounts);

  const failed = conservation.filter((c) => !c.holds);
  if (failed.length > 0) {
    const summary = failed.map((c) => `${c.id} (${c.description}): ${c.detail}`).join('; ');
    throw new Error(`Conservation identity failure in batch '${input.batch}' — this is a code bug: ${summary}`);
  }

  const elapsedSeconds = input.elapsedMs / 1000;
  const timing: TimingMetrics = {
    totalProcessingMs: input.elapsedMs,
    throughputRecordsPerSecond: elapsedSeconds > 0 ? n / elapsedSeconds : 0,
    note:
      'p50/p95 per-record timing requires instrumenting lib/engine/run.ts, which is out of scope for this script ' +
      '(prompt 10: "Must not modify: lib/engine/"). Only total wall-clock time and aggregate throughput are reported.',
  };

  return { batch: input.batch, accuracy, amounts, timing, composition, conservation };
}
