-- migration: 0055_quote_total_covers_goods
-- direction: down
-- owner: module_quotes
--
-- Removes the rule that a landed total covers the goods it lands.
--
-- Reverses cleanly: dropping a CHECK cannot invalidate a row. What it does mean is that an offer
-- whose total is below its own goods subtotal becomes storable again, and M-11 has no honest way to
-- open an order from one -- it would need a negative charge line, which the order schema refuses.

BEGIN;

ALTER TABLE module_quotes.quote
  DROP CONSTRAINT IF EXISTS quote_total_covers_goods;

COMMIT;
