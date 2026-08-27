# SETL — Implementation Blueprint

**AI-powered three-way settlement reconciliation for merchants**
Razorpay AI Buildathon 2026 · Track 04 (AI Finance Controller)
Build window: Thu 27 Aug → Wed 2 Sep 2026 · Buffer: 3–4 Sep · Apparent deadline: 5 Sep

---

## Requirement provenance

| Fact | Status |
|---|---|
| Track 04: agent closes one finance-ops loop over a 50+ record synthetic batch, reports match rate + unresolved exceptions | **Official** (razorpay.com/buildathon) |
| The bar: throughput + measured accuracy + honest exception list; one cherry-picked match proves nothing | **Official** |
| Submission = public repo + 5-min pitch video + architecture | **Official** |
| Application asks "what broke and how you recovered" | **Secondary** — verify on the form |
| Deadline 5 Sept 2026 | **Secondary** — verify on the form |
| Everything else in this document | **Our design choice.** Not a Razorpay rule |

We are choosing 300 records and a held-out batch. Razorpay asked for 50+. Say that plainly in the README — deliberately exceeding a floor reads better than pretending the floor was 300.

---

# 1. Setl explained from zero

## The one example that runs through everything

A customer buys shoes on your site for **₹1,000** and pays by credit card.

Razorpay collects that ₹1,000. It does **not** hand you ₹1,000. Two business days later it sends you:

```
Gross                    ₹1,000.00
MDR (fee, 2%)            −  ₹20.00
GST on MDR (18% of ₹20)  −   ₹3.60
─────────────────────────────────
Net to your bank         ₹  976.40
```

Now multiply that by 300 orders in a day, add refunds and disputes, and Razorpay does not send 300 separate bank transfers. It sends **one** transfer of, say, ₹2,84,193.40. Your bank statement shows a single line. Somewhere inside that number are 300 orders, their fees, their taxes, and three refunds that got netted off.

Your job as the merchant's finance person is to prove that number is correct. That is reconciliation. That is what Setl automates.

## Definitions

**Settlement.** The payout Razorpay sends to your bank account, covering many transactions at once, after deducting fees, taxes and refunds. Default cadence is T+2 business days from payment capture. A settlement has an ID that looks like `setl_DGlQ1Rj8os78Ec`.

**UTR (Unique Transaction Reference).** The bank's tracking number for that transfer, e.g. `1568176960vxp0rj`. It is the single strongest key you have for tying "money left Razorpay" to "money arrived in my bank." It appears in the settlement record *and* somewhere inside the bank statement's free-text narration line. Finding it inside that messy narration is one of the harder parts of the job.

**MDR (Merchant Discount Rate).** Razorpay's fee, expressed as a percentage of the transaction. Different per payment method. In India, **UPI carries zero MDR** for merchants, cards carry 0.9%–2%, international cards more. This matters: a UPI line with a non-zero fee is a genuine error, not a rounding quirk.

**GST on MDR.** India charges 18% GST on the fee itself. If the fee is ₹20, GST is ₹3.60. Two consequences: it comes out of your payout, and you can claim it back as input tax credit — but only if you can prove the number, which means reconciling it.

**Refund.** You send money back to a customer. Razorpay does not usually ask you for a cheque. It **deducts the refund from your next settlement**. So a payout that looks ₹4,820 "short" is often just two refunds netted off. Setl's job is to say that in one sentence instead of you finding it in Excel.

**Dispute (chargeback).** The customer's bank pulls the money back while an investigation runs. During that window Razorpay puts the amount **on hold** — the payment exists, it was captured, but it is not in any settlement. This looks exactly like a missing record unless your system knows what a hold is.

**Exception.** Any record Setl cannot fully account for. Exceptions are not bugs. A reconciliation system with zero exceptions on realistic data is lying.

**Match rate.** Of the records that *should* link to something, what fraction did we link correctly. If 280 of 300 records had a correct counterpart and we found 262, match rate is 93.6%.

**False match.** We linked two records that do not actually belong together. This is the dangerous one. An unmatched record sits in a queue and a human looks at it. A **false** match silently posts wrong numbers into the ledger and nobody finds out until the audit. Setl's headline claim is a low false-match rate, not a high match rate.

**Composition (settlement breakdown).** The arithmetic that turns a day's sales into a payout, written out in named buckets:

```
Gross payments                 ₹1,00,000.00
− Razorpay fees                   ₹2,000.00
− GST on fees                       ₹360.00
− Refunds                         ₹1,000.00
− Disputes / holds                    ₹0.00
− Adjustments                         ₹0.00
────────────────────────────────────────────
Expected payout                  ₹96,640.00

Bank received                    ₹96,640.00
Difference                            ₹0.00     ✅ Fully reconciled
```

## Reconciliation and composition are two different questions

This distinction is the spine of the product, and most reconciliation tools only answer the first one.

| | Question | Answer shape |
|---|---|---|
| **Reconciliation** | Does the settlement match what we expected and what the bank received? | A verdict: matched, needs review, unresolved |
| **Composition** | How exactly did we arrive at this number? | A ladder: every bucket, every underlying record, summing to the payout |

A merchant whose payout ties out perfectly still cannot post it to their accounts without the composition, because they need to know how much was revenue, how much was fee expense, how much was GST they can reclaim, and how much was refunds against prior sales. Reconciliation says the number is right. Composition says what the number is made of. **Setl answers both, and shows both.**

The composition is also what makes an exception legible. "This payout is ₹4,820 short" is a fact. "This payout is ₹4,820 short and the shortfall is entirely in the refunds bucket, here are the two refund lines" is an answer.

## Who uses it

The finance associate at a ₹2–20 crore/month D2C merchant. One person. Currently does this in Excel with VLOOKUP, five to ten hours a month, and closes the books by the 5th.

## The three data sources

| Source | Where it comes from | What it claims |
|---|---|---|
| **A — Order ledger** | The merchant's own shop/ERP database | "We sold these things for these amounts" |
| **B — Razorpay settlement recon** | Razorpay's settlement report / recon API | "We collected this, charged this, and paid you this" |
| **C — Bank statement** | The merchant's bank, as CSV | "This much money actually landed" |

Reconciliation is proving all three tell the same story. Razorpay's own dashboard can show you A-vs-B or just B. It structurally cannot see C, because it is not your bank. That gap is the product.

---

# 2. Complete product workflow

```
 1. INPUT              3 CSVs (orders, settlement recon, bank statement)
        ↓
 2. VALIDATION         schema check, type check, required columns, row count
        ↓
 3. NORMALIZATION      money → integer paise · dates → IST · narration → structured
        ↓
 4. MATCHING           pass 1–3: bank ↔ settlement, incl. splits and aggregations
        ↓
 5. SETTLEMENT VERIF.  Σcredit − Σdebit − fees − tax must equal the header amount
        ↓
 6. FEE / TAX VERIF.   recompute MDR from rate card, recompute 18% GST, compare
        ↓
 7. COMPOSITION        build the named-bucket ladder for every settlement, attribute
                       every underlying line's signed contribution to the payout
        ↓
 8. CLASSIFICATION     every residual gets one of 15 named exception types
        ↓
 9. CONFIDENCE         deterministic score from evidence quality
        ↓
10. DECISION           AUTO_RESOLVED · NEEDS_REVIEW · UNRESOLVED
        ↓
11. AI EXPLANATION     LLM writes 2 sentences from the evidence bundle, number-guarded
        ↓
12. METRICS            match rate, false-match rate, throughput, ₹ reconciled,
                       gross / fees / GST / refunds / adjustments rollups
        ↓
13. AUDIT TRAIL        every decision persisted with its rule, evidence and timestamp
```

**What happens at each stage**

**1. Input.** Three CSVs uploaded or seeded. Every run gets a `run_id`. Nothing is ever overwritten, so you can re-run and compare.

**2. Validation.** Reject the file, not the row, if columns are missing. Per-row problems (unparseable date, negative amount where impossible) get tagged `INVALID_ROW` and carried forward as exceptions rather than silently dropped. Silently dropping rows is how real recon tools lie about their match rate.

**3. Normalization.** `₹1,000.00` becomes the integer `100000`. Every timestamp becomes IST and gets a settlement-cycle date attached. Bank narration goes through a regex extractor; if that fails, the LLM parser gets one attempt.

**4. Matching.** Three passes described in §10. Deterministic, no AI.

**5. Settlement verification.** An internal-consistency check. If the settlement header says ₹2,84,193.40 but the lines inside it sum to ₹2,84,600.00 after fees, something is wrong with the report itself. This catches a class of problem the other passes cannot.

**6. Fee/tax verification.** Recompute what the fee *should* have been from the merchant's rate card and compare. Catches overcharges, wrong rate tiers, and UPI lines charged as cards.

**7. Composition.** For every settlement, sum its lines into six named buckets — gross payments, fees, GST on fees, refunds, disputes/holds, other adjustments — and derive the expected payout. Compare that against the settlement header and against the linked bank credit. Attach a signed `contribution` to every underlying line so the drill-down adds up to the payout exactly. This is Pass 4's arithmetic exploded into buckets a human can read, and it runs for **every** settlement, reconciled or not. See Pass 6B in §10.

**8. Classification.** Every record ends up in exactly one of 15 named buckets (§11). Named buckets are what let a break route to the right resolver instead of into a generic "mismatch" pile. Where a settlement has a non-zero difference, composition also names **which bucket** the difference lives in.

**9. Confidence.** A score in [0,1] computed from evidence quality — key strength, amount delta, date delta, how many candidates competed. Not a vibe, not an LLM judgement.

**10. Decision.** Thresholds chosen by experiment (§12), not by taste.

**11. AI explanation.** The LLM receives a JSON evidence bundle containing numbers that are already final, including the composition ladder. It writes prose. It computes nothing. Every number it writes is verified against the bundle before display.

**12. Metrics.** Computed by a standalone script against ground truth, not by the UI. Includes the run-level composition rollups and the conservation identities in §16.

**13. Audit trail.** One row per decision: what, why, which rule, which evidence, what confidence, when. Finance software without this is a toy.

---

# 3. MVP — locked

## CORE (cannot be removed; the project is not submittable without these)

1. Seeded deterministic generator producing the **300-record main batch** across three sources
2. Seeded generator producing the **300-record held-out batch** (different seed *and* different merchant profile)
3. Ground truth file emitted alongside both batches
4. All 14 injected complexity cases present in both batches
5. Validation + normalization layer, integer paise throughout
6. Reconciliation passes 1–6 including split and aggregation resolution
7. Settlement internal-balance verification
8. Fee + GST recomputation against a rate card
9. **Settlement composition engine (Pass 6B)** — six named buckets, expected payout, header and bank comparison, difference, and status, for **every** settlement
10. **Per-line signed contribution** attached to every settlement line, summing exactly to the expected payout
11. **Discrepancy attribution** — when a difference exists, name the bucket responsible
12. Full 15-class exception taxonomy
13. Confidence scoring with **experimentally selected** thresholds
14. Three-state decision: AUTO_RESOLVED / NEEDS_REVIEW / UNRESOLVED
15. Audit log table, one row per decision
16. `npm run evaluate` producing `metrics.json` + `REPORT.md` for both batches
17. **Composition rollup metrics + enforced amount-conservation identities** (§16)
18. LLM narration parser (fallback when regex fails)
19. LLM evidence-grounded explanation, including composition explanations
20. Number guard + rejection counter, covering composition values
21. **One-level drill-down** — a settlement expands to its own constituent lines, each showing its signed contribution and linked order reference
22. Four screens: Overview (with expandable settlement rows carrying the ladder and drill-down), Run, Exception Queue, Investigation (reusing the same two components, with the failing bucket highlighted)
23. Tests covering the 12 financial scenarios in §19 **plus the 5 composition scenarios**
24. `README.md`, `docs/ARCHITECTURE.md`, `FAILURES.md`
25. Public repo, no committed secrets, deployed on Vercel
26. 5-minute pitch video including the composition beat (§24)

## OPTIONAL (only if the day's CORE items are done)

27. Logistic regression + ablation table — **highest-value optional item.** Ships only if it measurably beats rules (§15)
28. Grounded Q&A screen with constrained tools
29. Threshold-sweep chart in the UI
30. Live Razorpay test-mode payments fetch, 90-minute box, abandon on overrun
31. CSV export of the exception queue or of a settlement's composition

## CUT (do not build)

Auth · multi-merchant · second gateway · webhooks/real-time · cash forecasting · Excel export · dark mode · animations · custom design system · Docker · anything requiring a new library learned after Day 4.

**Also cut, and named here so it does not creep back in:** the multi-hop drill-down (settlement → payments → orders → refunds → fees → adjustments as separately navigable levels) and any dedicated settlement screen. One level, one table, `order_ref` as a column. A judge will not click past the first level, and four extra joins on Day 6 is how a deadline dies.

## Acceptance criteria — composition

The capability is done when all of these are true. Check them literally, not by impression.

- [ ] **Every** settlement in a completed run has exactly one `settlement_composition` row, including unmatched and zero-line ones
- [ ] The ladder shows all nine values: gross, fees, GST, refunds, disputes, adjustments, expected payout, bank received, difference
- [ ] For a clean settlement: difference is exactly `0`, status is `FULLY_RECONCILED`, and the six-bucket ladder reproduces the worked example in Pass 6B
- [ ] For a broken settlement: the same ladder renders, and `discrepancy_component` names one bucket, or `UNATTRIBUTED` when no bucket accounts for the difference
- [ ] Expanding a settlement on Overview shows the ladder **and** its constituent lines, with no second network request
- [ ] The drill-down table's `contribution` column sums to `expected_payout` **exactly**, the sum is rendered on screen, and identity B is asserted in code
- [ ] The same `SettlementBreakdown` and `CompositionTable` components render on both Overview and Investigation. No second implementation exists
- [ ] Every value in the ladder is read from the database. `grep` the components for arithmetic on money and find none
- [ ] Running with `LLM_ENABLED=false` leaves the ladder, the drill-down and the difference completely unchanged
- [ ] Composition rollups appear in `REPORT.md` for both batches, and all conservation identities pass

New ideas after Day 4 go in README → Future Scope. That section costs nothing and makes you look ambitious.

---

# 4. Final tech stack

