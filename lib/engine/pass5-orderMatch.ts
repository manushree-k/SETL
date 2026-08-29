// Pass 5 — Settlement line ↔ Order. SETL_BLUEPRINT.md section 10.
//
// Pure function: settlement lines (payment and refund only — adjustment,
// dispute, and transfer lines are not this pass's concern) and orders in,
// links out. Tiered, first hit wins, same refusal discipline as Passes 1–3:
// two-or-more candidates escalate rather than pick the closer one.

import type { NormalizedSettlementLine } from '../normalize';
import type { Link, Order } from '../types';
import { daysBetweenIST } from '../dates';

/** Capture must fall within order_date + 0..3 days. */
const CAPTURE_WINDOW_MAX_DAYS = 3;

export interface Pass5Candidate {
  order_id: string;
  amount_delta_paise: number;
  date_delta_days: number;
}

/** A settlement line with 2+ candidate orders on amount + date. */
export interface Pass5AmbiguousMatch {
  entity_id: string;
  candidate_count: number;
  candidates: Pass5Candidate[];
  confidence: number;
}

export type Pass5OrderVerdictClass = 'DISPUTE_HOLD' | 'NOT_SETTLED';

/**
 * An order with no settlement line matched to it at all. Distinguishing
 * DISPUTE_HOLD from NOT_SETTLED is the point of this pass: a payment
 * frozen by a dispute is not the same failure as a payment that never
 * turned up in the settlement report, even though both look like "no line."
 *
 * NOT_SETTLED is a distinct class from the taxonomy's MISSING_IN_LEDGER
 * (section 11), which names the opposite direction — a bank credit with
 * nothing behind it in Source A/B. This class instead means Source A has
 * the order but Source B never produced a settlement line for it.
 *
 * Order-status filtering (e.g. ignoring a cancelled order that was never
 * expected to settle) is left to Pass 7's classifier — this pass reports
 * the raw signal for every unmatched order.
 */
export interface Pass5OrderVerdict {
  order_id: string;
  classification: Pass5OrderVerdictClass;
}

export interface Pass5Result {
  links: Link[];
  ambiguousMatches: Pass5AmbiguousMatch[];
  /** Settlement lines (payment/refund) that matched nothing. */
  unmatchedLines: NormalizedSettlementLine[];
  orderVerdicts: Pass5OrderVerdict[];
}

function orderIdLink(
  line: NormalizedSettlementLine,
  order: Order,
  relation: 'line_to_order' | 'refund_to_order'
): Link {
  return {
    left_source: 'settlement_line',
    left_id: line.entity_id,
    right_source: 'order',
    right_id: order.order_id,
    relation,
    pass: 5,
    confidence: 1.0,
    evidence: {
      key: 'order_id',
      amount_delta: 0,
      date_delta_days: daysBetweenIST(order.created_at, line.created_at),
      candidate_count: 1,
    },
  };
}

/**
 * Pass 5 — tiered settlement-line-to-order matching.
 *
 * Payment lines: (1) explicit order_id, (2) unique amount+date match within
 * the capture window, (3) 2+ such candidates → refuse. Refund lines: (1)
 * explicit order_id, then (4) fall back to matching against an order's
 * issued refund amount, with the same refuse-on-ambiguity rule.
 */
