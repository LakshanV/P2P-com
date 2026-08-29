-- migration: 0020_create_kernel_notification_schema
-- direction: down
-- owner: kernel_notifications
--
-- Reverses 0020. Nothing outside K-14 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. Triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.
--
-- RESTRICT on the schema, matching the convention used by other kernel modules: the rollback
-- only drops objects this migration created.

BEGIN;

DROP INDEX IF EXISTS kernel_notifications.delivery_attempt_notification_idx;

DROP INDEX IF EXISTS kernel_notifications.notification_status_idx;

DROP INDEX IF EXISTS kernel_notifications.notification_account_idx;

DROP INDEX IF EXISTS kernel_notifications.channel_channel_idx;

DROP INDEX IF EXISTS kernel_notifications.outbox_unprocessed_idx;

DROP TRIGGER IF EXISTS delivery_attempt_is_append_only ON kernel_notifications.delivery_attempt;

DROP TRIGGER IF EXISTS channel_is_append_only ON kernel_notifications.channel;

DROP TABLE IF EXISTS kernel_notifications.outbox;

DROP TABLE IF EXISTS kernel_notifications.delivery_attempt;

DROP TABLE IF EXISTS kernel_notifications.notification;

DROP TABLE IF EXISTS kernel_notifications.channel;

DROP FUNCTION IF EXISTS kernel_notifications.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_notifications.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_notifications RESTRICT;

COMMIT;
