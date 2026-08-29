-- migration: 0021_create_kernel_search_foundation_schema
-- direction: down
-- owner: kernel_search_foundation
--
-- Reverses 0021. Nothing outside K-15 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The trigger references `refuse_mutation`, so it goes first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.

BEGIN;

DROP INDEX IF EXISTS kernel_search_foundation.query_log_executed_idx;

DROP INDEX IF EXISTS kernel_search_foundation.outbox_unprocessed_idx;

DROP INDEX IF EXISTS kernel_search_foundation.document_tsv_idx;
DROP INDEX IF EXISTS kernel_search_foundation.document_language_idx;
DROP INDEX IF EXISTS kernel_search_foundation.document_scope_idx;
DROP INDEX IF EXISTS kernel_search_foundation.document_owner_id_idx;
DROP INDEX IF EXISTS kernel_search_foundation.document_owner_type_idx;

DROP TRIGGER IF EXISTS query_log_is_append_only ON kernel_search_foundation.query_log;

DROP TABLE IF EXISTS kernel_search_foundation.outbox;

DROP TABLE IF EXISTS kernel_search_foundation.query_log;

DROP TABLE IF EXISTS kernel_search_foundation.document;

DROP FUNCTION IF EXISTS kernel_search_foundation.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_search_foundation.keywords_to_text(text[]);

DROP FUNCTION IF EXISTS kernel_search_foundation.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_search_foundation RESTRICT;

COMMIT;
