-- migration: 0016_create_kernel_commerce_unit_registry_outbox
-- direction: up
-- owner: kernel_commerce_unit_registry
--
-- K-11 Commerce Unit Registry outbox (FND-003d).
--
-- Publishing, activating and retiring a commerce unit type each appends rows here inside the
-- same transaction that writes the registry history. A relay later reads unprocessed rows and
-- dispatches them to K-08 Event Infrastructure and K-09 Audit Foundation. Because the outbox
-- lives in K-11's own schema, the module does not need to open K-08 or K-09 transactions to publish
-- atomically.
--
-- The table is not append-only: the relay updates processed_at and retry_count as it works. That is
-- deliberate — the outbox is operational state, not evidence.

BEGIN;

CREATE TABLE IF NOT EXISTS kernel_commerce_unit_registry.outbox (
  outbox_id           text        NOT NULL,
  idempotency_key     text        NOT NULL,
  kind                text        NOT NULL,
  payload             jsonb       NOT NULL,
  recorded_at         timestamptz NOT NULL,
  producer            text        NOT NULL,
  correlation_id      text        NOT NULL,
  processed_at        timestamptz NULL,
  retry_count         integer     NOT NULL DEFAULT 0,
  last_error          text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_retry_non_negative CHECK (retry_count >= 0)
);

COMMENT ON TABLE kernel_commerce_unit_registry.outbox IS
  'Transactional outbox for commerce unit registry events and audit records, dispatched by a relay.';

-- The relay polls this index for unprocessed rows.
CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_commerce_unit_registry.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

COMMIT;
