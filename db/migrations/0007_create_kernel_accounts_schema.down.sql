-- migration: 0007_create_kernel_accounts_schema
-- direction: down
-- owner: kernel_accounts
--
-- Reverses 0007. Nothing outside K-03 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because there is no foreign key into `kernel_identity`, this rollback is genuinely independent of
-- K-01: it can run whether or not migration 0006 has been applied, and running it leaves K-01
-- exactly as it was. That independence is the reason the foreign key was refused in the first
-- place, and it is worth noticing that the rollback is where the benefit actually shows up.
--
-- Order matters twice. The trigger references `refuse_mutation`, so the trigger goes first. The
-- table's opacity CHECKs reference `is_opaque_identifier`, so the **table** goes before that
-- function — dropping it earlier would fail on the dependency, which is the database correctly
-- refusing to leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards every universal account.** Today that costs nothing, because no unit
-- opens one. Once orders and payments reference these ids it will cost a great deal, and a later
-- migration adding a foreign key from another schema will make this rollback fail at the RESTRICT
-- — the correct outcome, not a defect to be worked around with CASCADE.

BEGIN;

DROP INDEX IF EXISTS kernel_accounts.universal_account_origin_idx;

DROP INDEX IF EXISTS kernel_accounts.universal_account_chronological_idx;

DROP TRIGGER IF EXISTS universal_account_is_write_once ON kernel_accounts.universal_account;

DROP TABLE IF EXISTS kernel_accounts.universal_account;

DROP FUNCTION IF EXISTS kernel_accounts.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_accounts.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_accounts RESTRICT;

COMMIT;
