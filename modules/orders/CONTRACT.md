# M-11 Orders — contract

**Status:** foundation delivered.  
**Owner:** M-11, `modules/orders/`.  
**Layer:** L5. **Schema:** `module_orders`, created by
[`0028_create_module_orders_schema.up.sql`](../../db/migrations/0028_create_module_orders_schema.up.sql).  
**Depends on:** K-03 Accounts (the buyer and seller, by opaque id), K-08 Event Infrastructure,
K-09 Audit Foundation.

---

## 1. What this module owns

Three things, and the outbox that publishes changes to them:

1. **Orders** (`order_header`) — the agreement: buyer, seller, status, currency, totals and the
   timestamps of each lifecycle transition.
2. **Order items** (`order_item`) — one row per line added to a draft, pinning `(listing_id,
   version_id)`. Append-only.
3. **Order snapshots** (`order_snapshot`) — the immutable commercial record captured at placement.
   One row per order. Append-only.
4. **Order events** (`order_event`) — the append-only transition log. One row per successful
   lifecycle change.

It does **not** own:

- The buying or selling account — **K-03 Accounts**, referenced by opaque id.
- The listing or its version — **M-04 Universal Listing**, referenced by opaque id.
- The inventory reservation — **M-04 Universal Listing**, referenced by opaque reservation id.
- Payments, ledger accounts, commission or settlement — **M-12, M-13, M-14, M-15**, all the same
  layer or above; they arrive by event.
- Authentication, authorisation or identity — **K-01, K-02, K-04**.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new OrderService(repository)

createOrder(request):        Promise<{ order, replayed }>
addItem(request):            Promise<{ item, replayed }>
placeOrder(request):         Promise<{ order, snapshot, replayed }>
confirmOrder(request):       Promise<{ order, replayed }>
startFulfilment(request):    Promise<{ order, replayed }>
completeOrder(request):      Promise<{ order, replayed }>
cancelOrder(request):        Promise<{ order, replayed }>

