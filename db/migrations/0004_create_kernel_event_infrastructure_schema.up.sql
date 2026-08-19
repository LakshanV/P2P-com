-- migration: 0004_create_kernel_event_infrastructure_schema
-- direction: up
-- owner: kernel_event_infrastructure
--
-- K-08 Event Infrastructure's own namespace and its three tables (FND-003b).
--
-- The log is PostgreSQL rather than a broker, and that is a design decision rather than a stopgap:
-- a producing module can append its domain rows and its events in the SAME transaction, which no
-- broker can offer. Every "we published the event but the write rolled back" incident comes from
-- pretending otherwise. A broker can be added later behind the same port.
--
--   event           append-only. One row per fact. Never updated, so there is no UPDATE anywhere
--                   in the adapter for this table and no column on it that a consumer could move.
--   event_delivery  one row per (event, subscription, generation). Delivery state lives here and
--                   not on the event, because a consumer's retry loop must never rewrite history.
--   event_receipt   one row per (subscription, event). Written in the same transaction as the
--                   acknowledgement, so it exists if and only if the delivery was acknowledged.
--
-- Two constraints carry the concurrency guarantees, and both are enforced here as well as in the
-- service, so that something writing around the service still cannot break them:
--
--   event_delivery_claim_token_unique   a claim token identifies ONE claim. Completion is
--                                       predicated on it, so a worker whose lease expired holds a
--                                       token that is no longer current and can update nothing.
--   event_delivery_generation_unique    a replay appends the next generation; it never reopens a
--                                       terminal row, so a stalled worker cannot complete work an
--                                       operator has already superseded.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_event_infrastructure;

COMMENT ON SCHEMA kernel_event_infrastructure IS
  'K-08 Event Infrastructure. Append-only event log, per-subscription delivery, consumer receipts.';