| Tech | What it does | Why Setl needs it | Why not the fancier option |
|---|---|---|---|
| **Next.js 15 (App Router)** | React framework; serves pages *and* API routes from one codebase | One `npm run dev`, one deploy, one thing to explain in the panel | Separate Express backend + React frontend = two deploys, CORS, two package.jsons, zero added credibility |
| **TypeScript** | Types on top of JavaScript | Money code where `amount` might be rupees or paise is a bug factory. Branded types make that a compile error | Plain JS saves an hour on Day 1 and costs five hours on Day 4 |
| **Next API routes** | Backend endpoints as files under `app/api/` | Nine endpoints total. That is not a microservice-shaped problem | NestJS/Express adds structure you do not need at nine endpoints |
| **PostgreSQL (Neon free tier)** | Relational database, cloud-hosted | Audit trail, run history, exception queue. Needs real SQL joins | SQLite breaks on Vercel's read-only filesystem. Two databases (SQLite local + PG prod) is a trap |
| **`postgres` (postgres.js)** | Thin Postgres driver with tagged-template SQL | You write real SQL, so you can explain every query in the panel | Prisma = a schema DSL, a migration engine and a generated client to learn in a week. Drizzle is lighter but still a new API |
| **Tailwind CSS** | Utility classes for styling | Fast, no CSS files to organise, ships with create-next-app | A design system is a Day-5 time sink |
| **shadcn/ui** | Copy-paste React components (table, dialog, badge, tabs) | Table + dialog + badge is 80% of this UI. These are yours after copying, no dependency | MUI/Chakra = theming rabbit hole |
| **Recharts** | Charts | Two charts: exception breakdown, threshold sweep | D3 is a week of learning for two charts |
| **LLM API with JSON mode** | Structured text generation | Three narrow jobs (§13) | LangChain wraps three fetch calls in an abstraction layer. If asked why no LangChain: "three prompt calls with JSON schemas didn't need a framework" |
| **Vitest** | Test runner | 15 tests on financial logic | Jest needs more config with TS + ESM |
| **Vercel** | Hosting | `git push` deploys. Free | Anything else costs setup time |
| **Git + GitHub** | Version control | Required submission artifact | — |

**Not using, deliberately:** Kubernetes, microservices, Kafka, Redis, Terraform, queues, Docker, LangChain. 300 records reconcile synchronously in under two seconds. Every one of those tools would be answering a question nobody asked.

**On the LLM provider:** pick one with a free or cheap tier and JSON/structured output. Check current model names and pricing before Day 4 rather than trusting any list — they change monthly. Budget: at most ~350 calls per full run, most of them tiny narration parses.

---

# 5. Folder structure

```
setl/
├── CLAUDE.md                      # permanent instructions for Claude Code
├── README.md                      # the judge's entry point
├── FAILURES.md                    # what broke + how you fixed it. Start Day 1
├── REPORT.md                      # generated by evaluate.ts. Do not hand-edit
├── .env.local                     # secrets. NEVER committed
├── .env.example                   # variable names only, no values. Committed
├── .gitignore
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── app/
│   ├── layout.tsx
│   ├── page.tsx                   # Screen 1 — Overview
│   ├── run/page.tsx               # Screen 2 — Run Reconciliation
│   ├── exceptions/page.tsx        # Screen 3 — Exception Queue
│   ├── exceptions/[id]/page.tsx   # Screen 4 — Investigation
│   ├── ask/page.tsx               # OPTIONAL — grounded Q&A
│   ├── globals.css
│   └── api/
│       ├── runs/route.ts              # GET list, POST create+execute
│       ├── runs/[id]/route.ts         # GET one run + its metrics
│       ├── runs/[id]/records/route.ts # GET paginated records for a run
│       ├── runs/[id]/settlements/route.ts  # GET composition + lines, all settlements
│       ├── exceptions/route.ts        # GET filtered exception queue
│       ├── exceptions/[id]/route.ts   # GET one exception + full evidence
│       ├── exceptions/[id]/explain/route.ts  # POST → LLM explanation
│       └── ask/route.ts               # OPTIONAL
│
├── components/
│   ├── ui/                        # shadcn primitives, unmodified
│   ├── MetricCard.tsx
│   ├── TieOutStrip.tsx            # the signature component. See §17
│   ├── SettlementBreakdown.tsx    # the composition ladder. See §17
│   ├── CompositionTable.tsx       # one-level drill-down: the settlement's own lines
│   ├── ExceptionBadge.tsx
│   ├── EvidenceTable.tsx
│   ├── ConfidenceBar.tsx
│   └── MoneyCell.tsx              # renders paise → ₹, tabular figures
│
├── lib/
│   ├── money.ts                   # Paise type, parse, format, rounding. NO FLOATS
│   ├── dates.ts                   # IST handling, business days, settlement cycles
│   ├── db.ts                      # postgres.js client singleton
│   ├── types.ts                   # every shared type in the system
│   ├── rateCard.ts                # MDR rates per method, GST rate
│   │
│   ├── normalize/
│   │   ├── validate.ts            # schema + row validation
│   │   ├── narration.ts           # regex UTR extraction
│   │   └── index.ts
│   │
│   ├── engine/
│   │   ├── pass1-utr.ts
│   │   ├── pass2-amountDate.ts
│   │   ├── pass3-aggregate.ts     # subset-sum for splits/merges
│   │   ├── pass4-balance.ts       # settlement internal consistency
│   │   ├── pass5-orderMatch.ts
│   │   ├── pass6-feeAudit.ts
│   │   ├── pass6b-compose.ts      # settlement composition + contributions
│   │   ├── classify.ts            # → exception taxonomy
│   │   ├── confidence.ts
│   │   ├── decide.ts              # AUTO / REVIEW / UNRESOLVED
│   │   └── run.ts                 # orchestrates 1→6, returns RunResult
│   │
│   ├── ai/
│   │   ├── client.ts              # single LLM fetch wrapper, JSON mode, retries
│   │   ├── narrationParser.ts
│   │   ├── explainer.ts
│   │   ├── numberGuard.ts         # the hallucination check
│   │   └── prompts.ts             # all prompt text in one file
│   │
│   ├── ml/                        # OPTIONAL — only if §15 gate passes
│   │   ├── features.ts
│   │   ├── logreg.ts
│   │   └── model.json             # trained weights, committed
│   │
│   └── metrics/
│       ├── compute.ts             # all formulas from §16
│       └── report.ts              # writes REPORT.md
│
├── scripts/
│   ├── generate.ts                # synthetic data generator (both batches)
│   ├── seed.ts                    # load CSVs → Postgres
│   ├── evaluate.ts                # full eval → metrics.json + REPORT.md
│   ├── sweepThresholds.ts         # threshold-selection experiment
│   └── trainModel.ts              # OPTIONAL
│
├── data/
│   ├── main/                      # committed. 300 records + ground truth
│   │   ├── orders.csv
│   │   ├── settlements.csv
│   │   ├── settlement_lines.csv
│   │   ├── bank_statement.csv
│   │   └── ground_truth.json
│   ├── holdout/                   # committed. same 5 files, different profile
│   └── results/                   # metrics.json, sweep.json
│
├── db/
│   ├── schema.sql                 # the whole schema, one file
│   └── migrate.ts                 # runs schema.sql against DATABASE_URL
│
├── tests/
│   ├── money.test.ts
│   ├── narration.test.ts
│   ├── engine.scenarios.test.ts   # the 12 scenarios from §19
│   ├── numberGuard.test.ts
│   └── metrics.test.ts
│
└── docs/
    ├── ARCHITECTURE.md
    ├── PRD.md
    ├── DATASET.md                 # field dictionary + injected case list
    └── screenshots/
```

**Why data/ is committed:** a judge clones the repo and runs `npm run evaluate` without a database or an API key, and reproduces your numbers. That reproducibility is worth more than a clean repo.

---

# 6. Database schema

All money is `BIGINT` in **paise**. All timestamps are `TIMESTAMPTZ`. Never `FLOAT`, never `MONEY`, never `NUMERIC` for amounts.

### `runs`
One row per reconciliation execution.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | `run_<ulid>` |
| `batch` | `TEXT` | `'main'` or `'holdout'` |
| `started_at` | `TIMESTAMPTZ` | |
| `finished_at` | `TIMESTAMPTZ` | nullable |
| `status` | `TEXT` | `running` / `complete` / `failed` |
| `config` | `JSONB` | thresholds, rate card version, LLM on/off |
| `record_count` | `INT` | |

### `orders` — Source A
| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | composite in practice: `run_id + order_id` |
| `run_id` | `TEXT` FK → runs.id | |
| `order_id` | `TEXT` | `ord_...` |
| `order_ref` | `TEXT` | merchant's own reference, e.g. `KK-2026-04412` |
| `customer_ref` | `TEXT` | pseudonymous |
| `order_amount` | `BIGINT` | paise |
| `currency` | `TEXT` | `INR` |
| `created_at` | `TIMESTAMPTZ` | |
| `order_status` | `TEXT` | `paid` / `refunded` / `partially_refunded` / `cancelled` |
| `refund_issued` | `BIGINT` | paise, 0 if none |

Index: `(run_id)`, `(run_id, order_id)`, `(run_id, order_amount)`

### `settlements` — Source B, header
Mirrors Razorpay's settlement entity.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | |
| `run_id` | `TEXT` FK | |
| `settlement_id` | `TEXT` | `setl_...` |
| `amount` | `BIGINT` | net paid out, paise |
| `fees` | `BIGINT` | total MDR in the batch |
| `tax` | `BIGINT` | total GST on MDR |
| `utr` | `TEXT` | |
| `status` | `TEXT` | `processed` / `failed` |
| `created_at` | `TIMESTAMPTZ` | |

Index: `(run_id, utr)`, `(run_id, settlement_id)`

### `settlement_lines` — Source B, detail
Mirrors the recon API item shape.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | |
| `run_id` | `TEXT` FK | |
| `entity_id` | `TEXT` | `pay_...` / `rfnd_...` / `adj_...` |
| `type` | `TEXT` | `payment` / `refund` / `adjustment` / `dispute` / `transfer` |
| `debit` | `BIGINT` | paise |
| `credit` | `BIGINT` | paise |
| `amount` | `BIGINT` | paise |
| `fee` | `BIGINT` | paise |
| `tax` | `BIGINT` | paise |
| `on_hold` | `BOOLEAN` | |
| `settled` | `BOOLEAN` | |
| `created_at` | `TIMESTAMPTZ` | |
| `settled_at` | `TIMESTAMPTZ` | nullable |
| `settlement_id` | `TEXT` | nullable — null means unsettled |
| `settlement_utr` | `TEXT` | nullable |
| `order_id` | `TEXT` | nullable |
| `method` | `TEXT` | `card` / `upi` / `netbanking` / `wallet` |
| `card_network` | `TEXT` | nullable |
| `card_type` | `TEXT` | `credit` / `debit` / null |
| `international` | `BOOLEAN` | |
| `dispute_id` | `TEXT` | nullable |
| `description` | `TEXT` | free text, mostly for adjustments |
| `contribution` | `BIGINT` | **written by Pass 6B.** Signed effect of this line on the payout, paise |
| `contribution_bucket` | `TEXT` | `gross` / `fee` / `gst` / `refund` / `dispute` / `adjustment` |
| `contribution_reason` | `TEXT` | one line: why this record moved the payout |

Index: `(run_id, settlement_id)`, `(run_id, order_id)`, `(run_id, type)`

### `bank_lines` — Source C
| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | |
| `run_id` | `TEXT` FK | |
| `line_no` | `INT` | order in the statement |
| `value_date` | `DATE` | |
| `narration` | `TEXT` | the messy free-text field |
| `ref_no` | `TEXT` | nullable |
| `debit` | `BIGINT` | |
| `credit` | `BIGINT` | |
| `closing_balance` | `BIGINT` | |
| `parsed_utr` | `TEXT` | filled by normalization |
| `parse_source` | `TEXT` | `regex` / `llm` / `failed` |

Index: `(run_id, parsed_utr)`, `(run_id, value_date)`, `(run_id, credit)`

### `settlement_composition`
One row per settlement per run. The named-bucket ladder. Written by Pass 6B.

| Column | Type | Notes |
|---|---|---|
| `run_id` | `TEXT` FK | PK part 1 |
| `settlement_id` | `TEXT` | PK part 2 |
| `gross_payments` | `BIGINT` | Σ payment line `amount` |
| `fees_total` | `BIGINT` | Σ payment line `fee` |
| `gst_total` | `BIGINT` | Σ payment line `tax` |
| `refunds_total` | `BIGINT` | Σ refund line `debit` |
| `disputes_total` | `BIGINT` | Σ dispute line `debit` |
| `adjustments_net` | `BIGINT` | Σ adjustment `credit` − Σ adjustment `debit`. **Signed** |
| `expected_payout` | `BIGINT` | derived, see the identity in Pass 6B |
| `header_amount` | `BIGINT` | what Razorpay's settlement header claims |
| `bank_credit_total` | `BIGINT` | Σ credit on linked bank lines. `NULL` if unlinked |
| `diff_expected_vs_header` | `BIGINT` | `expected_payout − header_amount` |
| `diff_header_vs_bank` | `BIGINT` | `header_amount − bank_credit_total` |
| `diff_total` | `BIGINT` | `expected_payout − bank_credit_total` |
| `payment_count` | `INT` | |
| `refund_count` | `INT` | |
| `dispute_count` | `INT` | |
| `adjustment_count` | `INT` | |
| `status` | `TEXT` | `FULLY_RECONCILED` / `RECONCILED_WITH_ROUNDING` / `DISCREPANCY` / `UNMATCHED_TO_BANK` |
| `discrepancy_component` | `TEXT` | `NONE` / `GROSS` / `FEES` / `GST` / `REFUNDS` / `DISPUTES` / `ADJUSTMENTS` / `BANK_CREDIT` / `ROUNDING` / `UNATTRIBUTED` |
| `computed_at` | `TIMESTAMPTZ` | |

PK: `(run_id, settlement_id)`. Index: `(run_id, status)`, `(run_id, diff_total DESC)`, `(run_id, discrepancy_component)`

**Three differences, not one.** `diff_expected_vs_header` catches errors inside Razorpay's own report. `diff_header_vs_bank` catches errors between Razorpay and the bank. `diff_total` is what the merchant actually cares about. Collapsing them into a single number loses the ability to say *whose* number is wrong, which is the whole point.

### `links`
Proposed relationships between records. The output of matching.

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | |
| `run_id` | `TEXT` FK | |
| `left_source` | `TEXT` | `bank` / `settlement` / `settlement_line` / `order` |
| `left_id` | `TEXT` | |
| `right_source` | `TEXT` | |
| `right_id` | `TEXT` | |
| `relation` | `TEXT` | `bank_to_settlement` / `line_to_order` / `refund_to_order` |
| `pass` | `INT` | which pass produced it (1–6) |
| `confidence` | `NUMERIC(5,4)` | 0.0000–1.0000. Not money, so NUMERIC is fine |
| `evidence` | `JSONB` | keys used, deltas, competing candidates |

Index: `(run_id)`, `(run_id, left_source, left_id)`, `(run_id, right_source, right_id)`

