-- migration: 0028_create_module_orders_schema
-- direction: up
-- owner: module_orders
--
-- M-11 Orders' own namespace: the order header, its lines, the immutable commercial snapshot, the
-- append-only transition log, and the module outbox.
--
-- Owned data:
--   * `order_header`   — the mutable administrative state of one agreement. Named `order_header`
--     rather than `order` because ORDER is a reserved word in SQL and an unquoted
--     `module_orders.order` is a parse error waiting for the first person who forgets the quotes.
--   * `order_item`     — one line, pinning `(listing_id, version_id)`. Append-only.
--   * `order_snapshot` — what both parties agreed, captured once at placement. Append-only, one row
--     per order.
--   * `order_event`    — the append-only transition log behind the header's current status.
--   * `outbox`         — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- The module's central rule is that **an agreement does not change after it is made**. Three of the
-- five tables are append-only and enforced so by trigger; the header holds only administrative
-- state that legitimately moves — the status and its timestamps.
--
-- `version_id` is the M-04 listing version the line was priced from. It is an opaque identifier and
-- deliberately **not** a foreign key: MODULE_MAP §10.4 forbids one unit joining to another's tables.
-- The same applies to `buyer_account_id` and `seller_account_id` (K-03) and `reservation_id` (M-04
-- inventory). The cost is stated rather than hidden: the database will not stop a line referencing a
-- version that does not exist. The service reads M-04 through its public contract.
--
-- M-11 sits in the deterministic financial authority zone. Every amount here is an exact integer in
-- minor units. **No `double precision`, `real`, `float` or `money` column exists in this schema**,
-- and a price that cannot be represented exactly is a price somebody eventually disputes.
--
-- `is_opaque_identifier` is M-11's own copy of the rule set used by every other unit, in M-11's
-- schema, for the same ownership reason: a CHECK calling another schema's function would make the
-- two units one object. The copies are required to be character-for-character identical by
-- `tests/migrations.test.ts`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_orders;

COMMENT ON SCHEMA module_orders IS
  'M-11 Orders. Order headers, lines, the immutable commercial snapshot, the transition log and the module outbox.';

-- Character-for-character identical to the copies in every other schema that carries one, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION module_orders.is_opaque_identifier(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $rules$
  SELECT
    -- Shape: 8-128 characters, opaque alphabet, starting alphanumeric. Shorter than 8 is an
    -- ordinal, and an enumerable identity space lets anybody count the platform's parties.
        value ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    -- Credentials, by name and by shape. An identity record is permanent; a secret in one is
    -- disclosed for as long as the platform exists.
    AND value !~* '(password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential|authorization|bearer)'
    AND value !~ '\ysk-[A-Za-z0-9]{16,}'
    AND value !~ '\yghp_[A-Za-z0-9]{20,}'
    AND value !~ '\yAKIA[0-9A-Z]{16}'
    AND value !~ '\yeyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    -- Natural keys. Each of these publishes personal data into every row that copies the id.
    AND position('@' in value) = 0
    AND value !~ '^[0-9]{7,}$'
    AND value !~ '[0-9]{12,}'
    AND value !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,}$'
    AND value !~* '^(https?|mailto|tel):'
    AND value !~* '\.(com|net|org|io|co|uk|lk)$'
    AND value !~ '^[A-Za-z]+[._-][A-Za-z]+$'
    AND value !~* '^(dob|ssn|nic|nin|tin|vat|passport)[-._:]'
$rules$;

