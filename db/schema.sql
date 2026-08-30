-- Setl schema. Section 6 of SETL_BLUEPRINT.md.
--
-- MONEY: every amount is BIGINT storing integer paise. Never FLOAT, never
-- MONEY, never NUMERIC for an amount. NUMERIC appears only for confidence
-- scores, which are ratios rather than money.
--
-- TIME: every timestamp is TIMESTAMPTZ. value_date on bank_lines is DATE
-- because a bank statement credits a calendar day, not an instant.
--
-- This file is idempotent by construction: it drops before it creates, so
-- `npm run migrate` can be re-run at any point. That is safe here because
-- the data is regenerable from committed CSVs; it would not be safe against
-- a database holding anything you cannot rebuild.

DROP TABLE IF EXISTS llm_calls CASCADE;
DROP TABLE IF EXISTS run_metrics CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS exceptions CASCADE;
DROP TABLE IF EXISTS links CASCADE;
DROP TABLE IF EXISTS settlement_composition CASCADE;
DROP TABLE IF EXISTS bank_lines CASCADE;
DROP TABLE IF EXISTS settlement_lines CASCADE;
DROP TABLE IF EXISTS settlements CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS runs CASCADE;


-- ---------------------------------------------------------------------------
-- runs — one row per reconciliation execution. Owns everything else.
-- ---------------------------------------------------------------------------
CREATE TABLE runs (
  id            TEXT        PRIMARY KEY,
  batch         TEXT        NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  status        TEXT        NOT NULL,
  config        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  record_count  INT         NOT NULL DEFAULT 0,

  CONSTRAINT runs_batch_check  CHECK (batch IN ('main', 'holdout')),
  CONSTRAINT runs_status_check CHECK (status IN ('running', 'complete', 'failed'))
);


-- ---------------------------------------------------------------------------
-- orders — Source A, the merchant's own order ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id             TEXT        PRIMARY KEY,
  run_id         TEXT        NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  order_id       TEXT        NOT NULL,
  order_ref      TEXT        NOT NULL,
  customer_ref   TEXT,
  order_amount   BIGINT      NOT NULL,
  currency       TEXT        NOT NULL DEFAULT 'INR',
  created_at     TIMESTAMPTZ NOT NULL,
  order_status   TEXT        NOT NULL,
  refund_issued  BIGINT      NOT NULL DEFAULT 0,

  CONSTRAINT orders_status_check CHECK (
    order_status IN ('paid', 'refunded', 'partially_refunded', 'cancelled')
  )
);

CREATE INDEX orders_run_idx           ON orders (run_id);
CREATE INDEX orders_run_order_id_idx  ON orders (run_id, order_id);
CREATE INDEX orders_run_amount_idx    ON orders (run_id, order_amount);


-- ---------------------------------------------------------------------------
-- settlements — Source B, header. Mirrors Razorpay's settlement entity.
-- ---------------------------------------------------------------------------
CREATE TABLE settlements (
  id             TEXT        PRIMARY KEY,
  run_id         TEXT        NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  settlement_id  TEXT        NOT NULL,
  amount         BIGINT      NOT NULL,
  fees           BIGINT      NOT NULL DEFAULT 0,
  tax            BIGINT      NOT NULL DEFAULT 0,
  utr            TEXT,
  status         TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,

  CONSTRAINT settlements_status_check CHECK (status IN ('processed', 'failed'))
);

CREATE INDEX settlements_run_utr_idx  ON settlements (run_id, utr);
CREATE INDEX settlements_run_sid_idx  ON settlements (run_id, settlement_id);


-- ---------------------------------------------------------------------------
-- settlement_lines — Source B, detail. Mirrors the recon API item shape.
--
-- contribution / contribution_bucket / contribution_reason are written by
-- Pass 6B (prompt 09B), once composition exists to compute them.
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_lines (
  id                    TEXT        PRIMARY KEY,
  run_id                TEXT        NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  entity_id             TEXT        NOT NULL,
  type                  TEXT        NOT NULL,
  debit                 BIGINT      NOT NULL DEFAULT 0,
  credit                BIGINT      NOT NULL DEFAULT 0,
  amount                BIGINT      NOT NULL DEFAULT 0,
  fee                   BIGINT      NOT NULL DEFAULT 0,
  tax                   BIGINT      NOT NULL DEFAULT 0,
  on_hold               BOOLEAN     NOT NULL DEFAULT FALSE,
  settled               BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL,
  settled_at            TIMESTAMPTZ,
  settlement_id         TEXT,
  settlement_utr        TEXT,
  order_id              TEXT,
  method                TEXT,
  card_network          TEXT,
  card_type             TEXT,
  international         BOOLEAN     NOT NULL DEFAULT FALSE,
  dispute_id            TEXT,
  description           TEXT,
  contribution          BIGINT,
  contribution_bucket   TEXT,
  contribution_reason   TEXT,

  CONSTRAINT settlement_lines_type_check CHECK (
    type IN ('payment', 'refund', 'adjustment', 'dispute', 'transfer')
  ),
  CONSTRAINT settlement_lines_method_check CHECK (
    method IS NULL OR method IN ('card', 'upi', 'netbanking', 'wallet')
  ),
  CONSTRAINT settlement_lines_card_type_check CHECK (
    card_type IS NULL OR card_type IN ('credit', 'debit')
  ),
  CONSTRAINT settlement_lines_contribution_bucket_check CHECK (
    contribution_bucket IS NULL OR contribution_bucket IN ('gross', 'refund', 'dispute', 'adjustment')
  )
);