### `exceptions`
| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT` PK | |
| `run_id` | `TEXT` FK | |
| `record_source` | `TEXT` | |
| `record_id` | `TEXT` | |
| `class` | `TEXT` | one of the 15 taxonomy values |
| `decision` | `TEXT` | `AUTO_RESOLVED` / `NEEDS_REVIEW` / `UNRESOLVED` |
| `confidence` | `NUMERIC(5,4)` | |
| `amount_impact` | `BIGINT` | paise, the size of the break |
| `evidence` | `JSONB` | the bundle sent to the LLM |
| `deterministic_reason` | `TEXT` | template string, always present |
| `ai_explanation` | `TEXT` | nullable |
| `ai_status` | `TEXT` | `ok` / `rejected_by_guard` / `not_requested` / `error` |
| `next_action` | `TEXT` | from the taxonomy |
| `created_at` | `TIMESTAMPTZ` | |

Index: `(run_id, decision)`, `(run_id, class)`, `(run_id, amount_impact DESC)`

### `audit_log`
Append-only. One row per decision the system makes.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `run_id` | `TEXT` FK | |
| `at` | `TIMESTAMPTZ` | default now() |
| `subject_source` | `TEXT` | |
| `subject_id` | `TEXT` | |
| `action` | `TEXT` | `LINKED` / `CLASSIFIED` / `AUTO_RESOLVED` / `ESCALATED` / `REFUSED` |
| `rule` | `TEXT` | e.g. `pass1.utr_exact`, `pass6.mdr_recompute` |
| `confidence` | `NUMERIC(5,4)` | |
| `detail` | `JSONB` | |

Index: `(run_id, at)`, `(subject_source, subject_id)`

### `run_metrics`
| Column | Type |
|---|---|
| `run_id` | `TEXT` PK FK |
| `payload` | `JSONB` — the whole metrics object from §16 |

### `llm_calls`
| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `run_id` | `TEXT` FK | |
| `purpose` | `TEXT` | `narration` / `explain` / `qa` |
| `prompt_hash` | `TEXT` | for dedupe/caching |
| `latency_ms` | `INT` | |
| `guard_result` | `TEXT` | `pass` / `reject` / `n/a` |
| `rejected_tokens` | `JSONB` | which numbers failed the guard |

Relationships in one line: a **run** owns everything; **links** connect records across sources; **exceptions** describe records; **audit_log** records every decision; **llm_calls** records every AI invocation and whether the guard caught it.

---

# 7. Synthetic dataset schemas

## Source A — Merchant Order Ledger (`orders.csv`)

| Field | Type | Meaning |
|---|---|---|
| `order_id` | string | Internal ID, `ord_<12 chars>` |
| `order_ref` | string | Human reference the merchant uses, `KK-2026-04412` |
| `customer_ref` | string | Pseudonymous customer key, `cust_a91f` |
| `order_amount_paise` | integer | Gross order value. ₹1,000 → `100000` |
| `currency` | string | `INR` throughout |
| `created_at` | ISO8601 +05:30 | When the order was placed |
| `order_status` | enum | `paid` / `refunded` / `partially_refunded` / `cancelled` |
| `refund_issued_paise` | integer | Total refunded against this order, `0` if none |

## Source B1 — Settlement headers (`settlements.csv`)

| Field | Type | Meaning |
|---|---|---|
| `settlement_id` | string | `setl_<14 chars>` |
| `amount_paise` | integer | Net amount actually transferred |
| `fees_paise` | integer | Sum of MDR across all lines |
| `tax_paise` | integer | Sum of GST on MDR |
| `utr_number` | string | Bank reference for this transfer |
| `status` | enum | `processed` / `failed` |
| `created_at` | ISO8601 | When the payout was initiated |

## Source B2 — Settlement lines (`settlement_lines.csv`)

Field-for-field mirror of Razorpay's recon API item.

| Field | Type | Meaning |
|---|---|---|
| `entity_id` | string | `pay_...`, `rfnd_...`, `adj_...`, `dsp_...` |
| `type` | enum | `payment` / `refund` / `adjustment` / `dispute` / `transfer` |
| `debit_paise` | integer | Money out of your balance (refunds, disputes) |
| `credit_paise` | integer | Money into your balance (payments), **net of fee and tax** |
| `amount_paise` | integer | Gross transaction value |
| `fee_paise` | integer | MDR on this line |
| `tax_paise` | integer | GST on that MDR |
| `on_hold` | boolean | `true` = frozen, will not settle yet |
| `settled` | boolean | |
| `created_at` | ISO8601 | Capture time |
| `settled_at` | ISO8601 or empty | |
| `settlement_id` | string or empty | Empty means not yet in any payout |
| `settlement_utr` | string or empty | |
| `order_id` | string or empty | Link back to Source A. **Deliberately empty on some rows** |
| `method` | enum | `card` / `upi` / `netbanking` / `wallet` |
| `card_network` | string or empty | `VISA` / `MASTERCARD` / `RUPAY` / `AMEX` |
| `card_type` | enum or empty | `credit` / `debit` |
| `international` | boolean | Drives a different MDR tier |
| `dispute_id` | string or empty | |
| `description` | string | Free text. Mostly meaningful only on adjustments |

Key relationship: for a payment line, `credit = amount − fee − tax`. That identity is checkable, and breaking it deliberately in a few rows is one of the injected cases.

## Source C — Bank Statement (`bank_statement.csv`)

| Field | Type | Meaning |
|---|---|---|
| `line_no` | integer | Statement row order |
| `value_date` | `YYYY-MM-DD` | Date the bank credited the account |
| `narration` | string | **Free text. The hard part.** Contains the UTR, usually |
| `ref_no` | string | Bank's own reference. Sometimes blank, sometimes useless |
| `debit_paise` | integer | |
| `credit_paise` | integer | |
| `closing_balance_paise` | integer | Running balance. Useful as an integrity check |

## Ground Truth (`ground_truth.json`)

```jsonc
{
  "batch_id": "main-v1",
  "seed": 20260827,
  "profile": "kiranakart",
  "generated_at": "2026-08-28T...",
  "records": [
    {
      "record_id": "bank_0042",
      "source": "bank",
      "injected_case": "aggregated_credit",
      "expected_link_ids": ["setl_A1b2C3", "setl_D4e5F6"],
      "expected_class": "MATCHED_EXACT",
      "expected_decision": "AUTO_RESOLVED",
      "is_resolvable": true,
      "expected_reason": "One NEFT credit covers two settlements from 12 Apr"
    }
  ],
  "totals": {
    "records": 300,
    "resolvable": 286,
    "unresolvable_by_design": 14,
    "gross_amount_paise": 28419340,
    "expected_fee_paise": 512400,
    "expected_gst_paise": 92232
  }
}
```

`is_resolvable: false` is the field almost nobody thinks to include. It is what lets you measure "did the system correctly refuse?"

`expected_decision` lets you measure whether confidence routing works, separately from whether matching works.

---

# 8. Data generation

## Determinism

Use a seeded PRNG, not `Math.random()`. **mulberry32** is nine lines and reproducible across machines:

- Constructor takes a 32-bit seed
- Every random draw goes through this one instance
- The generator takes `--seed` and `--profile` as CLI arguments
- Running `npm run generate -- --seed 20260827 --profile kiranakart` twice must produce byte-identical CSVs

Add a test that asserts this. Reproducibility is a claim you make in the README, so it must be enforced by CI-style checking, not by hope.

## Generation order

Generate forward through the real-world causal chain, then *derive* ground truth from what you did. Never generate the answer and work backwards.

```
1. Merchant profile        → rate card, volume/day, method mix, refund rate, bank
2. Orders (Source A)       → 21 days of orders with realistic amount distribution
3. Payments                → mostly 1:1 with orders, method sampled from the mix
4. Fees + GST              → computed from the rate card, in integer paise
5. Refunds                 → sampled from the refund rate, dated after their order
6. Disputes                → small count, mark the payment on_hold
7. Adjustments             → a few, with free-text descriptions
8. Settlement batching     → group by T+2 business-day cycle → settlement headers
9. Bank credits (Source C) → one per settlement, narration from a template
10. INJECT ANOMALIES       → mutate the clean output (see below)
11. Emit ground truth      → record what each mutation did and whether it is resolvable
```

## Amount distribution

Not uniform. Real D2C order values are lognormal-ish. Sample from a mixture: 70% in ₹300–₹2,500, 25% in ₹2,500–₹10,000, 5% in ₹10,000–₹60,000. Round to realistic price points (ending in 9, 0, 99). Uniform random amounts are a tell that a judge will notice.

## Money arithmetic

```
fee   = roundHalfUp(amount_paise * mdr_bps / 10000)
gst   = roundHalfUp(fee * 1800 / 10000)          // 18% GST on the fee
credit = amount_paise - fee - gst
```

All integer. `roundHalfUp` is explicit and tested. Define it once in `lib/money.ts` and never inline it.

## Rate card (main profile)

| Method | Condition | MDR |
|---|---|---|
| UPI | any | **0 bps** (zero MDR in India) |
| Card | domestic debit | 90 bps |
| Card | domestic credit | 200 bps |
| Card | international | 300 bps |
| Netbanking | any | 190 bps |
| Wallet | any | 200 bps |

GST on MDR: 1800 bps (18%).

The UPI-zero-MDR rule creates a natural, realistic `FEE_OVERCHARGE` case: a UPI line charged as if it were a card.

## The 14 injected cases

Each mutation runs on the clean dataset and writes its own ground-truth entry. Target counts for a 300-record batch:

| # | Case | ~Count | How it is generated | Resolvable? |
|---|---|---|---|---|
| 1 | **Exact match** | ~180 | No mutation. Clean chain from order → payment → settlement → bank credit | Yes |
| 2 | **Timing difference** | ~24 | Move a payment's capture time to just before the T+2 cutoff so it lands in the *next* settlement cycle. Order date and settlement date differ by 3–4 days | Yes, rule |
| 3 | **Refund netted** | ~24 | Add a refund line with `debit > 0` into a settlement whose payments are unrelated to it. The payout is now "short" by the refund amount | Yes, rule |
| 4 | **Partial settlement** | ~9 | Split one payment's credit across two settlement IDs, each carrying part of the amount and a proportional share of fee/tax | Yes, pass 3 |
| 5 | **Split payout** | ~9 | One settlement paid to the bank as two separate NEFT credits with the same UTR prefix but different amounts summing to the total | Yes, pass 3 |
| 6 | **Aggregated credit** | ~9 | Two settlements collapsed into one bank credit line, narration mentioning only one UTR | Yes, subset-sum |
| 7 | **Duplicate credit** | ~3 | Copy a bank credit line, same UTR, same amount, next day. Bank posted twice | Yes, dedupe |
| 8 | **Missing in bank** | ~6 | Delete the bank line for one settlement. Payout initiated, never landed | **Detected, not resolved** |
| 9 | **Dispute hold** | ~9 | Set `on_hold = true`, `settlement_id = null` on a captured payment, create a `dsp_...` id | Yes, with reason |
| 10 | **Rounding residual** | ~12 | Perturb a settlement header amount by 1–99 paise | Yes, auto write-off |
| 11 | **Fee overcharge** | ~6 | Charge a UPI line at card rates, or apply the credit-card tier to a debit card | Yes, pass 6 |
| 12 | **Opaque adjustment** | ~9 | Adjustment line with descriptions like `MISC DR ADJ REF 88213`, `chargeback prov reversal Q1`, `svc adj — see note` | LLM-classified |
| 13 | **Ambiguous match** | ~6 | Two payments, identical amount, same day, both with `order_id` blank, bank narration carrying no order reference | **No — by design** |
| 14 | **Corrupted narration** | ~3 | Truncate the narration mid-UTR, or mangle characters (`1568176960vxp0`, `156817696OvxpOrj`) | **No — by design** |

Cases 8, 13 and 14 give you roughly **14 genuinely unresolvable records**. That is your honest exception list, and it is the most important part of the dataset.

## Narration templates

14 templates, sampled per bank credit:

```
NEFT-RAZORPAY SOFTWARE PVT LTD-{utr}-HDFC
IMPS/P2A/{ref}/RAZORPAY/SETTLEMENT
RTGS CR RAZORPAYSOFT UTR{utr}
NEFT CR-HDFC0000060-RAZORPAY SOFTWA-{UTR_UPPER}-
UPI/SETTLEMENT/{utr}/RAZORPAY
MMT/IMPS/{ref}/Razorpay Settle/HDFC
NEFT INWARD {utr} RAZORPAY SOFTWARE PRIVATE LIMI
BY TRANSFER-NEFT*HDFC0000060*{utr}*RAZORPAY
...
```

Vary case, separators, truncation length and whether `ref_no` is populated. Three templates should defeat a naive regex — that is what earns the LLM parser its place.

---

# 9. Held-out dataset

Same generator, six things changed. Run it as `--seed 771144 --profile bombayweave`.

| Axis | Main (`kiranakart`) | Held-out (`bombayweave`) |
|---|---|---|
| **Seed** | 20260827 | 771144 |
| **Merchant** | D2C snacks, ₹300–₹60,000 orders, high volume low value | Apparel, ₹1,200–₹1,80,000, lower volume higher value, **much higher refund rate** (apparel returns) |
| **Method mix** | UPI 55%, card 30%, netbanking 10%, wallet 5% | Card 60% (more credit cards), UPI 25%, netbanking 15%, **8% international** |
| **Bank** | HDFC-style narrations | ICICI/Axis-style narrations — **different 14 templates**, different separators, `ref_no` blank far more often |
| **Rate card** | 200 bps credit card, 90 debit | **175 bps credit, 75 debit, ₹12 flat netbanking** — a flat-fee tier the main batch never contains |
| **Anomaly mix** | Balanced across all 14 | **Skewed**: more aggregation and split cases, more corrupted narration, fewer clean exact matches |

**Why this makes the evaluation credible.** The obvious attack on any synthetic-data project is "you wrote the generator, so of course you match it." That attack lands if you tune thresholds, regexes and prompts on the same distribution you report on.

By tuning on `main` and reporting headline numbers on `holdout`, you can say: *different seed, different merchant, different bank, different fee structure — including a flat-fee tier my rate card logic had never seen — and here are the numbers.* You are testing generalisation, not memorisation.

**Rule you must not break:** you may look at held-out metrics **once per day, at most.** If you start tuning against held-out results, it stops being held-out and the claim becomes false. Note each look in `FAILURES.md`.

The flat-fee netbanking tier is deliberately adversarial: your Pass 6 fee audit will probably flag every netbanking line on the held-out batch as an overcharge on first run. That is a real finding, and how you handle it (parameterise the rate card rather than hardcode bps) is a good story for the panel.

---

# 10. The reconciliation engine

**Rules for the whole engine:** integer paise only, no floating point anywhere, no `parseFloat` on money, no AI. Every pass returns links with evidence attached. Every pass is a pure function — inputs in, results out, no database writes. `run.ts` orchestrates and persists.

---

## Pass 0 — Normalize

**Input:** raw parsed CSV rows.
**Algorithm:**
- Money strings → integer paise via `parseMoney()`. Reject anything with more than 2 decimal places.
- Dates → `Date` in IST. Compute `settlement_cycle_date` = capture date + 2 business days (skip Sat/Sun; a fixed holiday list is fine and more realistic than none).
- Narration → try regex extraction of a UTR (`/\b[0-9a-zA-Z]{12,22}\b/` filtered against the known UTR shape, plus template-specific patterns). Record `parse_source: 'regex'`.
- If regex fails, mark `parse_source: 'pending_llm'`. The AI layer picks these up later.
**Output:** normalized record sets + a list of `INVALID_ROW` exceptions.
**Failure condition:** unparseable amount or date → `INVALID_ROW`, carried forward, never dropped.

---

## Pass 1 — Bank credit ↔ Settlement, by UTR

**Input:** bank lines with a `parsed_utr`, settlement headers.
**Algorithm:** exact string match on normalized UTR (uppercase, strip non-alphanumerics). Then verify `bank.credit == settlement.amount`. If both hold, link with confidence 1.0.
**Output:** `bank_to_settlement` links, `pass: 1`.
**Evidence:** `{ key: 'utr_exact', utr, bank_credit, settlement_amount, amount_delta: 0 }`
**Failure conditions:**
- UTR matches but amounts differ → do **not** link at full confidence. Emit a candidate with `amount_delta` and hand to Pass 3 (it may be a split).
- Same UTR appears on two bank lines → `DUPLICATE_CREDIT`, keep the first, flag the second.
**Example:** bank line 42 narration contains `1568176960vxp0rj`, credit `2841934` paise; settlement `setl_DGlQ1` has utr `1568176960vxp0rj`, amount `2841934`. Linked, confidence 1.0.

---

## Pass 2 — Bank credit ↔ Settlement, by amount + date

**Input:** bank lines still unlinked after Pass 1 (UTR unparseable or absent).
**Algorithm:**
1. For each unlinked bank credit, find settlements where `|bank.value_date − settlement.created_at| ≤ 2 days`.
2. Filter to those where `|bank.credit − settlement.amount| ≤ 100` paise (₹1 tolerance).
3. Count candidates:
   - **exactly 1 candidate** → link. Confidence 0.85 if amount exact, 0.75 if within tolerance.
   - **0 candidates** → leave unlinked, goes to Pass 3.
   - **2+ candidates** → **do not link.** Emit all candidates as evidence, confidence = `0.3 / candidate_count`. This is the ambiguous case and it must escalate, not guess.
**Output:** links with `pass: 2`, or a multi-candidate exception.
**Evidence:** `{ key: 'amount_date', amount_delta, date_delta_days, candidate_count, candidates: [...] }`
**Failure condition:** ambiguity. This is where injected case 13 lands, and refusing here is the behaviour you demo at 3:00 in the pitch.
**Example:** bank credit of `1247500` on 14 Apr, two settlements of `1247500` created 13 Apr. Two candidates → confidence 0.15 → `UNRESOLVED`, next action "confirm UTR with bank."

---

## Pass 3 — Aggregation and splits (subset-sum)

**Input:** bank lines and settlements still unlinked after Passes 1–2.
**Algorithm — two directions:**

*(a) One bank credit covers N settlements.* For each unlinked bank credit, take all unlinked settlements within ±2 days as the candidate pool. Search for a subset summing exactly to `bank.credit`. Constraints that keep this fast and honest:
- Pool capped at 12 settlements (date window guarantees this in practice)
- Subset size capped at **k ≤ 4**
- Depth-first search with pruning: sort descending, abandon a branch once the running sum exceeds the target
- If **more than one** distinct subset sums to the target, **refuse** — ambiguity, not a match

*(b) One settlement paid as N bank credits.* The mirror image. For each unlinked settlement, search unlinked bank credits within ±2 days for a subset summing to `settlement.amount`. Same caps, same ambiguity rule.

**Output:** one link per (bank, settlement) pair in the resolved subset, `pass: 3`, confidence 0.9 for a unique exact subset.
**Evidence:** `{ key: 'subset_sum', direction: 'many_settlements_one_credit', members: [...], subset_size: 2, alternatives_found: 1 }`
**Failure condition:** zero subsets found, or more than one. Both escalate. Emit `alternatives_found` in evidence — it is the honest thing to show a judge.
**Example:** bank credit `4113200` on 16 Apr. Settlements `setl_A` = `2841934` and `setl_B` = `1271266` both dated 15 Apr, and 2841934 + 1271266 = 4113200 exactly, uniquely. Both linked at 0.9.

**Complexity note for the panel:** worst case is C(12,4) = 495 combinations per bank credit, with ~19 bank credits. Under 10,000 operations. This is why no queue and no worker process are needed.

---

## Pass 4 — Settlement internal balance

**Input:** settlement headers + their lines.
**Algorithm:** for each settlement, assert
```
Σ(line.credit) − Σ(line.debit) == settlement.amount
Σ(line.fee)                    == settlement.fees
Σ(line.tax)                    == settlement.tax
```
and per payment line, assert `credit == amount − fee − tax`.
**Output:** no links; a per-settlement balance verdict and a residual amount.
**Evidence:** `{ key: 'internal_balance', computed_net, header_amount, residual_paise, failing_lines: [...] }`
**Failure conditions:**
- `residual` between 1 and 99 paise → `ROUNDING_RESIDUAL`, auto-resolved with write-off
- `residual` ≥ 100 paise → `AMOUNT_MISMATCH`, escalate, and name the failing lines
**Example:** header says `2841934`, lines net to `2841937`. Residual 3 paise → auto write-off, logged.

**Why this pass exists:** it catches errors *inside* Source B, independent of the bank. No amount of bank matching would find a settlement report that does not add up.

---

## Pass 5 — Settlement line ↔ Order

**Input:** settlement lines of type `payment` and `refund`, plus orders.
**Algorithm — tiered, first hit wins:**
1. `line.order_id == order.order_id` → confidence 1.0
2. `line.amount == order.order_amount` **and** capture within order_date + 0..3 days **and exactly one such order** → confidence 0.8
3. Same as (2) but 2+ candidate orders → confidence `0.3 / n`, escalate
4. Refund lines: match to an order whose `refund_issued > 0` and where amounts reconcile → `refund_to_order` link
**Output:** `line_to_order` links, `pass: 5`.
**Evidence:** `{ key: 'order_id' | 'amount_date_unique' | 'ambiguous', amount_delta, date_delta_days, candidate_count }`
**Failure condition:** order exists but no settlement line → `MISSING_IN_LEDGER` unless the line is `on_hold`, in which case `DISPUTE_HOLD`. Getting this distinction right is the difference between a system that understands payments and one that does string matching.
**Example:** line `pay_XyZ` amount `129900`, `order_id` blank; exactly one order of `129900` created 11 hours earlier. Linked at 0.8, evidence records the 11-hour delta.

---

## Pass 6 — Fee and GST audit

**Input:** every settlement line of type `payment` + the rate card.
**Algorithm:**
```
expected_bps = rateCard.lookup(method, card_type, international)
expected_fee = roundHalfUp(amount * expected_bps / 10000)
expected_gst = roundHalfUp(expected_fee * 1800 / 10000)
fee_delta    = actual_fee - expected_fee
gst_delta    = actual_tax - expected_gst
```
**Output:** a fee verdict per line and a run-level `total_overcharge_paise`.
**Evidence:** `{ key: 'rate_card', method, card_type, international, expected_bps, expected_fee, actual_fee, fee_delta }`
**Failure conditions:**
- `|fee_delta| ≤ 1` paise → tolerated, rounding
- `fee_delta > 1` → `FEE_OVERCHARGE`, escalate with the rupee impact
- `fee_delta < −1` → also flag. Being undercharged is still a reconciliation break
- Method not in rate card → escalate as `AMOUNT_MISMATCH` rather than assuming zero. **This is what will fire on the held-out batch's flat-fee netbanking tier**
**Example:** UPI line, amount `85000`, actual fee `1700`. Expected `0`. Delta `1700` (₹17) → `FEE_OVERCHARGE`, next action "raise with Razorpay support, cite entity_id."

---

## Pass 6B — Settlement composition

**Runs for every settlement, reconciled or not.** A perfectly matched settlement still gets a full composition, because "it tied out" and "here is what it was made of" are different answers and the merchant needs both.

**Input:** settlement headers, their lines, the bank links from Passes 1–3, the fee verdicts from Pass 6.

**Algorithm.** For each settlement, bucket its lines and sum. All integer paise.

```
gross_payments   = Σ  line.amount        where type = 'payment'
fees_total       = Σ  line.fee           where type = 'payment'
gst_total        = Σ  line.tax           where type = 'payment'
refunds_total    = Σ  line.debit         where type = 'refund'
disputes_total   = Σ  line.debit         where type = 'dispute'
adjustments_net  = Σ  line.credit − Σ line.debit   where type in ('adjustment','transfer')

