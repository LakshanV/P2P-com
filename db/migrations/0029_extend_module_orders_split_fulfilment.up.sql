-- migration: 0029_extend_module_orders_split_fulfilment
-- direction: up
-- owner: module_orders
--
-- Split supplier fulfilment: a buyer orders twenty tonnes, no single supplier holds twenty tonnes,
-- and the order becomes a parent with one child order per supplier. Each child is a real order with
-- its own seller and its own lifecycle, which is what lets a supplier fail without the others
-- noticing and without inventing a second kind of thing for the rest of the platform to understand.
--
-- **Partial fulfilment is a quantity, not a status.** No status is added here. The tempting design
-- adds `partially-fulfilled` to the status vocabulary, and it is wrong: "partial" is a ratio that
-- changes every time a child moves, and encoding a ratio as an enum means inventing a new status
-- the first time a case does not fit. What was actually delivered is derived by summing the child
-- orders, the same way M-04 derives inventory availability from its movement log and K-10 derives
-- balances from entries. Nothing here stores a ratio.
--
-- The two-level limit — a child may not itself be split — is enforced in the service rather than
-- here, because expressing "the parent of this row has no parent of its own" needs a subquery, and
-- a CHECK constraint cannot execute one. That limitation is stated in the module contract rather
-- than left for somebody to discover.
--
-- This migration **extends** the schema migration 0028 created. It does not create the schema, and
-- it does not re-declare `is_opaque_identifier` or `refuse_mutation`, both of which already exist
-- in `module_orders`.

BEGIN;

ALTER TABLE module_orders.order_header
  ADD COLUMN IF NOT EXISTS parent_order_id text NULL,
  ADD COLUMN IF NOT EXISTS fulfilment_role text NOT NULL DEFAULT 'standalone';

ALTER TABLE module_orders.order_header
  ADD CONSTRAINT order_header_fulfilment_role_known
    CHECK (fulfilment_role IN ('standalone', 'parent', 'child')),
  -- A child has a parent, and only a child has one. Without this a row can claim to be a child of
  -- nothing, or a standalone order can carry a parent it does not behave like — two facts that
  -- disagree with nobody to arbitrate between them.
  ADD CONSTRAINT order_header_child_has_parent
    CHECK ((fulfilment_role = 'child') = (parent_order_id IS NOT NULL)),
  -- An order that is its own parent makes the fulfilment summary infinitely recursive.
  ADD CONSTRAINT order_header_no_self_parent
    CHECK (parent_order_id IS NULL OR parent_order_id <> order_id),
  ADD CONSTRAINT order_header_parent_id_opaque
    CHECK (parent_order_id IS NULL OR module_orders.is_opaque_identifier(parent_order_id));

COMMENT ON COLUMN module_orders.order_header.parent_order_id IS
  'The parent order this one fulfils part of, or null. An opaque id within this schema, not a foreign key.';

COMMENT ON COLUMN module_orders.order_header.fulfilment_role IS
  'standalone, parent or child. An order is born standalone; only a split may change it.';

-- Listing a parent's children is one indexed lookup, and the index is partial because the
-- overwhelming majority of orders are standalone and carry no parent at all.
CREATE INDEX IF NOT EXISTS order_header_parent_idx
  ON module_orders.order_header (parent_order_id, order_id)
  WHERE parent_order_id IS NOT NULL;

COMMIT;
