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

## 7. What is not delivered

- **No integration beyond the contract surface.** No payment, ledger, commission, logistics or
  returns module reacts to these events yet.
- **Nothing calls this module.** No API, no UI, no consumer of any of the six events.
- **No verification gate.** M-11 does not ask M-02 whether buyer or seller may trade.
- **No K-02 authentication and no K-04 authorisation.** Anyone holding the repository can create or
  transition an order as any account.
- **No commerce-unit-type check.** `commerceUnitTypeId` is not verified against K-11, for the reason
  in §1: no join across a unit boundary.
- **No split payments, refunds, partial fulfilment or returns.**
- **Nothing applied to a live server.** Migration 0028 runs in the integration suite against a live
  PostgreSQL 16 and nowhere else.

---

## 8. Verification

```
npm run typecheck
npm run lint
npm run format:check
npm run check:boundaries      # M-11 is L5: platform/, kernel/ and L1–L4 modules only, never K-13
npm run check:migrations      # 0028 is paired, transactional and module-owned
node --test tests/orders.test.ts tests/orders-repository.test.ts
npm run test:integration      # tests/integration/orders.integration.ts
```
