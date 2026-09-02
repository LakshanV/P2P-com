-- migration: 0055_quote_total_covers_goods
-- direction: up
-- owner: module_quotes
--
-- A landed total is never less than the goods it lands.
--
-- 0053 carried `total_minor` — what the buyer pays all in — separately from
-- `quantity * unit_price_minor`, because the difference is delivery, duties and handling, and a
-- comparison that ignored it would rank on the wrong number. What it did not say is which way that
-- difference may run.
--
-- It may only run upwards. A total **below** the goods subtotal says the stated unit price is not
-- the price, and there is no honest reading of the pair: an order opened from such an offer would
-- have to carry a negative charge line, which `order_item_line_total_non_negative` refuses, or
-- quietly restate the unit price the supplier gave. A supplier who wants to give a volume discount
-- states a lower unit price, which is what a discount is.
--
-- The rule matters because M-11 now opens an order directly from an accepted offer: a goods line at
-- the exact product and a charges line for the remainder. Without this CHECK that remainder could be
-- negative, and the order would either be refused far downstream with an arithmetic error nobody
-- could trace back to the quote, or be built by silently changing a number a supplier committed to.
--
-- Equality is fine and common: an ex-works offer with no delivery has nothing to add.
--
-- This migration touches no other unit's schema.

BEGIN;

ALTER TABLE module_quotes.quote
  ADD CONSTRAINT quote_total_covers_goods
    CHECK (total_minor >= quantity * unit_price_minor);

COMMENT ON CONSTRAINT quote_total_covers_goods ON module_quotes.quote IS
  'The landed total covers the goods. A total below quantity times unit price says the stated unit price is not the price, and there is no honest way to open an order from it.';

COMMIT;