CREATE INDEX settlement_lines_run_sid_idx    ON settlement_lines (run_id, settlement_id);
CREATE INDEX settlement_lines_run_order_idx  ON settlement_lines (run_id, order_id);
CREATE INDEX settlement_lines_run_type_idx   ON settlement_lines (run_id, type);


-- ---------------------------------------------------------------------------
-- settlement_composition — one row per settlement per run. The named-bucket
-- ladder. Written by Pass 6B, for every settlement, reconciled or not.
-- ---------------------------------------------------------------------------
CREATE TABLE settlement_composition (
  run_id                    TEXT        NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  settlement_id             TEXT        NOT NULL,
  gross_payments            BIGINT      NOT NULL,
  fees_total                BIGINT      NOT NULL,
  gst_total                 BIGINT      NOT NULL,
  refunds_total             BIGINT      NOT NULL,
  disputes_total            BIGINT      NOT NULL,
  adjustments_net           BIGINT      NOT NULL,
  expected_payout           BIGINT      NOT NULL,
  header_amount             BIGINT      NOT NULL,
  bank_credit_total         BIGINT,
  diff_expected_vs_header   BIGINT      NOT NULL,
  diff_header_vs_bank       BIGINT,
  diff_total                BIGINT,
  payment_count             INT         NOT NULL DEFAULT 0,
  refund_count              INT         NOT NULL DEFAULT 0,
  dispute_count             INT         NOT NULL DEFAULT 0,
  adjustment_count          INT         NOT NULL DEFAULT 0,
  status                    TEXT        NOT NULL,
  discrepancy_component     TEXT        NOT NULL,
  evidence                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  computed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (run_id, settlement_id),
  CONSTRAINT settlement_composition_status_check CHECK (
    status IN ('FULLY_RECONCILED', 'RECONCILED_WITH_ROUNDING', 'DISCREPANCY', 'UNMATCHED_TO_BANK')
  ),
  CONSTRAINT settlement_composition_component_check CHECK (
    discrepancy_component IN (
      'NONE', 'FEES', 'GST', 'REFUNDS', 'DISPUTES', 'ADJUSTMENTS', 'BANK_CREDIT', 'ROUNDING', 'UNATTRIBUTED'
    )
  )
);

CREATE INDEX settlement_composition_run_status_idx  ON settlement_composition (run_id, status);
CREATE INDEX settlement_composition_run_diff_idx    ON settlement_composition (run_id, diff_total DESC);
CREATE INDEX settlement_composition_run_comp_idx    ON settlement_composition (run_id, discrepancy_component);


-- ---------------------------------------------------------------------------
-- bank_lines — Source C, the bank statement.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_lines (
  id               TEXT    PRIMARY KEY,
  run_id           TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  line_no          INT     NOT NULL,
  value_date       DATE    NOT NULL,
  narration        TEXT    NOT NULL,
  ref_no           TEXT,
  debit            BIGINT  NOT NULL DEFAULT 0,
  credit           BIGINT  NOT NULL DEFAULT 0,
  closing_balance  BIGINT  NOT NULL DEFAULT 0,
  parsed_utr       TEXT,
  parse_source     TEXT,

  CONSTRAINT bank_lines_parse_source_check CHECK (
    parse_source IS NULL OR parse_source IN ('regex', 'llm', 'pending_llm', 'failed')
  )
);

CREATE INDEX bank_lines_run_utr_idx     ON bank_lines (run_id, parsed_utr);
CREATE INDEX bank_lines_run_date_idx    ON bank_lines (run_id, value_date);
CREATE INDEX bank_lines_run_credit_idx  ON bank_lines (run_id, credit);


-- ---------------------------------------------------------------------------
-- links — proposed relationships between records. The output of matching.
--
-- confidence is NUMERIC because it is a ratio in [0,1], not money.
-- ---------------------------------------------------------------------------
CREATE TABLE links (
  id            TEXT          PRIMARY KEY,
  run_id        TEXT          NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  left_source   TEXT          NOT NULL,
  left_id       TEXT          NOT NULL,
  right_source  TEXT          NOT NULL,
  right_id      TEXT          NOT NULL,
  relation      TEXT          NOT NULL,
  pass          INT           NOT NULL,
  confidence    NUMERIC(5,4)  NOT NULL,
  evidence      JSONB         NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT links_left_source_check CHECK (
    left_source IN ('bank', 'settlement', 'settlement_line', 'order')
  ),
  CONSTRAINT links_right_source_check CHECK (
    right_source IN ('bank', 'settlement', 'settlement_line', 'order')
  ),
  CONSTRAINT links_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT links_pass_check       CHECK (pass BETWEEN 0 AND 7)
);