expected_payout  = gross_payments
                 − fees_total
                 − gst_total
                 − refunds_total
                 − disputes_total
                 + adjustments_net

bank_credit_total = Σ credit on bank lines linked to this settlement   (null if unlinked)

diff_expected_vs_header = expected_payout  − header_amount
diff_header_vs_bank     = header_amount    − bank_credit_total
diff_total              = expected_payout  − bank_credit_total
```

Then attach a **signed contribution** to every line, so the drill-down adds up:

| Line type | `contribution` | `contribution_bucket` |
|---|---|---|
| `payment` | `+(amount − fee − tax)` | `gross` (with `fee`/`gst` shown as sub-rows) |
| `refund` | `−debit` | `refund` |
| `dispute` | `−debit` | `dispute` |
| `adjustment` / `transfer` | `+credit − debit` | `adjustment` |

**Output:** one `settlement_composition` row, plus `contribution` / `contribution_bucket` / `contribution_reason` written onto every settlement line.

**Status assignment:**

| Condition | `status` |
|---|---|
| `diff_total == 0` and bank linked | `FULLY_RECONCILED` |
| `1 ≤ |diff_total| ≤ 99` paise and bank linked | `RECONCILED_WITH_ROUNDING` |
| bank not linked (Passes 1–3 found nothing) | `UNMATCHED_TO_BANK` |
| otherwise | `DISCREPANCY` |

**Discrepancy attribution.** When `status = DISCREPANCY`, name the bucket. Evaluate in this order, first hit wins:

1. `|diff_total| == |Σ fee_delta from Pass 6|` → `FEES`
2. `|diff_total| == |Σ gst_delta from Pass 6|` → `GST`
3. A refund line in this settlement has no linked order (Pass 5) and its debit equals the difference → `REFUNDS`
4. A dispute line is present and its debit equals the difference → `DISPUTES`
5. An adjustment line is present with an unclassified description and its net equals the difference → `ADJUSTMENTS`
6. `diff_expected_vs_header == 0` but `diff_header_vs_bank ≠ 0` → `BANK_CREDIT` (Razorpay's lines are internally consistent; the bank is the odd one out)
7. `|diff_total| < 100` → `ROUNDING`
8. none of the above → `UNATTRIBUTED`

`UNATTRIBUTED` is a legitimate outcome and must appear in the UI as such. **Do not force an attribution.** Guessing which bucket is at fault is the same failure mode as guessing a match, and it is worse here because the guess looks authoritative in a ladder.

**Conservation, asserted at runtime.** Two identities are checked for every settlement and the run fails loudly if either breaks:

```
A.  gross − fees − gst − refunds − disputes + adjustments_net  ==  expected_payout
B.  Σ line.contribution                                        ==  expected_payout
```

Identity B is the one that matters for the UI: it guarantees the drill-down table a judge scrolls through actually sums to the number at the top of the page.

**Failure conditions:**
- A settlement with zero lines → composition of all zeros, `status = DISCREPANCY`, component `UNATTRIBUTED`. Do not skip it; a payout with no lines behind it is a serious finding
- Bank link exists but points at multiple credits (split payout) → sum them, and record `bank_line_count` in evidence
- Identity A or B fails → throw. This is a code bug, not a data finding, and it must never reach the UI

**Example (the demo case):**

```
Gross payments      ₹1,00,000.00     18 payments
− Razorpay fees        ₹2,000.00     rate card: 200 bps, credit card
− GST on fees            ₹360.00     18% of ₹2,000.00
− Refunds              ₹1,000.00     1 refund, order KK-2026-04198
− Disputes                 ₹0.00
− Adjustments              ₹0.00
──────────────────────────────────
Expected payout       ₹96,640.00
Header amount         ₹96,640.00     diff_expected_vs_header = ₹0.00
Bank received         ₹96,640.00     diff_header_vs_bank     = ₹0.00
Difference                 ₹0.00     status = FULLY_RECONCILED
```

**Contrast case (the exception the demo shows next):** identical shape, `refunds_total = ₹5,820.00`, `diff_total = ₹4,820.00`, `discrepancy_component = REFUNDS`, and the drill-down shows the two refund lines whose orders were never matched.

**Why this is a pass and not a UI concern.** If composition were computed in the frontend, it would be a second implementation of the arithmetic, it would drift from Pass 4, and it could not be tested or audited. It is computed once, persisted, and rendered.

---

## Pass 7 — Classify, score, decide

Not really a matching pass; it is the funnel that turns pass output into the exception queue. Every record ends with exactly one class (§11), one confidence (§12), one decision, one deterministic reason string, and one next action. Where the record is a settlement with a non-zero difference, the exception also carries the `discrepancy_component` from Pass 6B, so the queue can say *which bucket* is wrong rather than only *that something* is wrong. `run.ts` then writes links, compositions, exceptions and audit rows in a single transaction.

---

# 11. Exception taxonomy

| Exception | Meaning (plain) | Detection | Auto-resolve? | Evidence shown | Next action |
|---|---|---|---|---|---|
| `MATCHED_EXACT` | Everything ties out to the paise | Pass 1/3/5 link with confidence ≥ threshold and zero residual | **Yes** | Both records, UTR, zero delta | None |
| `FEE_DEDUCTION` | Payout is lower because of MDR. Expected | Pass 6 fee within tolerance of rate card | **Yes** | Rate card row, expected vs actual | None; post to fee expense |
| `GST_ON_FEE` | Payout lower because of 18% GST on the fee. Expected | Pass 6 GST within tolerance | **Yes** | Fee, 18%, computed GST | Claim as input tax credit |
| `TDS_194O` | 1% income tax withheld at source on gross sales | Line type `adjustment` with a TDS signature | No | Adjustment line, gross base, 1% | Verify against Form 26AS within 2 business days |
| `TIMING_DIFFERENCE` | Amount is right, period is wrong. Captured near the cutoff, settled next cycle | Pass 5 links but `date_delta` exceeds the normal cycle | **Yes** | Capture time, cutoff, cycle dates | Carry forward to next period |
| `PARTIAL_SETTLEMENT` | One payment paid out across two settlements | Pass 3 direction (b), unique subset | **Yes** | Both settlement IDs, part amounts, sum | None |
| `SPLIT_PAYOUT` | One settlement arrived as multiple bank credits | Pass 3 direction (b) on bank side | **Yes** | Credit lines, subset, sum | None |
| `REFUND_NETTED` | Payout is short because refunds were deducted | Refund line with `debit > 0` inside the settlement | **Yes** | Refund line, original order, amount | Post refund against revenue |
| `DISPUTE_HOLD` | Money frozen while a chargeback is investigated | `on_hold = true`, `settlement_id` null, `dispute_id` present | No | Payment, dispute id, hold date | Track dispute; do not treat as receivable |
| `DUPLICATE_CREDIT` | The bank posted the same credit twice | Two bank lines, same UTR, same amount | No | Both lines, UTR, dates | Confirm with bank within 1 business day |
| `MISSING_IN_BANK` | Razorpay says paid, bank shows nothing | Settlement with no link after passes 1–3 | No | Settlement, UTR, expected amount, date | Contact bank with UTR within 1 business day |
| `MISSING_IN_LEDGER` | Money arrived that the merchant's own system does not know about | Bank credit with no link after passes 1–3 | No | Bank line, narration, amount | Investigate source; possible unrecorded sale |
| `AMOUNT_MISMATCH` | Records link but the numbers do not agree beyond tolerance | Pass 4 residual ≥ ₹1, or linked pair with material delta | No | Both records, computed residual | Escalate to finance manager if > ₹10,000; 3 business days |
| `FEE_OVERCHARGE` | Fee charged does not match the contracted rate | Pass 6 `fee_delta` beyond tolerance | No | Rate card, expected vs actual, ₹ impact | Raise with Razorpay support, cite entity_id |
| `ROUNDING_RESIDUAL` | Difference under ₹1 | Pass 4 residual between 1 and 99 paise | **Yes** (write-off) | Residual amount | Write off below materiality |
| `UNRESOLVED` | System could not determine the answer and refuses to guess | No link, or multiple equally plausible candidates | **No** | All competing candidates, why each failed | Manual investigation |

*(15 classes plus `INVALID_ROW` for unparseable input rows.)*

**Taxonomy and composition are orthogonal, and both are shown.** The class says *what kind of problem this is*. The `discrepancy_component` from Pass 6B says *which bucket of the ladder the money went missing from*. A `REFUND_NETTED` exception carries component `REFUNDS`; a `FEE_OVERCHARGE` carries `FEES`; a `MISSING_IN_BANK` carries `BANK_CREDIT`. They will often agree, and where they disagree that is itself informative — a `AMOUNT_MISMATCH` with component `UNATTRIBUTED` is the hardest kind of break and should sort to the top of a human's queue.

## The five that matter most, in beginner terms

**`REFUND_NETTED`** — the single most common "why is my payout short" question in real life. Customer bought ₹2,000 of shoes on Monday, returned them Wednesday. Wednesday's payout is ₹2,000 lower than the day's sales. Nothing is wrong. Setl says so in one sentence instead of you finding it in a spreadsheet.

**`DISPUTE_HOLD`** — looks identical to a missing payment if you do not know what a hold is. The payment exists, it was captured, and it is deliberately not in any settlement because a customer's bank is disputing it. Classifying this correctly instead of as `MISSING_IN_LEDGER` is the clearest signal in the whole taxonomy that you understand payments.

**`MISSING_IN_BANK`** — genuinely serious. Razorpay's report says the money left, the bank shows nothing. Either the transfer failed or a bank statement is incomplete. One business day SLA.

**`FEE_OVERCHARGE`** — real money, and it compounds. A 25 bps error on ₹5 crore a month is ₹1.25 lakh. Merchants almost never check this because it requires recomputing every line.

**`UNRESOLVED`** — not a failure. It is the system declining to corrupt the ledger with a guess. In the demo, spend a full minute here.

---

# 12. Confidence system

## The score

Confidence is deterministic, computed from evidence quality. Range [0, 1].

```
confidence = key_strength × amount_factor × date_factor × ambiguity_factor
```

| Component | Values |
|---|---|
| `key_strength` | UTR exact 1.00 · order_id exact 0.95 · subset-sum unique 0.90 · amount+date unique 0.80 · amount+date ambiguous 0.30 |
| `amount_factor` | delta = 0 → 1.00 · delta ≤ 100 paise → 0.95 · delta ≤ 0.1% → 0.85 · else 0.50 |
| `date_factor` | within cycle → 1.00 · +1 day → 0.95 · +2–3 days → 0.85 · beyond → 0.70 |
| `ambiguity_factor` | 1 candidate → 1.00 · 2 → 0.50 · 3 → 0.33 · n → 1/n |

Every component is inspectable in the UI. When a judge asks "why 0.87?", you show the four multiplicands. That is not possible with a black box, which is one reason the ML model in §15 has to earn its place rather than being assumed.

## Threshold selection — the experiment

Do **not** hardcode 0.95 and 0.70.

`scripts/sweepThresholds.ts` runs on the **main batch only**:

1. Run the full engine once, keep every link with its confidence and whether ground truth says it is correct
2. For `t_auto` from 0.50 to 1.00 in steps of 0.01, and `t_review` from 0.30 to `t_auto`:
   - Everything ≥ `t_auto` → AUTO_RESOLVED
   - Between `t_review` and `t_auto` → NEEDS_REVIEW
   - Below `t_review` → UNRESOLVED
3. At each point compute: auto-resolution rate, **false-match rate among auto-resolved**, review queue size, correct-refusal rate
4. Write the whole curve to `data/results/sweep.json`

**The selection rule, stated in the README:**

> `t_auto` = the **lowest** threshold at which false-match rate among auto-resolved items is ≤ 0.5% on the tuning batch.
> `t_review` = the **highest** threshold at which correct-refusal rate is ≥ 90%.

Lowest, not highest, for `t_auto` — because subject to the safety constraint you want to automate as much as possible. Stating the constraint first and the objective second is exactly how a risk-aware finance system is designed, and saying it that way in the panel is worth more than the number itself.

Then freeze both thresholds in `config`, record them in `runs.config`, and never touch them again. Report held-out metrics using the frozen values.

**Falsifiability note for the README:** if the sweep shows no threshold achieves ≤ 0.5% false matches, say so and report the best achievable. That finding is more credible than a convenient number.

---

# 13. AI/LLM architecture

## The boundary, stated once

**Deterministic code owns all financial truth.** Arithmetic, totals, matching decisions, fee computation, GST computation, duplicate detection, validation, confidence, the AUTO/REVIEW/UNRESOLVED decision. If the LLM API were down, Setl would still produce a complete, correct reconciliation with template explanations. Build it that way and demo it that way — running the engine with `LLM_ENABLED=false` in front of a judge is a strong move.

**The LLM owns language, and only language.** Three jobs.

---

## Job 1 — Narration parsing

**When:** only for bank lines where regex extraction failed. Roughly 10–15% of lines.

**Exactly what is sent:**
```json
{ "narration": "NEFT CR-HDFC0000060-RAZORPAY SOFTWA-156817696OVXPORJ-" }
```
That is all. **No amounts, no dates, no settlement data.** The model cannot leak a number into a financial field because it is never shown one.

**Expected output (JSON mode):**
```json
{ "utr": "156817696OVXPORJ", "channel": "NEFT", "counterparty": "RAZORPAY SOFTWARE", "confidence": 0.7 }
```

**Post-validation, non-negotiable:** the returned `utr` is checked against the set of known settlement UTRs using normalized comparison plus a bounded fuzzy match (Levenshtein ≤ 2, to catch `O`/`0` and `l`/`1` OCR-style corruption). If it does not resolve to exactly one known UTR, the parse is **discarded** and the line proceeds as `parse_source: 'failed'`. The LLM proposes; deterministic code disposes.

---

## Job 2 — Evidence-grounded explanation

**When:** on demand, per exception, from the Investigation screen. Not for all 300 records — that would be slow and pointless.

**Exactly what is sent** — an evidence bundle where every number is already final and pre-formatted as a string. The composition ladder is part of the bundle:
```json
{
  "exception_class": "REFUND_NETTED",
  "settlement": { "id": "setl_DGlQ1", "date": "2026-04-15" },
  "composition": {
    "gross_payments":  "₹1,00,000.00",
    "fees_total":         "₹2,000.00",
    "gst_total":            "₹360.00",
    "refunds_total":      "₹5,820.00",
    "disputes_total":         "₹0.00",
    "adjustments_net":        "₹0.00",
    "expected_payout":   "₹91,820.00",
    "header_amount":     "₹96,640.00",
    "bank_credit_total": "₹91,820.00",
    "diff_total":         "₹4,820.00",
    "status": "DISCREPANCY",
    "discrepancy_component": "REFUNDS",
    "payment_count": 18, "refund_count": 3
  },
  "contributing_lines": [
    { "type": "refund", "entity_id": "rfnd_A1", "contribution": "−₹2,420.00", "order_ref": "KK-2026-04198", "order_linked": false },
    { "type": "refund", "entity_id": "rfnd_B2", "contribution": "−₹2,400.00", "order_ref": "KK-2026-04212", "order_linked": false }
  ],
  "confidence": 0.94,
  "rule_used": "pass6b.compose + pass4.internal_balance"
}
```

**System prompt constraints:**
- Write 2–3 sentences for a finance associate
- Use only values present in the bundle. **Do not compute, infer, estimate, add, subtract or re-derive any number.** Every total you need is already in `composition`
- If a number you want is not in the bundle, describe it in words instead
- Name the `discrepancy_component` in plain language when it is not `NONE`
- No hedging, no apologising, no restating the class name

**The hard rule, restated because it is the one a judge will probe:** the composition ladder is computed by `pass6b-compose.ts`, persisted to `settlement_composition`, and rendered by the UI directly from the database. The LLM sees it as already-formatted strings. If the LLM API were removed entirely, the ladder, the drill-down and the difference would be unchanged. Demonstrate this with the `LLM_ENABLED=false` toggle.

**Why this is a legitimate LLM job:** turning a nested JSON evidence structure into a sentence a non-engineer understands is genuinely what language models are for. It is not a wrapper — the model receives no raw data and makes no decision.

---

## Job 3 — Grounded Q&A (OPTIONAL)

The model does **not** write SQL. It selects one of six parameterised functions and supplies arguments:

```
unresolvedAbove(amount_paise)
explainSettlement(settlement_id)
breaksByClass(class)
totalByClass()
largestBreak(n)
runSummary()
```

Each function is hand-written SQL you control. The model's output is validated against the function signature before execution; anything else is refused. Text-to-SQL over a financial database is a bad idea and being able to say *why* you rejected it is a better answer than having built it.

---

# 14. Number guard

The mechanism that makes "the AI cannot invent financial facts" a demonstrable claim rather than a promise.

```
LLM explanation text
        ↓
