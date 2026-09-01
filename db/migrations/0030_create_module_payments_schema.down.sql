-- migration: 0030_create_module_payments_schema
-- direction: down
-- owner: module_payments
--
-- Reverses 0030. Nothing outside M-12 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The triggers reference `refuse_mutation` and `refuse_receipt_rewrite`, so they go
-- first. The tables' CHECK constraints reference `is_opaque_identifier`, so the tables go before
-- that function.

BEGIN;

DROP INDEX IF EXISTS module_payments.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_payments.webhook_receipt_unprocessed_idx;
DROP INDEX IF EXISTS module_payments.webhook_receipt_payment_idx;

DROP INDEX IF EXISTS module_payments.refund_payment_idx;

DROP INDEX IF EXISTS module_payments.payment_attempt_reference_idx;
DROP INDEX IF EXISTS module_payments.payment_attempt_payment_idx;

DROP INDEX IF EXISTS module_payments.payment_status_idx;
DROP INDEX IF EXISTS module_payments.payment_payee_idx;
DROP INDEX IF EXISTS module_payments.payment_payer_idx;
DROP INDEX IF EXISTS module_payments.payment_order_idx;

DROP TRIGGER IF EXISTS webhook_receipt_stamp_only ON module_payments.webhook_receipt;
DROP TRIGGER IF EXISTS refund_is_append_only ON module_payments.refund;
DROP TRIGGER IF EXISTS payment_attempt_is_append_only ON module_payments.payment_attempt;

DROP TABLE IF EXISTS module_payments.outbox;

DROP TABLE IF EXISTS module_payments.webhook_receipt;

DROP TABLE IF EXISTS module_payments.refund;

DROP TABLE IF EXISTS module_payments.payment_attempt;

DROP TABLE IF EXISTS module_payments.payment;

DROP FUNCTION IF EXISTS module_payments.refuse_receipt_rewrite();

DROP FUNCTION IF EXISTS module_payments.refuse_mutation();

DROP FUNCTION IF EXISTS module_payments.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_payments RESTRICT;

COMMIT;