CREATE INDEX links_run_idx        ON links (run_id);
CREATE INDEX links_run_left_idx   ON links (run_id, left_source, left_id);
CREATE INDEX links_run_right_idx  ON links (run_id, right_source, right_id);


-- ---------------------------------------------------------------------------
-- exceptions — one row per record the engine has something to say about.
-- ---------------------------------------------------------------------------
CREATE TABLE exceptions (
  id                    TEXT          PRIMARY KEY,
  run_id                TEXT          NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  record_source         TEXT          NOT NULL,
  record_id             TEXT          NOT NULL,
  class                 TEXT          NOT NULL,
  decision              TEXT          NOT NULL,
  confidence            NUMERIC(5,4)  NOT NULL,
  amount_impact         BIGINT        NOT NULL DEFAULT 0,
  evidence              JSONB         NOT NULL DEFAULT '{}'::jsonb,
  deterministic_reason  TEXT          NOT NULL,
  ai_explanation        TEXT,
  ai_status             TEXT          NOT NULL DEFAULT 'not_requested',
  next_action           TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT exceptions_decision_check CHECK (
    decision IN ('AUTO_RESOLVED', 'NEEDS_REVIEW', 'UNRESOLVED')
  ),
  CONSTRAINT exceptions_ai_status_check CHECK (
    ai_status IN ('ok', 'rejected_by_guard', 'not_requested', 'error')
  ),
  CONSTRAINT exceptions_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  -- The 15-class taxonomy of section 11, plus INVALID_ROW for unparseable
  -- input and NOT_SETTLED (lib/types.ts's ExceptionClass doc explains why:
  -- it resolves a naming collision between section 10's Pass 5 and section
  -- 11's own MISSING_IN_LEDGER). Enforced here so a typo in the classifier
  -- fails at write time rather than quietly creating a stray class nobody notices.
  CONSTRAINT exceptions_class_check CHECK (class IN (
    'MATCHED_EXACT',
    'FEE_DEDUCTION',
    'GST_ON_FEE',
    'TDS_194O',
    'TIMING_DIFFERENCE',
    'PARTIAL_SETTLEMENT',
    'SPLIT_PAYOUT',
    'REFUND_NETTED',
    'DISPUTE_HOLD',
    'DUPLICATE_CREDIT',
    'MISSING_IN_BANK',
    'MISSING_IN_LEDGER',
    'NOT_SETTLED',
    'AMOUNT_MISMATCH',
    'FEE_OVERCHARGE',
    'ROUNDING_RESIDUAL',
    'UNRESOLVED',
    'INVALID_ROW'
  ))
);

CREATE INDEX exceptions_run_decision_idx ON exceptions (run_id, decision);
CREATE INDEX exceptions_run_class_idx    ON exceptions (run_id, class);
CREATE INDEX exceptions_run_impact_idx   ON exceptions (run_id, amount_impact DESC);


-- ---------------------------------------------------------------------------
-- audit_log — append-only. One row per decision the system makes.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              BIGSERIAL     PRIMARY KEY,
  run_id          TEXT          NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  subject_source  TEXT          NOT NULL,
  subject_id      TEXT          NOT NULL,
  action          TEXT          NOT NULL,
  rule            TEXT          NOT NULL,
  confidence      NUMERIC(5,4),
  detail          JSONB         NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT audit_log_action_check CHECK (
    action IN ('LINKED', 'CLASSIFIED', 'AUTO_RESOLVED', 'ESCALATED', 'REFUSED')
  )
);

CREATE INDEX audit_log_run_at_idx   ON audit_log (run_id, at);
CREATE INDEX audit_log_subject_idx  ON audit_log (subject_source, subject_id);


-- ---------------------------------------------------------------------------
-- run_metrics — the whole metrics object from section 16, one row per run.
-- ---------------------------------------------------------------------------
CREATE TABLE run_metrics (
  run_id   TEXT  PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  payload  JSONB NOT NULL
);


-- ---------------------------------------------------------------------------
-- llm_calls — every AI invocation and whether the number guard caught it.
--
-- Deliberately narrow: it exists because the guard rejection count is a
-- headline claim. Nothing else gets added to it.
-- ---------------------------------------------------------------------------
CREATE TABLE llm_calls (
  id               BIGSERIAL    PRIMARY KEY,
  run_id           TEXT         NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  purpose          TEXT         NOT NULL,
  prompt_hash      TEXT,
  latency_ms       INT,
  guard_result     TEXT,
  rejected_tokens  JSONB,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT llm_calls_purpose_check CHECK (purpose IN ('narration', 'explain', 'qa')),
  CONSTRAINT llm_calls_guard_check CHECK (
    guard_result IS NULL OR guard_result IN ('pass', 'reject', 'n/a')
  )
);

CREATE INDEX llm_calls_run_idx      ON llm_calls (run_id);
CREATE INDEX llm_calls_purpose_idx  ON llm_calls (run_id, purpose);
