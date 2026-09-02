#!/usr/bin/env node
// Reproducible measurement. SETL_BLUEPRINT.md section 16.
//
//     npm run evaluate
//
// Works entirely offline: reads a batch's CSVs directly from data/<batch>/,
// runs them through Pass 0 (lib/normalize) and the pure reconcile() core
// (lib/engine/run.ts) in memory, and scores the result against
// ground_truth.json. No database, no LLM API key, no seed/migrate step —
// per the blueprint, a judge must be able to clone the repo and reproduce
// these numbers with nothing but `npm install`.
//
// Prompt 12 addendum: also calls resolvePendingLlmBankLines (lib/normalize)
// for job 1's narration-parsing ablation — LLM_ENABLED=true vs. false
// should move parse rate, not match rate. This is the one deviation from
// this script's original file scope (prompt 10 listed only lib/metrics/*
// and this file; prompt 12 lists lib/ai/* and lib/normalize/index.ts, not
// this one) — made explicitly, with sign-off, because otherwise prompt
// 12's own acceptance test ("LLM_ENABLED=true npm run evaluate" vs.
// "=false") has no script that could ever exercise it. The function is a
// complete no-op when LLM_ENABLED=false, so the "no LLM API key" guarantee
// above is unaffected either way.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GroundTruthFile, RateCard } from '../lib/types';
import {
  normalizeOrders,
  normalizeSettlements,
  normalizeSettlementLines,
  normalizeBankLines,
  resolvePendingLlmBankLines,
} from '../lib/normalize';
import { reconcile } from '../lib/engine/run';
import { KIRANAKART_RATE_CARD, BOMBAYWEAVE_RATE_CARD } from '../lib/rateCard';
import { computeMetrics, type BatchMetrics } from '../lib/metrics/compute';
import { renderReport } from '../lib/metrics/report';

type Batch = 'main' | 'holdout';

const RATE_CARD_BY_BATCH: Record<Batch, RateCard> = {
  main: KIRANAKART_RATE_CARD,
  holdout: BOMBAYWEAVE_RATE_CARD,
};

// ---------------------------------------------------------------------------
// A small, correct CSV parser (RFC4180-style) — the same shape as
// scripts/seed.ts's own, duplicated here rather than imported since
// seed.ts doesn't export it and this prompt's scope is lib/metrics/* and
// scripts/evaluate.ts only.
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
// Per-batch evaluation
// ---------------------------------------------------------------------------

async function evaluateBatch(batch: Batch): Promise<BatchMetrics> {
  const dir = join(process.cwd(), 'data', batch);

  const orderCsv = readCsv(join(dir, 'orders.csv'));
  const settlementCsv = readCsv(join(dir, 'settlements.csv'));
  const settlementLineCsv = readCsv(join(dir, 'settlement_lines.csv'));
  const bankLineCsv = readCsv(join(dir, 'bank_statement.csv'));

  const { orders, invalidRows: invalidOrders } = normalizeOrders(orderCsv.headers, orderCsv.rows);
  const { settlements, invalidRows: invalidSettlements } = normalizeSettlements(
    settlementCsv.headers,
    settlementCsv.rows
  );
  const { settlementLines, invalidRows: invalidLines } = normalizeSettlementLines(
    settlementLineCsv.headers,
    settlementLineCsv.rows
  );
  const { bankLines: rawBankLines, invalidRows: invalidBankLines } = normalizeBankLines(
    bankLineCsv.headers,
    bankLineCsv.rows
  );

  // Job 1's ablation point: a no-op per line when LLM_ENABLED=false.
  const knownUtrs = settlements.map((s) => s.utr_number);
  const bankLines = await resolvePendingLlmBankLines(rawBankLines, knownUtrs);

  const invalidTotal =
    invalidOrders.length + invalidSettlements.length + invalidLines.length + invalidBankLines.length;
  if (invalidTotal > 0) {
    console.warn(`  ${invalidTotal} INVALID_ROW(s) while normalizing '${batch}' — carried forward, not scored.`);
  }

  const groundTruth: GroundTruthFile = JSON.parse(readFileSync(join(dir, 'ground_truth.json'), 'utf8'));

  const start = performance.now();
  const reconcileOutput = reconcile({
    orders,
    settlements,
    settlementLines,
    bankLines,
    rateCard: RATE_CARD_BY_BATCH[batch],
  });
  const elapsedMs = performance.now() - start;

  return computeMetrics({
    batch,
    groundTruth,
    reconcileOutput,
    orders,
    settlements,
    settlementLines,
    bankLines,
    elapsedMs,
  });
}

function summarize(metrics: BatchMetrics): string {
  return (
    `false-match rate ${(metrics.accuracy.falseMatchRate * 100).toFixed(2)}%, ` +
    `match rate ${(metrics.accuracy.matchRate * 100).toFixed(2)}%, ` +
    `classification accuracy ${(metrics.accuracy.classificationAccuracy * 100).toFixed(2)}%, ` +
    `composition coverage ${(metrics.composition.compositionCoverage * 100).toFixed(2)}%`
  );
}

async function main(): Promise<void> {
  const resultsDir = join(process.cwd(), 'data', 'results');
  mkdirSync(resultsDir, { recursive: true });

  console.log('Evaluating batch: main ...');
  const mainMetrics = await evaluateBatch('main');
  writeFileSync(join(resultsDir, 'metrics-main.json'), JSON.stringify(mainMetrics, null, 2));
  console.log(`  ${summarize(mainMetrics)}`);

  console.log('Evaluating batch: holdout ...');
  const holdoutMetrics = await evaluateBatch('holdout');
  writeFileSync(join(resultsDir, 'metrics-holdout.json'), JSON.stringify(holdoutMetrics, null, 2));
  console.log(`  ${summarize(holdoutMetrics)}`);

  const report = renderReport(mainMetrics, holdoutMetrics);
  writeFileSync(join(process.cwd(), 'REPORT.md'), report);
  console.log(
    'Wrote data/results/metrics-main.json, data/results/metrics-holdout.json, REPORT.md'
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Evaluation failed: ${message}`);
  process.exit(1);
});
