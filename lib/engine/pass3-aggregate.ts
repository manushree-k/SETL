// Pass 3 — Aggregation and splits (subset-sum). SETL_BLUEPRINT.md section 10.
//
// Pure function: bank lines and settlements still unlinked after Passes 1–2
// in, links out. Two mirror-image directions — one bank credit covering N
// settlements, and one settlement paid as N bank credits — each solved by a
// capped, pruned DFS rather than anything approximate. An exact subset that
// isn't unique is refused, not chosen between: guessing which combination is
// "the" match is the same failure this whole engine exists to avoid.

import type { NormalizedBankLine } from '../normalize';
import type { Link, Settlement } from '../types';
import { daysBetweenIST } from '../dates';

const POOL_CAP = 12;
const SUBSET_SIZE_CAP = 4;

export type Pass3Direction = 'many_settlements_one_credit' | 'many_credits_one_settlement';

/** A target (bank credit or settlement) with 0, or 2+, subsets summing to it. */
export interface Pass3Ambiguity {
  direction: Pass3Direction;
  /** bank line_no for direction (a), settlement_id for direction (b). */
  target_id: string;
  target_amount_paise: number;
  /** 0 = no subset found; >1 = more than one distinct subset found. */
  alternatives_found: number;
}

export interface Pass3Result {
  links: Link[];
  ambiguities: Pass3Ambiguity[];
  unmatchedBankLines: NormalizedBankLine[];
  unmatchedSettlements: Settlement[];
}

/** One item generic enough to be either a bank line or a settlement. */
interface PoolItem<T> {
  id: string;
  amount_paise: number;
  date: Date;
  record: T;
}

/**
 * Find every subset of `pool` (size 1..SUBSET_SIZE_CAP) summing exactly to
 * `target`, stopping as soon as a second distinct subset is found — the
 * caller only needs to know "unique", "none", or "more than one", never
 * the full list of alternatives.
 *
 * DFS over indices with the pool pre-sorted descending: a branch is
 * abandoned the moment its running sum exceeds the target, which is what
 * keeps this fast (the blueprint's own bound: C(12,4) = 495 worst case).
 */
function findExactSubsets<T>(pool: readonly PoolItem<T>[], target: number): PoolItem<T>[][] {
  const sorted = [...pool].sort((a, b) => b.amount_paise - a.amount_paise);
  const found: PoolItem<T>[][] = [];

  function dfs(startIndex: number, remaining: number, chosen: PoolItem<T>[]): void {
    if (found.length > 1) return; // already know it's ambiguous — stop searching
    if (remaining === 0 && chosen.length > 0) {
      found.push([...chosen]);
      return;
    }
    if (chosen.length >= SUBSET_SIZE_CAP) return;

    for (let i = startIndex; i < sorted.length; i++) {
      const item = sorted[i];
      if (item.amount_paise > remaining) continue; // would overshoot; sorted descending, keep scanning smaller ones
      chosen.push(item);
      dfs(i + 1, remaining - item.amount_paise, chosen);
      chosen.pop();
      if (found.length > 1) return;
    }
  }

  dfs(0, target, []);
  return found;
}

function withinPoolCap<T>(items: PoolItem<T>[]): PoolItem<T>[] {
  return items.slice(0, POOL_CAP);
}

/**
 * Pass 3 — subset-sum aggregation, both directions.
 *
 * Direction (a) runs first and removes any settlements it resolves from the
 * pool; direction (b) then runs on what remains, so a settlement or bank
 * line already consumed by one direction cannot also be claimed by the
 * other.
 */
