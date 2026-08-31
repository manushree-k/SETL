#!/usr/bin/env node
// Threshold selection experiment. SETL_BLUEPRINT.md section 12.
//
//     npm run sweep
//
// Runs the deterministic engine ONCE on the main batch — offline, same
// CSV-plus-ground-truth path as scripts/evaluate.ts, no database — then
// sweeps t_auto (0.50-1.00) and t_review (0.30-t_auto) over the grid
// section 12 specifies, scoring every combination against ground truth.
// Writes the whole curve to data/results/sweep.json, applies the
// selection rule, and freezes the result into config/thresholds.json,
// which lib/engine/decide.ts reads.
//
// Two threshold-INDEPENDENT datasets, kept from the single engine run:
//   - every link's own confidence and whether it's correct (per ground
//     truth's expected_link_ids for the record on the link's "left" side —
//     the same per-link methodology scripts/evaluate.ts uses for match
//     rate, duplicated here since lib/metrics/* is out of this prompt's
//     scope)
//   - for every genuinely-unresolvable-by-design ground truth record
//     (is_resolvable: false), the MAX confidence among any link touching
//     it at all, from either side (0 if none — most of these have no
//     link whatsoever, since Passes 2/3 refuse an ambiguous case outright
//     rather than link it at low confidence, so they are correctly
//     refused independent of any threshold)
//
// From those: auto-resolution rate and false-match-rate-among-auto-resolved
// depend only on t_auto; correct-refusal-rate depends only on t_review;
// review queue size is the only metric needing both, which is why it's
// the one column that actually varies across a t_auto row in sweep.json.
//
// The selection rule's own t_review search is bounded to [0.30, t_auto]
// (the CHOSEN t_auto, from applying its own rule first) — not the full
// 0.30-1.00 range. Read literally over the full range the rule is
// degenerate: correct-refusal-rate can only rise as t_review rises
// (raising the cutoff can only push more low-confidence links below it,
// never fewer), so once it crosses 90% it stays there all the way to
// 1.00, making "highest achieving >=90%" trivially always 1.00. Bounding
// the search to the grid's own stated range ([0.30, t_auto]) is what
// makes "highest" a real search rather than a foregone conclusion.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundTruthFile, GroundTruthRecord, Link, RecordSource } from '../lib/types';
import {
  normalizeOrders,
  normalizeSettlements,
  normalizeSettlementLines,
  normalizeBankLines,
} from '../lib/normalize';
import { reconcile } from '../lib/engine/run';
import { KIRANAKART_RATE_CARD } from '../lib/rateCard';

// ---------------------------------------------------------------------------
// CSV reading — the same small RFC4180 parser as scripts/seed.ts and
// scripts/evaluate.ts, duplicated rather than imported (neither exports
// it, and this prompt's scope is scripts/sweepThresholds.ts,
// config/thresholds.json, lib/engine/decide.ts only).
// ---------------------------------------------------------------------------

