-- migration: 0004_create_kernel_event_infrastructure_schema
-- direction: down
-- owner: kernel_event_infrastructure
--
-- Reverses 0004. Nothing outside K-08 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters: the receipt and delivery tables carry foreign keys into the event table, and
-- delivery references itself through replay_of. Dropped children first, then the parent.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- Rolling this back discards the event log. That is a deliberate consequence of removing the
-- component, not an accident to be worked around: an event log with no component to read it is
-- not evidence anybody can use. An operator who needs the history should dump the three tables
-- before running this.

BEGIN;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_type_recorded_idx;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_correlation_idx;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_delivery_event_idx;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_delivery_expired_lease_idx;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_delivery_due_idx;

DROP TABLE IF EXISTS kernel_event_infrastructure.event_receipt;

DROP TABLE IF EXISTS kernel_event_infrastructure.event_delivery;

DROP TABLE IF EXISTS kernel_event_infrastructure.event;

DROP SCHEMA IF EXISTS kernel_event_infrastructure RESTRICT;

COMMIT;
