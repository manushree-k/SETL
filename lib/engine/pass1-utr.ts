// Pass 1 — Bank credit ↔ Settlement, by UTR. SETL_BLUEPRINT.md section 10.
//
// Pure function: normalized bank lines and settlements in, links out. No
// database writes, no AI — this file never sees an LLM. The only judgement
// call it makes is exact-match-or-refuse; anything less than certain gets
// handed forward to Pass 2/3 rather than guessed at here.

import type { NormalizedBankLine } from '../normalize';
import type { Link, Settlement } from '../types';
import type { Paise } from '../money';

/**
 * A bank line whose UTR exactly matches a settlement's UTR, but the amounts
 * disagree. Blueprint: "do not link at full confidence... hand to Pass 3
 * (it may be a split)." Both records still flow forward as unmatched; this
 * record is the evidence trail explaining why they were held back rather
 * than linked outright.
 */
export interface UtrAmountMismatch {
  bank_line_no: number;
  settlement_id: string;
  utr: string;
  bank_credit_paise: Paise;
  settlement_amount_paise: Paise;
  amount_delta_paise: number;
}

/** The second (and later) bank line sharing a UTR already claimed by another. */
export interface DuplicateCreditFlag {
  bank_line_no: number;
  first_bank_line_no: number;
  utr: string;
  bank_credit_paise: Paise;
}

export interface Pass1Result {
  links: Link[];
  duplicateCredits: DuplicateCreditFlag[];
  utrAmountMismatches: UtrAmountMismatch[];
  /** Bank lines to hand to Pass 2 — no UTR, no unique UTR match, or ambiguous. */
  unmatchedBankLines: NormalizedBankLine[];
  /** Settlements to hand to Pass 2. */
  unmatchedSettlements: Settlement[];
}

/** Uppercase, alphanumeric-only — the normalized form a UTR is compared in. */
function normalizeUtr(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/**
 * Pass 1 — exact UTR match between bank credits and settlements.
 *
 * Bank lines with no parsed UTR are not this pass's concern at all; they
 * pass through untouched, for Pass 2 to try on amount + date instead.
 */
export function runPass1(
  bankLines: readonly NormalizedBankLine[],
  settlements: readonly Settlement[]
): Pass1Result {
  const links: Link[] = [];
  const duplicateCredits: DuplicateCreditFlag[] = [];
  const utrAmountMismatches: UtrAmountMismatch[] = [];
  const unmatchedBankLines: NormalizedBankLine[] = [];

  // Settlements are consumed at most once each; track which have been
  // claimed by a link so a second bank line cannot also claim them.
  const claimedSettlementIds = new Set<string>();

  // Index settlements by normalized UTR. A given normalized UTR should be
  // unique in a real settlement report; if the synthetic data ever produces
  // a collision, that is exactly the kind of ambiguity this system refuses
  // to guess through — such a UTR is treated as having no usable match here.
  const settlementsByUtr = new Map<string, Settlement[]>();
  for (const s of settlements) {
    const key = normalizeUtr(s.utr_number);
    const bucket = settlementsByUtr.get(key);
    if (bucket) bucket.push(s);
    else settlementsByUtr.set(key, [s]);
  }

  // First occurrence of each normalized bank UTR wins the right to attempt
  // a match; every later bank line sharing that UTR is a duplicate credit,
  // flagged and excluded from matching entirely (not carried to Pass 2/3 —
  // the blueprint's "keep the first, flag the second" is a terminal call).
  const firstBankLineForUtr = new Map<string, NormalizedBankLine>();

  for (const bank of bankLines) {
    if (bank.parsed_utr === null) {
      unmatchedBankLines.push(bank);
      continue;
    }

    const key = normalizeUtr(bank.parsed_utr);
    const first = firstBankLineForUtr.get(key);
    if (first !== undefined) {
      duplicateCredits.push({
        bank_line_no: bank.line_no,
        first_bank_line_no: first.line_no,
        utr: key,
        bank_credit_paise: bank.credit_paise,
      });
      continue;
    }
    firstBankLineForUtr.set(key, bank);

    const candidates = settlementsByUtr.get(key) ?? [];
    if (candidates.length !== 1) {
      // No settlement with this UTR, or an unresolvable collision between
      // settlements sharing one UTR — either way, not this pass's job.
      unmatchedBankLines.push(bank);
      continue;
    }

    const settlement = candidates[0];
    if (settlement.amount_paise === bank.credit_paise) {
      links.push({
        left_source: 'bank',
        left_id: String(bank.line_no),
        right_source: 'settlement',
        right_id: settlement.settlement_id,
        relation: 'bank_to_settlement',
        pass: 1,
        confidence: 1.0,
        evidence: {
          key: 'utr_exact',
          utr: key,
          bank_credit: bank.credit_paise,
          settlement_amount: settlement.amount_paise,
          amount_delta: 0,
        },
      });
      claimedSettlementIds.add(settlement.settlement_id);
    } else {
      // UTR matches, amount does not — do not link at full confidence.
      // Record the mismatch as evidence and hand both records forward.
      utrAmountMismatches.push({
        bank_line_no: bank.line_no,
        settlement_id: settlement.settlement_id,
        utr: key,
        bank_credit_paise: bank.credit_paise,
        settlement_amount_paise: settlement.amount_paise,
        amount_delta_paise: bank.credit_paise - settlement.amount_paise,
      });
      unmatchedBankLines.push(bank);
      // Settlement is left unclaimed so it flows to unmatchedSettlements below.
    }
  }

  const unmatchedSettlements = settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id));

  return { links, duplicateCredits, utrAmountMismatches, unmatchedBankLines, unmatchedSettlements };
}
