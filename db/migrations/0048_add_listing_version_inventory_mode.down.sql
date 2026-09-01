-- migration: 0048_add_listing_version_inventory_mode
-- direction: down
-- owner: module_universal_listing
--
-- Drops the column, the CHECK and the index.
--
-- **Rolling this back loses information that cannot be recovered.** A version published as
-- `made-to-order` or `external` becomes indistinguishable from one published as `tracked`, and
-- rolling forward again backfills every row to `tracked` — which would tell the order path that a
-- service needs a stock reservation. That is survivable only while no version has been published
-- with a mode other than `tracked`, which is to say: immediately after deploying 0048 and not
-- afterwards.
--
-- The rollback is written anyway, because a migration that cannot be undone is a migration nobody
-- can deploy on a Friday. The cost is recorded here rather than discovered.

BEGIN;

DROP INDEX IF EXISTS module_universal_listing.listing_version_inventory_mode_idx;

ALTER TABLE module_universal_listing.listing_version
  DROP CONSTRAINT IF EXISTS listing_version_inventory_mode_known;

ALTER TABLE module_universal_listing.listing_version
  DROP COLUMN IF EXISTS inventory_mode;

COMMIT;
