-- migration: 0027_create_module_universal_listing_inventory
-- direction: up
-- owner: module_universal_listing
--
-- M-04 Universal Listing's inventory interface (slice B). The schema already exists; this migration
-- adds the two tables that implement the replaceability requirement: an append-only movement log and
-- a derived snapshot that is updated in the same transaction.
--
-- Availability is derived, never stored as a mutable counter. A movement's quantity is always
-- positive; the kind carries the direction. The snapshot is a cache of the movement sum and is
-- recomputed from movements whenever it is written, so it can never silently disagree with the log.
--
-- This migration does not re-declare `is_opaque_identifier`; that function already exists in
-- `module_universal_listing`. It does add a new append-only trigger using the existing
-- `refuse_mutation` function.
--
-- This migration touches no schema other than `module_universal_listing`.

BEGIN;

-- ---------------------------------------------------------------------------
-- Inventory movement: the truth. Append-only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.inventory_movement (
  movement_id       text        NOT NULL,
  listing_id        text        NOT NULL,
  version_id        text        NOT NULL,
  kind              text        NOT NULL,
  quantity          bigint      NOT NULL,
  reservation_id    text        NULL,
  reason            text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT inventory_movement_pkey PRIMARY KEY (movement_id),
  CONSTRAINT inventory_movement_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT inventory_movement_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(movement_id)),
  CONSTRAINT inventory_movement_listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT inventory_movement_version_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(version_id)),
  CONSTRAINT inventory_movement_reservation_id_opaque
    CHECK (reservation_id IS NULL OR module_universal_listing.is_opaque_identifier(reservation_id)),
  CONSTRAINT inventory_movement_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT inventory_movement_idempotency_key_opaque
    CHECK (module_universal_listing.is_opaque_identifier(idempotency_key)),
  CONSTRAINT inventory_movement_kind_known
    CHECK (kind IN ('receive', 'adjust-up', 'adjust-down', 'reserve', 'release', 'commit')),
  CONSTRAINT inventory_movement_quantity_positive
    CHECK (quantity > 0),
  CONSTRAINT inventory_movement_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT inventory_movement_reservation_required
    CHECK (
      (kind IN ('reserve', 'release', 'commit') AND reservation_id IS NOT NULL)
      OR
      (kind IN ('receive', 'adjust-up', 'adjust-down') AND reservation_id IS NULL)
    ),
  CONSTRAINT inventory_movement_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_universal_listing.inventory_movement IS
  'The append-only log of inventory movements for a listing version. Quantity is always positive; the kind carries the direction.';

CREATE INDEX IF NOT EXISTS inventory_movement_listing_version_idx
  ON module_universal_listing.inventory_movement (listing_id, version_id, occurred_at, movement_id);

CREATE INDEX IF NOT EXISTS inventory_movement_reservation_idx
  ON module_universal_listing.inventory_movement (reservation_id)
  WHERE reservation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Inventory snapshot: the derived position. One row per (listing, version).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.inventory_snapshot (
  listing_id      text        NOT NULL,
  version_id      text        NOT NULL,
  on_hand         bigint      NOT NULL,
  reserved        bigint      NOT NULL,
  committed       bigint      NOT NULL,
  updated_at      timestamptz NOT NULL,
  correlation_id  text        NOT NULL,

  CONSTRAINT inventory_snapshot_pkey PRIMARY KEY (listing_id, version_id),

  CONSTRAINT inventory_snapshot_listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT inventory_snapshot_version_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(version_id)),
  CONSTRAINT inventory_snapshot_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT inventory_snapshot_on_hand_non_negative
    CHECK (on_hand >= 0),
  CONSTRAINT inventory_snapshot_reserved_non_negative
    CHECK (reserved >= 0),
  CONSTRAINT inventory_snapshot_committed_non_negative
    CHECK (committed >= 0),
  -- The invariant: you cannot reserve stock you do not have.
  CONSTRAINT inventory_snapshot_reserved_lte_on_hand
    CHECK (reserved <= on_hand),
  CONSTRAINT inventory_snapshot_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_universal_listing.inventory_snapshot IS
  'Derived cache of the inventory position for one listing version. on_hand = received - adjusted_down + adjusted_up - committed; available = on_hand - reserved.';

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database.
-- ---------------------------------------------------------------------------

CREATE TRIGGER inventory_movement_is_append_only
  BEFORE UPDATE OR DELETE ON module_universal_listing.inventory_movement
  FOR EACH ROW EXECUTE FUNCTION module_universal_listing.refuse_mutation();

COMMIT;