function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsv(path: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = parseCsv(readFileSync(path, 'utf8')).filter((r) => !(r.length === 1 && r[0] === ''));
  const [headers, ...dataRows] = raw;
  const rows = dataRows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((col, idx) => {
      record[col] = row[idx] ?? '';
    });
    return record;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Ground truth <-> engine id reconciliation — same conventions as
// lib/metrics/compute.ts (duplicated locally; that file is out of this
// prompt's scope too).
// ---------------------------------------------------------------------------

/** Ground truth's `bank_0007` -> the engine's own bare-line_no key, `"7"`. */
function naturalRecordId(record: GroundTruthRecord): string {
  if (record.source === 'bank' && record.record_id.startsWith('bank_')) {
    return String(Number(record.record_id.slice('bank_'.length)));
  }
  return record.record_id;
}

/** Whether a link touches the given record, from whichever side its source appears on. */
function linkTargetsRecord(link: Link, source: RecordSource, naturalId: string): boolean {
  if (source === 'bank' || source === 'settlement_line') {
    return link.left_source === source && link.left_id === naturalId;
  }
  return link.right_source === source && link.right_id === naturalId;
}

// ---------------------------------------------------------------------------
// The two threshold-independent datasets
// ---------------------------------------------------------------------------

interface LinkSample {
  confidence: number;
  correct: boolean;
}

/** Every link's confidence, and whether it matches ground truth's expectation for its left-side record. */
function scoreLinks(links: readonly Link[], groundTruth: GroundTruthFile): LinkSample[] {
  const expectedByKey = new Map<string, Set<string>>();
  for (const r of groundTruth.records) {
    expectedByKey.set(`${r.source}|${naturalRecordId(r)}`, new Set(r.expected_link_ids));
  }

  return links.map((link) => {
    const expected = expectedByKey.get(`${link.left_source}|${link.left_id}`);
    return { confidence: link.confidence, correct: expected !== undefined && expected.has(link.right_id) };
  });
}

/** For every genuinely-unresolvable-by-design record, the max confidence among any link touching it. */
function scoreUnresolvable(groundTruth: GroundTruthFile, links: readonly Link[]): number[] {
  const maxConfidences: number[] = [];
  for (const r of groundTruth.records) {
    if (r.is_resolvable) continue;
    const naturalId = naturalRecordId(r);
    let max = 0;
    for (const link of links) {
      if (linkTargetsRecord(link, r.source, naturalId)) max = Math.max(max, link.confidence);
    }
    maxConfidences.push(max);
  }
  return maxConfidences;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

interface CurvePoint {
  t_auto: number;
  t_review: number;
  auto_resolution_rate: number;
  false_match_rate_among_auto_resolved: number;
  review_queue_size: number;
  correct_refusal_rate: number;
}

/** Avoid floating-point step drift (0.1 + 0.2 style) across the sweep's 0.01 increments. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function main(): void {
  const dir = join(process.cwd(), 'data', 'main');
  const orderCsv = readCsv(join(dir, 'orders.csv'));
  const settlementCsv = readCsv(join(dir, 'settlements.csv'));
  const settlementLineCsv = readCsv(join(dir, 'settlement_lines.csv'));
  const bankLineCsv = readCsv(join(dir, 'bank_statement.csv'));

  const { orders } = normalizeOrders(orderCsv.headers, orderCsv.rows);
  const { settlements } = normalizeSettlements(settlementCsv.headers, settlementCsv.rows);
  const { settlementLines } = normalizeSettlementLines(settlementLineCsv.headers, settlementLineCsv.rows);
  const { bankLines } = normalizeBankLines(bankLineCsv.headers, bankLineCsv.rows);

  const groundTruth: GroundTruthFile = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8'));

  console.log('Running the engine once on the main batch ...');
  const result = reconcile({ orders, settlements, settlementLines, bankLines, rateCard: KIRANAKART_RATE_CARD });

  const linkSamples = scoreLinks(result.links, groundTruth);
  const unresolvableConfidences = scoreUnresolvable(groundTruth, result.links);
  console.log(
    `  ${linkSamples.length} links kept, ${unresolvableConfidences.length} genuinely-unresolvable-by-design records`
  );

  const tAutoValues: number[] = [];
  for (let i = 50; i <= 100; i += 1) tAutoValues.push(round2(i / 100));

  // auto-resolution rate and false-match rate depend only on t_auto.
  const autoMetricsByTAuto = new Map<number, { autoResolutionRate: number; falseMatchRate: number }>();
  for (const tAuto of tAutoValues) {
    const autoLinks = linkSamples.filter((s) => s.confidence >= tAuto);
    const incorrectAuto = autoLinks.filter((s) => !s.correct).length;
    autoMetricsByTAuto.set(tAuto, {
      autoResolutionRate: linkSamples.length > 0 ? autoLinks.length / linkSamples.length : 0,
      falseMatchRate: autoLinks.length > 0 ? incorrectAuto / autoLinks.length : 0,
    });
  }

  // correct-refusal rate depends only on t_review — computed over the full
  // 0.30-1.00 range once; the grid and the selection rule each read from
  // this same map, bounding their own t_review range separately.
  const tReviewValuesFull: number[] = [];
  for (let i = 30; i <= 100; i += 1) tReviewValuesFull.push(round2(i / 100));

  const correctRefusalRateByTReview = new Map<number, number>();
  for (const tReview of tReviewValuesFull) {
    const refusedCorrectly = unresolvableConfidences.filter((c) => c < tReview).length;
    correctRefusalRateByTReview.set(
      tReview,
      unresolvableConfidences.length > 0 ? refusedCorrectly / unresolvableConfidences.length : 0
    );
  }

  // The full 2D curve: t_auto 0.50-1.00, t_review 0.30 up to that t_auto.
  const curve: CurvePoint[] = [];
  for (const tAuto of tAutoValues) {
    const { autoResolutionRate, falseMatchRate } = autoMetricsByTAuto.get(tAuto)!;
    const tAutoHundredths = Math.round(tAuto * 100);

    for (let i = 30; i <= tAutoHundredths; i += 1) {
      const tReview = round2(i / 100);
      const reviewQueueSize = linkSamples.filter((s) => s.confidence >= tReview && s.confidence < tAuto).length;
      curve.push({
        t_auto: tAuto,
        t_review: tReview,
        auto_resolution_rate: autoResolutionRate,
        false_match_rate_among_auto_resolved: falseMatchRate,
        review_queue_size: reviewQueueSize,
        correct_refusal_rate: correctRefusalRateByTReview.get(tReview)!,
      });
    }
  }

  const resultsDir = join(process.cwd(), 'data', 'results');
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, 'sweep.json'), JSON.stringify(curve, null, 2));
  console.log(`Wrote data/results/sweep.json (${curve.length} grid points)`);

  // --- Selection rule ---------------------------------------------------------

  const FALSE_MATCH_CEILING = 0.005; // 0.5%
  let chosenTAuto: number | null = null;
  let bestTAutoFalseMatch = tAutoValues[0];
  let bestFalseMatchRate = autoMetricsByTAuto.get(bestTAutoFalseMatch)!.falseMatchRate;
  for (const tAuto of tAutoValues) {
    const { falseMatchRate } = autoMetricsByTAuto.get(tAuto)!;
    if (falseMatchRate < bestFalseMatchRate) {
      bestFalseMatchRate = falseMatchRate;
      bestTAutoFalseMatch = tAuto;
    }
    if (chosenTAuto === null && falseMatchRate <= FALSE_MATCH_CEILING) chosenTAuto = tAuto;
  }

  if (chosenTAuto === null) {
    console.log(
      `No t_auto in [0.50, 1.00] achieves a false-match rate <= ${(FALSE_MATCH_CEILING * 100).toFixed(1)}% ` +
        `among auto-resolved links. Best achievable: t_auto=${bestTAutoFalseMatch.toFixed(2)}, ` +
        `false-match rate ${(bestFalseMatchRate * 100).toFixed(2)}%. Reporting the best achievable value ` +
        `rather than silently picking a threshold that doesn't meet the bar.`
    );
  }
  const tAuto = chosenTAuto ?? bestTAutoFalseMatch;

  const REVIEW_FLOOR = 0.9; // 90%
  let chosenTReview: number | null = null;
  let bestTReview = 0.3;
  let bestRefusalRate = correctRefusalRateByTReview.get(0.3)!;
  const tAutoHundredths = Math.round(tAuto * 100);
  for (let i = 30; i <= tAutoHundredths; i += 1) {
    const tReview = round2(i / 100);
    const rate = correctRefusalRateByTReview.get(tReview)!;
    if (rate >= bestRefusalRate) {
      bestRefusalRate = rate;
      bestTReview = tReview;
    }
    if (rate >= REVIEW_FLOOR) chosenTReview = tReview; // keep advancing — the last one that still holds is the highest
  }

  if (chosenTReview === null) {
    console.log(
      `No t_review in [0.30, ${tAuto.toFixed(2)}] achieves a correct-refusal rate >= ${(REVIEW_FLOOR * 100).toFixed(0)}%. ` +
        `Best achievable: t_review=${bestTReview.toFixed(2)}, rate ${(bestRefusalRate * 100).toFixed(2)}%. Reporting ` +
        `the best achievable value rather than silently picking a threshold that doesn't meet the bar.`
    );
  }
  const tReview = chosenTReview ?? bestTReview;

  console.log(
    `t_auto = ${tAuto.toFixed(2)} ` +
      `(false-match rate among auto-resolved: ${(autoMetricsByTAuto.get(tAuto)!.falseMatchRate * 100).toFixed(2)}%, ` +
      `auto-resolution rate: ${(autoMetricsByTAuto.get(tAuto)!.autoResolutionRate * 100).toFixed(2)}%)`
  );
  console.log(
    `t_review = ${tReview.toFixed(2)} ` +
      `(correct-refusal rate: ${(correctRefusalRateByTReview.get(tReview)! * 100).toFixed(2)}%)`
  );

  const configDir = join(process.cwd(), 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'thresholds.json'), JSON.stringify({ t_auto: tAuto, t_review: tReview }, null, 2));
  console.log('Wrote config/thresholds.json');
}

try {
  main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Threshold sweep failed: ${message}`);
  process.exit(1);
}
