// The engine's orchestrator. SETL_BLUEPRINT.md section 10, Pass 7.
//
// Two halves, deliberately separated:
//
//   `reconcile()` is the PURE core — typed records in, links/exceptions/audit
//   rows out. No database, no I/O. It runs Passes 1–6, classifies every
//   record, and turns each classification into a decision. Because it is
//   pure, it can be unit-tested with hand-built fixtures exactly like
//   Passes 1–6 were, without a live database.
//
//   `runReconciliation()` is the thin DB-facing wrapper prompt 09c actually
//   asked for: it loads a batch's already-seeded raw rows, maps them into
//   the typed shapes `reconcile()` expects, calls it, and persists the
//   result — links, exceptions, and audit rows — in one transaction.
//
// Not done here, by design: Pass 6B (composition) doesn't exist yet
// (prompt 09B), so `discrepancy_component` is not attached to any
// exception. Narration parsing and evidence-grounded explanation are the
// LLM's jobs (section 13) and untouched by this file entirely.

import type {
  ExceptionClass,
  Link,
  LinkSource,
  Order,
  RateCard,
  Settlement,
} from '../types';
import type { NormalizedBankLine, NormalizedSettlementLine } from '../normalize';
import { extractUtr } from '../normalize';
import { settlementCycleDate } from '../dates';
import { toPaise } from '../money';
import { KIRANAKART_RATE_CARD, BOMBAYWEAVE_RATE_CARD } from '../rateCard';
import { env } from '../env';
import { sql } from '../db';
import type postgres from 'postgres';

import { runPass1 } from './pass1-utr';
import { runPass2 } from './pass2-amountDate';
import { runPass3 } from './pass3-aggregate';
import { runPass4 } from './pass4-balance';
import { runPass5 } from './pass5-orderMatch';
import { runPass6 } from './pass6-feeAudit';
import { classifyBankLine, classifySettlement, classifySettlementLine, classifyOrder } from './classify';
import type { Classification } from './classify';
import { decide, DEFAULT_THRESHOLDS } from './decide';
import type { Decision, DecisionThresholds } from './decide';

// ---------------------------------------------------------------------------
// Shared record shapes for links/exceptions/audit — the same three tables
// `run.ts` persists, kept here since nothing else in lib/engine/* owns them.
// ---------------------------------------------------------------------------

export interface ExceptionRow {
  record_source: LinkSource;
  record_id: string;
  exception_class: ExceptionClass;
  decision: Decision;
  confidence: number;
  amount_impact_paise: number;
  evidence: Record<string, unknown>;
  deterministic_reason: string;
  next_action: string | null;
}

export type AuditAction = 'LINKED' | 'CLASSIFIED' | 'AUTO_RESOLVED' | 'ESCALATED' | 'REFUSED';

export interface AuditRow {
  subject_source: LinkSource;
  subject_id: string;
  action: AuditAction;
  rule: string;
  confidence: number | null;
  detail: Record<string, unknown>;
}

export interface ReconcileSummary {
  total: number;
  auto: number;
  review: number;
  unresolved: number;
}

export interface ReconcileOutput {
  links: Link[];
  exceptions: ExceptionRow[];
  audit: AuditRow[];
  summary: ReconcileSummary;
}

export interface ReconcileInput {
  orders: readonly Order[];
  settlements: readonly Settlement[];
  settlementLines: readonly NormalizedSettlementLine[];
  bankLines: readonly NormalizedBankLine[];
  rateCard: RateCard;
  thresholds?: DecisionThresholds;
}

// ---------------------------------------------------------------------------
// The pure core.
// ---------------------------------------------------------------------------

function decisionToAuditAction(decision: Decision): AuditAction {
  if (decision === 'AUTO_RESOLVED') return 'AUTO_RESOLVED';
  if (decision === 'NEEDS_REVIEW') return 'ESCALATED';
  return 'REFUSED';
}