extract every numeric token   (₹4,820.00 · 4820 · 4,820 · 0.94 · 18%)
        ↓
normalize each token          (strip ₹ , spaces; → canonical paise or ratio)
        ↓
compare against allowlist built from the evidence bundle
        ↓
   all present → display explanation, log guard_result: 'pass'
   any missing → REJECT, use deterministic template, log 'reject' + the tokens
```

## Building the allowlist

Walk the evidence bundle recursively and collect every numeric value. For each, add every representation the model might plausibly write:

| Evidence value (paise) | Allowed strings |
|---|---|
| `482000` | `482000`, `4820`, `4,820`, `4820.00`, `4,820.00`, `₹4,820`, `₹4,820.00` |
| `0.94` | `0.94`, `94`, `94%` |
| dates | `2026-04-15`, `15 Apr`, `15 April 2026`, `15/04/2026` |

Also allowlist: small integers 0–10 (counting words like "two refunds"), and the constants `18` and `2` (GST rate, T+2), since these are legitimately part of the domain vocabulary. Document that carve-out in the README rather than hiding it. A judge who spots an undocumented exemption will not trust the rest.

**Composition values are in scope.** Every bucket total, the expected payout, the header amount, the bank credit and all three differences are walked into the allowlist along with everything else. This is deliberate and it is the guard's most important job: the ladder is the most quotable set of numbers in the product, so an explanation that says "the payout was short ₹5,000" when the ladder says ₹4,820 must be rejected, not smoothed over. Write a test for exactly that case.

## On failure

The exception's `ai_status` becomes `rejected_by_guard`, `ai_explanation` stays null, and the UI shows the deterministic `deterministic_reason` template instead — which always exists, so the user never sees an empty box. Log the offending tokens to `llm_calls.rejected_tokens`.

## Dashboard metric

On the Overview screen:

```
AI explanations       142 generated
Guard rejections        3   (2.1%)
```

Make it clickable, showing which numbers were rejected. **Do not engineer this to zero.** A guard that never fires looks like it does not work. Some rejections prove it is live, and a judge asking "has it ever caught anything?" is a question you want to answer with data.

**Test it deliberately:** write a test that feeds a deliberately hallucinated explanation through the guard and asserts rejection. That test is worth showing on screen.

---

# 15. ML decision — a gate, not an assumption

**Default position: rules only.** ML ships only if it passes the gate.

## The protocol

**Step 1 (Day 3).** Complete the rules-only engine. Run `evaluate` on main + held-out. Record baseline: match rate, false-match rate, auto-rate, exception rate. Commit these numbers to `REPORT.md` before writing any model code, so they cannot drift.

**Step 2 (Day 5, only if Day 5 CORE is done).** Train a logistic regression that scores candidate link pairs.

- **Features:** `|amount_delta| / amount`, `date_delta_days`, UTR trigram Jaccard, order-ref substring hit (0/1), method match (0/1), `is_amount_exact` (0/1), `log(candidate_count)`
- **Labels:** correct / incorrect, from `ground_truth.json` on the **main batch only**
- **Training:** batch gradient descent, ~200 lines total including feature extraction. Seconds to train. Weights saved to `lib/ml/model.json` and committed
- **Use:** the model replaces the multiplicative confidence formula for Pass 2 and Pass 5 candidates only. Passes 1, 3, 4 and 6 are exact and do not need it

**Step 3 — the gate.** Re-run the threshold sweep with model confidence and re-evaluate on held-out. Ship the model **only if**:

> false-match rate is **not worse**, AND auto-resolution rate improves by **≥ 2 percentage points** at that equal-or-better false-match rate.

**Step 4.** Whatever happens, publish this table in the README:

| Configuration | Match rate | False-match rate | Auto-resolved | Unresolved |
|---|---|---|---|---|
| Rules only | — | — | — | — |
| Rules + logistic regression | — | — | — | — |

**If the model does not clear the gate, delete `lib/ml/` and keep the table.** "I built it, measured it, it did not help, so I removed it" is a stronger answer in a panel than a model that is quietly carried along. Most students cannot say that sentence. Say it.

**Honest caveat you must include:** the model is trained on labels from a generator you wrote. Held-out evaluation mitigates this but does not eliminate it. Write that limitation in the README yourself. Volunteering a weakness before a judge finds it converts a vulnerability into a credibility signal.

---

# 16. Metrics — exact definitions

All computed by `scripts/evaluate.ts` against `ground_truth.json`. Never by the UI. Never by hand.

**Base sets**
- `N` = total reconcilable records = orders + settlement_lines + bank_lines
- `L` = records where ground truth has ≥1 expected link (`linkable`)
- `U` = records where ground truth says `is_resolvable: false`

| Metric | Formula | Worked example |
|---|---|---|
| **Total records** | `N` | 300 |
| **Linkable records** | `L` | 286 |
| **Proposed links** | count of rows in `links` | 271 |
| **Correct matches** | proposed link set exactly equals expected link set for that record | 269 |
| **Incorrect matches** | proposed ≠ expected, and proposed ≠ ∅ | 2 |
| **Match rate** | `correct / L` | 269/286 = **94.06%** |
| **False-match rate** | `incorrect / proposed_links` | 2/271 = **0.74%** |
| **Auto-resolution precision** | `correct_among_auto / total_auto` | 244/246 = **99.19%** |
| **Correct-refusal rate** | `(UNRESOLVED ∩ is_resolvable=false) / |U|` | 13/14 = **92.86%** |
| **Exception rate** | `unresolved / N` | 18/300 = **6.00%** |
| **Classification accuracy** | `correct_class / classified` | 288/300 = **96.00%** |
| **Review queue size** | count of NEEDS_REVIEW | 36 |
| **Total processing time** | wall clock, engine only, LLM excluded | 1,842 ms |
| **Throughput** | `N / seconds` | 300/1.842 = **162.9 rec/s** |
| **p50 / p95 per record** | percentiles of per-record engine time | 4 ms / 11 ms |
| **Total amount processed** | Σ gross amounts across settlement lines | ₹28,41,934.00 |
| **Amount reconciled** | Σ amounts on AUTO_RESOLVED records | ₹26,88,102.00 |
| **Amount in review** | Σ on NEEDS_REVIEW | ₹1,12,430.00 |
| **Amount unresolved** | Σ on UNRESOLVED | ₹41,402.00 |
| **Fee overcharge detected** | Σ positive `fee_delta` | ₹1,284.00 |
| **LLM explanations generated** | count where `ai_status = 'ok'` | 142 |
| **Guard rejections** | count where `ai_status = 'rejected_by_guard'` | 3 |
| **Guard rejection rate** | rejections / (rejections + ok) | 3/145 = **2.07%** |

## Composition rollups

Summed across every `settlement_composition` row in the run. These are the numbers a finance person reads first, before any accuracy metric.

| Metric | Formula | Worked example |
|---|---|---|
| **Total gross processed** | `Σ gross_payments` | ₹28,41,934.00 |
| **Total Razorpay fees** | `Σ fees_total` | ₹51,240.00 |
| **Total GST on fees** | `Σ gst_total` | ₹9,223.00 |
| **Total refunds deducted** | `Σ refunds_total` | ₹62,180.00 |
| **Total disputes / holds** | `Σ disputes_total` | ₹18,400.00 |
| **Total adjustments (net)** | `Σ adjustments_net` | −₹2,140.00 |
| **Total expected payout** | `Σ expected_payout` | ₹26,98,751.00 |
| **Total bank credit received** | `Σ bank_credit_total` | ₹26,57,349.00 |
| **Total reconciled payout** | `Σ expected_payout` where status is `FULLY_RECONCILED` or `RECONCILED_WITH_ROUNDING` | ₹26,88,102.00 |
| **Total unresolved amount** | `Σ |diff_total|` where status is `DISCREPANCY` or `UNMATCHED_TO_BANK` | ₹41,402.00 |
| **Settlements fully reconciled** | count by status | 15 of 19 |
| **Settlements with discrepancy** | count by status | 3 of 19 |
| **Settlements unmatched to bank** | count by status | 1 of 19 |
| **Composition coverage** | settlements with a composition row / total settlements | **19/19 = 100%.** Anything below 100% is a bug |
| **Discrepancy by component** | count grouped by `discrepancy_component` | FEES 1 · REFUNDS 1 · BANK_CREDIT 1 |
| **Fee overcharge detected** | `Σ` positive `fee_delta` | ₹1,284.00 |

*(All numbers above are illustrative placeholders. Real ones come from the script. Never write a number into the README by hand.)*

## Amount conservation — asserted, not assumed

Five identities. Each is checked by `scripts/evaluate.ts` at runtime and by a test in `tests/metrics.test.ts`. All are **exact integer equalities** with zero tolerance. A failure is a bug, not a data finding, and it must fail the run loudly rather than print a nearly-right number.

| # | Scope | Identity |
|---|---|---|
| **C1** | per settlement | `gross − fees − gst − refunds − disputes + adjustments_net == expected_payout` |
| **C2** | per settlement | `Σ line.contribution == expected_payout` |
| **C3** | per settlement | `expected_payout − bank_credit_total == diff_total` |
| **C4** | per run | `Σ per-settlement expected_payout == total_gross − total_fees − total_gst − total_refunds − total_disputes + total_adjustments_net` |
| **C5** | per run | `amount_reconciled + amount_in_review + amount_unresolved == total_amount_processed` |

C2 is the one to show a judge. It means the drill-down table on screen genuinely sums to the number at the top of the page, and it is checkable by eye in the demo.

**Reporting rules for the README:**
1. Headline table reports **held-out** numbers. Main-batch numbers go in a secondary table labelled "tuning batch."
2. All five conservation identities hold, and the README says so with the assertion count.
3. Throughput excludes LLM latency, and say so — mixing a network call into a throughput claim is misleading.
4. Report false-match rate **before** match rate. It is the metric a finance team would ask for first.
5. Report the composition rollups **before** the accuracy metrics. A finance reader wants to know how much money moved before they care how well you matched it.

---

# 17. Frontend

## Design direction (decide once, on Day 5, do not iterate)

The subject is a ledger. The vernacular is columns of figures, hairline rules, and tick marks. Two rules that carry the whole design:

**Every money figure uses tabular monospace numerals.** Columns of rupees that align on the decimal are genuinely easier to scan, so this is a functional choice, not decoration. Body/UI: Inter. Figures: IBM Plex Mono, `font-variant-numeric: tabular-nums`.

**Tokens** (put in `globals.css`, use nowhere else):
```
--paper:     #FBFCFD    /* cool near-white, statement paper */
--ink:       #101820    /* near-black navy, ledger ink */
--rule:      #DCE3E8    /* hairline */
--muted:     #6B7A87
--verified:  #0F766E    /* deep teal — resolved */
--review:    #B45309    /* amber-brown — needs review */
--break:     #9F1239    /* deep crimson — unresolved / false */
```
Six values. No gradients. No shadows beyond a 1px rule. Radius 4px everywhere.

**The signature component — `TieOutStrip`.** One horizontal bar per settlement, segmented left to right, **driven entirely by the `settlement_composition` row.** No arithmetic in the component.

```
Gross ████████████████████████████████████████  ₹1,00,000.00
Fee   ▓▓                                           −₹2,000.00
GST   ▓                                              −₹360.00
Refnd ▒▒▒                                          −₹1,000.00
                                              ╌╌╌╌ gap = diff_total
