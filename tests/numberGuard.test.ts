// Tests for lib/ai/numberGuard.ts, per SETL_BLUEPRINT.md section 14.
//
// The sample bundle below is section 13 job 2's own worked example
// (a REFUND_NETTED settlement), reused here so the guard is tested
// against a real evidence shape, not an invented one. Per section 14's
// own explicit instruction — "an explanation that says 'the payout was
// short ₹5,000' when the ladder says ₹4,820 must be rejected... Write a
// test for exactly that case" — that scenario is tested verbatim below.

import { describe, expect, it } from 'vitest';
import { checkNumberGuard } from '../lib/ai/numberGuard';

const SAMPLE_BUNDLE = {
  exception_class: 'REFUND_NETTED',
  settlement: { id: 'setl_DGlQ1', date: '2026-04-15' },
  composition: {
    gross_payments: '₹1,00,000.00',
    fees_total: '₹2,000.00',
    gst_total: '₹360.00',
    refunds_total: '₹5,820.00',
    disputes_total: '₹0.00',
    adjustments_net: '₹0.00',
    expected_payout: '₹91,820.00',
    header_amount: '₹96,640.00',
    bank_credit_total: '₹91,820.00',
    diff_total: '₹4,820.00',
    status: 'DISCREPANCY',
    discrepancy_component: 'REFUNDS',
    payment_count: 18,
    refund_count: 3,
  },
  contributing_lines: [
    {
      type: 'refund',
      entity_id: 'rfnd_A1',
      contribution: '-₹2,420.00',
      order_ref: 'KK-2026-04198',
      order_linked: false,
    },
    {
      type: 'refund',
      entity_id: 'rfnd_B2',
      contribution: '-₹2,400.00',
      order_ref: 'KK-2026-04212',
      order_linked: false,
    },
  ],
  confidence: 0.94,
  rule_used: 'pass6b.compose + pass4.internal_balance',
};

describe('checkNumberGuard', () => {
  it('passes a clean explanation using only values present in the bundle', () => {
    const explanation =
      'The payout is short by ₹4,820.00 because refunds totalling ₹5,820.00 were netted against gross payments of ₹1,00,000.00. This is a REFUNDS discrepancy on settlement setl_DGlQ1 dated 2026-04-15, at 94% confidence.';

    const result = checkNumberGuard(explanation, SAMPLE_BUNDLE);

    expect(result.pass).toBe(true);
    expect(result.rejectedTokens).toEqual([]);
  });

  it('rejects the deliberate hallucination section 14 itself calls out: a wrong headline number', () => {
    // The ladder says the difference is ₹4,820 (diff_total); this
    // explanation invents ₹5,000 instead — exactly the case section 14
    // names as the one that must never be smoothed over.
    const explanation = 'The payout was short ₹5,000 because refunds were netted against this settlement.';

    const result = checkNumberGuard(explanation, SAMPLE_BUNDLE);

    expect(result.pass).toBe(false);
    expect(result.rejectedTokens.some((t) => t.includes('5,000'))).toBe(true);
  });

  it('rejects a number with no basis in the bundle at all, outside the documented carve-outs', () => {
    const explanation = 'There were 47 refund lines affected this cycle.';

    const result = checkNumberGuard(explanation, { unrelated: 'bundle' });

    expect(result.pass).toBe(false);
    expect(result.rejectedTokens).toContain('47');
  });

  it('allows the documented carve-outs (0-10, 18, 2) even when they are not present in the bundle', () => {
    const explanation = 'Two refunds were netted; this reflects the standard 18% GST on the T+2 settlement cycle.';

    const result = checkNumberGuard(explanation, { unrelated: 'bundle' });

    expect(result.pass).toBe(true);
    expect(result.rejectedTokens).toEqual([]);
  });

  it('allows a date written in prose form when the bundle only carries the ISO form', () => {
    const explanation = 'This settlement, dated 15 April 2026, shows a discrepancy.';

    const result = checkNumberGuard(explanation, { settlement: { date: '2026-04-15' } });

    expect(result.pass).toBe(true);
  });

  it('rejects a date not present in the bundle at all', () => {
    const explanation = 'This settlement, dated 3 March 2025, shows a discrepancy.';

    const result = checkNumberGuard(explanation, { settlement: { date: '2026-04-15' } });

    expect(result.pass).toBe(false);
    expect(result.rejectedTokens.length).toBeGreaterThan(0);
  });

  it('does not misread digits embedded in an id (order_ref, entity_id) as standalone numbers', () => {
    // "KK-2026-04198" contains "2026" and "04198" — neither is a number
    // the explanation is asserting; both are part of one opaque id, and
    // must not be checked (or rejected) as if they were bare figures.
    const explanation = `Refund rfnd_A1 (order ${SAMPLE_BUNDLE.contributing_lines[0].order_ref}) was netted from this payout.`;

    const result = checkNumberGuard(explanation, SAMPLE_BUNDLE);

    expect(result.pass).toBe(true);
    expect(result.rejectedTokens).toEqual([]);
  });

  it('walks composition values into the allowlist — the guard\'s most important job per section 14', () => {
    // A number that only appears inside composition (not anywhere else in
    // the bundle) must still be recognized as allowed.
    const explanation = 'Gross payments for this cycle were ₹1,00,000.00.';

    const result = checkNumberGuard(explanation, SAMPLE_BUNDLE);

    expect(result.pass).toBe(true);
  });
});