/**
 * Section 12's ambiguity signal comes in two shapes — Pass 2's
 * `Pass2AmbiguousMatch` already carries a `confidence`; Pass 3's
 * `Pass3Ambiguity` only carries `alternatives_found`, from which
 * `classifySettlement`'s own 0.3/n convention is reused here.
 */
function toBankAmbiguousMatch(
  candidate: { candidate_count: number; confidence: number } | { alternatives_found: number } | undefined
): { candidate_count: number; confidence: number } | undefined {
  if (candidate === undefined) return undefined;
  if ('candidate_count' in candidate) return candidate;
  return { candidate_count: candidate.alternatives_found, confidence: 0.3 / candidate.alternatives_found };
}

export function reconcile(input: ReconcileInput): ReconcileOutput {
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;

  const pass1 = runPass1(input.bankLines, input.settlements);
  const pass2 = runPass2(pass1.unmatchedBankLines, pass1.unmatchedSettlements);
  const pass3 = runPass3(pass2.unmatchedBankLines, pass2.unmatchedSettlements);
  const pass4 = runPass4(input.settlements, input.settlementLines);
  const pass5 = runPass5(input.settlementLines, input.orders);
  const pass6 = runPass6(input.settlementLines, input.rateCard);

  const links: Link[] = [...pass1.links, ...pass2.links, ...pass3.links, ...pass5.links];

  const exceptions: ExceptionRow[] = [];
  const audit: AuditRow[] = [];

  for (const link of links) {
    audit.push({
      subject_source: link.left_source,
      subject_id: link.left_id,
      action: 'LINKED',
      rule: typeof link.evidence.key === 'string' ? link.evidence.key : `pass_${link.pass}`,
      confidence: link.confidence,
      detail: link.evidence,
    });
  }

  function record(recordSource: LinkSource, recordId: string, classification: Classification, evidence: Record<string, unknown>): void {
    const decision = decide(classification.exceptionClass, classification.confidence, thresholds);

    exceptions.push({
      record_source: recordSource,
      record_id: recordId,
      exception_class: classification.exceptionClass,
      decision,
      confidence: classification.confidence,
      amount_impact_paise: classification.amountImpactPaise,
      evidence,
      deterministic_reason: classification.reason,
      next_action: classification.nextAction,
    });

    audit.push({
      subject_source: recordSource,
      subject_id: recordId,
      action: 'CLASSIFIED',
      rule: classification.exceptionClass,
      confidence: classification.confidence,
      detail: { reason: classification.reason },
    });
    audit.push({
      subject_source: recordSource,
      subject_id: recordId,
      action: decisionToAuditAction(decision),
      rule: classification.exceptionClass,
      confidence: classification.confidence,
      detail: { decision },
    });
  }

  // --- Bank lines ------------------------------------------------------------
  for (const bankLine of input.bankLines) {
    const duplicateOf = pass1.duplicateCredits.find((d) => d.bank_line_no === bankLine.line_no);
    const utrAmountMismatch = pass1.utrAmountMismatches.find((m) => m.bank_line_no === bankLine.line_no);
    const link = links.find((l) => l.left_source === 'bank' && l.left_id === String(bankLine.line_no));
    const ambiguousCandidate =
      pass2.ambiguousMatches.find((a) => a.bank_line_no === bankLine.line_no) ??
      pass3.ambiguities.find(
        (a) => a.direction === 'many_settlements_one_credit' && a.target_id === String(bankLine.line_no)
      );

    const classification = classifyBankLine({
      bankLine,
      duplicateOf: duplicateOf ? { first_bank_line_no: duplicateOf.first_bank_line_no } : undefined,
      utrAmountMismatch,
      ambiguousMatch: toBankAmbiguousMatch(ambiguousCandidate),
      link,
    });

    record('bank', String(bankLine.line_no), classification, {
      duplicateOf,
      utrAmountMismatch,
      ambiguousCandidate,
      link: link?.evidence,
    });
  }

  // --- Settlements -------------------------------------------------------------
  for (const settlement of input.settlements) {
    const pass4Verdict = pass4.verdicts.find((v) => v.settlement_id === settlement.settlement_id);
    if (pass4Verdict === undefined) {
      throw new Error(`Pass 4 produced no verdict for settlement ${settlement.settlement_id} — this is a code bug.`);
    }
    const link = links.find((l) => l.right_source === 'settlement' && l.right_id === settlement.settlement_id);
    const ambiguousMatch = pass3.ambiguities.find(
      (a) => a.direction === 'many_credits_one_settlement' && a.target_id === settlement.settlement_id
    );

    const classification = classifySettlement({ settlement, pass4Verdict, link, ambiguousMatch });

    record('settlement', settlement.settlement_id, classification, {
      pass4Verdict: pass4Verdict.evidence,
      ambiguousMatch,
      link: link?.evidence,
    });
  }

  // --- Settlement lines ---------------------------------------------------------
  for (const line of input.settlementLines) {
    const orderLink = links.find((l) => l.left_source === 'settlement_line' && l.left_id === line.entity_id);
    const ambiguousOrderMatch = pass5.ambiguousMatches.find((a) => a.entity_id === line.entity_id);
    const feeVerdict = pass6.lineVerdicts.find((v) => v.entity_id === line.entity_id);

    const classification = classifySettlementLine({ line, orderLink, ambiguousOrderMatch, feeVerdict });

    record('settlement_line', line.entity_id, classification, {
      orderLink: orderLink?.evidence,
      ambiguousOrderMatch,
      feeVerdict: feeVerdict?.evidence,
    });
  }

  // --- Orders — only Pass 5's unmatched orders need a record at all ------------
  for (const verdict of pass5.orderVerdicts) {
    const order = input.orders.find((o) => o.order_id === verdict.order_id);
    if (order === undefined) {
      throw new Error(`Pass 5 produced a verdict for unknown order ${verdict.order_id} — this is a code bug.`);
    }
    const classification = classifyOrder(order, verdict);
    record('order', order.order_id, classification, { orderVerdict: verdict });
  }

  const summary: ReconcileSummary = {
    total: exceptions.length,
    auto: exceptions.filter((e) => e.decision === 'AUTO_RESOLVED').length,
    review: exceptions.filter((e) => e.decision === 'NEEDS_REVIEW').length,
    unresolved: exceptions.filter((e) => e.decision === 'UNRESOLVED').length,
  };

  return { links, exceptions, audit, summary };
}

