-- migration: 0001_rebuild_settlement_table
-- direction: down
-- owner: module_settlements

BEGIN;
DROP TABLE IF EXISTS module_settlements.settlement;
COMMIT;
