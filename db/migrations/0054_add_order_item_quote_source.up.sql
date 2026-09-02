-- migration: 0054_add_order_item_quote_source
-- direction: up
-- owner: module_orders
--
-- An order line's source is a listing version **or** an accepted quote.
--
-- 0028 assumed every line came from a listing: `listing_id`, `version_id` and
-- `commerce_unit_type_id` were all NOT NULL, because an order pins the version it was priced from
-- and reads the same terms forever. That is right, and it is exactly half of the story.
--
-- **The other half is why the tender existed.** A tender is opened when the sourcing ladder found
-- nothing — no catalogue entry answered, so there is no listing and no version to pin. What the
-- buyer agreed to is an accepted offer: a price, a quantity, a lead time and delivery terms, held
-- immutable in `module_quotes.quote` by a trigger. That is a permanent address of exactly the kind
-- `version_id` provides, and it is the one this line has.
--
-- Faking a listing for it would be worse than either: a row in M-04 that nobody published, that no
-- supplier maintains, and that exists only so a NOT NULL could be satisfied. A reference invented to
-- satisfy a constraint is a lie the schema tells every reader after it.
--
-- So the three listing columns become nullable, `quote_id` is added, and
-- `order_item_names_one_source` requires **exactly one** source in both directions. A line with
-- neither cannot say what was agreed; a line with both has two prices and no way to say which one a
-- dispute is judged against.
--
-- `commerce_unit_type_id` is nullable **only** for a quote line, and required for a listing line. A
-- listing is published against a registered K-11 commerce unit type; a tender is written in whatever
-- unit the buyer used — 'tonne', 'sachet' — and there may be no registered type for it. NULL says
-- "no registered unit type is known for this line", which is true. Naming one that does not exist
-- would not be.
--
-- **`line_kind` separates goods from charges**, and it exists because of the one number a quote
-- carries that a listing line cannot express. A quote's `total_minor` is what the buyer pays all in:
-- price, delivery, duties, handling. That is deliberately **not** `quantity * unit_price_minor`, and
-- `order_item_line_total_is_product` — rightly — refuses a line where it is not. So an accepted
-- offer becomes a `goods` line at the exact product, plus a `charges` line for the difference when
-- there is one. Both survive: the arithmetic rule stays a database rule, and the buyer sees what
-- they are being charged for rather than a unit price quietly inflated to absorb delivery.
--
-- Existing rows are all listing lines and all goods, so both backfills are what those rows already
-- meant. `line_kind` keeps its default: a line is goods unless it says otherwise, and every caller
-- writing one before today meant exactly that.
--
-- This migration touches no other unit's schema.

BEGIN;

ALTER TABLE module_orders.order_item
  ALTER COLUMN listing_id            DROP NOT NULL,
  ALTER COLUMN version_id            DROP NOT NULL,
  ALTER COLUMN commerce_unit_type_id DROP NOT NULL;

ALTER TABLE module_orders.order_item
  ADD COLUMN IF NOT EXISTS quote_id  text NOT NULL DEFAULT '' ,
  ADD COLUMN IF NOT EXISTS line_kind text NOT NULL DEFAULT 'goods';

-- Added with a default so the statement is valid against existing rows, then dropped to NULL for
-- the column that has no sensible default: a line either names a quote or it does not.
ALTER TABLE module_orders.order_item ALTER COLUMN quote_id DROP DEFAULT;
UPDATE module_orders.order_item SET quote_id = NULL WHERE quote_id = '';
ALTER TABLE module_orders.order_item ALTER COLUMN quote_id DROP NOT NULL;

COMMENT ON COLUMN module_orders.order_item.quote_id IS
  'The M-10 offer this line was priced from, when the line came from a tender rather than a listing. Opaque: M-10 owns the quote, and its terms are immutable there.';

COMMENT ON COLUMN module_orders.order_item.line_kind IS
  'goods or charges. A quote''s landed total is not quantity times unit price -- the difference is delivery, duties and handling -- so an accepted offer becomes a goods line at the exact product plus a charges line for the rest.';

COMMENT ON COLUMN module_orders.order_item.commerce_unit_type_id IS
  'The K-11 type, required for a listing line and NULL for a quote line. A tender is written in whatever unit the buyer used, and there may be no registered type for it; naming one that does not exist would be worse than saying so.';

-- The three listing columns lost NOT NULL, so their opacity checks must now tolerate NULL. Dropped
-- and re-added rather than left: a CHECK that cannot fire is a rule that has quietly stopped
-- applying, and the next person to read it would believe it still did.
ALTER TABLE module_orders.order_item
  DROP CONSTRAINT IF EXISTS order_item_listing_id_opaque,
  DROP CONSTRAINT IF EXISTS order_item_version_id_opaque,
  DROP CONSTRAINT IF EXISTS order_item_unit_type_opaque;

ALTER TABLE module_orders.order_item
  ADD CONSTRAINT order_item_listing_id_opaque
    CHECK (listing_id IS NULL OR module_orders.is_opaque_identifier(listing_id)),
  ADD CONSTRAINT order_item_version_id_opaque
    CHECK (version_id IS NULL OR module_orders.is_opaque_identifier(version_id)),
  ADD CONSTRAINT order_item_unit_type_opaque
    CHECK (commerce_unit_type_id IS NULL
           OR module_orders.is_opaque_identifier(commerce_unit_type_id)),
  ADD CONSTRAINT order_item_quote_id_opaque
    CHECK (quote_id IS NULL OR module_orders.is_opaque_identifier(quote_id)),

  ADD CONSTRAINT order_item_line_kind_known CHECK (line_kind IN ('goods', 'charges')),

  -- Exactly one source, in both directions. A line with neither cannot say what was agreed; a line
  -- with both has two prices and no way to say which one a dispute is judged against.
  ADD CONSTRAINT order_item_names_one_source
    CHECK (
      (listing_id IS NOT NULL AND version_id IS NOT NULL AND commerce_unit_type_id IS NOT NULL
       AND quote_id IS NULL)
      OR
      (quote_id IS NOT NULL AND listing_id IS NULL AND version_id IS NULL)
    );

-- What a fulfilment view opens: every line priced from one accepted offer.
CREATE INDEX IF NOT EXISTS order_item_quote_idx
  ON module_orders.order_item (quote_id)
  WHERE quote_id IS NOT NULL;

COMMIT;
