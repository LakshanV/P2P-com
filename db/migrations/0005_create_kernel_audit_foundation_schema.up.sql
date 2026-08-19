-- migration: 0005_create_kernel_audit_foundation_schema
-- direction: up
-- owner: kernel_audit_foundation
--
-- K-09 Audit Foundation's own namespace and its single table (FND-003c).
--
-- One row per audited action, appended and never touched again. The value of an audit trail rests
-- entirely on that, so immutability is enforced here as well as in the service: the trigger below
-- refuses every UPDATE and DELETE against the table, which means a write that bypasses the adapter
-- still cannot edit history. The application refuses because it has no such operation; the database
-- refuses because it was told to.
--
-- The compound index on (recorded_at, record_id) is what makes paginated retrieval stable. Audit
-- records arrive in bursts and two can share an instant to the microsecond; an index and an ORDER BY
-- on time alone would leave the tie broken by whatever the planner returned, so a cursor built from
-- one page could skip or repeat rows on the next.
--
-- Evidence is jsonb because its fields are declared per action in the registry rather than in this
-- schema. Every field is classified at registration; nothing unclassified reaches this table.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_audit_foundation;

COMMENT ON SCHEMA kernel_audit_foundation IS
  'K-09 Audit Foundation. Append-only records of security-sensitive and business-authoritative actions.';

CREATE TABLE IF NOT EXISTS kernel_audit_foundation.audit_record (
  record_id             text        NOT NULL,
  action                text        NOT NULL,
  recorded_at           timestamptz NOT NULL,
  actor_kind            text        NOT NULL,
  actor_id              text        NOT NULL,
  actor_authentication  text        NOT NULL,
  actor_session_id      text        NULL,
  resource_owner        text        NOT NULL,
  resource_type         text        NOT NULL,
  resource_id           text        NOT NULL,
  outcome               text        NOT NULL,
  reason                text        NOT NULL,
  correlation_id        text        NOT NULL,
  causation_id          text        NULL,
  evidence              jsonb       NOT NULL,
  content_fingerprint   text        NOT NULL,
  idempotency_key       text        NOT NULL,
  CONSTRAINT audit_record_pkey PRIMARY KEY (record_id),
  CONSTRAINT audit_record_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT audit_record_action_format
    CHECK (action ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT audit_record_actor_kind_known
    CHECK (actor_kind IN ('human', 'system', 'ai')),
  -- AI may prompt a human or a deterministic system to record an action; it may not attest to one.
  -- The service refuses the actor and so does this, because a fabricated audit record is
  -- indistinguishable from a real one to everybody who reads it later.
  CONSTRAINT audit_record_actor_not_ai CHECK (actor_kind <> 'ai'),
  CONSTRAINT audit_record_authentication_known
    CHECK (actor_authentication IN ('unauthenticated', 'session', 'service-credential')),
  -- K-02 does not exist, so no session can have been established. A record claiming one would be
  -- asserting a verification that never happened. This constraint is expected to be relaxed by a
  -- later migration when authentication lands, and until then it keeps the log honest.
  CONSTRAINT audit_record_session_requires_authentication
    CHECK (actor_session_id IS NULL OR actor_authentication <> 'unauthenticated'),
  CONSTRAINT audit_record_outcome_known
    CHECK (outcome IN ('succeeded', 'failed', 'denied')),
  CONSTRAINT audit_record_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT audit_record_resource_type_format
    CHECK (resource_type ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
  CONSTRAINT audit_record_evidence_is_object CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT audit_record_fingerprint_format CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_record_recorded_at_finite
    CHECK (recorded_at > '-infinity'::timestamptz AND recorded_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_audit_foundation.audit_record IS
  'Append-only. Refused by trigger against UPDATE and DELETE: an audit trail that can be amended is not evidence.';

COMMENT ON COLUMN kernel_audit_foundation.audit_record.actor_authentication IS
  'How the identity was established. Always unauthenticated until K-02 exists, and recorded as such.';

COMMENT ON COLUMN kernel_audit_foundation.audit_record.evidence IS
  'Structured evidence. Every field is declared and classified in the K-09 action registry.';

-- Immutability, enforced by the database rather than by convention. A trigger rather than a
-- permission grant because no roles exist yet: this holds for every connection, including the one
-- an operator opens by hand at three in the morning.
CREATE OR REPLACE FUNCTION kernel_audit_foundation.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN RAISE EXCEPTION ''audit records are append-only: % on kernel_audit_foundation.audit_record is refused'', TG_OP USING ERRCODE = ''restrict_violation''; END;';

COMMENT ON FUNCTION kernel_audit_foundation.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against the audit table. Dropped only by the 0005 rollback.';

CREATE TRIGGER audit_record_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_audit_foundation.audit_record
  FOR EACH ROW EXECUTE FUNCTION kernel_audit_foundation.refuse_mutation();

-- Retrieval reads a filtered window in time order, page by page. The record id breaks ties so a
-- cursor is stable when two records share an instant.
CREATE INDEX IF NOT EXISTS audit_record_chronological_idx
  ON kernel_audit_foundation.audit_record (recorded_at, record_id);

-- The three filters an investigation actually starts from: who, what was touched, and what chain.
CREATE INDEX IF NOT EXISTS audit_record_actor_idx
  ON kernel_audit_foundation.audit_record (actor_id, recorded_at, record_id);

CREATE INDEX IF NOT EXISTS audit_record_resource_idx
  ON kernel_audit_foundation.audit_record (resource_owner, resource_type, resource_id, recorded_at);

CREATE INDEX IF NOT EXISTS audit_record_correlation_idx
  ON kernel_audit_foundation.audit_record (correlation_id, recorded_at, record_id);

CREATE INDEX IF NOT EXISTS audit_record_action_idx
  ON kernel_audit_foundation.audit_record (action, recorded_at, record_id);

COMMIT;
