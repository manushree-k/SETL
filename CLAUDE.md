# CLAUDE.md — Setl

Permanent working instructions. Read this before every task.

## Context

Setl is a three-way settlement reconciliation system for a Razorpay Buildathon submission. It reconciles a merchant's order ledger against a Razorpay settlement report against a bank statement, across a 300-record synthetic batch with known ground truth, and reports what it could not resolve.

The developer is a third-year CS student learning fintech, Next.js and backend development, on a hard 7-day deadline. Optimise for something finishable and defensible, not for something impressive.

## How to work with me

- **Explain before you implement.** State what you will change and which files you will touch. Wait for a go-ahead on anything beyond a single file.
- **Small changes.** One milestone per task. If a task needs more than about 250 lines across more than about 4 files, stop and propose splitting it.
- **Teach as you go.** I am learning this stack. When you use an unfamiliar pattern, add one sentence explaining it. No lectures.
- **Say when something is a bad idea.** If I ask for something that will break the deadline or the architecture, tell me plainly and propose the smaller version. Do not quietly comply.
- **If you are unsure, ask.** A clarifying question costs a minute. A wrong rewrite costs an afternoon.

## Non-negotiable engineering rules

**Money**
- All amounts are integers in **paise**. Never rupees, never floats.
- No `parseFloat`, no `Number()` on money strings, no `/` or `*` on money outside `lib/money.ts`.
- Rounding goes through `roundHalfUp()` in `lib/money.ts`. Nowhere else.
- If you catch yourself writing `Math.round` on an amount, stop and use the helper.

**Determinism**
- All financial truth is computed by deterministic code: matching, arithmetic, totals, fees, GST, duplicates, confidence, and the AUTO/REVIEW/UNRESOLVED decision.
- The LLM never computes, matches, or decides. It parses text and it writes prose. That is all.
- The system must produce a complete, correct reconciliation with `LLM_ENABLED=false`.
- No `Math.random()` anywhere. The generator uses a seeded mulberry32 PRNG.

**Composition**
- The settlement composition ladder (gross, fees, GST, refunds, disputes, adjustments, expected payout, bank received, difference) is computed **once**, by `lib/engine/pass6b-compose.ts`, and persisted.
- UI components render stored values. **No arithmetic on money in any component.** If a component needs a total, the engine supplies it.
- The LLM never computes, re-derives or checks a composition value. It receives them pre-formatted as strings.
- Conservation identities A and B are asserted at runtime and throw on breach. Never relax an assertion to make a run pass — a breach is a code bug.
- `SettlementBreakdown` and `CompositionTable` are built once and imported everywhere. Never write a second version.
- Drill-down is **one level**: a settlement to its own lines. Do not add order, refund or fee sub-levels.
- When no bucket accounts for a difference, the component is `UNATTRIBUTED`. Never force an attribution — guessing a bucket is the same failure as guessing a match.

**Ambiguity**
- When two or more candidates tie, the system **refuses**. It never picks the best-looking one.
- A false match is worse than an unresolved record. Optimise for low false-match rate, not high match rate.
- Records are never silently dropped. Bad input becomes an `INVALID_ROW` exception and carries forward.

**LLM discipline**
- Every LLM call requests structured JSON output.
- The narration parser receives the narration string only — no amounts, no dates, no settlement data.
- The explainer receives an evidence bundle where every number is already final and pre-formatted.
- Every explanation passes through `lib/ai/numberGuard.ts` before display. Rejections are logged, not hidden.
- Never widen the number-guard allowlist to make a rejection go away. If it rejects, that is the guard working.

**Security**
- Never write a secret into a file that is not `.env.local`.
- Never log or return `LLM_API_KEY` or `DATABASE_URL`, including inside error messages.
- All SQL goes through postgres.js tagged templates. No string concatenation, ever.
- Validate every API input against an explicit allowlist before it reaches a query.

**Scope discipline**
- Modify only the files named in the task. If a change seems to require touching something else, stop and say so.
- Do not refactor working code. Do not rename things. Do not reorganise imports across files.
- Do not change the architecture without asking. The passes, the taxonomy and the schema are fixed.
- Do not add a dependency without asking. Current stack: next, react, typescript, tailwind, postgres, recharts, vitest, tsx. That is the list.
- **Explicitly banned:** Docker, LangChain, Prisma, an ORM, Redis, any queue, any microservice split, any state management library.

**Tests**
- Run `npm run test` after any change to `lib/`.
- Never modify a test to make it pass. If a test fails, the code is wrong — report it and explain what the engine is actually doing.
- Never weaken an assertion. Never delete a failing test.

**Preserve working code**
- If it works, do not touch it. Additive changes over rewrites.
- Before replacing a function, say what is wrong with the current one.
- If a change breaks something that previously worked, revert it and tell me rather than patching forward.

## Deadline protection

Seven days total. The build order is: data → engine → metrics → AI → UI → docs.

If a task risks pushing past its day:
1. Say so immediately.
2. Propose the smallest version that keeps the milestone.
3. Never expand scope on your own initiative.

These are never cut, whatever else goes: the 300-record batch, the held-out batch, ground truth, the deterministic engine, the exception taxonomy, the metrics, the honest unresolved list.

These are cut first: ML model, grounded Q&A, live Razorpay API, threshold charts, CSV export, any visual polish.

## Definition of done for any task

- [ ] It compiles: `npx tsc --noEmit` is clean
- [ ] Tests pass: `npm run test`
- [ ] No floats on money, no `Math.random`, no concatenated SQL
- [ ] Only the named files changed
- [ ] I can explain every line of it in a panel interview
