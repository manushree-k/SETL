# Architecture — SETL

Pure engine + thin UI. See `SETL_BLUEPRINT.md` §5–6, §10 for the full plan.

## Layers

```
CSV (data/main, data/holdout) → lib/normalize (P0) → lib/engine (P1–6B) → lib/metrics → REPORT.md
                                    ↓
                               lib/db.ts → Postgres (Neon free) → app/api → app/* (Next 15 App Router)
                                    ↓
                               lib/ai (LLM_ENABLED=false still fully correct)
```

- **Deterministic core** `lib/engine/run.ts:reconcile()` — pure function, no DB/IO, ~10k ops for 300 records, 4–9 ms.
- **Money** `lib/money.ts` — branded `Paise`, `BigInt` parsing, `roundHalfUp(numer,denom)` integer division, no floats.
- **Composition** `lib/engine/pass6b-compose.ts` — 1 row/settlement, 6 buckets, per-line `contribution`, identities A/B throw.
- **Classification** `lib/engine/classify.ts` — 15 classes + INVALID_ROW, PARTIAL_SETTLEMENT halves detected via group sum == order amount, opaque adjustments → AMOUNT_MISMATCH.
- **Shared-credit prorating** — 1 bank credit → N settlements prorated by header amount, remainder distributed deterministically (largest settlement first).
- **Thresholds** `lib/engine/decide.ts` — static import of `config/thresholds.json` (bundled for Vercel), validated `0.3 ≤ t_review ≤ t_auto ≤ 1`.

## API routes (8)

- `POST /api/runs` {batch: main|holdout} → runs reconciliation
- `GET /api/runs` → 20 latest
- `GET /api/runs/:id` → run + metrics + compositions
- `GET /api/runs/:id/settlements` → compositions + linesBySettlement (single payload, drill-down needs no second fetch)
- `GET /api/runs/:id/records` → orders/lines/bank paginated
- `GET /api/exceptions?runId=&decision=&class=&minAmount=&q=&page=&limit=` → filtered, default UNRESOLVED+NEEDS_REVIEW
- `GET /api/exceptions/:id` → exception + composition+lines inline
- `POST /api/exceptions/:id/explain` → LLM 2–3 sentences, number-guarded

All SQL via `postgres.js` tagged templates, never concatenated. Env is lazy (`lib/env.ts` getters) so `next build` needs no `DATABASE_URL`.

## UI (4 screens, one-level drill-down)

- **Overview** `app/page.tsx` — 6 metric cards (3×2), run-level ladder, settlements table (default |diff| desc) with expandable `SettlementBreakdown` + `CompositionTable` (Σ contribution ✓). No arithmetic on money in components.
- **Run** `app/run/page.tsx` — batch selector, counts, single “Reconcile 300” button.
- **Exceptions** `app/exceptions/page.tsx` — filters (decision/class/minAmount/q), 25/page, default UNRESOLVED+NEEDS_REVIEW.
- **Investigation** `app/exceptions/[id]/page.tsx` — 9 sections: what happened, ladder (failing bucket highlighted), drill-down, evidence, how decided, AI (on-demand), competing candidates, why unresolved, next action.

Reuses `SettlementBreakdown` + `CompositionTable` across Overview and Investigation — never two versions.

## Free infra

Neon (0.5GB, sleeps, `max:1` pool) + Vercel Hobby + GitHub + LLM optional. `npm run evaluate` reproduces headline numbers with zero infra.
