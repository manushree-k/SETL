# SETL — Claude Code Prompt Sequence

Run these **in order**. One prompt = one milestone = one commit.

**Before every prompt:** `git status` must be clean. If it is not, commit or discard first. That way `git reset --hard HEAD` always rescues you.

**After every prompt:** run the verification command. If the output does not match, paste the error back to Claude Code once. If it is still broken after the second attempt, `git reset --hard HEAD` and re-run the prompt with tighter file scope.

---

## Prompt 01 — Project setup

**Paste:**
> Create a new Next.js 15 project in the current directory using the App Router and TypeScript, with Tailwind CSS and ESLint. Use the `src`-less layout (app/ at the root). Then set up the folder skeleton from CLAUDE.md: `lib/`, `lib/engine/`, `lib/ai/`, `lib/normalize/`, `lib/metrics/`, `components/`, `scripts/`, `data/main/`, `data/holdout/`, `data/results/`, `db/`, `tests/`, `docs/`. Put a `.gitkeep` in each empty directory. Install `postgres`, `vitest`, `@vitejs/plugin-react`, and `tsx` as dev dependencies. Add npm scripts: `generate`, `seed`, `evaluate`, `sweep`, `test`, `migrate`. Point them at `scripts/*.ts` files that do not exist yet — they will fail, that is expected. Do not write any application logic. Show me the final package.json before you finish.

**May create/modify:** everything (fresh project)
**Must not modify:** n/a
**Accomplishes:** runnable Next.js app + the exact folder shape everything else assumes
**Run:** `npm run dev` then open http://localhost:3000
**Expect:** the default Next.js page renders, no errors in the terminal
**Commit:** `chore: initialize project`
**Could go wrong:** Claude Code may create a `src/` directory. Tell it to move `app/` to the root — every path in the blueprint assumes no `src/`.

---

## Prompt 02 — Environment, git safety, CLAUDE.md

**Paste:**
> Create `.gitignore` covering: node_modules, .next, .env, .env.local, .env*.local, *.log, .DS_Store, data/results/. Create `.env.example` containing only the variable NAMES with empty values: DATABASE_URL, LLM_API_KEY, LLM_MODEL, LLM_ENABLED. Create an empty `.env.local` with the same keys. Create `FAILURES.md` with a heading and a table with columns Date, What broke, Root cause, Fix, Time lost. Create `lib/env.ts` that reads and validates environment variables at startup and throws a clear error naming the missing variable. Never log or return the values of LLM_API_KEY or DATABASE_URL anywhere. Do not touch any other file.

**May create/modify:** `.gitignore`, `.env.example`, `.env.local`, `FAILURES.md`, `lib/env.ts`
**Must not modify:** `app/`, `package.json`
**Accomplishes:** secrets can never be committed; missing config fails loudly
**Run:** `git status` — `.env.local` must NOT appear in the list
**Expect:** `.env.local` absent from git status output
**Commit:** `chore: configure environment and gitignore`
**Could go wrong:** if `.env.local` shows in git status, `.gitignore` is wrong or the file was staged earlier. Fix before continuing — after a push it is too late.

---

## Prompt 03 — Database schema + money/date primitives

**Paste:**
> Read the schema in SETL_BLUEPRINT.md section 6 and write it to `db/schema.sql`: tables runs, orders, settlements, settlement_lines, bank_lines, links, exceptions, audit_log, run_metrics, llm_calls. All money columns are BIGINT storing paise. All timestamps TIMESTAMPTZ. Include the primary keys, foreign keys and indexes listed in the blueprint. Then write `db/migrate.ts` which connects using DATABASE_URL and executes schema.sql idempotently (DROP TABLE IF EXISTS then CREATE). Then write `lib/db.ts` exporting a single postgres.js client. Then write `lib/money.ts` with: a `Paise` branded number type, `parseMoney(s: string): Paise` that throws on more than 2 decimal places, `formatPaise(p: Paise): string` producing Indian-format `₹1,00,000.00`, and `roundHalfUp(numerator, denominator)` using integer arithmetic only. Then `lib/dates.ts` with IST parsing, `addBusinessDays(date, n)` skipping weekends and a HOLIDAYS array, and `settlementCycleDate(captureDate)` = capture + 2 business days. No floating-point arithmetic anywhere in money.ts. Explain your rounding implementation before writing it.

**May create/modify:** `db/schema.sql`, `db/migrate.ts`, `lib/db.ts`, `lib/money.ts`, `lib/dates.ts`, `lib/types.ts`
**Must not modify:** `app/`, `components/`
**Accomplishes:** the financial foundation everything else sits on
**Run:** `npm run migrate` then `npx tsx -e "import {parseMoney,formatPaise} from './lib/money'; console.log(formatPaise(parseMoney('₹1,00,000.00')))"`
**Expect:** migrate reports 10 tables created; the one-liner prints `₹1,00,000.00`
**Commit:** `feat: add database schema and money primitives`
**Could go wrong:** Claude Code may reach for `Math.round` or floats. If you see `parseFloat` or `/` on money anywhere in money.ts, reject it and say "integer arithmetic only, show me roundHalfUp again."

