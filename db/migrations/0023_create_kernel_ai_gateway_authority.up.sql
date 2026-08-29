-- migration: 0023_create_kernel_ai_gateway_authority
-- direction: up
-- owner: kernel_ai_gateway
--
-- K-13 AI Gateway — graduated authority, and the kill switch.
--
-- Migration 0019 gave K-13 a place to *record* that an AI-influenced decision had a policy level.
-- Recording is not controlling: nothing consulted that level before a task ran, so every registered
-- task could be invoked with any authority anybody claimed.
--
-- This migration adds the grant that a run is checked against.
--
--   task_authority   an append-only version history of what one task is permitted to do
--
-- A grant states a ceiling (`max_authority`, 0-4) and whether the task is suspended. Raising a
-- ceiling, lowering it and pulling the kill switch are all the same operation — a new version — so
-- "who allowed this, and when" always has an answer, and the grant that was in force last month is
-- still readable after this month's change. The grant in force at an instant is the latest version
-- granted at or before it.
--
--   0 observe                 may look and record; may not propose
--   1 recommend               may propose; a human decides and acts
--   2 prepare                 may assemble a complete action; a human approves before it executes
--   3 execute-within-limits   may execute an approved class of low-risk action inside stated limits
--   4 manage-with-exceptions  may run a defined operational area, escalating exceptions to a human
--
-- `suspended` refuses every level including 0, because something that keeps observing after being
-- switched off is not switched off.
--
-- `ai_run` gains `authority_level`: the level the run actually executed under, recorded on the run
-- rather than inferred from the grant, because the grant can change afterwards and the question an
-- audit asks is what was permitted at the time. Rows written before this migration are backfilled
-- to 1 (recommend) — a run made when nothing could authorise action had no authority to act — and
-- the default is then dropped so a writer must state it.
--
-- `rationale` is NOT NULL and non-empty: a grant nobody explained is a grant nobody can review.
--
-- Forward-additive: no column is dropped and no row is deleted.
--
-- This migration touches no other unit's schema.

BEGIN;

-- ---------------------------------------------------------------------------
-- Authority grants
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.task_authority (
  authority_id      text        NOT NULL,
  task_id           text        NOT NULL,
  max_authority     integer     NOT NULL,
  suspended         boolean     NOT NULL,
  rationale         text        NOT NULL,
  granted_by        text        NOT NULL,
  granted_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT task_authority_pkey PRIMARY KEY (authority_id),
  CONSTRAINT task_authority_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT task_authority_id_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(authority_id)),
  -- The same dotted-lowercase shape migration 0019 requires of task_definition.task_id, written
  -- out rather than shared, exactly as that migration writes it.
  CONSTRAINT task_authority_task_id_dotted_lowercase
    CHECK (task_id ~ '^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT task_authority_level_known
    CHECK (max_authority BETWEEN 0 AND 4),
  CONSTRAINT task_authority_rationale_present
    CHECK (length(btrim(rationale)) > 0),
  CONSTRAINT task_authority_granted_by_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(granted_by)),
  CONSTRAINT task_authority_idempotency_key_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(idempotency_key)),
  CONSTRAINT task_authority_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz),
  CONSTRAINT task_authority_task_exists
    FOREIGN KEY (task_id) REFERENCES kernel_ai_gateway.task_definition(task_id)
);

COMMENT ON TABLE kernel_ai_gateway.task_authority IS
  'Append-only version history of what one task is permitted to do. The grant in force at an instant is the latest version granted at or before it.';

COMMENT ON COLUMN kernel_ai_gateway.task_authority.max_authority IS
  '0 observe, 1 recommend, 2 prepare, 3 execute-within-limits, 4 manage-with-exceptions.';
COMMENT ON COLUMN kernel_ai_gateway.task_authority.suspended IS
  'The kill switch. While true the task refuses every level, including observe.';
COMMENT ON COLUMN kernel_ai_gateway.task_authority.rationale IS
  'Why this ceiling was set. A grant nobody explained is a grant nobody can review.';

-- The resolution query: latest grant for a task at or before an instant.
CREATE INDEX IF NOT EXISTS task_authority_in_force_idx
  ON kernel_ai_gateway.task_authority (task_id, granted_at DESC, authority_id DESC);

-- ---------------------------------------------------------------------------
-- The level a run executed under
-- ---------------------------------------------------------------------------

ALTER TABLE kernel_ai_gateway.ai_run
  ADD COLUMN IF NOT EXISTS authority_level integer NOT NULL DEFAULT 1;

ALTER TABLE kernel_ai_gateway.ai_run
  ALTER COLUMN authority_level DROP DEFAULT;

ALTER TABLE kernel_ai_gateway.ai_run
  ADD CONSTRAINT ai_run_authority_level_known
    CHECK (authority_level BETWEEN 0 AND 4);

COMMENT ON COLUMN kernel_ai_gateway.ai_run.authority_level IS
  'The authority level this run executed under, as permitted at the time. Recorded, not inferred: the grant can change afterwards.';

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE TRIGGER task_authority_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ai_gateway.task_authority
  FOR EACH ROW EXECUTE FUNCTION kernel_ai_gateway.refuse_mutation();

COMMIT;
