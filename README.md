# SETL — Three-Way Settlement Reconciliation

**Razorpay Buildathon 2026 · Track 04 · AI Finance Controller**

One finance associate at a ₹2–20cr/month D2C merchant spends 5–10h/month proving a single lump payout (e.g. ₹2,84,193 covering 300 orders) is correct. Razorpay collects ₹1,000, deducts MDR (2% = ₹20) + 18% GST on MDR (₹3.60) → merchant gets ₹976.40. Multiply by 300 orders + refunds + disputes, and one bank credit hides 300 orders' fees, taxes and refunds. SETL closes the loop.

**Razorpay knows A↔B (orders vs settlements) but is blind to C (bank). SETL reconciles A↔B↔C.**

> 300-record synthetic batch with grounded truth · held-out batch (different merchant/bank/rate card) · honest unresolved list · low false-match > high match rate.

---

## Reproduce in 30 seconds — no database, no API key

```bash
git clone https://github.com/manushree-k/SETL.git
cd SETL
npm install
npm run evaluate   # works with LLM_ENABLED=false and no DATABASE_URL
cat REPORT.md
```

`REPORT.md` is **generated**, not hand-typed. Every number is computed from `data/main/` and `data/holdout/` via the pure deterministic engine (`lib/engine/run.ts:reconcile()`).

- `main` (tuning): 99.70% match (333/334), 2.06% false-match, 14/15 settlements FULLY_RECONCILED
- `holdout` (headline, different seed/merchant/bank/flat-fee tier): 99.59% match (241/242), 2.81% false-match, 14/15 FULLY_RECONCILED
- All 5 conservation identities (C1–C5) hold; composition coverage 100%

`npm run evaluate` is offline: it reads CSVs, runs Pass 0 + `reconcile()` in memory, and scores against `ground_truth.json` — no `DATABASE_URL`, no `LLM_API_KEY`, no migration.

## Composition — the spine of the product

Reconciliation asks *does it tie?* Composition asks *what is it made of?* A merchant whose payout ties still needs the ladder to post revenue vs fee expense vs GST reclaim vs refunds.

```
Gross payments                 ₹1,00,000.00
− Razorpay fees                   ₹2,000.00
− GST on fees                       ₹360.00
− Refunds                         ₹1,000.00
− Disputes / holds                    ₹0.00
± Adjustments                        ₹0.00
────────────────────────────────────────────
Expected payout                  ₹96,640.00
Bank received                    ₹96,640.00
Difference                            ₹0.00   ✓ FULLY_RECONCILED
```

Computed **once** by `lib/engine/pass6b-compose.ts` and persisted to `settlement_composition` (1 row/settlement, 9 values + `status` + `discrepancy_component`). UI renders stored values — zero arithmetic on money in components. `UNATTRIBUTED` when no bucket accounts for a difference: guessing the bucket is the same failure as guessing a match.

Per-line signed `contribution` (payment `amount−fee−GST`, refund `−debit`, …) sums exactly to `expected_payout` (identity B, asserted at runtime).

## Architecture

```
Next.js 15 App Router · TypeScript 5 (branded Paise type) · Tailwind 4 + shadcn/ui
Postgres (Neon free) via postgres.js tagged templates · Vitest
No Docker/Prisma/LangChain/queues — 300 records reconcile in 4–9 ms (71–120k rec/s)
```

- **Money**: branded `Paise = number & {paiseBrand}` (`lib/money.ts`), `parseMoney` via `BigInt`, `roundHalfUp(numer, denom)` integer-only, DB `BIGINT` paise. No `parseFloat`, no floats on money.
- **Determinism**: `reconcile()` is pure (`orders, settlements, lines, bankLines → links, exceptions, compositions`). LLM never computes — it parses narration (regex fallback) and writes 2-sentence prose from a pre-formatted evidence bundle, verified by `lib/ai/numberGuard.ts`.
- **13-stage pipeline**: validate → normalize (₹→paise, IST cycle) → P1 UTR exact → P2 amount+date → P3 subset-sum (pool ≤12, k≤4) → P4 balance → P6 fee audit (vs rate card) → P6B composition → classify (15 classes) → confidence → decide (AUTO/REVIEW/UNRESOLVED, thresholds swept via `sweepThresholds.ts`, frozen `0.86/0.86`) → LLM explain → metrics → audit.

See `SETL_BLUEPRINT.md` (full spec), `docs/ARCHITECTURE.md`, `FAILURES.md` (what broke and how it was fixed — updated as it happened).

## Data

- `scripts/generate.ts` — seeded `mulberry32`, lognormal-ish amounts, 14 injected cases (exact, timing, refund-netted, partial, split, aggregated, duplicate, missing, dispute, rounding 1–99p, fee overcharge, opaque adjustment, ambiguous, corrupted narration)
- `data/main/` — 300 main (kiranakart: UPI 55%, 90/200 bps cards) + `data/holdout/` — 300 holdout (bombayweave: card 60%, 8% international, ₹12 flat netbanking — adversarial tier)
- `ground_truth.json` — `is_resolvable`, `expected_class`, `expected_link_ids`

```bash
npm run generate -- --seed 20260827 --profile kiranakart --out data/main
npm run generate -- --seed 771144 --profile bombayweave --out data/holdout
```

Byte-identical CSVs on same seed (tested in `tests/generator.test.ts`).

## Run with a database (Neon free)

```bash
cp .env.example .env.local
# set DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
# set LLM_ENABLED=false (or true + LLM_API_KEY + LLM_MODEL)
npm run migrate
npm run seed -- --batch main
npm run seed -- --batch holdout
npm run dev   # http://localhost:3000  — Overview with drill-down, Run, Exception queue, Investigation
```

`lib/env.ts` and `lib/db.ts` are now lazy — `next build` and `npm run evaluate` no longer require `DATABASE_URL` at import time.

## Deploy for free

| Need | Free tier | Env vars on Vercel |
|---|---|---|
| Postgres | Neon free (0.5GB, sleeps) | `DATABASE_URL` |
| Hosting | Vercel Hobby (`git push` deploys) | `LLM_ENABLED`, `LLM_MODEL`, `LLM_API_KEY` |
| LLM | Anthropic $5 free / Gemini Flash free — or `LLM_ENABLED=false` | — |
| Repo | GitHub public | — |

`npm run build` must pass with `LLM_ENABLED=false` and no DB (now does). `config/thresholds.json` is bundled via static import so Vercel never falls back to placeholder 0.9/0.5.

## Docs

- `SETL_BLUEPRINT.md` — implementation plan (sections 1–19)
- `docs/threshold-selection-notes.md` — why `t_auto = t_review = 0.86` gives an empty confidence band but a non-empty review queue (class gate)
- `FAILURES.md` — 10 honest failures, including shared-credit prorating and partial-settlement classifier now fixed
- `REPORT.md` — generated headline numbers for both batches

## Trade-offs & cuts

Exceeding the 50-record floor (we do 300) reads better than pretending the floor was 300. Held-out is measured once/day — tuning against it stops being held-out.

Cut first: ML model, grounded Q&A, live Razorpay API, threshold charts, CSV export. Those live in `README → Future Scope` for free.

Auth/multi-tenant/second gateway/webhooks/Docker/ORM/queues are out — 300 records don't need them.
