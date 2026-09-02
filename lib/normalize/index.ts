// Pass 0 — Normalize. SETL_BLUEPRINT.md section 10.
//
// A pure function per source: raw parsed CSV rows in, typed records plus
// a carried-forward list of INVALID_ROW failures out. No database writes
// — run.ts (prompt 09) orchestrates and persists.

import type {
  BankLine,
  CardType,
  Order,
  OrderStatus,
  PaymentMethod,
  RecordSource,
  Settlement,
  SettlementLine,
  SettlementLineType,
  SettlementStatus,
} from '../types';
import { parseMoney, toPaise, type Paise } from '../money';
import { parseIST, settlementCycleDate } from '../dates';
import {
  validateBankLineRow,
  validateColumns,
  validateOrderRow,
  validateSettlementLineRow,
  validateSettlementRow,
} from './validate';
import { extractUtr, type ParseSource } from './narration';
import { parseNarrationWithLlm } from '../ai/narrationParser';

export { validateColumns } from './validate';
export { extractUtr } from './narration';
export type { ParseSource } from './narration';

/** A row that failed to normalize. Carried forward, never dropped. */
export interface InvalidRowError {
  source: RecordSource;
  rawRow: Record<string, string>;
  reason: string;
}

/** SettlementLine plus the settlement_cycle_date Pass 0 attaches to payments. */
export interface NormalizedSettlementLine extends SettlementLine {
  settlement_cycle_date: Date | null; // set only for type === 'payment'
}

/**
 * regex/pending_llm come from Pass 0's own extraction (lib/normalize/narration.ts);
 * llm/failed are added on top by resolvePendingLlmBankLines below, once the
 * LLM layer (prompt 12) has had a chance to resolve a 'pending_llm' line —
 * a wider type here, not a change to narration.ts's own ParseSource, since
 * that file only knows what regex-only extraction can determine.
 */
export type BankLineParseSource = ParseSource | 'llm' | 'failed';

/** BankLine plus the UTR extraction result Pass 0 (and, for pending_llm lines, the LLM layer) attaches. */
export interface NormalizedBankLine extends BankLine {
  parsed_utr: string | null;
  parse_source: BankLineParseSource;
}

/**
 * Convert one money field to Paise.
 *
 * A field like '85900' — this system's own CSV convention, an already
 * paise-valued integer written as digits — is NOT a "money string" in
 * the sense parseMoney() targets: parseMoney('85900') would read it as
 * ₹85,900.00 (rupees), returning 8,590,000 paise, a 100x error. Number()
 * on a bare integer-digit string is exact and carries no such risk, so
 * that path is used whenever the field does not look like a formatted
 * currency string (no ₹, comma or decimal point). A genuinely
 * rupee-decimal-formatted field — the shape a real merchant's export is
 * likely to actually use — still goes through parseMoney() as intended.
 */
function parseAmountField(raw: string): Paise {
  if (raw.trim() === '') {
    throw new Error('amount field is empty');
  }
  const looksFormatted = /[₹,.]/.test(raw);
  if (looksFormatted) return parseMoney(raw);
  return toPaise(Number(raw));
}

