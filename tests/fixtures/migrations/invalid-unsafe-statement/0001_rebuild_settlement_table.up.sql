-- migration: 0001_rebuild_settlement_table
-- direction: up
-- owner: module_settlements
--
-- A forward migration that destroys data: the old table is dropped and the remaining rows are
-- deleted without a predicate. Neither is recoverable by running the rollback.

BEGIN;

DROP TABLE IF EXISTS module_settlements.settlement_legacy;

CREATE TABLE IF NOT EXISTS module_settlements.settlement (
  id uuid NOT NULL,
  CONSTRAINT settlement_pkey PRIMARY KEY (id)
);

DELETE FROM module_settlements.settlement;

COMMIT;