Net   ████████████████████████████████████       ₹96,640.00
```

Widths proportional to amount. Any difference renders as a **visible dashed gap** at the end of the bar, and the bucket named by `discrepancy_component` is outlined in `--break`. It is the product's thesis in one component: money in, deductions accounted, and the hole that is left. Build it once, spend your visual budget here, keep everything else plain.

**Its companion — `SettlementBreakdown`.** The same composition rendered as a readable ladder rather than a bar. The strip is for scanning; the ladder is for reading and for screenshots.

```
Gross payments                    ₹1,00,000.00      18 payments
− Razorpay fees                      ₹2,000.00      200 bps, credit card
− GST on fees                          ₹360.00      18% of fees
− Refunds                            ₹1,000.00      1 refund
− Disputes / holds                       ₹0.00      —
− Adjustments                            ₹0.00      —
──────────────────────────────────────────────
Expected payout                     ₹96,640.00
Bank received                       ₹96,640.00
Difference                               ₹0.00      ✅ Fully reconciled
```

Right-hand column carries the *why* for each bucket. Every figure is monospace and right-aligned so the decimals stack. Both components take a `SettlementComposition` object and render it. Neither adds, subtracts or rounds anything.

---

## Screen 1 — Overview (`/`)

**Layout:** header with run selector → 6 metric cards in a 3×2 grid → **run-level composition ladder** (the aggregate rollups, same `SettlementBreakdown` component) → **settlements table with expandable rows** → two-column row: exception breakdown bar chart | top 5 breaks by rupee value.

**Data:** `run_metrics.payload` plus `GET /api/runs/[id]/settlements`.

**Metric cards, in this order:** False-match rate · Match rate · Auto-resolved · Needs review · Unresolved · Throughput. False-match first, deliberately.

**Run-level composition ladder.** The rollups from §16 rendered in the same six-bucket shape as a single settlement: total gross, total fees, total GST, total refunds, total disputes, total adjustments, total expected payout, total bank credit, total unresolved. One glance answers "how much money moved and where did it go" for the entire batch.

**Settlements table.** One row per settlement: settlement ID (mono) · date · status chip (`Fully reconciled` in `--verified`, `Rounding` in `--muted`, `Discrepancy` in `--review`, `Unmatched to bank` in `--break`) · payment count · expected payout · bank received · difference · a chevron.

Clicking the chevron **expands the row in place** to reveal `SettlementBreakdown` (the six-bucket ladder) followed by `CompositionTable` (the one-level drill-down of that settlement's own lines). Expanded state is local React state. **No navigation and no second request** — `GET /api/runs/[id]/settlements` returns composition and lines for every settlement in one payload, so expanding is instant.

This expansion *is* the composition view. There is deliberately no separate settlement screen: a fully reconciled settlement has no exception and therefore no Investigation page, and rather than add a fifth screen for it, the Overview row becomes the place you open it. The same two components are then reused on Investigation for the broken case.

Default sort: difference descending by absolute value, so the settlements that need attention are at the top and the fully reconciled ones are below. A finance associate opens this page to find the problem, not to admire the successes.

**Buttons:** run selector dropdown · "Run reconciliation" → `/run` · "View exceptions" → `/exceptions` · a `main` / `held-out` toggle · per-row expand chevron.

**API:** `GET /api/runs` (list) · `GET /api/runs/[id]` · `GET /api/runs/[id]/settlements`.

**Loading:** skeleton cards, real layout, no spinner-over-everything.
**Empty:** "No runs yet. Reconcile a batch to see results." with a primary button to `/run`.
**Error:** "Couldn't load run data. Check the database connection and reload." with a retry button. Errors state what happened and what to do; they do not apologise.

---

## Screen 2 — Run Reconciliation (`/run`)

**Layout:** batch selector (main / held-out) → data summary card (record counts per source, read from the CSVs) → LLM toggle → big "Reconcile 300 records" button → live progress → results summary with a link to Overview.

**Progress:** stage-by-stage, with per-stage timings:
```
✓ Validate            300 rows        12 ms
✓ Normalize           298 parsed, 2 pending LLM      31 ms
✓ Pass 1  UTR         168 linked     104 ms
✓ Pass 2  amount+date  46 linked, 6 ambiguous   287 ms
✓ Pass 3  subset-sum   18 linked, 2 refused     412 ms
✓ Pass 4  balance      19 verified, 3 residual   88 ms
✓ Pass 5  order match 214 linked                391 ms
✓ Pass 6  fee audit     6 overcharges           117 ms
✓ Classify + decide   246 auto · 36 review · 18 unresolved
```

This screen is the throughput evidence. Show real milliseconds. **The LLM toggle is a demo weapon** — run it off, get the same match rate, and prove the AI is not doing the reconciliation.

**API:** `POST /api/runs` with `{ batch, llm_enabled }`.
**Loading:** button disabled, stages stream in as they complete.
**Empty:** n/a.
**Error:** which stage failed, the message, and a "Retry" button. Partial results stay on screen.

---

## Screen 3 — Exception Queue (`/exceptions`)

**Layout:** filter bar → sortable table → pagination (25/page).

**Filters:** decision (All / Auto / Review / Unresolved) · class (multi-select of the 15) · amount above ₹ · free-text search on record ID. Default view: **Unresolved and Needs Review only, sorted by rupee impact descending.** That is the view a finance associate would actually open, and defaulting to it shows you thought about the user rather than the data.

**Columns:** Record ID (mono) · Source · Class (colour-coded badge) · **Component** (which bucket, from `discrepancy_component`) · Amount impact (mono, right-aligned) · Confidence (thin bar) · Decision · Next action (truncated) · → link.

The Component column lets an associate triage by *where* the money went missing rather than only by *what kind* of problem it is, which is how a real queue gets worked: all the fee breaks together, all the refund breaks together. Add it to the filters alongside class.

**API:** `GET /api/exceptions?run_id=&decision=&class=&component=&min_amount=&page=`
**Loading:** table skeleton, 10 rows.
**Empty:** "No exceptions match these filters." plus a "Clear filters" button.
**Error:** inline banner above the table, previous results retained.

---

## Screen 4 — Investigation (`/exceptions/[id]`)

The screen that wins the demo. Vertical narrative, top to bottom, in this exact order:

```
 1. WHAT HAPPENED     class badge + one-line deterministic summary + ₹ impact
 2. SETTLEMENT BREAKDOWN   the six-bucket ladder for this settlement, with the
                           bucket named by discrepancy_component highlighted in --break
 3. DRILL-DOWN        this settlement's own lines, one level, offending lines
                      highlighted. Same CompositionTable as the Overview
 4. EVIDENCE          the actual records side by side, differing fields highlighted
 5. HOW WE DECIDED    which pass, which rule, the four confidence multiplicands
 6. AI EXPLANATION    2–3 sentences + a "guard: passed / rejected" chip
 7. COMPETING CANDIDATES   for ambiguous cases — every candidate and why each failed
 8. WHY UNRESOLVED    for refusals — plain-language statement of what is missing
 9. NEXT ACTION       from the taxonomy, with the SLA