// ---------------------------------------------------------------------------
// The DB-facing wrapper.
// ---------------------------------------------------------------------------

export type Batch = 'main' | 'holdout';

export interface RunReconciliationResult {
  run_id: string;
  batch: Batch;
  summary: ReconcileSummary;
}

/** A DATE/TIMESTAMPTZ column: postgres.js hands back a Date for both, but
 * this stays defensive in case a driver upgrade or config change ever
 * returns the wire string instead. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

interface DbOrderRow {
  order_id: string;
  order_ref: string;
  customer_ref: string | null;
  order_amount: number;
  created_at: Date | string;
  order_status: string;
  refund_issued: number;
}

function dbRowToOrder(row: DbOrderRow): Order {
  return {
    order_id: row.order_id,
    order_ref: row.order_ref,
    customer_ref: row.customer_ref ?? '',
    order_amount_paise: toPaise(row.order_amount),
    currency: 'INR',
    created_at: asDate(row.created_at),
    order_status: row.order_status as Order['order_status'],
    refund_issued_paise: toPaise(row.refund_issued),
  };
}

interface DbSettlementRow {
  settlement_id: string;
  amount: number;
  fees: number;
  tax: number;
  utr: string | null;
  status: string;
  created_at: Date | string;
}

function dbRowToSettlement(row: DbSettlementRow): Settlement {
  return {
    settlement_id: row.settlement_id,
    amount_paise: toPaise(row.amount),
    fees_paise: toPaise(row.fees),
    tax_paise: toPaise(row.tax),
    utr_number: row.utr ?? '',
    status: row.status as Settlement['status'],
    created_at: asDate(row.created_at),
  };
}

interface DbSettlementLineRow {
  entity_id: string;
  type: string;
  debit: number;
  credit: number;
  amount: number;
  fee: number;
  tax: number;
  on_hold: boolean;
  settled: boolean;
  created_at: Date | string;
  settled_at: Date | string | null;
  settlement_id: string | null;
  settlement_utr: string | null;
  order_id: string | null;
  method: string | null;
  card_network: string | null;
  card_type: string | null;
  international: boolean;
  dispute_id: string | null;
  description: string | null;
}

function dbRowToSettlementLine(row: DbSettlementLineRow): NormalizedSettlementLine {
  const type = row.type as NormalizedSettlementLine['type'];
  const createdAt = asDate(row.created_at);
  return {
    entity_id: row.entity_id,
    type,
    debit_paise: toPaise(row.debit),
    credit_paise: toPaise(row.credit),
    amount_paise: toPaise(row.amount),
    fee_paise: toPaise(row.fee),
    tax_paise: toPaise(row.tax),
    on_hold: row.on_hold,
    settled: row.settled,
    created_at: createdAt,
    settled_at: row.settled_at === null ? null : asDate(row.settled_at),
    settlement_id: row.settlement_id,
    settlement_utr: row.settlement_utr,
    order_id: row.order_id,
    method: row.method as NormalizedSettlementLine['method'],
    card_network: row.card_network as NormalizedSettlementLine['card_network'],
    card_type: row.card_type as NormalizedSettlementLine['card_type'],
    international: row.international,
    dispute_id: row.dispute_id,
    description: row.description ?? '',
    settlement_cycle_date: type === 'payment' ? settlementCycleDate(createdAt) : null,
  };
}

interface DbBankLineRow {
  line_no: number;
  value_date: Date | string;
  narration: string;
  ref_no: string | null;
  debit: number;
  credit: number;
  closing_balance: number;
}

function dbRowToBankLine(row: DbBankLineRow): NormalizedBankLine {
  const { utr, parse_source } = extractUtr(row.narration);
  return {
    line_no: row.line_no,
    value_date: asDate(row.value_date),
    narration: row.narration,
    ref_no: row.ref_no,
    debit_paise: toPaise(row.debit),
    credit_paise: toPaise(row.credit),
    closing_balance_paise: toPaise(row.closing_balance),
    parsed_utr: utr,
    parse_source,
  };
}

/**
 * Run the deterministic engine against a batch's most recently seeded run,
 * and persist links, exceptions and audit rows under that same run_id in
 * one transaction. Run `npx tsx scripts/seed.ts --batch <batch>` first —
 * this function reads what seed.ts already loaded, it does not read CSVs
 * itself.
 */