export function runPass5(
  lines: readonly NormalizedSettlementLine[],
  orders: readonly Order[]
): Pass5Result {
  const links: Link[] = [];
  const ambiguousMatches: Pass5AmbiguousMatch[] = [];
  const unmatchedLines: NormalizedSettlementLine[] = [];
  const matchedOrderIds = new Set<string>();

  const ordersById = new Map(orders.map((o) => [o.order_id, o] as const));
  const relevantLines = lines.filter((l) => l.type === 'payment' || l.type === 'refund');

  for (const line of relevantLines) {
    const relation: 'line_to_order' | 'refund_to_order' =
      line.type === 'refund' ? 'refund_to_order' : 'line_to_order';

    // Tier 1: explicit order_id, either line type.
    if (line.order_id !== null) {
      const order = ordersById.get(line.order_id);
      if (order !== undefined) {
        links.push(orderIdLink(line, order, relation));
        matchedOrderIds.add(order.order_id);
        continue;
      }
      // order_id given but no such order exists — an explicit, wrong id is
      // not something amount+date should paper over. Leave unmatched.
      unmatchedLines.push(line);
      continue;
    }

    if (line.type === 'payment') {
      // Tier 2/3: unique amount+date match, order_id blank.
      const candidates = orders.filter((o) => {
        if (o.order_amount_paise !== line.amount_paise) return false;
        const delta = daysBetweenIST(o.created_at, line.created_at);
        return delta >= 0 && delta <= CAPTURE_WINDOW_MAX_DAYS;
      });

      if (candidates.length === 1) {
        const order = candidates[0];
        links.push({
          left_source: 'settlement_line',
          left_id: line.entity_id,
          right_source: 'order',
          right_id: order.order_id,
          relation: 'line_to_order',
          pass: 5,
          confidence: 0.8,
          evidence: {
            key: 'amount_date_unique',
            amount_delta: 0,
            date_delta_days: daysBetweenIST(order.created_at, line.created_at),
            candidate_count: 1,
          },
        });
        matchedOrderIds.add(order.order_id);
      } else if (candidates.length > 1) {
        ambiguousMatches.push({
          entity_id: line.entity_id,
          candidate_count: candidates.length,
          candidates: candidates.map((o) => ({
            order_id: o.order_id,
            amount_delta_paise: line.amount_paise - o.order_amount_paise,
            date_delta_days: daysBetweenIST(o.created_at, line.created_at),
          })),
          confidence: 0.3 / candidates.length,
        });
        unmatchedLines.push(line);
      } else {
        unmatchedLines.push(line);
      }
      continue;
    }

    // type === 'refund', order_id blank: tier 4, match against the order's
    // own issued-refund amount rather than its gross order amount.
    const refundCandidates = orders.filter(
      (o) => o.refund_issued_paise > 0 && o.refund_issued_paise === line.amount_paise
    );

    if (refundCandidates.length === 1) {
      const order = refundCandidates[0];
      links.push({
        left_source: 'settlement_line',
        left_id: line.entity_id,
        right_source: 'order',
        right_id: order.order_id,
        relation: 'refund_to_order',
        pass: 5,
        confidence: 0.8,
        evidence: {
          key: 'amount_date_unique',
          amount_delta: 0,
          date_delta_days: daysBetweenIST(order.created_at, line.created_at),
          candidate_count: 1,
        },
      });
      matchedOrderIds.add(order.order_id);
    } else if (refundCandidates.length > 1) {
      ambiguousMatches.push({
        entity_id: line.entity_id,
        candidate_count: refundCandidates.length,
        candidates: refundCandidates.map((o) => ({
          order_id: o.order_id,
          amount_delta_paise: line.amount_paise - o.refund_issued_paise,
          date_delta_days: daysBetweenIST(o.created_at, line.created_at),
        })),
        confidence: 0.3 / refundCandidates.length,
      });
      unmatchedLines.push(line);
    } else {
      unmatchedLines.push(line);
    }
  }

  // Order-side failure: orders never matched to any line at all.
  const linesByOrderId = new Map<string, NormalizedSettlementLine[]>();
  for (const line of lines) {
    if (line.order_id === null) continue;
    const bucket = linesByOrderId.get(line.order_id);
    if (bucket) bucket.push(line);
    else linesByOrderId.set(line.order_id, [line]);
  }

  const orderVerdicts: Pass5OrderVerdict[] = [];
  for (const order of orders) {
    if (matchedOrderIds.has(order.order_id)) continue;
    const referencingLines = linesByOrderId.get(order.order_id) ?? [];
    const onHold = referencingLines.some((l) => l.on_hold);
    orderVerdicts.push({
      order_id: order.order_id,
      classification: onHold ? 'DISPUTE_HOLD' : 'NOT_SETTLED',
    });
  }

  return { links, ambiguousMatches, unmatchedLines, orderVerdicts };
}
