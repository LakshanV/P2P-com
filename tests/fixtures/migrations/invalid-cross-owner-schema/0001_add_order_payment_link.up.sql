-- migration: 0001_add_order_payment_link
-- direction: up
-- owner: module_orders
--
-- Reaches into another module's namespace instead of going through its contract.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_orders;

CREATE TABLE IF NOT EXISTS module_orders.purchase (
  id         uuid NOT NULL,
  payment_id uuid NOT NULL REFERENCES module_payments.payment (id),
  CONSTRAINT purchase_pkey PRIMARY KEY (id)
);

COMMIT;