export async function runReconciliation(batch: Batch): Promise<RunReconciliationResult> {
  const runRows = await sql<{ id: string }[]>`
    SELECT id FROM runs WHERE batch = ${batch} ORDER BY started_at DESC LIMIT 1
  `;
  if (runRows.length === 0) {
    throw new Error(
      `No seeded run found for batch '${batch}'. Run \`npx tsx scripts/seed.ts --batch ${batch}\` first.`
    );
  }
  const runId = runRows[0].id;

  await sql`UPDATE runs SET status = 'running' WHERE id = ${runId}`;

  try {
    const [orderRows, settlementRows, settlementLineRows, bankLineRows] = await Promise.all([
      sql<DbOrderRow[]>`SELECT * FROM orders WHERE run_id = ${runId}`,
      sql<DbSettlementRow[]>`SELECT * FROM settlements WHERE run_id = ${runId}`,
      sql<DbSettlementLineRow[]>`SELECT * FROM settlement_lines WHERE run_id = ${runId}`,
      sql<DbBankLineRow[]>`SELECT * FROM bank_lines WHERE run_id = ${runId}`,
    ]);

    const orders = orderRows.map(dbRowToOrder);
    const settlements = settlementRows.map(dbRowToSettlement);
    const settlementLines = settlementLineRows.map(dbRowToSettlementLine);
    const bankLines = bankLineRows.map(dbRowToBankLine);

    const rateCard = batch === 'main' ? KIRANAKART_RATE_CARD : BOMBAYWEAVE_RATE_CARD;

    const result = reconcile({ orders, settlements, settlementLines, bankLines, rateCard });

    await sql.begin(async (tx) => {
      // Pass 0's UTR extraction, written back onto the rows seed.ts left
      // un-normalized. One UPDATE per line — the batch is ~300 records, so
      // this is well within a demo's patience; a bulk VALUES-join UPDATE
      // would be the next step if that ever stopped being true.
      for (const bankLine of bankLines) {
        await tx`
          UPDATE bank_lines
          SET parsed_utr = ${bankLine.parsed_utr}, parse_source = ${bankLine.parse_source}
          WHERE run_id = ${runId} AND line_no = ${bankLine.line_no}
        `;
      }

      if (result.links.length > 0) {
        const linkRows = result.links.map((link) => ({
          id: `link_${randomId()}`,
          run_id: runId,
          left_source: link.left_source,
          left_id: link.left_id,
          right_source: link.right_source,
          right_id: link.right_id,
          relation: link.relation,
          pass: link.pass,
          confidence: link.confidence,
          evidence: tx.json(link.evidence as postgres.JSONValue),
        }));
        await tx`
          INSERT INTO links ${tx(
            linkRows,
            'id',
            'run_id',
            'left_source',
            'left_id',
            'right_source',
            'right_id',
            'relation',
            'pass',
            'confidence',
            'evidence'
          )}
        `;
      }

      if (result.exceptions.length > 0) {
        const exceptionRows = result.exceptions.map((exception) => ({
          id: `exc_${randomId()}`,
          run_id: runId,
          record_source: exception.record_source,
          record_id: exception.record_id,
          class: exception.exception_class,
          decision: exception.decision,
          confidence: exception.confidence,
          amount_impact: exception.amount_impact_paise,
          evidence: tx.json(exception.evidence as postgres.JSONValue),
          deterministic_reason: exception.deterministic_reason,
          ai_status: 'not_requested',
          next_action: exception.next_action,
        }));
        await tx`
          INSERT INTO exceptions ${tx(
            exceptionRows,
            'id',
            'run_id',
            'record_source',
            'record_id',
            'class',
            'decision',
            'confidence',
            'amount_impact',
            'evidence',
            'deterministic_reason',
            'ai_status',
            'next_action'
          )}
        `;
      }

      if (result.audit.length > 0) {
        const auditRows = result.audit.map((row) => ({
          run_id: runId,
          subject_source: row.subject_source,
          subject_id: row.subject_id,
          action: row.action,
          rule: row.rule,
          confidence: row.confidence,
          detail: tx.json(row.detail as postgres.JSONValue),
        }));
        await tx`
          INSERT INTO audit_log ${tx(
            auditRows,
            'run_id',
            'subject_source',
            'subject_id',
            'action',
            'rule',
            'confidence',
            'detail'
          )}
        `;
      }

      await tx`
        UPDATE runs
        SET status = 'complete',
            finished_at = now(),
            config = config || ${tx.json({
              thresholds: { t_auto: DEFAULT_THRESHOLDS.t_auto, t_review: DEFAULT_THRESHOLDS.t_review },
              rate_card: batch === 'main' ? 'kiranakart' : 'bombayweave',
              llm_enabled: env.LLM_ENABLED,
            } as unknown as postgres.JSONValue)}
        WHERE id = ${runId}
      `;
    });

    return { run_id: runId, batch, summary: result.summary };
  } catch (error) {
    await sql`UPDATE runs SET status = 'failed', finished_at = now() WHERE id = ${runId}`;
    throw error;
  }
}

let idCounter = 0;
/** A short, collision-safe id suffix — monotonic within a process plus a
 * random component, since these rows never need to be looked up by id. */
function randomId(): string {
  idCounter += 1;
  return `${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}
