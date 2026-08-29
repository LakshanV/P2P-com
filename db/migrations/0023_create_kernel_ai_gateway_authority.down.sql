-- migration: 0023_create_kernel_ai_gateway_authority
-- direction: down
-- owner: kernel_ai_gateway
--
-- Undo 0023: remove the authority grant table and the level recorded on each run.
--
-- Rolling this back removes the only thing that stops a registered task being invoked at any level
-- anybody claims. The grant history goes with it, so the record of who permitted what is lost — that
-- is the honest consequence of undoing an authority model, and the reason this is operator-invoked
-- only.

BEGIN;

DROP TRIGGER IF EXISTS task_authority_is_append_only ON kernel_ai_gateway.task_authority;

DROP INDEX IF EXISTS kernel_ai_gateway.task_authority_in_force_idx;

DROP TABLE IF EXISTS kernel_ai_gateway.task_authority;

ALTER TABLE kernel_ai_gateway.ai_run
  DROP CONSTRAINT IF EXISTS ai_run_authority_level_known;

ALTER TABLE kernel_ai_gateway.ai_run
  DROP COLUMN IF EXISTS authority_level;

COMMIT;