CREATE TABLE IF NOT EXISTS kernel_event_infrastructure.event (
  event_id             text        NOT NULL,
  event_type           text        NOT NULL,
  schema_version       integer     NOT NULL,
  occurred_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL,
  producer             text        NOT NULL,
  correlation_id       text        NOT NULL,
  causation_id         text        NULL,
  payload              jsonb       NOT NULL,
  payload_fingerprint  text        NOT NULL,
  idempotency_key      text        NOT NULL,
  origin               text        NOT NULL,
  CONSTRAINT event_pkey PRIMARY KEY (event_id),
  CONSTRAINT event_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT event_type_format
    CHECK (event_type ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT event_schema_version_positive CHECK (schema_version >= 1),
  -- AI may propose that something happened; it may not assert it. The service refuses the origin
  -- and so does this, because a fabricated event is indistinguishable from a real one downstream.
  CONSTRAINT event_origin_permitted CHECK (origin IN ('system', 'human')),
  CONSTRAINT event_not_recorded_before_it_happened CHECK (recorded_at >= occurred_at),
  CONSTRAINT event_instants_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz
       AND recorded_at > '-infinity'::timestamptz AND recorded_at < 'infinity'::timestamptz),
  CONSTRAINT event_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT event_fingerprint_format CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE kernel_event_infrastructure.event IS
  'Append-only. An event is evidence that a fact occurred and is never rewritten or deleted.';

CREATE TABLE IF NOT EXISTS kernel_event_infrastructure.event_delivery (
  delivery_id       text        NOT NULL,
  event_id          text        NOT NULL,
  subscription      text        NOT NULL,
  generation        integer     NOT NULL,
  status            text        NOT NULL,
  attempts          integer     NOT NULL,
  next_attempt_at   timestamptz NOT NULL,
  claimed_by        text        NULL,
  claim_token       text        NULL,
  claim_expires_at  timestamptz NULL,
  last_error        text        NULL,
  completed_at      timestamptz NULL,
  created_at        timestamptz NOT NULL,
  replay_of         text        NULL,
  replay_reason     text        NULL,
  CONSTRAINT event_delivery_pkey PRIMARY KEY (delivery_id),
  CONSTRAINT event_delivery_generation_unique UNIQUE (event_id, subscription, generation),
  CONSTRAINT event_delivery_claim_token_unique UNIQUE (claim_token),
  CONSTRAINT event_delivery_event_fkey
    FOREIGN KEY (event_id) REFERENCES kernel_event_infrastructure.event (event_id),
  CONSTRAINT event_delivery_replay_of_fkey
    FOREIGN KEY (replay_of) REFERENCES kernel_event_infrastructure.event_delivery (delivery_id),
  CONSTRAINT event_delivery_status_known
    CHECK (status IN ('pending', 'in-flight', 'delivered', 'dead-lettered')),
  CONSTRAINT event_delivery_generation_positive CHECK (generation >= 1),
  CONSTRAINT event_delivery_attempts_not_negative CHECK (attempts >= 0),
  -- A claim is all three fields or none of them. A half-set claim is a lease nobody owns.
  CONSTRAINT event_delivery_claim_is_whole
    CHECK ((claimed_by IS NULL) = (claim_token IS NULL)
       AND (claimed_by IS NULL) = (claim_expires_at IS NULL)),
  CONSTRAINT event_delivery_claim_only_in_flight
    CHECK ((status = 'in-flight') = (claim_token IS NOT NULL)),
  CONSTRAINT event_delivery_terminal_has_instant
    CHECK ((status IN ('delivered', 'dead-lettered')) = (completed_at IS NOT NULL)),
  CONSTRAINT event_delivery_replay_is_whole
    CHECK ((replay_of IS NULL) = (replay_reason IS NULL)),
  CONSTRAINT event_delivery_replay_has_generation
    CHECK (replay_of IS NULL OR generation > 1)
);

COMMENT ON TABLE kernel_event_infrastructure.event_delivery IS
  'One row per (event, subscription, generation). Terminal rows are never reopened; a replay appends.';

COMMENT ON COLUMN kernel_event_infrastructure.event_delivery.claim_token IS
  'Identifies one claim, not one worker. Every completion is predicated on it.';

CREATE TABLE IF NOT EXISTS kernel_event_infrastructure.event_receipt (
  subscription  text        NOT NULL,
  event_id      text        NOT NULL,
  delivery_id   text        NOT NULL,
  processed_at  timestamptz NOT NULL,
  CONSTRAINT event_receipt_pkey PRIMARY KEY (subscription, event_id),
  CONSTRAINT event_receipt_event_fkey
    FOREIGN KEY (event_id) REFERENCES kernel_event_infrastructure.event (event_id),
  CONSTRAINT event_receipt_delivery_fkey
    FOREIGN KEY (delivery_id) REFERENCES kernel_event_infrastructure.event_delivery (delivery_id)
);

COMMENT ON TABLE kernel_event_infrastructure.event_receipt IS
  'Consumer-side deduplication. Written in the same transaction as the acknowledgement, never apart.';

-- The claim query: due work for one subscription, oldest first. Partial, because delivered and
-- dead-lettered rows accumulate for ever and a worker never looks at them.
CREATE INDEX IF NOT EXISTS event_delivery_due_idx
  ON kernel_event_infrastructure.event_delivery (subscription, next_attempt_at, delivery_id)
  WHERE status IN ('pending', 'in-flight');

-- Reclaiming abandoned work: in-flight rows whose lease has run out.
CREATE INDEX IF NOT EXISTS event_delivery_expired_lease_idx
  ON kernel_event_infrastructure.event_delivery (claim_expires_at)
  WHERE status = 'in-flight';

-- Replay and inspection read every generation for one event and subscription.
CREATE INDEX IF NOT EXISTS event_delivery_event_idx
  ON kernel_event_infrastructure.event_delivery (event_id, subscription, generation DESC);

-- Tracing a causal chain across units, which is the point of carrying a correlation id at all.
CREATE INDEX IF NOT EXISTS event_correlation_idx
  ON kernel_event_infrastructure.event (correlation_id, recorded_at);

CREATE INDEX IF NOT EXISTS event_type_recorded_idx
  ON kernel_event_infrastructure.event (event_type, recorded_at);

COMMIT;
