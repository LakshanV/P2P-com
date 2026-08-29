-- migration: 0019_create_kernel_ai_gateway_schema
-- direction: down
-- owner: kernel_ai_gateway
--
-- Reverses 0019. Nothing outside K-13 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. Triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.
--
-- CASCADE on the schema so the rollback is complete; K-13 owns this namespace and nothing else
-- should have been created inside it.

BEGIN;

DROP INDEX IF EXISTS kernel_ai_gateway.ai_run_binding_idx;

DROP INDEX IF EXISTS kernel_ai_gateway.ai_run_task_idx;

DROP INDEX IF EXISTS kernel_ai_gateway.ai_decision_task_idx;

DROP INDEX IF EXISTS kernel_ai_gateway.model_binding_capability_idx;

DROP INDEX IF EXISTS kernel_ai_gateway.outbox_unprocessed_idx;

DROP TRIGGER IF EXISTS ai_decision_is_append_only ON kernel_ai_gateway.ai_decision;

DROP TRIGGER IF EXISTS ai_run_is_append_only ON kernel_ai_gateway.ai_run;

DROP TRIGGER IF EXISTS model_binding_is_append_only ON kernel_ai_gateway.model_binding;

DROP TRIGGER IF EXISTS task_definition_is_append_only ON kernel_ai_gateway.task_definition;

DROP TABLE IF EXISTS kernel_ai_gateway.outbox;

DROP TABLE IF EXISTS kernel_ai_gateway.ai_decision;

DROP TABLE IF EXISTS kernel_ai_gateway.ai_run;

DROP TABLE IF EXISTS kernel_ai_gateway.model_binding;

DROP TABLE IF EXISTS kernel_ai_gateway.task_definition;

DROP FUNCTION IF EXISTS kernel_ai_gateway.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_ai_gateway.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_ai_gateway CASCADE;

COMMIT;
