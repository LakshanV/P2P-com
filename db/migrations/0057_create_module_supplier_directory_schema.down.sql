-- migration: 0057_create_module_supplier_directory_schema
-- direction: down
-- owner: module_supplier_directory
--
-- Drops M-48's schema and everything in it.
--
-- What is lost is the network: who supplies what, where, and whether they are open. Nothing breaks
-- mechanically -- no other schema holds a foreign key into this one -- but the sourcing ladder goes
-- back to searching only the catalogue, so every Need it cannot fill from stock becomes a tender.
-- That is a quiet failure: the platform still works and starts asking the market about things
-- somebody on it could have supplied.

BEGIN;

DROP TRIGGER IF EXISTS directory_event_is_append_only
  ON module_supplier_directory.directory_event;

DROP FUNCTION IF EXISTS module_supplier_directory.refuse_mutation();

DROP TABLE IF EXISTS module_supplier_directory.outbox;
DROP TABLE IF EXISTS module_supplier_directory.directory_event;
DROP TABLE IF EXISTS module_supplier_directory.supplier_location;
DROP TABLE IF EXISTS module_supplier_directory.supplier_facet;
DROP TABLE IF EXISTS module_supplier_directory.directory_entry;

DROP FUNCTION IF EXISTS module_supplier_directory.is_facet_code(text);
DROP FUNCTION IF EXISTS module_supplier_directory.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_supplier_directory;

COMMIT;