---

## Prompt 04 — Synthetic data generator (main batch)

**Paste:**
> Write `scripts/generate.ts`. It takes `--seed`, `--profile` and `--out` CLI arguments. Use a mulberry32 seeded PRNG — never Math.random. Read SETL_BLUEPRINT.md sections 7 and 8 for the exact field schemas, the generation order, the amount distribution, the rate card and the 14 injected cases. Generate in causal order: profile → orders → payments → fees/GST from the rate card → refunds → disputes → adjustments → settlement batching on T+2 business days → bank credit lines with narration templates → then inject the anomalies as mutations on the clean output. Write orders.csv, settlements.csv, settlement_lines.csv and bank_statement.csv to the --out directory. Do not write ground truth yet, that is the next prompt. All money is integer paise. Use the 14 narration templates from the blueprint, and make at least three of them defeat a naive regex. Build this one section at a time and show me each section before moving on.

**May create/modify:** `scripts/generate.ts`, `lib/rateCard.ts`, `lib/types.ts`
**Must not modify:** `lib/money.ts`, `lib/dates.ts`, `db/`
**Accomplishes:** the 300-record main batch
**Run:** `npm run generate -- --seed 20260827 --profile kiranakart --out data/main`
**Expect:** four CSVs in `data/main/`, roughly 300 records total across sources, `wc -l data/main/*.csv` shows sensible counts
**Commit:** `feat: add synthetic data generator`
**Could go wrong:** amounts come out uniformly distributed. Check by eye — if every order is a random number between 100 and 100000, tell it to use the lognormal mixture and realistic price points from the blueprint.

---

## Prompt 05 — Ground truth emission

**Paste:**
> Extend `scripts/generate.ts` to emit `ground_truth.json` in the --out directory, using the exact shape in SETL_BLUEPRINT.md section 7. Every injected anomaly must record its own ground-truth entry at the moment it is injected — do not reconstruct ground truth afterwards by re-analysing the CSVs. Each record entry needs record_id, source, injected_case, expected_link_ids, expected_class, expected_decision, is_resolvable and expected_reason. Cases 8 (missing in bank), 13 (ambiguous) and 14 (corrupted narration) must have is_resolvable false. Also emit the totals block. Then add a determinism check: running the generator twice with the same seed must produce byte-identical files. Write `tests/generator.test.ts` asserting that.

**May create/modify:** `scripts/generate.ts`, `tests/generator.test.ts`
**Must not modify:** anything else
**Accomplishes:** ground truth exists, and it is trustworthy because it is recorded at injection time
**Run:** `npm run generate -- --seed 20260827 --profile kiranakart --out data/main && npm run test -- generator`
**Expect:** `ground_truth.json` present; `totals.unresolvable_by_design` is around 14; determinism test passes
**Commit:** `feat: add ground truth emission`
**Could go wrong:** if it reconstructs ground truth by analysing the CSVs, the ground truth inherits any bug in the analysis. Insist on recording at injection time.

---

## Prompt 06 — Held-out batch + seeding

**Paste:**
> Add a second merchant profile `bombayweave` to the generator, differing on all six axes in SETL_BLUEPRINT.md section 9: different seed, apparel merchant with higher order values and a much higher refund rate, card-heavy method mix with 8% international, a completely different set of 14 bank narration templates in an ICICI/Axis style with ref_no blank more often, a rate card with 175bps credit / 75bps debit and a FLAT ₹12 netbanking fee, and an anomaly mix skewed toward aggregation, splits and corrupted narration. The flat netbanking fee is deliberate — the main profile has no flat-fee tier. Then write `scripts/seed.ts` that reads a batch directory's CSVs and inserts them into Postgres under a new run_id.

**May create/modify:** `scripts/generate.ts`, `scripts/seed.ts`, `lib/rateCard.ts`
**Must not modify:** `lib/money.ts`, `data/main/`
**Accomplishes:** a genuinely different held-out distribution
**Run:** `npm run generate -- --seed 771144 --profile bombayweave --out data/holdout && npm run seed -- --batch holdout`
**Expect:** `data/holdout/` has 5 files; seed reports rows inserted per table
**Commit:** `feat: add held-out batch profile and database seeding`
**Could go wrong:** the rate card may be hardcoded as bps only, which cannot express a flat fee. Make it `{ type: 'bps' | 'flat', value }` now — it will otherwise break Pass 6 on Day 3.

---

## Prompt 07 — Normalization layer