function parseDateField(raw: string): Date {
  if (raw.trim() === '') {
    throw new Error('date field is empty');
  }
  return parseIST(raw);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function normalizeOrders(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): { orders: Order[]; invalidRows: InvalidRowError[] } {
  validateColumns('order', headers);

  const orders: Order[] = [];
  const invalidRows: InvalidRowError[] = [];

  for (const row of rows) {
    const structural = validateOrderRow(row);
    if (structural) {
      invalidRows.push({ source: 'order', rawRow: row, reason: structural.reason });
      continue;
    }
    try {
      orders.push({
        order_id: row.order_id,
        order_ref: row.order_ref,
        customer_ref: row.customer_ref,
        order_amount_paise: parseAmountField(row.order_amount_paise),
        currency: row.currency as 'INR',
        created_at: parseDateField(row.created_at),
        order_status: row.order_status as OrderStatus,
        refund_issued_paise: parseAmountField(row.refund_issued_paise),
      });
    } catch (error) {
      invalidRows.push({
        source: 'order',
        rawRow: row,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { orders, invalidRows };
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export function normalizeSettlements(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): { settlements: Settlement[]; invalidRows: InvalidRowError[] } {
  validateColumns('settlement', headers);

  const settlements: Settlement[] = [];
  const invalidRows: InvalidRowError[] = [];

  for (const row of rows) {
    const structural = validateSettlementRow(row);
    if (structural) {
      invalidRows.push({ source: 'settlement', rawRow: row, reason: structural.reason });
      continue;
    }
    try {
      settlements.push({
        settlement_id: row.settlement_id,
        amount_paise: parseAmountField(row.amount_paise),
        fees_paise: parseAmountField(row.fees_paise),
        tax_paise: parseAmountField(row.tax_paise),
        utr_number: row.utr_number,
        status: row.status as SettlementStatus,
        created_at: parseDateField(row.created_at),
      });
    } catch (error) {
      invalidRows.push({
        source: 'settlement',
        rawRow: row,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { settlements, invalidRows };
}

// ---------------------------------------------------------------------------
// Settlement lines
// ---------------------------------------------------------------------------

export function normalizeSettlementLines(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): { settlementLines: NormalizedSettlementLine[]; invalidRows: InvalidRowError[] } {
  validateColumns('settlement_line', headers);

  const settlementLines: NormalizedSettlementLine[] = [];
  const invalidRows: InvalidRowError[] = [];

  for (const row of rows) {
    const structural = validateSettlementLineRow(row);
    if (structural) {
      invalidRows.push({ source: 'settlement_line', rawRow: row, reason: structural.reason });
      continue;
    }
    try {
      const createdAt = parseDateField(row.created_at);
      const type = row.type as SettlementLineType;

      settlementLines.push({
        entity_id: row.entity_id,
        type,
        debit_paise: parseAmountField(row.debit_paise),
        credit_paise: parseAmountField(row.credit_paise),
        amount_paise: parseAmountField(row.amount_paise),
        fee_paise: parseAmountField(row.fee_paise),
        tax_paise: parseAmountField(row.tax_paise),
        on_hold: row.on_hold === 'true',
        settled: row.settled === 'true',
        created_at: createdAt,
        settled_at: row.settled_at === '' ? null : parseDateField(row.settled_at),
        settlement_id: row.settlement_id === '' ? null : row.settlement_id,
        settlement_utr: row.settlement_utr === '' ? null : row.settlement_utr,
        order_id: row.order_id === '' ? null : row.order_id,
        method: (row.method === '' ? null : row.method) as PaymentMethod | null,
        card_network: row.card_network === '' ? null : (row.card_network as SettlementLine['card_network']),
        card_type: (row.card_type === '' ? null : row.card_type) as CardType | null,
        international: row.international === 'true',
        dispute_id: row.dispute_id === '' ? null : row.dispute_id,
        description: row.description,
        // Pass 0 attaches this to every payment line — the capture date
        // plus T+2 business days. Not meaningful for refund/adjustment/
        // dispute lines, which is why it is null for those.
        settlement_cycle_date: type === 'payment' ? settlementCycleDate(createdAt) : null,
      });
    } catch (error) {
      invalidRows.push({
        source: 'settlement_line',
        rawRow: row,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { settlementLines, invalidRows };
}

// ---------------------------------------------------------------------------
// Bank lines
// ---------------------------------------------------------------------------

export function normalizeBankLines(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): { bankLines: NormalizedBankLine[]; invalidRows: InvalidRowError[] } {
  validateColumns('bank', headers);

  const bankLines: NormalizedBankLine[] = [];
  const invalidRows: InvalidRowError[] = [];

  for (const row of rows) {
    const structural = validateBankLineRow(row);
    if (structural) {
      invalidRows.push({ source: 'bank', rawRow: row, reason: structural.reason });
      continue;
    }
    try {
      const lineNo = Number(row.line_no);
      if (!Number.isInteger(lineNo)) throw new Error(`line_no is not an integer: ${JSON.stringify(row.line_no)}`);

      const { utr, parse_source } = extractUtr(row.narration);

      bankLines.push({
        line_no: lineNo,
        value_date: parseDateField(row.value_date),
        narration: row.narration,
        ref_no: row.ref_no === '' ? null : row.ref_no,
        debit_paise: parseAmountField(row.debit_paise),
        credit_paise: parseAmountField(row.credit_paise),
        closing_balance_paise: parseAmountField(row.closing_balance_paise),
        parsed_utr: utr,
        parse_source,
      });
    } catch (error) {
      invalidRows.push({
        source: 'bank',
        rawRow: row,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { bankLines, invalidRows };
}

// ---------------------------------------------------------------------------
// LLM enrichment — job 1 (SETL_BLUEPRINT.md section 13), wired into the
// normalization layer as the prompt asks, but kept as a SEPARATE async
// function rather than folded into normalizeBankLines above. That function
// stays synchronous and unchanged: lib/engine/run.ts calls extractUtr
// directly (not normalizeBankLines) and must stay a pure, synchronous
// core, and scripts/sweepThresholds.ts calls normalizeBankLines
// synchronously too. Only a caller that explicitly wants LLM enrichment —
// today, scripts/evaluate.ts — awaits this.
// ---------------------------------------------------------------------------

/**
 * For every bank line Pass 0 marked 'pending_llm', attempt the LLM parse
 * and its mandatory post-validation (lib/ai/narrationParser.ts); every
 * other line passes through untouched. A no-op per line when
 * LLM_ENABLED=false (lib/ai/client.ts's own hard switch) — this function
 * is always safe to call.
 */
export async function resolvePendingLlmBankLines(
  bankLines: readonly NormalizedBankLine[],
  knownUtrs: readonly string[]
): Promise<NormalizedBankLine[]> {
  const resolved: NormalizedBankLine[] = [];
  for (const line of bankLines) {
    if (line.parse_source !== 'pending_llm') {
      resolved.push(line);
      continue;
    }
    const result = await parseNarrationWithLlm(line.narration, knownUtrs);
    resolved.push({ ...line, parsed_utr: result.utr, parse_source: result.parse_source });
  }
  return resolved;
}
