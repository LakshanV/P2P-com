# M-36 User Cockpit — contract

**Status:** foundation delivered.  
**Owner:** M-36, `modules/user-cockpit/`.  
**Layer:** L8, **terminal**. **Schema:** none, deliberately — see §2.  
**Depends on:** K-03 Accounts (identifier rules), K-10 Ledger Foundation (balances and asset-type
metadata), M-11 Orders, M-12 Payments, M-13 Financial Ledger.

---

## 1. What this module owns

Nothing. That is not a stage it will grow out of.

M-36 assembles a buyer's own screens from the units that own the data:

| View | Assembled from |
|---|---|
| **MY MONEY** | M-13 for the wallet map, K-10 for every balance and every asset attribute |
| **MY ORDERS** | M-11 |
| One order in detail | M-11, M-12, and M-13's coverage |

---

## 2. It stores nothing, and that is the design

There is no cockpit table, no materialised view, no cached total and no migration. Every figure is
read from the owning unit at the moment it is asked for.

A cockpit with its own store is a second source of truth about money, and the second source is the
one that goes stale. On a screen showing somebody their balance that is not a performance
characteristic; it is a lie with a timestamp. The consequence of this design is that **M-36 cannot
be wrong about money. It can only be slow.**

If it ever becomes too slow, the answer is a cache whose age is shown to the reader — not a table
nobody remembers to update. A test asserts there is no `repository.ts`, no migration naming this
module, and no write statement anywhere in it.

---

## 3. MY MONEY never shows one total

`MoneyView` is a **list of holdings**, one per asset type, and the only sums are within an asset
type.

A holder with 1,500 reward points and LKR 8,000 does not have "9,500 of anything". Points are a
restricted credit: they have an issuer, they may expire, and there is a list of things they may be
spent on. Rupees are none of those. Adding them produces a figure that is wrong in a way the reader
cannot see, and every decision made from it inherits the error.

So each `WalletPosition` carries the asset's own attributes beside the number — `withdrawable`,
`transferable`, `issuer`, `precision` — because a holder looking at a reward balance needs to know
it is not cash, and next to the number is the honest place to say so. That is what K-10 records
those attributes *for*.

The three positions of an account are reported separately: `available`, `pending`, `locked`, and
their sum. A screen showing only one of them would mislead about what can be spent today.

`empty` distinguishes "you have no wallets" from "every balance is zero". They mean different things
to the person reading the screen.

---

## 4. Public contract

```ts
new UserCockpitService({ orders, payments, ledger, journal })

myMoney(accountId, asOf):      Promise<MoneyView>
myOrders(accountId, asOf):     Promise<OrdersView>
orderDetail(orderId, asOf):    Promise<OrderDetailView>
```

Every view carries `asOf` — the instant its figures were derived. A client caching one is caching a
snapshot, and the timestamp is how it knows how old the snapshot is.

The caller supplies the instant, as everywhere else in this repository.

### Refusals

| Code | When |
|---|---|
| `malformed-identifier`, `natural-identifier`, `secret-bearing-input` | The account id is not an opaque handle |
| `malformed-instant` | `asOf` is not a UTC instant |
| `dangling-wallet` | A wallet names a K-10 account that does not exist |
| `unknown-asset-type` | A wallet names an asset type K-10 does not know |

The last two are **defects in the platform, not client mistakes**, and the API answers them with a
500. Showing a zero instead would be inventing a balance, and a number without its unit is not a
balance at all.

---

## 5. Terminal

MODULE_MAP §7: cockpits compose, and are never composed into. Nothing in `kernel/`, `modules/` or
`platform/` imports M-36, and a test walks those roots to keep it true. A module that depended on a
cockpit would invert the dependency graph.

---

## 6. What this module does not do yet

- **No seller cockpit (M-37) and no operations cockpit (M-38).** The seller's view of their own
  earnings, and the operator's view of the outbox backlog and dead-letter queue, are not built.
- **No authorisation.** `myMoney(accountId)` will assemble anybody's money for anybody who asks.
  K-04 Permissions exists and nothing calls it; until the API asks it whether this caller may read
  this account, the only thing standing between one holder and another's balance is that no client
  has been written yet. **This is the most important gap in this module.**
- **No paging.** `myOrders` returns every order a buyer has ever placed. That is fine for a buyer
  with ten and wrong for a buyer with ten thousand.
- **No spend limits, no expiry, no restriction enforcement.** K-10 records `expiryDays` and
  `restrictions`; M-36 shows them and nothing acts on them.
- **No UI.** These are the shapes a screen would be built from; no screen exists.