**Paste:**
> Write `lib/normalize/validate.ts`, `lib/normalize/narration.ts` and `lib/normalize/index.ts` following SETL_BLUEPRINT.md section 10, Pass 0. validate.ts checks required columns and rejects the file if any are missing; per-row problems become INVALID_ROW exceptions carried forward, never dropped silently. narration.ts extracts a UTR from a bank narration string using regex against the known UTR shape plus template-specific patterns, returning `{ utr, parse_source: 'regex' | 'pending_llm' }`. No LLM call in this prompt. index.ts converts all money strings to integer paise, all dates to IST, and attaches a settlement_cycle_date to each payment. Write `tests/narration.test.ts` covering at least 8 narration templates including two that must fail to parse.

**May create/modify:** `lib/normalize/*`, `tests/narration.test.ts`
**Must not modify:** `lib/engine/`, `scripts/`
**Accomplishes:** clean typed records for the engine
**Run:** `npm run test -- narration`
**Expect:** all tests pass; the two deliberately-corrupted narrations return `pending_llm`
**Commit:** `feat: add normalization layer`
**Could go wrong:** an over-greedy regex that "successfully" extracts garbage from corrupted narrations. That is worse than failing. The two corrupted cases must return `pending_llm`.

---

## Prompt 08 — Reconciliation passes 1–3

**Paste:**
> Write `lib/engine/pass1-utr.ts`, `lib/engine/pass2-amountDate.ts` and `lib/engine/pass3-aggregate.ts` exactly as specified in SETL_BLUEPRINT.md section 10. Each is a pure function: inputs in, links out, no database writes, no side effects. Every link carries an evidence object. Pass 2 must REFUSE to link when 2 or more candidates tie — emit all candidates as evidence with confidence 0.3/n instead. Pass 3 is subset-sum in both directions with pool capped at 12, subset size capped at 4, DFS with descending-sort pruning, and it must REFUSE when more than one distinct subset hits the target, recording alternatives_found in evidence. Integer paise only. Write the passes one at a time and show me pass 1 working before starting pass 2.

**May create/modify:** `lib/engine/pass1-utr.ts`, `lib/engine/pass2-amountDate.ts`, `lib/engine/pass3-aggregate.ts`, `lib/types.ts`
**Must not modify:** `lib/normalize/`, `lib/money.ts`
**Accomplishes:** bank-to-settlement matching including splits and merges
**Run:** `npm run test -- engine` (tests come in prompt 19; for now check it compiles: `npx tsc --noEmit`)
**Expect:** no type errors; pass 3 exports a function that returns both links and refusals
**Commit:** `feat: add reconciliation passes 1-3`
**Could go wrong:** Pass 2 or 3 picking the "best" candidate when several tie. This is the single most important behaviour in the system. If it ever links an ambiguous case, stop and fix it before going further.

---

## Prompt 09 — Passes 4–6 + classifier + confidence

**Paste:**
> Write `lib/engine/pass4-balance.ts` (settlement internal consistency: sum of credits minus debits equals header amount; sum of fees equals header fees; sum of tax equals header tax; and per payment line credit == amount − fee − tax), `lib/engine/pass5-orderMatch.ts` (tiered: order_id exact, then unique amount+date, then refuse on ambiguity; distinguish MISSING_IN_LEDGER from DISPUTE_HOLD using on_hold and dispute_id), and `lib/engine/pass6-feeAudit.ts` (recompute expected fee from the rate card supporting both bps and flat tiers, recompute 18% GST, report deltas; a method missing from the rate card escalates rather than assuming zero). Then `lib/engine/classify.ts` implementing all 15 exception classes from SETL_BLUEPRINT.md section 11, `lib/engine/confidence.ts` implementing the four-factor multiplicative score from section 12, `lib/engine/decide.ts` reading thresholds from config, and `lib/engine/run.ts` orchestrating passes 0–6 and persisting links, exceptions and audit rows in one transaction. Use placeholder thresholds of 0.9 and 0.5 for now with a TODO — they get replaced in prompt 11. Do NOT write the composition engine in this prompt; that is prompt 09B and it depends on Pass 6's fee verdicts being finished first.

**May create/modify:** `lib/engine/*`
**Must not modify:** `lib/normalize/`, `scripts/generate.ts`
**Accomplishes:** the complete rules-only engine
**Run:** `npx tsx scripts/seed.ts --batch main && npx tsx -e "import {runReconciliation} from './lib/engine/run'; runReconciliation('main').then(r=>console.log(r.summary))"`
**Expect:** a summary printing counts for auto / review / unresolved, with unresolved greater than zero
**Commit:** `feat: add passes 4-6, exception taxonomy and confidence scoring`
**Could go wrong:** unresolved comes back as zero. That means the ambiguity refusals are not firing. Do not proceed — the honest exception list is the project.

---

## Prompt 09B — Settlement composition engine