export function runPass3(
  bankLines: readonly NormalizedBankLine[],
  settlements: readonly Settlement[]
): Pass3Result {
  const links: Link[] = [];
  const ambiguities: Pass3Ambiguity[] = [];

  const claimedBankLineNos = new Set<number>();
  const claimedSettlementIds = new Set<string>();
  // A bank credit direction (a) found genuinely ambiguous between two or
  // more settlements. It must not also be treated as "the" unique credit
  // for any one settlement in direction (b) — that would silently resolve
  // the exact ambiguity direction (a) just refused to guess through, via
  // the other direction's search instead. See pass3-aggregate.ts's own
  // "Could go wrong" case: two ₹500 settlements, one ₹500 unattributed
  // credit — direction (a) correctly refuses; without this exclusion,
  // direction (b) would then find that same credit "uniquely" matches
  // whichever settlement happens to be considered first.
  const ambiguousBankLineNos = new Set<number>();

  // --- Direction (a): one bank credit covers N settlements ------------------
  for (const bank of bankLines) {
    const pool = withinPoolCap(
      settlements
        .filter((s) => !claimedSettlementIds.has(s.settlement_id))
        .filter((s) => Math.abs(daysBetweenIST(s.created_at, bank.value_date)) <= 2)
        .map((s): PoolItem<Settlement> => ({
          id: s.settlement_id,
          amount_paise: s.amount_paise,
          date: s.created_at,
          record: s,
        }))
    );

    const subsets = findExactSubsets(pool, bank.credit_paise);

    if (subsets.length === 1) {
      const members = subsets[0];
      for (const member of members) {
        links.push({
          left_source: 'bank',
          left_id: String(bank.line_no),
          right_source: 'settlement',
          right_id: member.id,
          relation: 'bank_to_settlement',
          pass: 3,
          confidence: 0.9,
          evidence: {
            key: 'subset_sum',
            direction: 'many_settlements_one_credit',
            members: members.map((m) => m.id),
            subset_size: members.length,
            alternatives_found: 0,
          },
        });
        claimedSettlementIds.add(member.id);
      }
      claimedBankLineNos.add(bank.line_no);
    } else if (subsets.length > 1) {
      ambiguities.push({
        direction: 'many_settlements_one_credit',
        target_id: String(bank.line_no),
        target_amount_paise: bank.credit_paise,
        alternatives_found: subsets.length,
      });
      ambiguousBankLineNos.add(bank.line_no);
    }
    // subsets.length === 0: no match here, leave for the caller's unmatched list.
  }

  // --- Direction (b): one settlement paid as N bank credits ------------------
  for (const settlement of settlements) {
    if (claimedSettlementIds.has(settlement.settlement_id)) continue;

    const pool = withinPoolCap(
      bankLines
        .filter((b) => !claimedBankLineNos.has(b.line_no) && !ambiguousBankLineNos.has(b.line_no))
        .filter((b) => Math.abs(daysBetweenIST(settlement.created_at, b.value_date)) <= 2)
        .map((b): PoolItem<NormalizedBankLine> => ({
          id: String(b.line_no),
          amount_paise: b.credit_paise,
          date: b.value_date,
          record: b,
        }))
    );

    const subsets = findExactSubsets(pool, settlement.amount_paise);

    if (subsets.length === 1) {
      const members = subsets[0];
      for (const member of members) {
        links.push({
          left_source: 'bank',
          left_id: member.id,
          right_source: 'settlement',
          right_id: settlement.settlement_id,
          relation: 'bank_to_settlement',
          pass: 3,
          confidence: 0.9,
          evidence: {
            key: 'subset_sum',
            direction: 'many_credits_one_settlement',
            members: members.map((m) => m.id),
            subset_size: members.length,
            alternatives_found: 0,
          },
        });
        claimedBankLineNos.add(Number(member.id));
      }
      claimedSettlementIds.add(settlement.settlement_id);
    } else if (subsets.length > 1) {
      ambiguities.push({
        direction: 'many_credits_one_settlement',
        target_id: settlement.settlement_id,
        target_amount_paise: settlement.amount_paise,
        alternatives_found: subsets.length,
      });
    }
  }

  const unmatchedBankLines = bankLines.filter((b) => !claimedBankLineNos.has(b.line_no));
  const unmatchedSettlements = settlements.filter((s) => !claimedSettlementIds.has(s.settlement_id));

  return { links, ambiguities, unmatchedBankLines, unmatchedSettlements };
}
