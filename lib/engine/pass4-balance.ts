// Pass 4 — Settlement internal balance. SETL_BLUEPRINT.md section 10.
//
// Pure function: settlement headers + their lines in, a per-settlement
// balance verdict out. No links — this pass catches errors *inside*
// Source B, independent of the bank. No amount of bank matching would find
// a settlement report that does not add up on its own.

import type { NormalizedSettlementLine } from '../normalize';
import type { Settlement } from '../types';

/** Residual between 1 and 99 paise, inclusive, is rounding — not a break. */
const ROUNDING_RESIDUAL_MIN_PAISE = 1;
const ROUNDING_RESIDUAL_MAX_PAISE = 99;

export type Pass4Classification = 'BALANCED' | 'ROUNDING_RESIDUAL' | 'AMOUNT_MISMATCH';

/** A payment line whose credit doesn't equal amount − fee − tax. */
export interface Pass4LineFailure {
  entity_id: string;
  reason: string;
  expected_credit_paise: number;
  actual_credit_paise: number;
}

export interface Pass4Verdict {
  settlement_id: string;
  computed_net_paise: number; // Σ(line.credit) − Σ(line.debit)
  header_amount_paise: number;
  residual_paise: number; // computed_net − header_amount, signed
  computed_fees_paise: number; // Σ(line.fee)
  header_fees_paise: number;
  fee_residual_paise: number;
  computed_tax_paise: number; // Σ(line.tax)
  header_tax_paise: number;
  tax_residual_paise: number;
  failing_lines: Pass4LineFailure[];
  classification: Pass4Classification;
  evidence: Record<string, unknown>;
}

export interface Pass4Result {
  verdicts: Pass4Verdict[];
}

/**
 * Pass 4 — assert every settlement's lines net to its header, and every
 * payment line's own credit/amount/fee/tax equation holds.
 *
 * Classification: the blueprint's failure conditions are stated in terms of
 * the net-amount residual (1–99 paise → rounding write-off, 100+ → escalate,
 * with failing lines named). A settlement whose net residual is small but
 * whose fee sum, tax sum, or a per-line equation independently fails is
 * still not "balanced" — this implementation treats any such failure as
 * disqualifying ROUNDING_RESIDUAL and falling through to AMOUNT_MISMATCH,
 * since a small net residual next to an internally inconsistent fee or tax
 * sum is not a rounding artifact, it's a different break wearing a small
 * number.
 */
export function runPass4(
  settlements: readonly Settlement[],
  lines: readonly NormalizedSettlementLine[]
): Pass4Result {
  const linesBySettlement = new Map<string, NormalizedSettlementLine[]>();
  for (const line of lines) {
    if (line.settlement_id === null) continue;
    const bucket = linesBySettlement.get(line.settlement_id);
    if (bucket) bucket.push(line);
    else linesBySettlement.set(line.settlement_id, [line]);
  }

  const verdicts: Pass4Verdict[] = settlements.map((settlement) => {
    const settlementLines = linesBySettlement.get(settlement.settlement_id) ?? [];

    let computedNet = 0;
    let computedFees = 0;
    let computedTax = 0;
    const failingLines: Pass4LineFailure[] = [];

    for (const line of settlementLines) {
      computedNet += line.credit_paise - line.debit_paise;
      computedFees += line.fee_paise;
      computedTax += line.tax_paise;

      if (line.type === 'payment') {
        const expectedCredit = line.amount_paise - line.fee_paise - line.tax_paise;
        if (line.credit_paise !== expectedCredit) {
          failingLines.push({
            entity_id: line.entity_id,
            reason: 'credit != amount - fee - tax',
            expected_credit_paise: expectedCredit,
            actual_credit_paise: line.credit_paise,
          });
        }
      }
    }

    const residual = computedNet - settlement.amount_paise;
    const feeResidual = computedFees - settlement.fees_paise;
    const taxResidual = computedTax - settlement.tax_paise;
    const absResidual = Math.abs(residual);
    const otherChecksClean = feeResidual === 0 && taxResidual === 0 && failingLines.length === 0;

    let classification: Pass4Classification;
    if (residual === 0 && otherChecksClean) {
      classification = 'BALANCED';
    } else if (
      absResidual >= ROUNDING_RESIDUAL_MIN_PAISE &&
      absResidual <= ROUNDING_RESIDUAL_MAX_PAISE &&
      otherChecksClean
    ) {
      classification = 'ROUNDING_RESIDUAL';
    } else {
      classification = 'AMOUNT_MISMATCH';
    }

    return {
      settlement_id: settlement.settlement_id,
      computed_net_paise: computedNet,
      header_amount_paise: settlement.amount_paise,
      residual_paise: residual,
      computed_fees_paise: computedFees,
      header_fees_paise: settlement.fees_paise,
      fee_residual_paise: feeResidual,
      computed_tax_paise: computedTax,
      header_tax_paise: settlement.tax_paise,
      tax_residual_paise: taxResidual,
      failing_lines: failingLines,
      classification,
      evidence: {
        key: 'internal_balance',
        computed_net: computedNet,
        header_amount: settlement.amount_paise,
        residual_paise: residual,
        failing_lines: failingLines,
      },
    };
  });

  return { verdicts };
}
