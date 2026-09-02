// Job 2 — evidence-grounded explanation. SETL_BLUEPRINT.md section 13.
//
// On demand, per exception (never for a whole batch). Builds the evidence
// bundle SERVER-SIDE, from the database — the caller supplies only an
// exception id, never evidence itself, so there is no path for a client
// to inject a number into what the model sees. Every number in the bundle
// is already final: settlement_composition and settlement_lines.contribution
// are both written once, by pass6b-compose.ts, and never recomputed here —
// this file only reads and formats them.
//
// The number guard (section 14) sits between the LLM's response and what
// gets persisted: `checkNumberGuard` walks this same evidence bundle for
// its allowlist, so a hallucinated number is rejected before it ever
// reaches `ai_explanation` — `rejected_by_guard` leaves that column null
// and the UI falls back to `deterministic_reason`, same as the plain
// `'error'` case. llm_calls logging (guard_result, rejected_tokens) is
// still deferred — see FAILURES.md — but `rejectedTokens` is returned
// here so whatever wires that logging in later has the data already.

import { sql } from '../db';
import { formatPaise } from '../money';
import { formatISTDate } from '../dates';
import { callLlm, type LlmToolSchema } from './client';
import { EXPLAINER_SYSTEM_PROMPT } from './prompts';
import { checkNumberGuard } from './numberGuard';

const WRITE_EXPLANATION_TOOL: LlmToolSchema = {
  name: 'write_explanation',
  description:
    'Write a 2-3 sentence explanation of this reconciliation exception for a finance associate, using only values present in the evidence bundle you were given.',
  input_schema: {
    type: 'object',
    properties: {
      explanation: {
        type: 'string',
        description: '2 to 3 sentences. No hedging, no apologising, no restating the exception class name.',
      },
    },
    required: ['explanation'],
    additionalProperties: false,
  },
};

interface ExceptionDbRow {
  id: string;
  run_id: string;
  record_source: string;
  record_id: string;
  class: string;
  confidence: number;
}

interface SettlementContext {
  id: string;
  date: string;
}

interface CompositionEvidence {
  gross_payments: string;
  fees_total: string;
  gst_total: string;
  refunds_total: string;
  disputes_total: string;
  adjustments_net: string;
  expected_payout: string;
  header_amount: string;
  bank_credit_total: string;
  diff_total: string;
  status: string;
  discrepancy_component: string;
  payment_count: number;
  refund_count: number;
}

interface ContributingLine {
  type: string;
  entity_id: string;
  contribution: string;
  order_ref: string | null;
  order_linked: boolean;
}

export interface EvidenceBundle {
  exception_class: string;
  settlement: SettlementContext | null;
  composition: CompositionEvidence | null;
  contributing_lines: ContributingLine[];
  confidence: number;
  rule_used: string;
}

export interface ExplainResult {
  explanation: string | null;
  status: 'ok' | 'error' | 'rejected_by_guard';
  /** Tokens the number guard rejected — empty unless status is 'rejected_by_guard'. */
  rejectedTokens: string[];
}

/**
 * Every record source resolves to a settlement differently — a settlement
 * record IS one; a settlement_line carries its own settlement_id; a bank
 * line reaches one via its bank_to_settlement link; an order reaches one
 * via whichever settlement_line references it. Returns null when no
 * settlement is resolvable at all (e.g. a genuinely MISSING_IN_BANK
 * settlement with no link, or an order with NOT_SETTLED) — the bundle
 * just carries less context in that case, never a guess.
 */
async function resolveSettlementId(
  runId: string,
  recordSource: string,
  recordId: string
): Promise<string | null> {
  if (recordSource === 'settlement') return recordId;

  if (recordSource === 'settlement_line') {
    const rows = await sql<{ settlement_id: string | null }[]>`
      SELECT settlement_id FROM settlement_lines WHERE run_id = ${runId} AND entity_id = ${recordId}
    `;
    return rows[0]?.settlement_id ?? null;
  }

  if (recordSource === 'bank') {
    const rows = await sql<{ right_id: string }[]>`
      SELECT right_id FROM links
      WHERE run_id = ${runId} AND left_source = 'bank' AND left_id = ${recordId} AND relation = 'bank_to_settlement'
      LIMIT 1
    `;
    return rows[0]?.right_id ?? null;
  }

  if (recordSource === 'order') {
    const rows = await sql<{ settlement_id: string | null }[]>`
      SELECT settlement_id FROM settlement_lines
      WHERE run_id = ${runId} AND order_id = ${recordId} AND settlement_id IS NOT NULL
      LIMIT 1
    `;
    return rows[0]?.settlement_id ?? null;
  }

  return null;
}