**Paste:**
> Write `lib/engine/pass6b-compose.ts` exactly as specified in SETL_BLUEPRINT.md section 10, Pass 6B. For every settlement in the run — reconciled or not, including ones with no bank link and ones with zero lines — bucket its lines into gross_payments, fees_total, gst_total, refunds_total, disputes_total and adjustments_net, then derive expected_payout, compare against the header amount and against the linked bank credit total, and compute diff_expected_vs_header, diff_header_vs_bank and diff_total. All integer paise. Then attach a signed `contribution`, a `contribution_bucket` and a one-line `contribution_reason` to every settlement line using the table in the blueprint. Assign status using the four-row table. Assign discrepancy_component using the eight-step ordered attribution, and when no step matches use UNATTRIBUTED — never force an attribution. Assert conservation identities A and B for every settlement and throw if either fails, because that is a code bug and must not reach the UI. Add the `settlement_composition` table to `db/schema.sql` and the `contribution`, `contribution_bucket` and `contribution_reason` columns to `settlement_lines`. Wire the pass into `run.ts` after Pass 6 and persist compositions inside the same transaction. Explain your bucketing logic before writing it.

**May create/modify:** `lib/engine/pass6b-compose.ts`, `lib/engine/run.ts`, `db/schema.sql`, `db/migrate.ts`, `lib/types.ts`
**Must not modify:** `lib/engine/pass1-*` through `pass6-*`, `lib/normalize/`, `scripts/generate.ts`
**Accomplishes:** the deterministic answer to "how was this number built", for every settlement
**Run:** `npm run migrate && npx tsx scripts/seed.ts --batch main && npx tsx -e "import {runReconciliation} from './lib/engine/run'; runReconciliation('main').then(r=>console.log(r.compositions.length, r.compositions.filter(c=>c.status==='FULLY_RECONCILED').length))"`
**Expect:** one composition per settlement (count equals your settlement count exactly), with a majority `FULLY_RECONCILED` and a handful of `DISCREPANCY` and `UNMATCHED_TO_BANK`
**Commit:** `feat: add settlement composition engine`
**Could go wrong:** (a) settlements skipped when they have no bank link or no lines — every settlement gets a row, no exceptions; (b) the attribution ladder falling through to a bucket instead of `UNATTRIBUTED` — check that at least one settlement in the run ends up `UNATTRIBUTED`, and if none does, the ladder is guessing; (c) identity B failing because refunds were double-counted in both `contribution` and `refunds_total`. If it throws, that is the assertion working — fix the arithmetic, do not relax the assertion.

---

## Prompt 10 — Metrics and evaluation

**Paste:**
> Write `lib/metrics/compute.ts` implementing every formula in SETL_BLUEPRINT.md section 16 exactly, including false-match rate, correct-refusal rate and amount conservation. Write `lib/metrics/report.ts` which renders a markdown report. Write `scripts/evaluate.ts` which, for a given batch, seeds, runs the engine, loads ground_truth.json, computes all metrics and writes `data/results/metrics-<batch>.json` plus a combined `REPORT.md` at the repo root covering both batches. REPORT.md must label the main batch "tuning batch" and the held-out batch "held-out". Report false-match rate before match rate in every accuracy table, but put the composition rollups from section 16 ABOVE the accuracy tables — total gross, total fees, total GST, total refunds, total disputes, total adjustments, total expected payout, total bank credit, total reconciled, total unresolved — because a finance reader wants to know how much money moved before they care how well you matched it. Also compute composition coverage (settlements with a composition row over total settlements; anything below 100% is a bug). Assert every conservation identity in section 16 and fail loudly on any breach, including that reconciled + review + unresolved equals processed. Never hardcode a number into the report.

**May create/modify:** `lib/metrics/*`, `scripts/evaluate.ts`
**Must not modify:** `lib/engine/`
**Accomplishes:** reproducible measurement
**Run:** `npm run evaluate`
**Expect:** `REPORT.md` at the root with composition rollups first, then real accuracy numbers for both batches; match rate somewhere in the 80s or 90s; false-match rate low but probably not zero; composition coverage exactly 100%
**Commit:** `feat: add metrics engine, composition rollups and evaluation script`
**Could go wrong:** a 100% match rate. That means ground truth is being read as the answer key somewhere in the engine path, or the injected anomalies are not in the data. Investigate before celebrating.

---

## Prompt 11 — Threshold selection experiment

**Paste:**
> Write `scripts/sweepThresholds.ts` implementing SETL_BLUEPRINT.md section 12. Run the engine ONCE on the main batch, keep every link with its confidence and whether ground truth says it is correct. Then sweep t_auto from 0.50 to 1.00 in 0.01 steps and t_review from 0.30 up to t_auto, computing at each point the auto-resolution rate, false-match rate among auto-resolved, review queue size and correct-refusal rate. Write the whole curve to `data/results/sweep.json`. Then apply the selection rule: t_auto is the LOWEST threshold where false-match rate among auto-resolved is at most 0.5%; t_review is the HIGHEST threshold where correct-refusal rate is at least 90%. Print both, and write them into a `config/thresholds.json` that `lib/engine/decide.ts` reads. If no threshold achieves 0.5%, print that finding clearly and report the best achievable rather than silently picking something.