COMMENT ON FUNCTION module_orders.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Order header: the administrative state of one agreement
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_orders.order_header (
  order_id             text        NOT NULL,
  buyer_account_id     text        NOT NULL,
  seller_account_id    text        NOT NULL,
  status               text        NOT NULL,
  currency             text        NOT NULL,
  subtotal_minor       bigint      NOT NULL,
  total_minor          bigint      NOT NULL,
  item_count           integer     NOT NULL,
  placed_at            timestamptz NULL,
  confirmed_at         timestamptz NULL,
  completed_at         timestamptz NULL,
  cancelled_at         timestamptz NULL,
  cancellation_reason  text        NULL,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  correlation_id       text        NOT NULL,
  idempotency_key      text        NOT NULL,

  CONSTRAINT order_header_pkey PRIMARY KEY (order_id),
  CONSTRAINT order_header_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT order_header_id_opaque
    CHECK (module_orders.is_opaque_identifier(order_id)),
  CONSTRAINT order_header_buyer_opaque
    CHECK (module_orders.is_opaque_identifier(buyer_account_id)),
  CONSTRAINT order_header_seller_opaque
    CHECK (module_orders.is_opaque_identifier(seller_account_id)),
  CONSTRAINT order_header_correlation_opaque
    CHECK (module_orders.is_opaque_identifier(correlation_id)),
  CONSTRAINT order_header_idempotency_opaque
    CHECK (module_orders.is_opaque_identifier(idempotency_key)),

  CONSTRAINT order_header_status_known
    CHECK (status IN ('draft', 'placed', 'confirmed', 'fulfilling', 'completed', 'cancelled')),
  CONSTRAINT order_header_cancellation_reason_known
    CHECK (cancellation_reason IS NULL OR cancellation_reason IN
      ('buyer-withdrew', 'seller-declined', 'payment-failed', 'stock-unavailable', 'expired')),
  CONSTRAINT order_header_currency_well_formed
    CHECK (currency ~ '^[A-Z]{3}$'),

  CONSTRAINT order_header_subtotal_non_negative CHECK (subtotal_minor >= 0),
  CONSTRAINT order_header_total_non_negative CHECK (total_minor >= 0),
  CONSTRAINT order_header_item_count_non_negative CHECK (item_count >= 0),

  -- The status and its timestamps must agree. Without these a row can claim to be cancelled with no
  -- instant of cancellation, and the two facts disagree with nobody to arbitrate.
  CONSTRAINT order_header_cancelled_at_matches_status
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT order_header_cancellation_reason_matches_status
    CHECK ((status = 'cancelled') = (cancellation_reason IS NOT NULL)),
  CONSTRAINT order_header_completed_at_matches_status
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  -- A draft has never been placed; everything past draft has, except a draft cancelled before
  -- placement.
  CONSTRAINT order_header_placed_at_present_once_past_draft
    CHECK (status IN ('draft', 'cancelled') OR placed_at IS NOT NULL),
  CONSTRAINT order_header_draft_never_placed
    CHECK (status <> 'draft' OR placed_at IS NULL),
  CONSTRAINT order_header_confirmed_at_present_once_confirmed
    CHECK (status NOT IN ('confirmed', 'fulfilling', 'completed') OR confirmed_at IS NOT NULL),

  CONSTRAINT order_header_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT order_header_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_orders.order_header IS
  'One agreement. Only administrative state is mutable; the lines, snapshot and event log are append-only.';

CREATE INDEX IF NOT EXISTS order_header_buyer_idx
  ON module_orders.order_header (buyer_account_id, created_at, order_id);

CREATE INDEX IF NOT EXISTS order_header_seller_idx
  ON module_orders.order_header (seller_account_id, created_at, order_id);

CREATE INDEX IF NOT EXISTS order_header_status_idx
  ON module_orders.order_header (status);

-- ---------------------------------------------------------------------------
-- Order item: one line, pinning the listing version it was priced from
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_orders.order_item (
  item_id                 text        NOT NULL,
  order_id                text        NOT NULL,
  listing_id              text        NOT NULL,
  version_id              text        NOT NULL,
  commerce_unit_type_id   text        NOT NULL,
  quantity                bigint      NOT NULL,
  unit_price_minor        bigint      NOT NULL,
  line_total_minor        bigint      NOT NULL,
  currency                text        NOT NULL,
  reservation_id          text        NULL,
  added_at                timestamptz NOT NULL,
  correlation_id          text        NOT NULL,
  idempotency_key         text        NOT NULL,

  CONSTRAINT order_item_pkey PRIMARY KEY (item_id),
  CONSTRAINT order_item_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT order_item_id_opaque
    CHECK (module_orders.is_opaque_identifier(item_id)),
  CONSTRAINT order_item_order_id_opaque
    CHECK (module_orders.is_opaque_identifier(order_id)),
  CONSTRAINT order_item_listing_id_opaque
    CHECK (module_orders.is_opaque_identifier(listing_id)),
  CONSTRAINT order_item_version_id_opaque
    CHECK (module_orders.is_opaque_identifier(version_id)),
  CONSTRAINT order_item_unit_type_opaque
    CHECK (module_orders.is_opaque_identifier(commerce_unit_type_id)),
  CONSTRAINT order_item_reservation_opaque
    CHECK (reservation_id IS NULL OR module_orders.is_opaque_identifier(reservation_id)),
  CONSTRAINT order_item_correlation_opaque
    CHECK (module_orders.is_opaque_identifier(correlation_id)),
  CONSTRAINT order_item_idempotency_opaque
    CHECK (module_orders.is_opaque_identifier(idempotency_key)),

  CONSTRAINT order_item_currency_well_formed CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT order_item_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_item_unit_price_non_negative CHECK (unit_price_minor >= 0),
  CONSTRAINT order_item_line_total_non_negative CHECK (line_total_minor >= 0),
  -- The arithmetic is checked by the database as well as the service. A line total that does not
  -- equal quantity times unit price is a number nobody can defend in a dispute.
  CONSTRAINT order_item_line_total_is_product
    CHECK (line_total_minor = quantity * unit_price_minor),
  CONSTRAINT order_item_added_at_finite
    CHECK (added_at > '-infinity'::timestamptz AND added_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_orders.order_item IS
  'One order line. Pins (listing_id, version_id) — the permanent address of the terms it was priced from. Append-only.';

CREATE INDEX IF NOT EXISTS order_item_order_idx
  ON module_orders.order_item (order_id, added_at, item_id);

CREATE INDEX IF NOT EXISTS order_item_version_idx
  ON module_orders.order_item (version_id);

-- ---------------------------------------------------------------------------
-- Order snapshot: what was agreed, captured once
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_orders.order_snapshot (
  snapshot_id        text        NOT NULL,
  order_id           text        NOT NULL,
  buyer_account_id   text        NOT NULL,
  seller_account_id  text        NOT NULL,
  currency           text        NOT NULL,
  subtotal_minor     bigint      NOT NULL,
  total_minor        bigint      NOT NULL,
  lines              jsonb       NOT NULL,
  policy_version_id  text        NULL,
  captured_at        timestamptz NOT NULL,
  correlation_id     text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT order_snapshot_pkey PRIMARY KEY (snapshot_id),
  CONSTRAINT order_snapshot_idempotency_unique UNIQUE (idempotency_key),
  -- One snapshot per order. An order with two snapshots has two agreements, and no way to say which
  -- one a dispute is judged against.
  CONSTRAINT order_snapshot_order_unique UNIQUE (order_id),

  CONSTRAINT order_snapshot_id_opaque
    CHECK (module_orders.is_opaque_identifier(snapshot_id)),
  CONSTRAINT order_snapshot_order_id_opaque
    CHECK (module_orders.is_opaque_identifier(order_id)),
  CONSTRAINT order_snapshot_buyer_opaque
    CHECK (module_orders.is_opaque_identifier(buyer_account_id)),
  CONSTRAINT order_snapshot_seller_opaque
    CHECK (module_orders.is_opaque_identifier(seller_account_id)),
  CONSTRAINT order_snapshot_policy_opaque
    CHECK (policy_version_id IS NULL OR module_orders.is_opaque_identifier(policy_version_id)),
  CONSTRAINT order_snapshot_correlation_opaque
    CHECK (module_orders.is_opaque_identifier(correlation_id)),
  CONSTRAINT order_snapshot_idempotency_opaque
    CHECK (module_orders.is_opaque_identifier(idempotency_key)),

  CONSTRAINT order_snapshot_currency_well_formed CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT order_snapshot_subtotal_non_negative CHECK (subtotal_minor >= 0),
  CONSTRAINT order_snapshot_total_non_negative CHECK (total_minor >= 0),
  CONSTRAINT order_snapshot_lines_object CHECK (jsonb_typeof(lines) = 'object'),
  CONSTRAINT order_snapshot_captured_at_finite
    CHECK (captured_at > '-infinity'::timestamptz AND captured_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_orders.order_snapshot IS
  'The commercial agreement, captured at placement. One per order. Append-only: this is what a dispute is judged against.';

-- ---------------------------------------------------------------------------
-- Order event: the append-only transition log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_orders.order_event (
  event_id         text        NOT NULL,
  order_id         text        NOT NULL,
  kind             text        NOT NULL,
  from_status      text        NULL,
  to_status        text        NOT NULL,
  reason           text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  correlation_id   text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT order_event_pkey PRIMARY KEY (event_id),
  CONSTRAINT order_event_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT order_event_id_opaque
    CHECK (module_orders.is_opaque_identifier(event_id)),
  CONSTRAINT order_event_order_id_opaque
    CHECK (module_orders.is_opaque_identifier(order_id)),
  CONSTRAINT order_event_correlation_opaque
    CHECK (module_orders.is_opaque_identifier(correlation_id)),
  CONSTRAINT order_event_idempotency_opaque
    CHECK (module_orders.is_opaque_identifier(idempotency_key)),

  CONSTRAINT order_event_kind_known
    CHECK (kind IN ('created', 'placed', 'confirmed', 'fulfilling', 'completed', 'cancelled')),
  CONSTRAINT order_event_from_status_known
    CHECK (from_status IS NULL OR from_status IN
      ('draft', 'placed', 'confirmed', 'fulfilling', 'completed', 'cancelled')),
  CONSTRAINT order_event_to_status_known
    CHECK (to_status IN ('draft', 'placed', 'confirmed', 'fulfilling', 'completed', 'cancelled')),
  -- A transition that does not change the status is not a transition.
  CONSTRAINT order_event_transition_changes_status
    CHECK (from_status IS NULL OR from_status <> to_status),
  CONSTRAINT order_event_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT order_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_orders.order_event IS
  'One status transition of one order. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS order_event_order_idx
  ON module_orders.order_event (order_id, occurred_at, event_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_orders.outbox (
  outbox_id         text        NOT NULL,
  idempotency_key   text        NOT NULL,
  kind              text        NOT NULL,
  payload           jsonb       NOT NULL,
  recorded_at       timestamptz NOT NULL,
  producer          text        NOT NULL,
  correlation_id    text        NOT NULL,
  processed_at      timestamptz NULL,
  retry_count       integer     NOT NULL DEFAULT 0,
  last_error        text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_retry_non_negative CHECK (retry_count >= 0)
);

COMMENT ON TABLE module_orders.outbox IS
  'Transactional outbox for order events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_orders.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_orders.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Order records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_orders.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER order_item_is_append_only
  BEFORE UPDATE OR DELETE ON module_orders.order_item
  FOR EACH ROW EXECUTE FUNCTION module_orders.refuse_mutation();

CREATE TRIGGER order_snapshot_is_append_only
  BEFORE UPDATE OR DELETE ON module_orders.order_snapshot
  FOR EACH ROW EXECUTE FUNCTION module_orders.refuse_mutation();

CREATE TRIGGER order_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_orders.order_event
  FOR EACH ROW EXECUTE FUNCTION module_orders.refuse_mutation();

COMMIT;
