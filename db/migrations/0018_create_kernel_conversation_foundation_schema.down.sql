-- migration: 0018_create_kernel_conversation_foundation_schema
-- direction: down
-- owner: kernel_conversation_foundation
--
-- Reverses 0018. Nothing outside K-12 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. Triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.
--
-- CASCADE on the schema so the rollback is complete; K-12 owns this namespace and nothing else
-- should have been created inside it.

BEGIN;

DROP INDEX IF EXISTS kernel_conversation_foundation.message_conversation_sent_idx;

DROP INDEX IF EXISTS kernel_conversation_foundation.message_conversation_idx;

DROP INDEX IF EXISTS kernel_conversation_foundation.participant_conversation_idx;

DROP INDEX IF EXISTS kernel_conversation_foundation.outbox_unprocessed_idx;

DROP TRIGGER IF EXISTS message_is_append_only ON kernel_conversation_foundation.message;

DROP TRIGGER IF EXISTS participant_is_append_only ON kernel_conversation_foundation.participant;

DROP TRIGGER IF EXISTS conversation_is_append_only ON kernel_conversation_foundation.conversation;

DROP TABLE IF EXISTS kernel_conversation_foundation.outbox;

DROP TABLE IF EXISTS kernel_conversation_foundation.message;

DROP TABLE IF EXISTS kernel_conversation_foundation.participant;

DROP TABLE IF EXISTS kernel_conversation_foundation.conversation;

DROP FUNCTION IF EXISTS kernel_conversation_foundation.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_conversation_foundation.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_conversation_foundation CASCADE;

COMMIT;