getOrder(orderId)
listItems(orderId)
getSnapshot(orderId)
getHistory(orderId)
listOrdersByBuyer(buyerAccountId)
listOrdersBySeller(sellerAccountId)
```

### Refusals

| Code | When |
|---|---|
| `duplicate-order-id` | the order id already exists with different content |
| `duplicate-item-id` | the item id already exists with different content |
| `duplicate-snapshot-id` | the snapshot id already exists with different content |
| `duplicate-event-id` | the event id already exists with different content |
| `idempotency-key-reuse` | the idempotency key was already used for a different record |
| `order-not-found` | the order id is unknown |
| `order-not-draft` | an item was added or the order was placed when it is no longer draft |
| `order-empty` | `placeOrder` was called on an order with no items |
| `order-terminal` | the order is `completed` or `cancelled` and refuses further transition |
| `illegal-transition` | the requested status change is not in `ORDER_TRANSITIONS` |
| `currency-mismatch` | an item's currency differs from the order's currency |
| `total-mismatch` | the caller's expected total disagrees with the computed total |
| `line-total-mismatch` | `lineTotalMinor` is not exactly `quantity * unitPriceMinor` |
| `snapshot-exists` | the order already has a snapshot |
| `negative-amount` / `negative-quantity` | a money amount or quantity below zero, or not an exact integer |
| `malformed-currency` | not three uppercase letters |
| `unknown-status` | a status value outside `ORDER_STATUSES` |
| `unknown-cancellation-reason` | a reason outside `CANCELLATION_REASONS` |
| `malformed-reason` | a reason text empty or longer than 500 characters |

---

## 3. An order is an agreement, never edited

This is the module's central decision, and the reason the items, snapshot and event log are
append-only.

What was agreed at placement is captured in `order_snapshot` and judged against it later, not
against tables that have moved on. The snapshot pins every `version_id`, quantity and unit price.
`UNIQUE (order_id)` on `order_snapshot` enforces one commercial record per order, and the
append-only triggers on `order_item`, `order_snapshot` and `order_event` stop the record being
rewritten after the fact.

---

## 4. Money

Amounts are `bigint` minor units. No floating point exists in this module, and migration 0028
declares no `double precision`, `real`, `float` or `money` column. The validator accepts a `bigint`,
a non-negative **safe** integer, or a digits-only string — the same three forms K-10 Ledger
Foundation accepts, and for the same reason: the string form is what PostgreSQL returns for a
`bigint`, and the safe-integer check stops a value that has already lost precision from being stored
as if it had not.

Events carry `total_minor` as a **string**, because a `bigint` does not survive JSON.

---

## 5. State machine

The legal transitions are declared once as `ORDER_TRANSITIONS` and every operation is driven from
it:

```
draft      -> placed, cancelled
placed     -> confirmed, cancelled
confirmed  -> fulfilling, cancelled
fulfilling -> completed, cancelled
completed  -> (terminal)
cancelled  -> (terminal)
```

An illegal transition is refused with `illegal-transition` naming the from and to status.

---

## 6. Events and audit

Through the module-owned outbox, in the same transaction as the state change:

| Fact | Event |
|---|---|
| An order was created as a draft | `order.created` |
| An order was placed | `order.placed` |
| An order was confirmed | `order.confirmed` |
| Fulfilment started | `order.fulfilling` |
| An order was completed | `order.completed` |
| An order was cancelled | `order.cancelled` |

Outbox ids derive from the append-only `order_event` id, not from the order id alone. An order
transitions many times, and an id derived from the order would collide with itself on the second
transition; M-01 shipped that bug and `outbox_pkey` refused the write.

Each event carries a matching audit record.

---

## 7. Split supplier fulfilment

A buyer may order a quantity no single supplier can deliver. `splitOrder` turns one `placed`
standalone order into a `parent` with one `placed` `child` per supplier allocation. Children are
real orders: they have their own seller, their own item rows, their own event log and their own
lifecycle. A consumer that does not care about splitting sees ordinary `order.placed`,
`order.completed` and `order.cancelled` events.

### The parent/child model

- Every order is born `standalone` with no `parentOrderId`.
- A standalone order that is split becomes a `parent` and gains children. The parent moves to
  `fulfilling` at split time.
- Each child has `fulfilmentRole: 'child'` and `parentOrderId` set to its parent.
- Split fulfilment is **two levels only**: a child may not be split again. This is a service rule
  (`nested-split`) rather than a database CHECK, because expressing "this row's parent has no
  parent" requires a subquery and a CHECK cannot execute one.

### Partial is a derived quantity, not a status

The status machine in §5 is unchanged. "Partially fulfilled" is not a status because it is a ratio
that changes every time a child moves. `getFulfilmentSummary(orderId)` derives every number by
summing child rows:

- `orderedQuantity` — the parent's own item total.
- `allocatedQuantity` — sum of child item quantities.
- `fulfilledQuantity` — quantity of children whose status is `completed`.
- `cancelledQuantity` — quantity of children whose status is `cancelled`.
- `pendingQuantity` — `allocated − fulfilled − cancelled`.

Nothing stores a ratio, so the summary cannot drift from the orders it describes.

### The allocation-mismatch rule

`splitOrder` groups parent items and allocated items by `(listingId, versionId)` and refuses
`allocation-mismatch` unless the summed child quantity equals the parent's ordered quantity for
every pair. Allocating 7 t and 5 t of a 20 t order and forgetting the last 8 t is impossible to
commit, which is why splitting is one transactional act rather than several `createOrder` calls.

### Lifecycle rules for parents

- `completeOrder` on a parent refuses `children-outstanding` unless every child is terminal
  (`completed` or `cancelled`). It refuses `nothing-fulfilled` when every child was cancelled.
  Partial fulfilment completes the parent: the buyer's remedy for a short delivery is a refund,
  not a permanently open order.
- `cancelOrder` on a parent cascades to every non-terminal child with the parent's reason, in the
  same transaction. Already-terminal children are left alone. Cancellation is never refused for
  having outstanding children.
- Cancelling one child does **not** cancel the parent or its siblings.

### Events

In addition to the events in §6:

| Fact | Event |
|---|---|
| A parent was split into children | `order.split` |
| A child order was placed | `order.placed` |

A child's `order.cancelled` event carries `parent_order_id` so a consumer can attribute the
cancellation to the order it was fulfilling part of.

---

## 8. What is not delivered

- **No integration beyond the contract surface.** No payment, ledger, commission, logistics or
  returns module reacts to these events yet.
- **Nothing calls this module.** No API, no UI, no consumer of any of the six events.
- **No verification gate.** M-11 does not ask M-02 whether buyer or seller may trade.
- **No K-02 authentication and no K-04 authorisation.** Anyone holding the repository can create or
  transition an order as any account.
- **No commerce-unit-type check.** `commerceUnitTypeId` is not verified against K-11, for the reason
  in §1: no join across a unit boundary.
- **No split payments, refunds or returns.** Split supplier fulfilment is delivered; payments and
  refunds for it are not.
- **Nothing applied to a live server.** Migration 0028 runs in the integration suite against a live
  PostgreSQL 16 and nowhere else.

---

## 9. Verification

```
npm run typecheck
npm run lint
npm run format:check
npm run check:boundaries      # M-11 is L5: platform/, kernel/ and L1–L4 modules only, never K-13
npm run check:migrations      # 0028 and 0029 are paired, transactional and module-owned
node --test tests/orders.test.ts tests/orders-split-fulfilment.test.ts
npm run test:integration      # tests/integration/orders.integration.ts
```
