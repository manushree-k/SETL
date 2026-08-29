// Shared record shapes for the synthetic data generator.
//
// These mirror SETL_BLUEPRINT.md section 7 field-for-field, using the
// blueprint's own column names so a reader can hold the CSV schema and
// this file side by side. Amounts are Paise (never a raw number); dates
// are Date objects in memory and get formatted to the CSV-specific string
// shape (ISO8601, or YYYY-MM-DD for the bank statement) only when written.
//
// This is deliberately NOT the engine's type surface. ExceptionClass and
// Decision appear here only because ground_truth.json needs to name them.
// Link, evidence and composition types belong to prompts 08/09/09B, once
// the engine that produces them exists.

import type { Paise } from './money';

// ---------------------------------------------------------------------------
// Source A — Merchant order ledger (orders.csv)
// ---------------------------------------------------------------------------

export type OrderStatus = 'paid' | 'refunded' | 'partially_refunded' | 'cancelled';

export interface Order {
  order_id: string; // ord_<12 chars>
  order_ref: string; // e.g. KK-2026-04412
  customer_ref: string; // e.g. cust_a91f
  order_amount_paise: Paise;
  currency: 'INR';
  created_at: Date;
  order_status: OrderStatus;
  refund_issued_paise: Paise; // 0 if none
}

// ---------------------------------------------------------------------------
// Source B1 — Settlement headers (settlements.csv)
// ---------------------------------------------------------------------------

export type SettlementStatus = 'processed' | 'failed';

