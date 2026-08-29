// Pass 2 — Bank credit ↔ Settlement, by amount + date. SETL_BLUEPRINT.md
// section 10.
//
// Pure function: bank lines and settlements still unlinked after Pass 1 in,
// links out. This pass runs on records that had no usable UTR at all — so
// unlike Pass 1, a "candidate" here is a guess grounded only in amount and
// timing, which is exactly why 2-or-more candidates must refuse rather than
// pick the closer-looking one. A false match is worse than an unresolved one.

import type { NormalizedBankLine } from '../normalize';
import type { Link, Settlement } from '../types';
import { daysBetweenIST } from '../dates';

/** ₹1 tolerance, in paise — the blueprint's own number. */
const AMOUNT_TOLERANCE_PAISE = 100;
/** Bank value_date vs settlement created_at, in either direction. */
const DATE_WINDOW_DAYS = 2;

/** One settlement within window/tolerance of a given bank credit. */
export interface Pass2Candidate {
  settlement_id: string;
  amount_delta_paise: number;
  date_delta_days: number;
}

/**
 * A bank credit with 2+ settlement candidates. Refused, not linked — the
 * blueprint's injected case 13 lands here, and this is the ambiguity the
 * pitch demos: "two candidates → confidence 0.15 → UNRESOLVED."
 */
export interface Pass2AmbiguousMatch {
  bank_line_no: number;
  candidate_count: number;
  candidates: Pass2Candidate[];
  confidence: number;
}

export interface Pass2Result {
  links: Link[];
  ambiguousMatches: Pass2AmbiguousMatch[];
  /** Bank lines with zero candidates — hand to Pass 3. */
  unmatchedBankLines: NormalizedBankLine[];
  /** Settlements not claimed by any link — hand to Pass 3. */
  unmatchedSettlements: Settlement[];
}

/**
 * Pass 2 — match by amount + date when UTR gave nothing to go on.
 *
 * Settlements are consumed at most once: the first bank line to uniquely
 * claim one removes it from the pool for every bank line considered after
 * it. Bank lines are processed in their given order, so which credit gets
 * first claim on a settlement is deterministic (input order), not a race.
 */
export function runPass2(
  bankLines: readonly NormalizedBankLine[],
  settlements: readonly Settlement[]
): Pass2Result {
  const links: Link[] = [];
  const ambiguousMatches: Pass2AmbiguousMatch[] = [];
  const unmatchedBankLines: NormalizedBankLine[] = [];
  const claimedSettlementIds = new Set<string>();

  for (const bank of bankLines) {
    const candidates = settlements.filter((s) => {
      if (claimedSettlementIds.has(s.settlement_id)) return false;
      const dateDelta = Math.abs(daysBetweenIST(s.created_at, bank.value_date));
      if (dateDelta > DATE_WINDOW_DAYS) return false;
      const amountDelta = Math.abs(bank.credit_paise - s.amount_paise);
      return amountDelta <= AMOUNT_TOLERANCE_PAISE;
    });

    if (candidates.length === 0) {
      unmatchedBankLines.push(bank);
      continue;
    }

    if (candidates.length === 1) {
      const settlement = candidates[0];
      const amountDelta = bank.credit_paise - settlement.amount_paise;
      const dateDelta = daysBetweenIST(settlement.created_at, bank.value_date);
      links.push({
        left_source: 'bank',
        left_id: String(bank.line_no),
        right_source: 'settlement',
        right_id: settlement.settlement_id,
        relation: 'bank_to_settlement',
        pass: 2,
        confidence: amountDelta === 0 ? 0.85 : 0.75,
        evidence: {
          key: 'amount_date',
          amount_delta: amountDelta,
          date_delta_days: dateDelta,
          candidate_count: 1,
        },
      });
      claimedSettlementIds.add(settlement.settlement_id);
      continue;
    }

    // 2+ candidates: refuse. Emit every candidate as evidence rather than
    // picking the closer-looking one.
    const candidateEvidence: Pass2Candidate[] = candidates.map((s) => ({
      settlement_id: s.settlement_id,
      amount_delta_paise: bank.credit_paise - s.amount_paise,
      date_delta_days: daysBetweenIST(s.created_at, bank.value_date),
    }));
    ambiguousMatches.push({
      bank_line_no: bank.line_no,
      candidate_count: candidates.length,
      candidates: candidateEvidence,
      confidence: 0.3 / candidates.length,
    });
    unmatchedBankLines.push(bank);
    // None of the tied settlements are claimed — they stay in the pool.
  }

  const unmatchedSettlements = settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id));

  return { links, ambiguousMatches, unmatchedBankLines, unmatchedSettlements };
}
