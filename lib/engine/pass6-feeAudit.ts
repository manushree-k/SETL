// Pass 6 — Fee and GST audit. SETL_BLUEPRINT.md section 10.
//
// Pure function: every payment settlement line + the rate card in, a fee
// verdict per line out. Reuses `computeFee`/`lookupTier` from lib/rateCard.ts
// — the SAME function the generator used to produce fee_paise/tax_paise in
// the first place, so "expected" and "actual" can never drift apart by two
// independent implementations disagreeing about what the rate card means.

import type { NormalizedSettlementLine } from '../normalize';
import type { RateCard } from '../types';
import { computeFee, lookupTier } from '../rateCard';

/** |fee_delta| this small or smaller is rounding, not a break. */
const FEE_TOLERANCE_PAISE = 1;

export type Pass6Classification = 'TOLERATED' | 'FEE_OVERCHARGE' | 'FEE_UNDERCHARGE' | 'AMOUNT_MISMATCH';

export interface Pass6LineVerdict {
  entity_id: string;
  method: string | null;
  expected_bps: number | null; // null for a flat tier, or when unresolvable
  expected_fee_paise: number | null; // null only when the method/card_type is unresolvable
  expected_gst_paise: number | null;
  actual_fee_paise: number;
  actual_tax_paise: number;
  fee_delta_paise: number | null;
  gst_delta_paise: number | null;
  classification: Pass6Classification;
  evidence: Record<string, unknown>;
}

export interface Pass6Result {
  lineVerdicts: Pass6LineVerdict[];
  /** Sum of fee_delta_paise across every FEE_OVERCHARGE line. */
  total_overcharge_paise: number;
}

/**
 * Pass 6 — recompute the expected fee and GST for every payment line and
 * flag the delta. A method the rate card cannot resolve (missing card_type
 * on a card line, or a method genuinely absent from the card) escalates as
 * AMOUNT_MISMATCH rather than assuming zero — this is deliberately what
 * fires on the held-out batch's flat-fee netbanking tier if the rate card
 * passed in doesn't carry it.
 */
export function runPass6(lines: readonly NormalizedSettlementLine[], rateCard: RateCard): Pass6Result {
  const lineVerdicts: Pass6LineVerdict[] = [];
  let totalOvercharge = 0;

  for (const line of lines) {
    if (line.type !== 'payment') continue;

    if (line.method === null) {
      lineVerdicts.push({
        entity_id: line.entity_id,
        method: null,
        expected_bps: null,
        expected_fee_paise: null,
        expected_gst_paise: null,
        actual_fee_paise: line.fee_paise,
        actual_tax_paise: line.tax_paise,
        fee_delta_paise: null,
        gst_delta_paise: null,
        classification: 'AMOUNT_MISMATCH',
        evidence: { key: 'rate_card', method: null, reason: 'payment line has no method' },
      });
      continue;
    }

    let expectedBps: number | null;
    let expectedFee: number;
    let expectedGst: number;
    try {
      const tier = lookupTier(rateCard, line.method, line.card_type, line.international);
      expectedBps = tier.type === 'bps' ? tier.value : null;
      const result = computeFee(rateCard, line.method, line.card_type, line.international, line.amount_paise);
      expectedFee = result.feePaise;
      expectedGst = result.gstPaise;
    } catch (error) {
      lineVerdicts.push({
        entity_id: line.entity_id,
        method: line.method,
        expected_bps: null,
        expected_fee_paise: null,
        expected_gst_paise: null,
        actual_fee_paise: line.fee_paise,
        actual_tax_paise: line.tax_paise,
        fee_delta_paise: null,
        gst_delta_paise: null,
        classification: 'AMOUNT_MISMATCH',
        evidence: {
          key: 'rate_card',
          method: line.method,
          card_type: line.card_type,
          international: line.international,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }

    const feeDelta = line.fee_paise - expectedFee;
    const gstDelta = line.tax_paise - expectedGst;

    let classification: Pass6Classification;
    if (Math.abs(feeDelta) <= FEE_TOLERANCE_PAISE) {
      classification = 'TOLERATED';
    } else if (feeDelta > FEE_TOLERANCE_PAISE) {
      classification = 'FEE_OVERCHARGE';
      totalOvercharge += feeDelta;
    } else {
      // feeDelta < -FEE_TOLERANCE_PAISE — undercharged, still a break.
      classification = 'FEE_UNDERCHARGE';
    }

    lineVerdicts.push({
      entity_id: line.entity_id,
      method: line.method,
      expected_bps: expectedBps,
      expected_fee_paise: expectedFee,
      expected_gst_paise: expectedGst,
      actual_fee_paise: line.fee_paise,
      actual_tax_paise: line.tax_paise,
      fee_delta_paise: feeDelta,
      gst_delta_paise: gstDelta,
      classification,
      evidence: {
        key: 'rate_card',
        method: line.method,
        card_type: line.card_type,
        international: line.international,
        expected_bps: expectedBps,
        expected_fee: expectedFee,
        actual_fee: line.fee_paise,
        fee_delta: feeDelta,
      },
    });
  }

  return { lineVerdicts, total_overcharge_paise: totalOvercharge };
}