**May create/modify:** `scripts/sweepThresholds.ts`, `config/thresholds.json`, `lib/engine/decide.ts`
**Must not modify:** `lib/metrics/`, `scripts/evaluate.ts`
**Accomplishes:** thresholds you can defend in a panel
**Run:** `npm run sweep && npm run evaluate`
**Expect:** two threshold numbers printed with their justification; REPORT.md numbers shift slightly
**Commit:** `feat: add threshold selection experiment`
**Could go wrong:** the sweep re-running the engine at every step, taking minutes. Run the engine once, sweep over the stored results.

---

## Prompt 12 — LLM narration parser

**Paste:**
> Write `lib/ai/client.ts`: a single fetch wrapper around the LLM API using LLM_API_KEY and LLM_MODEL from env, requesting JSON output, with a 10-second timeout, one retry on 5xx, and a hard `LLM_ENABLED=false` switch that makes every call a no-op returning null. Write `lib/ai/prompts.ts` holding all prompt text. Write `lib/ai/narrationParser.ts` per SETL_BLUEPRINT.md section 13 job 1: it sends ONLY the narration string, no amounts and no dates, and expects `{utr, channel, counterparty, confidence}`. Then validate the returned UTR against the set of known settlement UTRs using normalized comparison plus Levenshtein distance up to 2; if it does not resolve to exactly one known UTR, discard the parse and mark parse_source 'failed'. Log every call to the llm_calls table. Wire it into the normalization layer so it runs only for lines where regex returned pending_llm.

**May create/modify:** `lib/ai/client.ts`, `lib/ai/prompts.ts`, `lib/ai/narrationParser.ts`, `lib/normalize/index.ts`
**Must not modify:** `lib/engine/`, `lib/money.ts`
**Accomplishes:** the LLM's first narrow job, with deterministic validation on top
**Run:** `LLM_ENABLED=true npm run evaluate` then `LLM_ENABLED=false npm run evaluate`
**Expect:** parse rate is higher with the LLM on; match rate barely moves. **That is the correct outcome** — record both numbers, they become your ablation
**Commit:** `feat: add AI narration parser`
**Could go wrong:** sending amounts or settlement data in the prompt "for context". It must receive the narration string and nothing else.

---

## Prompt 13 — LLM explanation generator

**Paste:**
> Write `lib/ai/explainer.ts` per SETL_BLUEPRINT.md section 13 job 2. It takes an exception ID, builds an evidence bundle server-side from the database — the client never supplies evidence — and asks the model for 2 to 3 sentences aimed at a finance associate. The system prompt must forbid computing, inferring or estimating any number, and instruct it to describe a value in words if that value is not in the bundle. Every number in the bundle is already final and pre-formatted as a string. Write `app/api/exceptions/[id]/explain/route.ts` calling it. Store the result on the exception as ai_explanation with ai_status. Ensure the deterministic_reason template is always populated regardless, so the UI never has an empty state.

**May create/modify:** `lib/ai/explainer.ts`, `lib/ai/prompts.ts`, `app/api/exceptions/[id]/explain/route.ts`
**Must not modify:** `lib/engine/`, `lib/ai/narrationParser.ts`
**Accomplishes:** human-readable break explanations
**Run:** `curl -X POST localhost:3000/api/exceptions/<some-id>/explain`
**Expect:** two or three sentences mentioning only numbers that appear in the evidence
**Commit:** `feat: add AI explanation generator`
**Could go wrong:** the model computing a total the bundle does not contain. This is exactly what the next prompt catches — do not fix it by prompt-tuning alone.

---

## Prompt 14 — Number guard

**Paste:**
> Write `lib/ai/numberGuard.ts` per SETL_BLUEPRINT.md section 14. It walks the evidence bundle recursively and builds an allowlist of every numeric value in every representation the model might write: raw paise, rupees, comma-grouped Indian format, with and without the ₹ symbol, with and without decimals, plus date formats. Documented carve-outs: integers 0 through 10, and the constants 18 and 2. Then extract every numeric token from the explanation text, normalize each, and compare. If any token is not in the allowlist, reject the explanation, set ai_status to 'rejected_by_guard', leave ai_explanation null, and log the offending tokens to llm_calls.rejected_tokens. The UI falls back to deterministic_reason. Write `tests/numberGuard.test.ts` including a test that feeds a deliberately hallucinated explanation and asserts rejection.

