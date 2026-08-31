# Threshold selection — the empty review band

`scripts/sweepThresholds.ts` (SETL_BLUEPRINT.md section 12) froze `t_auto = t_review = 0.86` on the main batch on 2026-08-31. Because the two values are equal, the `NEEDS_REVIEW` band — confidence in `[t_review, t_auto)` — is mathematically empty: every link is either `AUTO_RESOLVED` (≥ 0.86) or `UNRESOLVED` (< 0.86), with nothing landing in between. This is worth a dedicated note because it looks like a bug at a glance and isn't one.

## Why it happens

The selection rule picks the **highest** `t_review` in `[0.30, t_auto]` at which correct-refusal-rate reaches 90% (see `scripts/sweepThresholds.ts`'s own header comment for why the search is bounded to `t_auto` rather than the full 0.30–1.00 range). On the main batch, correct-refusal-rate over the 8 genuinely-unresolvable-by-design ground-truth records is a step function, not a smooth curve:

- 5 of the 8 have **no link at all** (Passes 2/3 refuse an ambiguous or unmatched case outright, so there's nothing to threshold) — these count as correctly refused at *every* `t_review` value, including `0.30`.
- The other 3 all sit at confidence **exactly 0.85** — not a coincidence, but a discrete tier: Pass 2's unique amount+date match (`lib/engine/pass2-amountDate.ts`) is a hardcoded constant, `0.85`, not a continuous score.

So correct-refusal-rate is `5/8 = 62.5%` for every `t_review` from `0.30` up to `0.85`, then jumps straight to `8/8 = 100%` at `t_review = 0.86` — the one-hundredth of a point that clears Pass 2's fixed tier. `0.86` is the only value in `[0.30, 0.86]` (the search range, since `t_auto` itself came out to `0.86`) that reaches the 90% floor at all, so it's simultaneously the *lowest* and *highest* value that qualifies. The rule asks for the highest — it just happens to have exactly one candidate.

## Confirmed on holdout, not a main-only artifact

Re-running the same analysis against the holdout batch (not part of the sweep itself, which by design tunes on main only — this was a manual cross-check) shows the **identical structure**:

- Also exactly 8 genuinely-unresolvable-by-design records.
- Also splits 5-at-confidence-0 / 3-at-confidence-exactly-0.85.
- Also reaches 100% correct-refusal-rate only at `t_review = 0.86`, for the same reason (Pass 2's fixed 0.85 tier).

This means the empty band is a structural consequence of the confidence formula's discrete tiers (1.00, 0.95, 0.90, 0.85, 0.75, 0.30/n, ...) colliding with a 90% floor and a small unresolvable population — not an overfit quirk of main's particular 8 records. It generalizes.

## The band isn't inherently empty — proof

To confirm this is about the *selection rule's* interaction with the data, not "there's no middle ground at all": applying the old placeholder `t_review = 0.5` to holdout's actual links puts **5 of 249 links (2%)** into `[0.5, 0.86)` — a real, non-empty review queue would exist at that threshold. The band only vanishes because `0.86` is the specific value the 90%-floor rule demands, and it happens to coincide with `t_auto`.

## What this means operationally — corrected

The "empty band" describes the pure `[t_review, t_auto)` **confidence interval** the sweep itself measures, over links — and that interval genuinely is empty when the two are equal. It does NOT mean the review queue is empty. Checked directly against `scripts/evaluate.ts`'s output after refreshing with the frozen thresholds:

```
main:    reviewQueueSize = 12   (DISPUTE_HOLD @ 1.0 ×10, AMOUNT_MISMATCH @ 0.95 ×2)
holdout: reviewQueueSize = 4
```

The reason: `lib/engine/decide.ts`'s decision has **two independent gates**, not one — `AUTO_RESOLVED` requires both `confidence >= t_auto` *and* the exception class being in `AUTO_RESOLVE_ELIGIBLE` (section 11's "Auto-resolve: Yes" rows). `DISPUTE_HOLD` and `AMOUNT_MISMATCH` are never eligible, however high their confidence — so a `DISPUTE_HOLD` at confidence `1.0` still fails the eligibility gate, falls through to the `confidence >= t_review` check, and lands in `NEEDS_REVIEW` regardless of the empty confidence *band*. Class-ineligible-but-high-confidence records are exactly what keeps the review queue populated when `t_auto == t_review`.

So the accurate statement is: with the frozen thresholds, a record reaches `NEEDS_REVIEW` only through the class-eligibility gate, never through sitting in the confidence band itself (since that band has no width) — and that's still a legitimate, cross-validated outcome of the selection rule as specified, not a bug in `sweepThresholds.ts` or `decide.ts`.
