-- migration: 0048_add_listing_version_inventory_mode
-- direction: up
-- owner: module_universal_listing
--
-- How a version's fulfilment relates to stock, as a **policy** rather than a Boolean.
--
-- The gap this closes: M-04 had no way to say a listing holds no stock. Availability is derived from
-- an append-only movement log, so a service that never received stock was indistinguishable from a
-- machine that is out of stock. Orders could not tell whether a line needed a reservation, which
-- meant either every line reserved — so the platform could sell only tracked goods — or no line did,
-- and an order line could claim stock nothing was holding.
--
-- **Not a Boolean.** `tracks_inventory boolean` would answer today's question and force a migration
-- of the whole order and inventory path the first time a supplier-direct machine, a made-to-order
-- part or a digital entitlement arrived. Those are not "untracked" in the same way a haircut is:
-- each has different availability, reservation and fulfilment behaviour, and collapsing them loses
-- exactly the distinction that will be needed. A text column with a CHECK is as cheap as a boolean
-- and extends by widening the CHECK.
--
-- **Not derived from the commerce unit type.** "Product means tracked, service means untracked" is
-- the obvious shortcut and it is wrong: a physical part can be made to order, a service can hold
-- bookable capacity, and a supplier-direct machine is a product whose stock JAYA does not own.
-- Inventory behaviour belongs to the offer, not to the kind of thing being offered.
--
-- **On the version, not the listing.** A seller moving a listing from TRACKED to MADE_TO_ORDER has
-- changed the terms — what the buyer can expect about delivery is different — and an order pins a
-- version precisely so past terms stay what they were. Putting it on the listing would let a change
-- today rewrite what an order last month meant.
--
-- The five initial modes:
--
--   * `tracked`       — ordinary physical stock. Stock must exist, a reservation is required, and
--                       release and commit rules apply.
--   * `untracked`     — a service. No inventory and no reservation.
--   * `external`      — supplier-direct or drop-ship. JAYA does not own the stock ledger;
--                       availability comes from the supplier. No local reservation unless and until
--                       an external reservation adapter exists.
--   * `made-to-order` — produced or procured after the order. Nothing to reserve; the fulfilment
--                       workflow still applies in full.
--   * `digital`       — an entitlement. No physical reservation; delivery behaviour is its own
--                       concern and is not modelled here yet.
--
-- **Existing rows default to `tracked`**, which is what every existing version behaved as: the
-- reservation path was the only one there was. A backfill that guessed anything else would rewrite
-- the meaning of terms already agreed.
--
-- New rows carry no default. The column is NOT NULL and the service requires it explicitly, so
-- publishing a version means deciding this — a default of `tracked` on new writes would make the
-- most restrictive behaviour the one nobody chose.
--
-- This migration touches no other unit's schema.

BEGIN;

ALTER TABLE module_universal_listing.listing_version
  ADD COLUMN IF NOT EXISTS inventory_mode text NOT NULL DEFAULT 'tracked';

-- The default existed only to backfill rows written before this column did. Dropping it means a
-- writer must say which mode it means, which is the point: this is a decision, not a setting.
ALTER TABLE module_universal_listing.listing_version
  ALTER COLUMN inventory_mode DROP DEFAULT;

ALTER TABLE module_universal_listing.listing_version
  ADD CONSTRAINT listing_version_inventory_mode_known
    CHECK (inventory_mode IN ('tracked', 'untracked', 'external', 'made-to-order', 'digital'));

COMMENT ON COLUMN module_universal_listing.listing_version.inventory_mode IS
  'How fulfilment of this version relates to stock: tracked, untracked, external, made-to-order or digital. A policy rather than a boolean, so a supplier-direct or made-to-order offer does not need the order and inventory path migrated to describe it. Pinned with the version, because changing it changes the terms.';

-- Reserving against a version that holds no stock is the mistake this column exists to prevent, and
-- it is worth answering in one index rather than in a scan per order line.
CREATE INDEX IF NOT EXISTS listing_version_inventory_mode_idx
  ON module_universal_listing.listing_version (inventory_mode);

COMMIT;