export interface Settlement {
  settlement_id: string; // setl_<14 chars>
  amount_paise: Paise; // net amount actually transferred
  fees_paise: Paise; // sum of MDR across all lines
  tax_paise: Paise; // sum of GST on MDR
  utr_number: string;
  status: SettlementStatus;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Source B2 — Settlement lines (settlement_lines.csv)
// Field-for-field mirror of Razorpay's recon API item shape.
// ---------------------------------------------------------------------------

export type SettlementLineType = 'payment' | 'refund' | 'adjustment' | 'dispute' | 'transfer';
export type PaymentMethod = 'card' | 'upi' | 'netbanking' | 'wallet';
export type CardNetwork = 'VISA' | 'MASTERCARD' | 'RUPAY' | 'AMEX';
export type CardType = 'credit' | 'debit';

export interface SettlementLine {
  entity_id: string; // pay_..., rfnd_..., adj_..., dsp_...
  type: SettlementLineType;
  debit_paise: Paise; // money out of balance (refunds, disputes)
  credit_paise: Paise; // money in, net of fee and tax (payments)
  amount_paise: Paise; // gross transaction value
  fee_paise: Paise; // MDR on this line
  tax_paise: Paise; // GST on that MDR
  on_hold: boolean; // true = frozen, will not settle yet
  settled: boolean;
  created_at: Date; // capture time
  settled_at: Date | null;
  settlement_id: string | null; // null means not yet in any payout
  settlement_utr: string | null;
  order_id: string | null; // deliberately empty on some rows
  method: PaymentMethod | null;
  card_network: CardNetwork | null;
  card_type: CardType | null;
  international: boolean;
  dispute_id: string | null;
  description: string; // free text, mostly meaningful on adjustments
}

// ---------------------------------------------------------------------------
// Source C — Bank statement (bank_statement.csv)
// ---------------------------------------------------------------------------

export interface BankLine {
  line_no: number; // statement row order
  value_date: Date; // date the bank credited the account
  narration: string; // free text — the hard part
  ref_no: string | null; // bank's own reference; often blank or useless
  debit_paise: Paise;
  credit_paise: Paise;
  closing_balance_paise: Paise; // running balance
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * The 15-class exception taxonomy from section 11, plus INVALID_ROW for
 * unparseable input rows and NOT_SETTLED. Scoped here only so ground truth
 * can reference an expected class; the engine (prompt 09) owns the
 * classifier that assigns these for real.
 *
 * NOT_SETTLED is not one of section 11's 15 — it was added to resolve a
 * naming collision: section 10's Pass 5 failure condition ("order exists
 * but no settlement line → MISSING_IN_LEDGER") and section 11's own
 * MISSING_IN_LEDGER ("a bank credit with no link after passes 1–3")
 * describe opposite failure directions under one name. MISSING_IN_LEDGER
 * keeps section 11's bank-side meaning; NOT_SETTLED is Pass 5's
 * order-side case.
 */
export type ExceptionClass =
  | 'MATCHED_EXACT'
  | 'FEE_DEDUCTION'
  | 'GST_ON_FEE'
  | 'TDS_194O'
  | 'TIMING_DIFFERENCE'
  | 'PARTIAL_SETTLEMENT'
  | 'SPLIT_PAYOUT'
  | 'REFUND_NETTED'
  | 'DISPUTE_HOLD'
  | 'DUPLICATE_CREDIT'
  | 'MISSING_IN_BANK'
  | 'MISSING_IN_LEDGER'
  | 'NOT_SETTLED'
  | 'AMOUNT_MISMATCH'
  | 'FEE_OVERCHARGE'
  | 'ROUNDING_RESIDUAL'
  | 'UNRESOLVED'
  | 'INVALID_ROW';

export type Decision = 'AUTO_RESOLVED' | 'NEEDS_REVIEW' | 'UNRESOLVED';

export type RecordSource = 'order' | 'settlement' | 'settlement_line' | 'bank';

/** The 14 injected cases from section 8, plus 'none' for an untouched record. */
export type InjectedCase =
  | 'none'
  | 'exact_match'
  | 'timing_difference'
  | 'refund_netted'
  | 'partial_settlement'
  | 'split_payout'
  | 'aggregated_credit'
  | 'duplicate_credit'
  | 'missing_in_bank'
  | 'dispute_hold'
  | 'rounding_residual'
  | 'fee_overcharge'
  | 'opaque_adjustment'
  | 'ambiguous_match'
  | 'corrupted_narration';

export interface GroundTruthRecord {
  record_id: string;
  source: RecordSource;
  injected_case: InjectedCase;
  expected_link_ids: string[];
  expected_class: ExceptionClass;
  expected_decision: Decision;
  is_resolvable: boolean;
  expected_reason: string;
}

export interface GroundTruthTotals {
  records: number;
  resolvable: number;
  unresolvable_by_design: number;
  gross_amount_paise: number;
  expected_fee_paise: number;
  expected_gst_paise: number;
}

export interface GroundTruthFile {
  batch_id: string;
  seed: number;
  profile: string;
  generated_at: string; // ISO8601 — the one timestamp that is genuinely "now"
  records: GroundTruthRecord[];
  totals: GroundTruthTotals;
}

// ---------------------------------------------------------------------------
// Rate card — shared between the generator and, later, Pass 6's fee audit.
// A tier is EITHER a basis-points rate (bps of the transaction amount) OR a
// flat fee in paise. Modelling both from the start matters: the held-out
// profile's netbanking tier is a flat ₹12, and a bps-only shape could not
// express that (see section 8 vs section 9 of the blueprint).
// ---------------------------------------------------------------------------

export type RateCardTier = { type: 'bps'; value: number } | { type: 'flat'; value: Paise };

export interface RateCard {
  gstBps: number; // GST rate on the fee itself, in bps (1800 = 18%)
  upi: RateCardTier;
  cardDomesticDebit: RateCardTier;
  cardDomesticCredit: RateCardTier;
  cardInternational: RateCardTier;
  netbanking: RateCardTier;
  wallet: RateCardTier;
}

// ---------------------------------------------------------------------------
// Links — the engine's common vocabulary. One shape regardless of which
// pass (1–6) produced the row; mirrors the `links` table in section 6.
// ---------------------------------------------------------------------------

export type LinkSource = 'bank' | 'settlement' | 'settlement_line' | 'order';
export type LinkRelation = 'bank_to_settlement' | 'line_to_order' | 'refund_to_order';

/** The keys used, deltas, and competing candidates behind a link's confidence. */
export type Evidence = Record<string, unknown>;

/** One proposed relationship between two records, with the evidence for it. */
export interface Link {
  left_source: LinkSource;
  left_id: string;
  right_source: LinkSource;
  right_id: string;
  relation: LinkRelation;
  pass: number;
  confidence: number;
  evidence: Evidence;
}

// ---------------------------------------------------------------------------
// Merchant profile — everything that differs between "main" and "holdout".
// ---------------------------------------------------------------------------

export interface MethodMix {
  upi: number;
  card: number;
  netbanking: number;
  wallet: number;
}

export interface AmountBand {
  min: Paise;
  max: Paise;
  weight: number;
}

export interface MerchantProfile {
  name: string; // 'kiranakart' | 'bombayweave'
  rateCard: RateCard;
  methodMix: MethodMix;
  internationalCardShare: number; // fraction of card payments that are international
  amountBands: AmountBand[]; // the lognormal-ish mixture from section 8
  refundRate: number; // fraction of orders that get refunded
  ordersPerDay: number;
  days: number; // how many days of orders to generate
  startDate: string; // 'YYYY-MM-DD', IST — first day of the order window
  narrationTemplates: string[]; // 14 templates, bank-style
  bankRefNoBlankRate: number; // how often ref_no is left blank
}