async function fetchSettlementContext(runId: string, settlementId: string): Promise<SettlementContext | null> {
  const rows = await sql<{ settlement_id: string; created_at: Date }[]>`
    SELECT settlement_id, created_at FROM settlements WHERE run_id = ${runId} AND settlement_id = ${settlementId}
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].settlement_id, date: formatISTDate(rows[0].created_at) };
}

async function fetchComposition(runId: string, settlementId: string): Promise<CompositionEvidence | null> {
  const rows = await sql<
    {
      gross_payments: number;
      fees_total: number;
      gst_total: number;
      refunds_total: number;
      disputes_total: number;
      adjustments_net: number;
      expected_payout: number;
      header_amount: number;
      bank_credit_total: number | null;
      diff_total: number | null;
      status: string;
      discrepancy_component: string;
      payment_count: number;
      refund_count: number;
    }[]
  >`
    SELECT gross_payments, fees_total, gst_total, refunds_total, disputes_total, adjustments_net,
           expected_payout, header_amount, bank_credit_total, diff_total, status, discrepancy_component,
           payment_count, refund_count
    FROM settlement_composition WHERE run_id = ${runId} AND settlement_id = ${settlementId}
  `;
  if (rows.length === 0) return null;
  const c = rows[0];
  return {
    gross_payments: formatPaise(c.gross_payments),
    fees_total: formatPaise(c.fees_total),
    gst_total: formatPaise(c.gst_total),
    refunds_total: formatPaise(c.refunds_total),
    disputes_total: formatPaise(c.disputes_total),
    adjustments_net: formatPaise(c.adjustments_net),
    expected_payout: formatPaise(c.expected_payout),
    header_amount: formatPaise(c.header_amount),
    bank_credit_total: c.bank_credit_total === null ? 'not linked to any bank credit' : formatPaise(c.bank_credit_total),
    diff_total: c.diff_total === null ? 'not applicable — unlinked' : formatPaise(c.diff_total),
    status: c.status,
    discrepancy_component: c.discrepancy_component,
    payment_count: c.payment_count,
    refund_count: c.refund_count,
  };
}

/**
 * The settlement's own non-payment lines (refund/dispute/adjustment/transfer
 * — the ones a composition discrepancy is usually attributed to), plus the
 * specific payment line under investigation if this exception IS one.
 * Contribution figures are Pass 6B's own already-computed, already-signed
 * per-line numbers — never recomputed here.
 */
async function fetchContributingLines(
  runId: string,
  settlementId: string,
  highlightEntityId: string | null
): Promise<ContributingLine[]> {
  const rows = await sql<
    {
      entity_id: string;
      type: string;
      contribution: number | null;
      order_ref: string | null;
      order_linked: boolean;
    }[]
  >`
    SELECT sl.entity_id, sl.type, sl.contribution, o.order_ref,
           EXISTS (
             SELECT 1 FROM links l
             WHERE l.run_id = ${runId} AND l.left_source = 'settlement_line' AND l.left_id = sl.entity_id
           ) AS order_linked
    FROM settlement_lines sl
    LEFT JOIN orders o ON o.run_id = sl.run_id AND o.order_id = sl.order_id
    WHERE sl.run_id = ${runId}
      AND sl.settlement_id = ${settlementId}
      AND (sl.type != 'payment' OR sl.entity_id = ${highlightEntityId ?? ''})
    ORDER BY sl.entity_id
  `;

  return rows.map((r) => ({
    type: r.type,
    entity_id: r.entity_id,
    contribution: r.contribution === null ? 'not yet computed' : formatPaise(r.contribution),
    order_ref: r.order_ref,
    order_linked: r.order_linked,
  }));
}

function deriveRuleUsed(recordSource: string, hasComposition: boolean): string {
  const base: Record<string, string> = {
    bank: 'passes 1-3 (bank <-> settlement matching)',
    settlement: 'pass 4 (internal balance)',
    settlement_line: 'pass 5 (order match) + pass 6 (fee audit)',
    order: 'pass 5 (order match)',
  };
  const rule = base[recordSource] ?? 'lib/engine/classify.ts';
  return hasComposition ? `${rule} + pass 6b (composition)` : rule;
}

async function buildEvidenceBundle(exceptionRow: ExceptionDbRow): Promise<EvidenceBundle> {
  const settlementId = await resolveSettlementId(exceptionRow.run_id, exceptionRow.record_source, exceptionRow.record_id);

  const settlement = settlementId !== null ? await fetchSettlementContext(exceptionRow.run_id, settlementId) : null;
  const composition = settlement !== null ? await fetchComposition(exceptionRow.run_id, settlement.id) : null;
  const contributingLines =
    settlement !== null
      ? await fetchContributingLines(
          exceptionRow.run_id,
          settlement.id,
          exceptionRow.record_source === 'settlement_line' ? exceptionRow.record_id : null
        )
      : [];

  return {
    exception_class: exceptionRow.class,
    settlement,
    composition,
    contributing_lines: contributingLines,
    confidence: exceptionRow.confidence,
    rule_used: deriveRuleUsed(exceptionRow.record_source, composition !== null),
  };
}

/**
 * Build the evidence bundle for one exception and ask the LLM to explain
 * it in 2-3 sentences. Throws only when the exception id itself doesn't
 * exist (a 404, for the caller to handle) — every other failure (LLM
 * disabled, network error, malformed output) resolves to
 * `{ explanation: null, status: 'error' }` so it can still be persisted
 * and the UI can fall back to `deterministic_reason`.
 */
export async function explainException(exceptionId: string): Promise<ExplainResult> {
  const rows = await sql<ExceptionDbRow[]>`
    SELECT id, run_id, record_source, record_id, class, confidence
    FROM exceptions WHERE id = ${exceptionId}
  `;
  if (rows.length === 0) {
    throw new Error(`Exception ${exceptionId} not found`);
  }

  const bundle = await buildEvidenceBundle(rows[0]);

  const call = await callLlm({
    system: EXPLAINER_SYSTEM_PROMPT,
    userContent: JSON.stringify(bundle),
    tool: WRITE_EXPLANATION_TOOL,
    maxTokens: 400,
  });

  if (!call.ok || call.output === null) {
    return { explanation: null, status: 'error', rejectedTokens: [] };
  }

  const explanation = call.output.explanation;
  if (typeof explanation !== 'string' || explanation.trim().length === 0) {
    return { explanation: null, status: 'error', rejectedTokens: [] };
  }

  const guard = checkNumberGuard(explanation, bundle);
  if (!guard.pass) {
    return { explanation: null, status: 'rejected_by_guard', rejectedTokens: guard.rejectedTokens };
  }

  return { explanation, status: 'ok', rejectedTokens: [] };
}
