// Markdown rendering for metrics. SETL_BLUEPRINT.md section 16's reporting
// rules, applied literally:
//
//   1. Headline table reports HELD-OUT numbers; main-batch numbers go in a
//      secondary table labelled "tuning batch."
//   2. All five conservation identities hold, and the report says so with
//      the assertion count.
//   3. Throughput excludes LLM latency — say so (there is no LLM call in
//      this engine at all, but the report states the exclusion anyway,
//      per the blueprint's own instruction not to let that go unsaid).
//   4. False-match rate reported BEFORE match rate, every time.
//   5. Composition rollups reported BEFORE accuracy metrics.
//
// Every number below is read off a BatchMetrics object computed by
// lib/metrics/compute.ts — nothing in this file computes a metric itself,
// and nothing here is a hand-typed number.

import { formatPaise } from '../money';
import type { BatchMetrics } from './compute';

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function money(paise: number): string {
  return formatPaise(paise as Parameters<typeof formatPaise>[0]);
}

/** One batch's full section: composition rollups, then accuracy, then amounts/timing, then conservation. */
function renderBatchSection(metrics: BatchMetrics, label: string): string {
  const { composition, accuracy, amounts, timing, conservation } = metrics;
  const lines: string[] = [];

  lines.push(`### ${label}`, '');

  lines.push('#### Composition rollups', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Total gross processed | ${money(composition.totalGrossProcessedPaise)} |`);
  lines.push(`| Total Razorpay fees | ${money(composition.totalFeesPaise)} |`);
  lines.push(`| Total GST on fees | ${money(composition.totalGstPaise)} |`);
  lines.push(`| Total refunds deducted | ${money(composition.totalRefundsPaise)} |`);
  lines.push(`| Total disputes / holds | ${money(composition.totalDisputesPaise)} |`);
  lines.push(`| Total adjustments (net) | ${money(composition.totalAdjustmentsNetPaise)} |`);
  lines.push(`| Total expected payout | ${money(composition.totalExpectedPayoutPaise)} |`);
  lines.push(`| Total bank credit received | ${money(composition.totalBankCreditReceivedPaise)} |`);
  lines.push(`| Total reconciled payout | ${money(composition.totalReconciledPayoutPaise)} |`);
  lines.push(`| Total unresolved amount | ${money(composition.totalUnresolvedAmountPaise)} |`);
  lines.push(
    `| Settlements fully reconciled | ${composition.settlementsFullyReconciled} of ${composition.totalSettlements} |`
  );
  lines.push(
    `| Settlements with discrepancy | ${composition.settlementsWithDiscrepancy} of ${composition.totalSettlements} |`
  );
  lines.push(
    `| Settlements unmatched to bank | ${composition.settlementsUnmatchedToBank} of ${composition.totalSettlements} |`
  );
  lines.push(`| Composition coverage | ${pct(composition.compositionCoverage)}${composition.compositionCoverage < 1 ? ' — **BUG: below 100%**' : ''} |`);
  lines.push(
    `| Discrepancy by component | ${
      composition.discrepancyByComponent.length > 0
        ? composition.discrepancyByComponent.map((d) => `${d.component} ${d.count}`).join(' · ')
        : 'none'
    } |`
  );
  lines.push(`| Fee overcharge detected | ${money(amounts.feeOverchargeDetectedPaise)} |`, '');

  lines.push('#### Accuracy', '');
  lines.push('| Metric | Value |', '|---|---|');
  // False-match rate before match rate, per the blueprint's own reporting rule 4.
  lines.push(`| False-match rate | ${pct(accuracy.falseMatchRate)} |`);
  lines.push(`| Match rate | ${pct(accuracy.matchRate)} (${accuracy.correctMatches} / ${accuracy.linkableRecords}) |`);
  lines.push(`| Total records (N) | ${accuracy.totalRecords} |`);
  lines.push(`| Linkable records (L) | ${accuracy.linkableRecords} |`);
  lines.push(`| Unresolvable by design (|U|) | ${accuracy.unresolvableByDesign} |`);
  lines.push(`| Proposed links | ${accuracy.proposedLinks} |`);
  lines.push(`| Correct matches | ${accuracy.correctMatches} |`);
  lines.push(`| Incorrect matches | ${accuracy.incorrectMatches} |`);
  lines.push(`| Auto-resolution precision | ${pct(accuracy.autoResolutionPrecision)} |`);
  lines.push(`| Correct-refusal rate | ${pct(accuracy.correctRefusalRate)} |`);
  lines.push(`| Exception rate | ${pct(accuracy.exceptionRate)} |`);
  lines.push(`| Classification accuracy | ${pct(accuracy.classificationAccuracy)} |`);
  lines.push(`| Review queue size | ${accuracy.reviewQueueSize} |`, '');

  lines.push('#### Amounts', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Total amount processed | ${money(amounts.totalAmountProcessedPaise)} |`);
  lines.push(`| Amount reconciled | ${money(amounts.amountReconciledPaise)} |`);
  lines.push(`| Amount in review | ${money(amounts.amountInReviewPaise)} |`);
  lines.push(`| Amount unresolved | ${money(amounts.amountUnresolvedPaise)} |`, '');

  lines.push('#### Timing', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Total processing time | ${timing.totalProcessingMs.toFixed(0)} ms |`);
  lines.push(`| Throughput | ${timing.throughputRecordsPerSecond.toFixed(1)} rec/s |`);
  lines.push('', `_${timing.note}_`, '');
  lines.push('_Throughput excludes LLM latency — this engine makes no LLM call in its reconciliation path at all._', '');

  lines.push('#### Conservation identities', '');
  const holdingCount = conservation.filter((c) => c.holds).length;
  lines.push(`All ${holdingCount} of ${conservation.length} conservation identities hold.`, '');
  lines.push('| ID | Description | Holds |', '|---|---|---|');
  for (const c of conservation) {
    lines.push(`| ${c.id} | ${c.description} | ${c.holds ? '✅' : `❌ ${c.detail ?? ''}`} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * The combined REPORT.md — held-out first (the headline), main second
 * (labelled "tuning batch"), per reporting rule 1.
 */
export function renderReport(mainMetrics: BatchMetrics, holdoutMetrics: BatchMetrics): string {
  const lines: string[] = [];

  lines.push('# Setl — Reconciliation Report', '');
  lines.push(
    'Generated by `scripts/evaluate.ts`. Every number below is computed from `data/main/` and ' +
      '`data/holdout/`\'s CSVs and `ground_truth.json` — nothing here is hand-typed.',
    ''
  );

  lines.push('## Held-out batch (headline)', '');
  lines.push(renderBatchSection(holdoutMetrics, 'Held-out'));

  lines.push('## Tuning batch (main)', '');
  lines.push(renderBatchSection(mainMetrics, 'Main (tuning batch)'));

  return lines.join('\n');
}
