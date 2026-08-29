// Pass 0, structural validation. SETL_BLUEPRINT.md section 10.
//
// Two different failures get two different responses:
//   - A required COLUMN missing → reject the whole FILE. A file missing a
//     column is malformed at the source; there is nothing to normalize.
//   - A required FIELD missing or an enum value invalid on one ROW → that
//     row becomes an INVALID_ROW, carried forward, never dropped. Money
//     and date PARSEABILITY are checked separately, by index.ts's actual
//     conversion attempt — this file only checks structure and enums.

import type { RecordSource } from '../types';

const REQUIRED_COLUMNS: Record<RecordSource, readonly string[]> = {
  order: [
    'order_id',
    'order_ref',
    'customer_ref',
    'order_amount_paise',
    'currency',
    'created_at',
    'order_status',
    'refund_issued_paise',
  ],
  settlement: ['settlement_id', 'amount_paise', 'fees_paise', 'tax_paise', 'utr_number', 'status', 'created_at'],
  settlement_line: [
    'entity_id',
    'type',
    'debit_paise',
    'credit_paise',
    'amount_paise',
    'fee_paise',
    'tax_paise',
    'on_hold',
    'settled',
    'created_at',
    'settled_at',
    'settlement_id',
    'settlement_utr',
    'order_id',
    'method',
    'card_network',
    'card_type',
    'international',
    'dispute_id',
    'description',
  ],
  bank: ['line_no', 'value_date', 'narration', 'ref_no', 'debit_paise', 'credit_paise', 'closing_balance_paise'],
};

/**
 * Rejects the whole file if any required column is missing. This is a
 * file-level decision — never a per-row one — so it throws rather than
 * returning a value the caller might ignore.
 */
export function validateColumns(source: RecordSource, headerColumns: readonly string[]): void {
  const present = new Set(headerColumns);
  const missing = REQUIRED_COLUMNS[source].filter((c) => !present.has(c));
  if (missing.length > 0) {
    throw new Error(`${source} file is missing required column(s): ${missing.join(', ')}.`);
  }
}

export interface RowValidationError {
  reason: string;
}

const ORDER_STATUSES = new Set(['paid', 'refunded', 'partially_refunded', 'cancelled']);
const SETTLEMENT_STATUSES = new Set(['processed', 'failed']);
const LINE_TYPES = new Set(['payment', 'refund', 'adjustment', 'dispute', 'transfer']);
// '' is included because these fields are legitimately blank on non-card
// lines (e.g. an adjustment has no method) — schema.sql allows NULL here.
const METHODS = new Set(['card', 'upi', 'netbanking', 'wallet', '']);
const CARD_TYPES = new Set(['credit', 'debit', '']);

export function validateOrderRow(row: Record<string, string>): RowValidationError | null {
  if (!row.order_id) return { reason: 'order_id is required' };
  if (!row.order_ref) return { reason: 'order_ref is required' };
  if (!row.customer_ref) return { reason: 'customer_ref is required' };
  if (!ORDER_STATUSES.has(row.order_status)) {
    return { reason: `invalid order_status: ${JSON.stringify(row.order_status)}` };
  }
  return null;
}

export function validateSettlementRow(row: Record<string, string>): RowValidationError | null {
  if (!row.settlement_id) return { reason: 'settlement_id is required' };
  if (!SETTLEMENT_STATUSES.has(row.status)) {
    return { reason: `invalid status: ${JSON.stringify(row.status)}` };
  }
  return null;
}

export function validateSettlementLineRow(row: Record<string, string>): RowValidationError | null {
  if (!row.entity_id) return { reason: 'entity_id is required' };
  if (!LINE_TYPES.has(row.type)) return { reason: `invalid type: ${JSON.stringify(row.type)}` };
  if (!METHODS.has(row.method)) return { reason: `invalid method: ${JSON.stringify(row.method)}` };
  if (!CARD_TYPES.has(row.card_type)) return { reason: `invalid card_type: ${JSON.stringify(row.card_type)}` };
  return null;
}

export function validateBankLineRow(row: Record<string, string>): RowValidationError | null {
  if (!row.line_no) return { reason: 'line_no is required' };
  if (!row.narration) return { reason: 'narration is required' };
  return null;
}