**May create/modify:** `lib/ai/numberGuard.ts`, `lib/ai/explainer.ts`, `tests/numberGuard.test.ts`
**Must not modify:** `lib/engine/`, `lib/metrics/`
**Accomplishes:** a demonstrable anti-hallucination claim
**Run:** `npm run test -- numberGuard && LLM_ENABLED=true npm run evaluate`
**Expect:** tests pass; the hallucination test rejects; some real rejections appear in llm_calls. **Do not tune this to zero rejections**
**Commit:** `feat: add number guard`
**Could go wrong:** the allowlist being so permissive it never rejects anything. Verify with the deliberate-hallucination test, not by eyeballing output.

---

## Prompt 15 — Overview screen

**Paste:**
> Build `app/page.tsx`, the Overview screen, per SETL_BLUEPRINT.md section 17. Add the six design tokens to globals.css and use them nowhere else. Import Inter for UI and IBM Plex Mono for figures; every money value uses tabular-nums. Layout: header with run selector, then six metric cards in a 3x2 grid ordered false-match rate, match rate, auto-resolved, needs review, unresolved, throughput. Then the run-level composition ladder using `components/SettlementBreakdown.tsx`, fed by the rollups. Then a settlements table with expandable rows: settlement ID in mono, date, status chip, payment count, expected payout, bank received, difference, and a chevron. Clicking the chevron expands the row IN PLACE to show that settlement's `SettlementBreakdown` ladder followed by `components/CompositionTable.tsx`, the one-level drill-down of its own lines with columns entity ID, type, gross, fee, GST, signed contribution, order ref and contribution reason, plus a footer row summing the contribution column with a ✓ when it equals expected payout. Default sort is absolute difference descending. Then a row with an exception-breakdown bar chart and the top 5 breaks by rupee value. Build `components/MetricCard.tsx`, `components/MoneyCell.tsx`, `components/TieOutStrip.tsx`, `components/SettlementBreakdown.tsx` and `components/CompositionTable.tsx`. Also build `app/api/runs/[id]/settlements/route.ts` returning composition AND lines for every settlement in ONE payload, so expanding a row makes no network request. These components must contain NO arithmetic on money — every value is read from the API response. Include loading skeletons that match the real layout, an empty state inviting the user to run a reconciliation, and an error state that says what failed and offers retry. Install shadcn/ui and use its card, badge and table primitives unmodified. Do not add gradients, shadows beyond a 1px rule, or animations.