```

Sections 2 and 3 reuse `SettlementBreakdown` and `CompositionTable` unchanged, imported from the Overview build. **Do not write a second version.** The only difference here is two props: the bucket named by `discrepancy_component` is highlighted in `--break`, and the lines contributing to the difference are highlighted in the table.

**Sections 2 and 3 are what turn a number into an answer.** "₹4,820 short" becomes "₹4,820 short, and all of it is in the refunds bucket, and here are the two refund lines whose orders were never matched." That is the difference between a system that detects and a system that explains.

Section 7 is the one nobody else will build. Showing the two settlements that both matched, and that the system refused to pick, is the moment a judge understands this is a real system.

For an exception that is not attached to a settlement (a stray bank credit, an invalid row), sections 2 and 3 are omitted rather than rendered empty.

**Buttons:** "Explain with AI" (calls the LLM on demand, not preloaded) · "Copy evidence JSON" · back to queue.
**API:** `GET /api/exceptions/[id]` (returns the composition inline) · `POST /api/exceptions/[id]/explain`
**Loading:** the deterministic sections render instantly; only the AI block shows a shimmer.
**Empty:** n/a.
**Error on explain:** "Explanation unavailable. The deterministic reason above is unaffected." The ladder, the drill-down and the difference all still render — which is the design statement about where the truth lives.

---

# 18. API design

Nine endpoints. All responses `{ ok: boolean, data?: T, error?: { code, message } }`.

### `GET /api/runs`
**Purpose:** list runs for the run selector.
**Request:** `?limit=20`
**Response:** `{ runs: [{ id, batch, started_at, status, record_count, match_rate, false_match_rate }] }`
**Validation:** `limit` integer 1–100, default 20.
**Errors:** `500 DB_ERROR`

### `POST /api/runs`
**Purpose:** create and execute a reconciliation run.
**Request:** `{ batch: 'main' | 'holdout', llm_enabled: boolean }`
**Response:** `{ run_id, stages: [{ name, ms, counts }], summary: { auto, review, unresolved } }`
**Validation:** `batch` must be one of the two literals. Reject anything else with 400 — never `String(batch)` into a query.
**Errors:** `400 INVALID_BATCH` · `409 RUN_IN_PROGRESS` · `500 ENGINE_ERROR` (include the failing stage)

### `GET /api/runs/[id]`
**Purpose:** one run plus its full metrics payload.
**Response:** `{ run, metrics }`
**Errors:** `404 RUN_NOT_FOUND`

### `GET /api/runs/[id]/records`
**Purpose:** paginated raw records for a run.
**Request:** `?source=bank|order|settlement_line&page=1&limit=50`
**Response:** `{ records, page, total }`
**Validation:** `source` from an allowlist. `limit` ≤ 100.
**Errors:** `400 INVALID_SOURCE` · `404 RUN_NOT_FOUND`

### `GET /api/runs/[id]/settlements`
**Purpose:** every settlement in the run with its composition **and its own lines**, in one payload. Powers the Overview table and its row expansion with a single request.
**Request:** `?status=&sort=diff_desc|date`
**Response:**
```
{
  rollups,                      // the run-level composition totals from §16
  settlements: [{
    settlement_id, created_at, utr, status, discrepancy_component,
    payment_count, refund_count,
    gross_payments, fees_total, gst_total, refunds_total,
    disputes_total, adjustments_net,
    expected_payout, header_amount, bank_credit_total, diff_total,
    lines: [{ entity_id, type, method, gross, fee, gst,
              contribution, contribution_bucket, contribution_reason,
              order_id, order_ref, order_linked }],
    contribution_sum, conservation_ok
  }]
}
```
**Validation:** `status` and `sort` against enums.
**Errors:** `404 RUN_NOT_FOUND` · `409 COMPOSITION_MISSING` (run has not finished Pass 6B)
**Rules:** `contribution_sum` and `conservation_ok` are computed server-side from stored values — the client renders them, it never sums the lines itself. Nineteen settlements at ~16 lines each is a small payload; do not paginate it and do not add a per-settlement endpoint.

### `GET /api/exceptions`
**Purpose:** filtered exception queue.
**Request:** `?run_id=&decision=&class=&component=&min_amount=&page=&limit=`
**Response:** `{ exceptions, page, total, filtered_amount_paise }`
**Validation:** `decision`, `class` and `component` checked against enums. `min_amount` non-negative integer paise.
**Errors:** `400 INVALID_FILTER` · `404 RUN_NOT_FOUND`

### `GET /api/exceptions/[id]`
**Purpose:** one exception with its full evidence bundle, linked records and — where the exception is attached to a settlement — its composition and drill-down inline.
**Response:** `{ exception, composition | null, groups | null, evidence, linked_records, candidates, audit_trail }`
**Errors:** `404 EXCEPTION_NOT_FOUND`

### `POST /api/exceptions/[id]/explain`
**Purpose:** generate an AI explanation on demand.
**Request:** `{}` — the server builds the bundle. **The client never supplies evidence.** If it did, anyone could feed the model arbitrary numbers.
**Response:** `{ explanation, guard: { status: 'pass'|'reject', rejected_tokens? }, latency_ms }`
**Validation:** exception must exist and belong to a complete run.
**Errors:** `404` · `429 LLM_RATE_LIMIT` · `503 LLM_UNAVAILABLE` (client falls back to the deterministic reason)

### `POST /api/ask` — OPTIONAL
**Request:** `{ run_id, question }`
**Response:** `{ answer, tool_used, tool_args, rows }`
**Validation:** question ≤ 500 chars. Tool name must be one of the six.
**Errors:** `400 UNSUPPORTED_QUESTION` when the model picks no valid tool. Refusing is the correct behaviour.

**Global rules:** every query parameterised through postgres.js tagged templates, never string-concatenated. No endpoint accepts money values from the client. No endpoint returns the LLM API key or the database URL, including inside error messages.

---

# 19. Testing strategy

Around 20 tests. Financial logic only. No UI tests, no snapshot tests.

## Foundation (`money.test.ts`)
- `parseMoney('₹1,000.00')` → `100000`
- `parseMoney('1000.005')` → throws. More than 2 decimals is a data error, not a rounding opportunity
- `roundHalfUp(2.5)` → `3` and `roundHalfUp(-2.5)` → `-3`
- `formatPaise(100000)` → `'₹1,000.00'`
- Round-trip: `parseMoney(formatPaise(n)) === n` over 1,000 seeded values
- Assert no `Number.isInteger` violations anywhere in a full run's money fields

## The 12 required scenarios (`engine.scenarios.test.ts`)

Each builds a minimal fixture (2–5 records), runs the relevant pass, asserts class, decision and confidence band.

| # | Scenario | Expected behaviour |
|---|---|---|
| 1 | **Exact match** | UTR matches, amounts equal → `MATCHED_EXACT`, `AUTO_RESOLVED`, confidence 1.0 |
| 2 | **Timing difference** | Capture 3 days before settlement, amount exact → `TIMING_DIFFERENCE`, `AUTO_RESOLVED`, confidence ≥ 0.8 |
| 3 | **Refund netted** | Settlement short by exactly the refund debit → `REFUND_NETTED`, `AUTO_RESOLVED`, shortfall equals refund amount to the paise |
| 4 | **Partial settlement** | One payment across two settlement IDs, parts sum to the whole → `PARTIAL_SETTLEMENT`, both linked, sum asserted exactly |
| 5 | **Split payout** | One settlement, two bank credits summing to it → `SPLIT_PAYOUT`, subset unique, both linked |
| 6 | **Duplicate credit** | Two bank lines, same UTR, same amount → first linked, second `DUPLICATE_CREDIT`, `NEEDS_REVIEW`, **not** counted in amount reconciled |
| 7 | **Missing bank record** | Settlement with no bank line → `MISSING_IN_BANK`, `UNRESOLVED`, next action names the UTR |
| 8 | **Ambiguous match** | Two settlements, identical amount and date, no UTR → **no link produced**, `UNRESOLVED`, both candidates in evidence, confidence ≤ 0.3. *If this test ever passes by producing a link, the system is broken* |
| 9 | **Corrupted narration** | Narration with mangled UTR, LLM disabled → `parse_source: 'failed'`, falls through to Pass 2 |
| 10 | **Fee mismatch** | UPI line with non-zero fee → `FEE_OVERCHARGE`, `NEEDS_REVIEW`, `fee_delta` equals the full charged fee |
| 11 | **GST mismatch** | Fee correct, GST ≠ 18% of fee → flagged, `gst_delta` exact |
| 12 | **Unresolved** | Bank credit with no plausible counterpart anywhere → `MISSING_IN_LEDGER`, `UNRESOLVED`, evidence explains what was searched |

## The 5 composition scenarios (`engine.composition.test.ts`)

| # | Scenario | Expected behaviour |
|---|---|---|
| 13 | **Clean composition** | 18 payments, 1 refund, correct fees. Ladder equals the worked example: gross ₹1,00,000, fees ₹2,000, GST ₹360, refunds ₹1,000, expected ₹96,640, bank ₹96,640, `diff_total = 0`, status `FULLY_RECONCILED`, component `NONE` |
| 14 | **Refund-attributed discrepancy** | Same settlement with a second refund of ₹4,820 whose order is unlinked → `diff_total = 482000` paise, status `DISCREPANCY`, `discrepancy_component = REFUNDS` |
| 15 | **Fee-attributed discrepancy** | A UPI line charged ₹17 → `discrepancy_component = FEES`, and `|diff_total|` equals `Σ fee_delta` exactly |
| 16 | **Contribution conservation** | For a settlement mixing payments, refunds, a dispute and a signed adjustment, `Σ line.contribution == expected_payout` to the paise (identity C2) |
| 17 | **Unattributable discrepancy** | A settlement whose difference matches no bucket → `discrepancy_component = UNATTRIBUTED`. *The test asserts it does **not** guess a bucket.* This is the composition equivalent of scenario 8 |

Also assert: **every settlement in a full run has exactly one composition row**, including `UNMATCHED_TO_BANK` ones, and that a zero-line settlement produces a zero ladder rather than being skipped. And assert identity B per settlement: the sum of the `contribution` column over that settlement's own lines equals `expected_payout` exactly. That is the identity the drill-down table renders on screen, so it is the one that must never be approximate.

## Conservation tests (in `metrics.test.ts`)

One test per identity from §16, each on a hand-built fixture with values computed by hand, asserting exact integer equality with zero tolerance:

- **C1** per-settlement bucket arithmetic
- **C2** contributions sum to expected payout
- **C3** expected minus bank equals `diff_total`
- **C4** run-level rollups equal the sum of per-settlement values
- **C5** reconciled + review + unresolved equals processed

Plus a negative test: deliberately corrupt one `contribution` value and assert the run **throws** rather than reporting a nearly-right total. A conservation check that can be silently violated is not a check.

## Guard tests (`numberGuard.test.ts`)
- Explanation containing only bundle values → passes
- Explanation containing `₹5,000.00` when the bundle has no such value → **rejected**, token reported
- Formatting variants (`4820`, `4,820`, `₹4,820.00`) all accepted for the same underlying value
- Percentages and the documented carve-outs (`18`, `2`, 0–10) accepted
- **Composition rounding test:** bundle says the shortfall is ₹4,820.00; explanation says "short by about ₹5,000" → **rejected.** Approximating a ladder figure is the exact failure the guard exists to catch
- Every bucket total from the composition is in the allowlist

## Metrics tests (`metrics.test.ts`)
- On a hand-built 10-record fixture with known ground truth, every formula in §16 returns the hand-computed value
- Amount conservation: `reconciled + review + unresolved == processed`, asserted exactly

## Determinism test (`generator.test.ts`)
- Generating twice with the same seed produces identical output hashes
- Generating with different seeds produces different output

**Run tests after every prompt in §21 that touches `lib/`.** A test suite you run once at the end is a test suite that lied to you for six days.

---

# 20. GitHub + Claude Code workflow

## The loop

```
You read the prompt from CLAUDE_CODE_PROMPTS.md
        ↓
Paste into Claude Code
        ↓
Claude Code explains what it will change  ← CLAUDE.md enforces this
        ↓
You say go
        ↓
Claude Code edits files
        ↓
You run the verification command from the prompt
        ↓
Output matches expected?  ──no──→  paste the error back, one fix attempt
        ↓ yes                              ↓ still broken → git reset (below)
Commit with the message from the prompt
        ↓