**May create/modify:** `app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `components/*`, `app/api/runs/route.ts`, `app/api/runs/[id]/route.ts`, `app/api/runs/[id]/settlements/route.ts`
**Must not modify:** `lib/engine/`, `lib/ai/`, `lib/metrics/`
**Accomplishes:** the first screen a judge sees
**Run:** `npm run dev` → http://localhost:3000
**Expect:** six metric cards, the run-level ladder, and a settlements table where expanding a FULLY_RECONCILED row shows the ladder plus its lines instantly, with the contribution column summing to expected payout and showing ✓
**Commit:** `feat: add overview dashboard`
**Could go wrong:** (a) a generic AI-looking dashboard with gradient cards — if it appears, say "use only the six tokens in globals.css, no gradients, no shadows, 4px radius, monospace figures"; (b) the components summing the lines client-side to display the total. That is a second implementation of the arithmetic and it will drift. `grep -n '[+-]' components/CompositionTable.tsx` and check nothing adds money; (c) a per-settlement fetch on expand. One payload, no request on expand.

---

## Prompt 16 — Run screen

**Paste:**
> Build `app/run/page.tsx` and `app/api/runs/route.ts` POST handler per SETL_BLUEPRINT.md section 17 screen 2. Batch selector for main and held-out, a data summary card showing record counts per source read from the CSVs, an LLM enabled/disabled toggle, and a primary button reading "Reconcile 300 records". On click, POST to /api/runs and display each engine stage as it completes with its real millisecond timing and its counts, in the format shown in the blueprint. Validate the batch parameter against a two-value allowlist and return 400 on anything else. On error, show which stage failed and keep partial results on screen.

**May create/modify:** `app/run/page.tsx`, `app/api/runs/route.ts`
**Must not modify:** `lib/engine/`, `app/page.tsx`
**Accomplishes:** the throughput evidence and the LLM-off demo moment
**Run:** click through both batches with the toggle on and off
**Expect:** stage timings appear; match rate is essentially identical with the LLM off
**Commit:** `feat: add run page with live stage timings`
**Could go wrong:** stage timings faked or rounded to whole seconds. They must be real milliseconds from the engine.

---

## Prompt 17 — Exception queue

**Paste:**
> Build `app/exceptions/page.tsx` and `app/api/exceptions/route.ts` per SETL_BLUEPRINT.md section 17 screen 3. Filters: decision, class multi-select, minimum amount, free-text record ID search. Default view is Unresolved plus Needs Review only, sorted by rupee impact descending. Columns: record ID in mono, source, colour-coded class badge, amount impact right-aligned in mono, a thin confidence bar, decision, truncated next action, and a link through to the investigation page. Paginate at 25. Validate every filter against its enum server-side and parameterise all SQL through postgres.js tagged templates — never string concatenation. Empty state offers to clear filters. Build `components/ExceptionBadge.tsx` and `components/ConfidenceBar.tsx`.

**May create/modify:** `app/exceptions/page.tsx`, `app/api/exceptions/route.ts`, `components/ExceptionBadge.tsx`, `components/ConfidenceBar.tsx`
**Must not modify:** `app/page.tsx`, `lib/engine/`
**Accomplishes:** the working surface a finance associate would use
**Run:** `npm run dev` → /exceptions, try each filter
**Expect:** default view shows unresolved and review items sorted by rupee value, largest first
**Commit:** `feat: add exception queue`
**Could go wrong:** any string-concatenated SQL. Check the route file yourself. This is the one place a judge might read your code for security.

---

## Prompt 18 — Investigation screen

**Paste:**
> Build `app/exceptions/[id]/page.tsx` and `app/api/exceptions/[id]/route.ts` per SETL_BLUEPRINT.md section 17 screen 4. Vertical narrative in exactly this order: 1 what happened with class badge and rupee impact, 2 the settlement breakdown ladder with the bucket named by discrepancy_component highlighted in --break, 3 the one-level drill-down of this settlement's lines with the lines contributing to the difference highlighted, 4 evidence with the actual records side by side and differing fields highlighted, 5 how we decided showing the pass, the rule name and the four confidence multiplicands individually, 6 the AI explanation with a chip showing whether the number guard passed or rejected, 7 competing candidates for ambiguous cases showing every candidate and why each failed, 8 why unresolved in plain language for refusals, 9 the next action with its SLA. Sections 2 and 3 must IMPORT `components/SettlementBreakdown.tsx` and `components/CompositionTable.tsx` built in prompt 15 and pass them two extra props for the highlighting — do not write a second version of either component. Where an exception is not attached to a settlement, omit sections 2 and 3 rather than rendering them empty. The exceptions API returns the composition and lines inline so this page makes one request. Deterministic sections render instantly; only the AI block shows a loading shimmer. Add an "Explain with AI" button that calls the explain endpoint on demand, and a "Copy evidence JSON" button. If the explain call fails, show "Explanation unavailable. The deterministic reason above is unaffected." and degrade nothing else. Build `components/EvidenceTable.tsx`.

**May create/modify:** `app/exceptions/[id]/page.tsx`, `app/api/exceptions/[id]/route.ts`, `components/EvidenceTable.tsx`
**Must not modify:** `lib/ai/`, `lib/engine/`
**Accomplishes:** the screen that wins the demo
**Run:** open an UNRESOLVED exception with multiple candidates
**Expect:** the ladder renders with the failing bucket in red, the drill-down highlights the contributing lines, and section 7 lists every competing candidate with a reason for each failure
**Commit:** `feat: add investigation page with settlement breakdown`
**Could go wrong:** (a) section 7 skipped as "nice to have" — it is the most important section on the most important screen, insist on it; (b) Claude Code writing a fresh breakdown component instead of importing the one from prompt 15. Check `git diff components/` — if either component changed beyond added props, reject it.

---

## Prompt 19 — Tests

**Paste:**
> Write `tests/engine.scenarios.test.ts` covering the 12 scenarios in SETL_BLUEPRINT.md section 19, each with a minimal hand-built fixture of 2 to 5 records, asserting the exception class, the decision and the confidence band. Scenario 8, the ambiguous match, must assert that NO link is produced — if that test ever passes by producing a link, the system is broken. Also write `tests/engine.composition.test.ts` covering the 5 composition scenarios in section 19: a clean composition matching the worked example exactly (gross ₹1,00,000, fees ₹2,000, GST ₹360, refunds ₹1,000, expected ₹96,640, bank ₹96,640, diff 0, status FULLY_RECONCILED, component NONE); a fee-attributed discrepancy; a refund-attributed discrepancy; a bank-attributed discrepancy; and an unattributable one that must assert component UNATTRIBUTED and must NOT guess a bucket. Also assert that every settlement in a full run has exactly one composition row including zero-line and unmatched ones, and assert identity B per settlement: the sum of the contribution column equals expected_payout exactly. Also write `tests/money.test.ts` including a 1000-value seeded round-trip, and `tests/metrics.test.ts` verifying every formula against a hand-computed 10-record fixture plus every conservation identity in section 16. Do not modify any lib/ file to make a test pass — if a test fails, tell me and explain what the engine is doing wrong.

**May create/modify:** `tests/*`
**Must not modify:** `lib/`, `app/` — if a test fails, report it, do not patch the engine
**Accomplishes:** proof the financial logic is right
**Run:** `npm run test`
**Expect:** all tests green. If one fails, that is a real bug — fix it in a separate commit
**Commit:** `test: add reconciliation and composition scenario tests`
**Could go wrong:** Claude Code silently weakening an assertion to make a test pass. The "do not modify lib/" scope is what prevents this. Check `git diff` before committing.

---

## Prompt 20 — Deployment

**Paste:**
> Prepare the app for Vercel. Verify no secrets are in the repo. Add a `vercel.json` only if genuinely needed. Make sure every API route handles a cold Neon connection gracefully with a clear error rather than a timeout. Ensure `npm run evaluate` works with no database and no LLM API key by reading CSVs directly from data/, so a judge can reproduce the metrics after only `npm install`. Add a `README` section listing the exact two commands to reproduce. Then walk me through connecting the GitHub repo to Vercel and setting the environment variables in the Vercel dashboard.

**May create/modify:** `vercel.json`, `scripts/evaluate.ts`, `lib/db.ts`, `README.md`
**Must not modify:** `lib/engine/`, `tests/`
**Accomplishes:** a live URL, and offline reproducibility
**Run:** after deploying, open the Vercel URL and run a reconciliation from `/run`
**Expect:** the deployed app runs a full batch without timing out
**Commit:** `chore: deploy to vercel`
**Could go wrong:** serverless function timeout on cold start plus Neon wake-up. Test this on **Day 7 morning**, not evening. If it times out, pre-seed the database and make `/run` read a completed run instead of executing live.

---

## Prompt 21 — README

**Paste:**
> Write README.md following the structure in SETL_BLUEPRINT.md section 25. Open with this exact differentiation sentence, not a feature list: "Razorpay's settlement report tells a merchant what Razorpay did. Setl checks that against the merchant's own order ledger and their actual bank statement, and reports what it could not verify." Then problem, what it does, the held-out metrics table with false-match rate as the FIRST row, the two reproduction commands, the architecture diagram as ASCII, dataset and ground truth, the full 15-class exception taxonomy table, the threshold selection methodology stating the rule in words, what the AI does and explicitly does not do, the number guard with its actual rejection count, a limitations section I will review before you finalise, future scope, and the demo video link placeholder. Pull every number from REPORT.md — do not type any metric by hand. Label main-batch numbers as "tuning batch" and held-out as "held-out".

**May create/modify:** `README.md`
**Must not modify:** anything else
**Accomplishes:** the artifact that decides whether the video gets watched
**Run:** read it start to finish as if you were a stranger
**Expect:** a judge could understand the project without a meeting
**Commit:** `docs: add readme`
**Could go wrong:** metrics typed from memory and drifting from REPORT.md. Regenerate the report and diff the numbers.

---

## Prompt 22 — Architecture and dataset docs

**Paste:**
> Write `docs/ARCHITECTURE.md`: the component diagram, the request lifecycle for a reconciliation run, why each technology was chosen and what was deliberately rejected and why, the data flow through the six passes, where determinism ends and the LLM begins, and the audit trail design. Write `docs/DATASET.md`: the field dictionary for all four sources with the meaning of every field, the rate card for both profiles, the 14 injected cases table with generation method and counts, the ground truth format, and how the held-out batch differs on all six axes. Write `docs/PRD.md`: problem, user, the manual workflow being replaced, scope decisions and what was explicitly cut. Keep all three factual — no marketing language.

**May create/modify:** `docs/*`
**Must not modify:** `README.md`, `lib/`
**Accomplishes:** the "architecture" artifact the submission explicitly asks for
**Run:** `ls docs/`
**Expect:** three markdown files, each readable on its own
**Commit:** `docs: add architecture, dataset and product documentation`
**Could go wrong:** ARCHITECTURE.md restating the README. It should explain *why*, where the README explains *what*.

---

## Prompt 23 — Final audit

**Paste:**
> Act as a senior engineer reviewing this repository before submission. Check and report on each item without fixing anything yet: (1) any secret or API key anywhere in the repo or in git history, (2) any floating-point arithmetic on money anywhere in lib/ or scripts/, (3) any string-concatenated SQL, (4) any hardcoded metric in README.md that does not match REPORT.md, (5) any file that exists but is never imported, (6) any TODO or FIXME left in the code, (7) any dependency in package.json that is not actually used, (8) whether `npm install && npm run evaluate` works from a clean clone with no .env.local, (9) whether every one of the 15 exception classes actually fires at least once across both batches, (10) whether the number guard has rejected at least one real explanation. Give me a numbered list of findings ranked by severity. Do not change any code in this prompt.

**May create/modify:** nothing — report only
**Must not modify:** anything
**Accomplishes:** catches the things that embarrass you in a panel
**Run:** read the findings, then fix them one at a time with separate small prompts and separate commits
**Expect:** 3 to 8 findings. Zero findings means the audit was not thorough
**Commit:** `chore: address final audit findings` (after fixing)
**Could go wrong:** item 9 revealing that two or three exception classes never fire. Either add them to the generator or remove them from the taxonomy. A documented class that never occurs is a claim you cannot support.