Next prompt
```

**Commit before starting each prompt, not just after.** That way `git reset --hard HEAD` always returns you to a known-good state.

## Beginner Git commands

**Day 1, once:**
```bash
git init
git add .gitignore
git commit -m "chore: add gitignore before anything else"
git branch -M main
git remote add origin https://github.com/<you>/setl.git
git push -u origin main
```

**After every prompt:**
```bash
git status                              # check nothing unexpected changed
git diff                                # read what actually changed
git add .
git commit -m "feat: add reconciliation pass 1"
git push
```

Read `git diff` before committing. It takes thirty seconds and it is how you catch Claude Code quietly rewriting a file you did not ask it to touch.

**Checkpoint messages, in order:**
```
chore: initialize project
chore: configure environment and gitignore
feat: add database schema
feat: add money and date primitives
feat: add synthetic data generator
feat: add ground truth emission
feat: add held-out batch profile
feat: add normalization layer
feat: add reconciliation pass 1 (utr matching)
feat: add reconciliation passes 2-3 (amount-date, subset-sum)
feat: add reconciliation passes 4-6 (balance, orders, fee audit)
feat: add exception taxonomy and classifier
feat: add confidence scoring
feat: add metrics and evaluation script
feat: add threshold selection experiment
feat: add AI narration parser
feat: add AI explanation generator
feat: add number guard
feat: add overview dashboard
feat: add run page
feat: add exception queue
feat: add investigation page
test: add reconciliation scenario tests
docs: add readme, architecture and dataset docs
chore: deploy to vercel
```

## When Claude Code breaks the application

Escalate in this order. Do not skip steps.

**1. Uncommitted mess, want it gone:**
```bash
git checkout .          # discard changes to tracked files
git clean -fd           # delete new files it created. Careful: this is permanent
```

**2. Want to keep the changes but get working again:**
```bash
git stash               # set changes aside
npm run test            # confirm you're back to green
git stash pop           # bring them back when ready
```

**3. Bad commit, already made:**
```bash
git log --oneline -5    # find the last good commit hash
git reset --hard <hash> # go back. Loses everything after it
```

**4. Already pushed a bad commit:**
```bash
git revert <hash>       # makes a NEW commit that undoes it. Safe on shared repos
```

**5. Truly stuck:** `git reset --hard <last good hash>`, then re-run the prompt with an added line: *"The previous attempt broke X. Do not modify Y. Change only Z."*

**Rule:** if Claude Code cannot fix its own breakage in **two** attempts, reset and re-prompt with tighter file scope. Debugging a bad generation costs more than regenerating it, and on a 7-day clock that difference compounds.

## Accidentally committed `.env.local`

**Rotate the key first.** Immediately, before anything else. Then:
```bash
git rm --cached .env.local
echo ".env.local" >> .gitignore
git commit -m "chore: remove env from tracking"
```
Rewriting history does not un-leak a key that was public for ten minutes. Rotation is the fix; cleanup is housekeeping.

---

# 23. Seven-day execution plan

Prompt numbers refer to `CLAUDE_CODE_PROMPTS.md`.

## Day 1 — Thu 27 Aug · Foundation
**Prompts:** 01, 02, 03
**Goals:** repo live, Next.js running, Neon connected, schema applied, `CLAUDE.md` and `FAILURES.md` in place, money/date primitives written and tested.
**Done when:** `npm run dev` renders a page that reads a row from Postgres, and `npm run test` passes on `money.test.ts`.
**If behind:** cut nothing. Day 1 has no optional content. Work later instead.

## Day 2 — Fri 28 Aug · Data
**Prompts:** 04, 05, 06
**Goals:** generator produces the 300-record main batch with all 14 injected cases and ground truth; held-out profile produces its own 300; seeding into Postgres works.
**Done when:** `npm run generate` twice with the same seed gives identical files; `data/main/` and `data/holdout/` are committed; `npm run seed` loads both.
**If behind:** generate the held-out batch on Day 3 morning. Do **not** reduce the main batch or drop injected cases — the anomalies *are* the project.

## Day 3 — Sat 29 Aug · Engine, the load-bearing day
**Prompts:** 07, 08, 09, 09B
**Goals:** normalization, passes 1–6, composition engine (6B), exception taxonomy, classifier. No AI.
**Done when:** `npm run evaluate` prints a real match rate on both batches from rules alone, **and every settlement has a composition row whose contributions sum to its expected payout.**
**If behind:** push 09B (composition) to Day 4 morning and take the metrics work into Day 4 afternoon. Never cut Pass 3 (subset-sum) — it is the depth signal and the source of your best demo moment. Never cut composition entirely; it is CORE and the demo is built around it.
**Checkpoint:** if you finish Day 3, you have a submittable project even if Days 4–7 go badly. Protect this day above all others.

## Day 4 — Sun 30 Aug · Measurement
**Prompts:** 10, 11
**Goals:** full metrics engine including composition rollups, all five conservation identities asserted, `REPORT.md` generation, threshold-selection sweep, thresholds frozen into config.
**Done when:** `REPORT.md` exists with real numbers and composition rollups for both batches, all five identities pass, and the README can state *why* each threshold is what it is.
**If behind:** cut the sweep visualisation. Never cut the sweep itself — hardcoded thresholds are the weakest thing you could hand a judge. Never cut the conservation assertions; they take twenty minutes and they are the thing that makes the ladder trustworthy.

## Day 5 — Mon 31 Aug · AI + UI part one
**Prompts:** 12, 13, 14, 15
**Goals:** narration parser, explainer (with the composition bundle), number guard, Overview screen including the run-level composition ladder and expandable settlement rows.
**Done when:** guard tests pass, a rejection has been observed at least once, and Overview renders real metrics plus an expandable settlements table.
**If behind:** cut the ML gate entirely (§15) — publish rules-only numbers and say so. Cut Q&A. Do not cut the Overview row expansion — with no separate settlement screen it is the only way to see a reconciled settlement's composition, and the demo opens on it. Keep the guard; it is your best AI-safety soundbite.

## Day 6 — Tue 1 Sep · UI part two + hardening
**Prompts:** 16, 17, 18, 18B, 19
**Goals:** Run page, Exception Queue, Investigation page, Settlement Breakdown page with drill-down, full test suite green, input validation on every endpoint.
**Done when:** a stranger can find the largest unresolved break in under 30 seconds, **and can trace a settlement down to the individual refund that caused it.**
**If behind:** cut the Run page's live progress streaming — compute, then show the completed stage table. Collapse the drill-down from grouped accordions to a single flat contributions table with a summing footer; that keeps identity C2 visible, which is the part that matters. Never cut the Investigation page or the breakdown ladder; that is where the demo is won.

## Day 7 — Wed 2 Sep · Ship
**Prompts:** 20, 21, 22, 23
**Goals:** deploy to Vercel, README, ARCHITECTURE.md, DATASET.md, FAILURES.md finalised, screenshots, final audit, record the video.
**Done when:** a judge can clone the repo, run `npm install && npm run evaluate`, and reproduce your numbers with no database and no API key.
**Feature freeze at 12:00.** Anything unfinished at noon goes to Future Scope.
**If behind:** cut deployment before you cut the README. A judge who can read your repo will forgive a missing live URL; a judge who cannot understand your repo will not open the video.

## Buffer — Thu 3 / Fri 4 Sep
Re-record the video. Rehearse answers to §26. Verify the deadline on the form. Submit on the 4th at the latest — never on the closing day, because forms close early and networks fail.

---

# 24. Demo strategy — five minutes

Record the screen at 1920×1080. Talk over it. Three takes minimum; the third is the one you submit.

| Time | Screen | Action | What you say |
|---|---|---|---|
| **0:00–0:30** | Bank statement CSV, one row highlighted | Scroll to a single credit of ₹28,41,934 | "One line. Three hundred orders are inside it, minus fees, minus GST, minus refunds. A finance associate spends a morning proving this number is right. That's the job Setl does." |
| **0:30–1:00** | `/run`, batch selector on `main` | Show the three source files and their counts | "Three sources: the merchant's own orders, Razorpay's settlement report, the bank statement. Three hundred records, synthetic, generated with known ground truth." |
| **1:00–1:35** | `/run`, click Reconcile | Stages stream in with real timings | "Seven deterministic passes. UTR matching, amount-date candidates, subset-sum for split payouts, internal balance, order matching, fee audit, and composition. One point eight seconds for the batch. No AI has run yet." |
| **1:35–1:55** | `/run`, toggle LLM off, run again | Same match rate appears | "Same numbers with the language model switched off. The AI does not do the reconciliation and it does not do the arithmetic. I'll show you what it does do." |
| **1:55–2:45** | `/` Overview → expand a `FULLY_RECONCILED` settlement row | The ladder, then the line table below it | "Setl answers two questions. First: does it tie out. Second: how was it built. Here's the second one, without leaving this page. ₹1,00,000 gross, minus ₹2,000 fees, minus ₹360 GST — that's 18% on the fee — minus ₹1,000 of refunds. Expected ₹96,640. Bank received ₹96,640. Difference zero. And underneath, every line that made it: eighteen payments with their order references, the one refund, the fee on each. **That contribution column sums to ₹96,640 exactly, and that identity is asserted in code, not eyeballed.**" |
| **2:45–3:25** | An exception settlement → Investigation, sections 2 and 3 | Same ladder, refunds bucket highlighted, offending group auto-expanded, then the AI explanation | "Same ladder, different settlement. This one doesn't tie. ₹4,820 short, and the system tells me *where*: it's entirely in the refunds bucket. Here are the two refund lines whose orders were never matched. And here's the AI explanation — every number in it was checked against that ladder before it was shown. It can't round ₹4,820 up to five thousand." |
| **3:25–4:10** | An `UNRESOLVED` item with competing candidates | Show both candidates and the refusal | "Two settlements, same amount, same day, and the bank narration is truncated. The system could have picked one and been right half the time. In reconciliation a wrong match is worse than no match, because a wrong match is silent. So it refuses, shows both candidates, and tells the associate exactly what to ask the bank. **This is the part I'm proudest of.**" |
| **4:10–4:45** | `/` Overview, held-out toggle | Held-out metrics + composition rollups | "Held-out batch. Different seed, different merchant, different bank narration templates, and a flat-fee tier my rate card had never seen. Total gross, total fees, total GST, total refunds — then false-match rate, because that's the number a finance team asks for first. Fourteen records were unresolvable by design and it correctly refused thirteen." |
| **4:45–5:00** | README, Future Scope | — | "The settlement report tells a merchant what Razorpay did. Setl checks that against their own ledger and their actual bank statement, and shows exactly how every payout was built. Everything mirrors the real recon API schema, so the production path is a source adapter, not a rewrite." |

**The 1:55–3:25 stretch is the new centre of the demo.** Clean composition first, then the same ladder failing, is a much stronger ninety seconds than an exception on its own, because the judge learns to read the ladder on an easy case and then sees it do real work. Rehearse the transition between the two settlements until it is one continuous sentence.

**Rehearse 3:25–4:10 until you can do it without notes.** It is still the segment that separates you from every other Track 04 submission.

**Record a backup.** Full offline run with `LLM_ENABLED=false`, plus a still-image walkthrough of the four screens. If the live API or Vercel dies during your panel, you have something to show inside five seconds.

---

# 25. Submission artifacts

## Required
```
README.md                    the judge's entry point. Written last, matters most
docs/ARCHITECTURE.md         officially named in the submission requirements
FAILURES.md                  three real entries with root cause and fix
REPORT.md                    generated. Both batches. Never hand-edited
data/main/*                  300 records + ground_truth.json, committed
data/holdout/*               300 records + ground_truth.json, committed
data/results/metrics.json    generated
.env.example                 variable names only
public GitHub repo           no secrets in history
5-minute pitch video         unlisted YouTube or Drive link, in the README
```

## Recommended
```
CLAUDE.md                    shows how you worked with an AI tool. Judges will find this interesting
docs/DATASET.md              field dictionary + the 14 injected cases table
docs/PRD.md                  problem, user, workflow, scope decisions
docs/screenshots/            four screens, for anyone who won't run it
data/results/sweep.json      the threshold experiment output
tests/                       green
live Vercel URL
```

## Optional
```
lib/ml/ + ablation table     only if the §15 gate passed
docs/DEMO_SCRIPT.md
backup demo recording
```

**Verify before submitting, do not assume:** the closing date, whether the form asks for the "what broke" narrative, whether it wants a resume, and the file-size or link format for the video. All of these are on the form itself and I have only seen them reported secondhand.

## README structure (write it last, on Day 7)

Open with the differentiation sentence, not with a feature list:

> Razorpay's settlement report tells a merchant what Razorpay did. Setl checks that against the merchant's own order ledger and their actual bank statement, and reports what it could not verify.

Then: problem · what it does · **held-out metrics table (false-match rate first)** · how to reproduce in two commands · architecture diagram · dataset and ground truth · exception taxonomy table · threshold methodology · what the AI does and does not do · number guard with its rejection count · limitations (state these yourself) · future scope · demo video.

---

# 26. Brutal review

Sitting as a Razorpay engineer who has reviewed the repo before the call.

## What is the biggest weakness?

**Ground-truth circularity.** You wrote the generator, so you decided what "correct" means. Held-out evaluation narrows this but does not close it: both batches came from the same code and the same assumptions about how settlements behave. If your mental model of settlement batching is wrong, both batches are wrong in the same direction and every metric inherits the error.

**Fix:** state this limitation in the README yourself, in your own words, before a judge raises it. Then reduce it concretely: model Source B field-for-field on the published recon API rather than on intuition, and cite the doc. Say in the panel: "the strongest version of this runs against a real merchant's exports, and the source adapter is the only thing that changes."

## What could make the demo fail?

1. **LLM API dead or rate-limited mid-demo.** Mitigated by the `LLM_ENABLED` toggle, which you are showing anyway.
2. **Neon cold start.** Free-tier Postgres sleeps. Hit the deployed URL two minutes before you present.
3. **Vercel function timeout.** The full run is under two seconds locally, but a cold serverless function plus Neon wake-up can exceed the limit. **Test the deployed URL end to end on Day 7 morning, not Day 7 evening.**
4. **A number on screen not matching a number in the README.** Regenerate `REPORT.md` last and copy from it mechanically.

## What is over-engineered?

The `llm_calls` table is more instrumentation than a 7-day project needs; it earns its place only because the guard rejection count is a headline claim. Keep it, but do not add anything else to it.

Ten database tables is at the top end. Justified, because each is simple and maps to one real thing, but if Day 1 runs long, fold `settlements` into `settlement_lines` with a `is_header` flag rather than dropping a feature.

## What is under-engineered?

**Idempotency.** If someone clicks Reconcile twice, you get two runs. Fine for a demo, wrong for finance software, and a judge may ask. Have the answer ready: "runs are append-only and immutable by design; a production version would key runs on a batch hash and return the existing run."

**Materiality thresholds are global.** Real finance teams set them per account and per amount band. Acknowledge it rather than building it.

## What will a fintech engineer challenge?

- *"What's your T+2 business-day logic? Does it handle bank holidays?"* — Have a holiday list, even a short one. Answering "weekends only" is fine if you say so deliberately.
- *"Why is UPI zero MDR in your rate card?"* — Because it is, in India, for merchant transactions. Knowing this unprompted is a strong signal.
- *"What happens to a settlement that fails after initiation?"* — `status = 'failed'`, no bank credit expected, must not count as `MISSING_IN_BANK`. **Make sure your code actually does this.** It is an easy miss and an obvious question.
- *"Show me where you handle negative balance / adjustment recovery."* — Honest answer: out of scope, in Future Scope, here is how it would slot in.

## What will an AI engineer challenge?

- *"Your narration parser could be pure regex. Prove the LLM adds something."* — The ablation: parse rate regex-only vs regex+LLM on the held-out batch, where the templates are different. If the delta is small, **say so** and keep the LLM only for the corrupted cases.
- *"Your number guard is regex over text. What about a hallucinated entity ID?"* — Correct, it only guards numbers. Extend the allowlist to include IDs, or state the limitation. Do not pretend it covers more than it does.
- *"Why not embeddings for candidate matching?"* — Because the keys are structured (UTR, order ID, amount, date), and semantic similarity over structured financial identifiers adds nondeterminism to a domain that needs the opposite. That is a good answer; have it ready.

## What will a product judge challenge?

- *"Who pays for this?"* — The merchant, as part of finance-ops tooling; or Razorpay, as a retention feature that reduces support tickets asking "why is my payout short."
- *"Why wouldn't Razorpay just build it?"* — They partly have, on their side of the data. The bank statement is the piece they do not hold. Say it in one sentence.
- *"What's the wedge?"* — One number: hours saved per close, plus rupees of fee overcharge detected. You have both from the metrics.

## What claim should you never make?

- **Never** say "99% accurate" without naming the metric, the batch and the denominator.
- **Never** call the synthetic data "real" or "production" data.
- **Never** claim a live Razorpay integration you did not build. If you use test-mode payments, say exactly that: "test-mode payments API, settlements are synthetic because test mode does not produce them."
- **Never** present tuning-batch numbers as held-out numbers.
- **Never** say the AI "understands" or "decides." It parses and it explains. That precision is itself a signal.
- **Never** claim the number guard prevents all hallucination. It checks numeric tokens against an evidence allowlist. Say exactly that.

## What to demonstrate live
The batch run with timings · the LLM-off toggle · one solved hard case · one refusal with competing candidates · held-out metrics. Nothing else.

## What to record as backup
A full offline run with `LLM_ENABLED=false`, and stills of all four screens. Keep it on your laptop, not in the cloud.

## Corrected final recommendations

1. **Write the limitations section of the README on Day 4, not Day 7.** Writing it early forces you to design against the weaknesses instead of papering over them at the end.
2. **Add the `status = 'failed'` settlement case to the generator.** It is one injected case, it takes twenty minutes, and it defuses an obvious question.
3. **Cap Day 5 AI work at four hours.** If the guard is not working by hour four, ship template explanations and report that the AI layer was descoped. A working system with no AI beats a broken system with AI, on this track specifically.
4. **Keep the LLM-off toggle in the final build.** It is the single most persuasive thirty seconds in the demo and it costs one boolean.
5. **Put false-match rate first in every table, in the README, in the video, and in the panel.** Everything else about this project follows from that one choice, and it is the choice that says you thought about money rather than about metrics.
