# M-12 Payments — contract

**Status:** foundation delivered.  
**Owner:** M-12, `modules/payments/`.  
**Layer:** L5. **Schema:** `module_payments`, created by
[`0030_create_module_payments_schema.up.sql`](../../db/migrations/0030_create_module_payments_schema.up.sql).  
**Depends on:** K-03 Accounts (the payer and payee, by opaque id), K-08 Event Infrastructure,
K-09 Audit Foundation.

---

## 1. What this module owns

Four things, and the outbox that publishes changes to them:

1. **Payments** (`payment`) — one payment against one external settlement rail: the parties, the
   asset, the amount, what has been captured and refunded, and the timestamps of each transition.
2. **Provider attempts** (`payment_attempt`) — one row per call to a gateway, successful or not.
   Append-only. This is the reconciliation trail: what was asked, what came back, and when.
3. **Refunds** (`refund`) — one row per return of captured value, partial or full. Append-only.
4. **Webhook receipts** (`webhook_receipt`) — one row per provider delivery, recorded before it is
   believed. Append-only except for a one-way `processed_at` stamp.

It does **not** own:

- The paying or receiving account — **K-03 Accounts**, referenced by opaque id.
- The order being paid for — **M-11 Orders**, referenced by opaque id. M-11 is the same layer, so
  it reaches M-12 by event and neither joins to the other's tables.
- Ledger accounts and balances — **K-10 Ledger Foundation**.
- The allocation of internally issued value — **M-13**. See §6.
- Commission, settlement and payout — **M-14, M-15, M-16**, all the same layer; they arrive by
  event.
- Authentication, authorisation or identity — **K-01, K-02, K-04**.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new PaymentService(repository, resolveProvider)

requestPayment(request):   Promise<{ payment, replayed }>
authorisePayment(request): Promise<{ payment, attempt, replayed }>
capturePayment(request):   Promise<{ payment, attempt, replayed }>
cancelPayment(request):    Promise<{ payment, attempt, replayed }>
refundPayment(request):    Promise<{ payment, refund, attempt, replayed }>
recordWebhook(request):    Promise<{ receipt, payment, applied, ignoredBecause, replayed }>

getPayment(paymentId)
listPaymentsForOrder(orderId)
listPaymentsForPayer(payerAccountId)
listAttempts(paymentId)
listRefunds(paymentId)
listReceipts(paymentId)
```

Every operation is idempotent by `idempotencyKey`. A repeated request returns what already happened
with `replayed: true` and does nothing further; a *different* request under a used key is refused
with `idempotency-key-reuse`, because returning the earlier record would tell the caller their new
amount had been accepted.

### Refusals

Every refusal is a `PaymentError` carrying a `code` a caller can branch on. The codes that matter
most:

| Code | When |
|---|---|
| `illegal-transition` | The move is not in `PAYMENT_TRANSITIONS`, or the payment changed while a provider call was in flight |
| `payment-terminal` | The payment is `refunded`, `failed` or `cancelled` |
| `over-capture` | The capture would exceed the authorised amount |
| `over-refund` | The refund, plus everything already refunded, would exceed the captured amount |
| `provider-failed` | The gateway refused, or gave no answer. `failureCode` on the attempt says which |
| `internal-value-not-settleable` | The asset is value JAYA issues itself. See §6 |
| `unsupported-settlement` | The adapter does not declare this rail or this asset |
| `unknown-provider` | No adapter is registered under that name |
| `malformed-token` | The instrument token is not an opaque handle. See §5 |
| `unverified-webhook` | The caller did not verify the provider's signature |
| `duplicate-webhook` | This provider event has already been received |
| `foreign-concern` | The request carried a field belonging to another unit |

---

## 3. The state machine

```
requires-authorisation ──> authorised ──> captured ──> partially-refunded ──> refunded
         │                     │              │                                   ▲
         │                     │              └───────────────────────────────────┘
         ├──> failed           ├──> failed
         └──> cancelled        └──> cancelled
```

`refunded`, `failed` and `cancelled` are terminal. A second partial refund records a `refund` row
and leaves the status at `partially-refunded` — a transition that does not change the status is not
a transition.

A **captured payment is refunded, never cancelled.** The money has left the payer, and the way back
is a refund, which leaves a record of the return rather than pretending the payment never happened.

---

## 4. A timeout is not a failure

This is the distinction the module is built around, and the one most likely to be got wrong by a
future change.

A **declined card is an answer.** The money did not move. The payment fails, `failureCode` records
why, and no retry can succeed.

A **timeout is the absence of an answer.** The gateway may well have taken the money. So the payment
stays exactly where it was, the attempt is recorded, and the caller may retry — under the *same*
idempotency key, which the provider recognises as the same operation rather than a second one.
Treating a timeout as a decline is how a platform charges somebody twice.

`INDETERMINATE_FAILURES` is the whole of that decision: `provider-timeout` and
`provider-unavailable`. An adapter that *throws* is read the same way, because a thrown error tells
M-12 nothing about whether the money moved.

Two consequences follow:

- **A provider call happens outside a transaction.** Holding one open across a network call means a
  slow gateway holds locks on payment rows, and a gateway that never answers holds them for ever.
- **The attempt row is committed even when the payment cannot then be moved.** If the guarded update
  finds the payment already changed underneath, rolling back would leave money moved with nothing
  written down, so the refusal is raised *after* the commit.

---

## 5. No instrument is ever stored

**No column in `module_payments` holds an instrument**, and none ever may: no card number, no PAN,
no CVV, no expiry, no bank account, no IBAN, no cardholder name. A payment row outlives the
transaction it describes and is copied into every projection built from it, so a PAN written here is
disclosed for as long as the platform exists and no later deletion policy can recall it.

What is stored is `instrument_token`: the opaque handle the provider gave back. It is held to K-03's
opacity rule — in TypeScript by `assertInstrumentToken`, and in SQL by
`payment_instrument_token_opaque` — which refuses a long digit run, an IBAN shape or an `@`. A
"token" with any of those shapes is not a token.

A request carrying `cardNumber`, `cvv`, `iban` or any of the other instrument fields is refused by
name with `foreign-concern`, rather than ignored: a caller sending one has misunderstood the
boundary and needs telling.

---

## 6. M-12 settles externally. It does not allocate internal value

Every rail M-12 knows crosses the platform boundary: a real counterparty settles.

`assetCode` is deliberately **not** constrained to a three-letter fiat code. A settlement may be LKR
today and BTC, USDC or a licensed provider's unit tomorrow, and a contract that assumed ISO-4217
would have to be broken to allow it. `assetScale` — minor units per major unit as a power of ten —
travels with every amount so a reader can render it without consulting a registry. K-10's asset-type
registry remains the authority; M-12 records what its caller stated and **never converts between
assets**, because a conversion is a ledger act and M-13 owns it.

What `assetCode` *is* closed to is the value JAYA issues itself:

```
JAYA_REWARD  CASHBACK  MERCHANT_CREDIT  PROMO_CREDIT  DELIVERY_CREDIT  COMMUNITY_CREDIT
```

These are internal liabilities. No bank, card network or custodian has heard of them and there is no
rail down which they could travel. Sending one to a gateway would either fail confusingly or — far
worse — succeed against some fiat balance and quietly turn a restricted credit into cash. They are
refused by name, in `assertSettlementAsset`, in the provider contract suite, and by the CHECK
constraint `payment_asset_is_externally_settleable`.

**A mixed-value purchase is several legs, and M-12 knows about exactly one of them.** LKR 10,000
paid as 1,500 rewards + 500 merchant credit + 8,000 on a card is three legs: M-13's value router
allocates the first two against the universal ledger, M-12 orchestrates the 8,000, and M-13 proves
the three balance.

---

## 7. Webhooks

A webhook is untrusted input from outside the platform: an instruction from a stranger to move
money. So it is **recorded before it is believed**, and three rules apply.

**Unverified is refused.** M-12 does not verify the signature — the transport layer holds the
signing secret — but it will not act on a delivery nobody verified. The database agrees:
`webhook_receipt_signature_verified` refuses the row.

**A redelivery takes effect once.** `UNIQUE (provider, provider_event_id)` is what makes that true.
Every provider eventually delivers the same event twice; the second is reported as `replayed: true`
rather than moving the payment again.

**An out-of-order delivery is stale, not an error.** Providers deliver out of order routinely, and a
`captured` notice arriving after the refund has been processed describes the past. It is recorded,
marked processed so the provider stops retrying, and does not move the payment. `ignoredBecause`
says which of `stale`, `unknown-payment` or `no-assertion` applied.

A receipt is append-only with exactly one exception: stamping `processed_at`, once. Re-stamping
would erase when the platform actually acted, which is the fact a dispute turns on, and editing the
payload would be rewriting the evidence of what the provider sent. Both are refused by the
`webhook_receipt_stamp_only` trigger.

---

## 8. Concurrency

`updatePaymentIfUnchanged` is a conditional `UPDATE` whose `WHERE` clause repeats what the caller
read: the status **and** both running totals. Two captures racing both read the payment as
`authorised` and both call the provider; the second blocks on the row, re-evaluates the clause after
the first commits, updates nothing, and reports false — so the service refuses, with its attempt row
already written.

The totals are part of the guard because the status alone misses the case that matters most: two
concurrent partial refunds against a `partially-refunded` payment both leave the status where it
was. Guarding on status only, both would commit, and the payment would show one refund's worth of
movement against two refund rows.

The in-memory repository models the same row lock rather than only checking at commit. Without that
it would be *less* safe than the database it stands in for, and a passing test would mean nothing
about production.

---

## 9. Events

| Event | When | Fact id |
|---|---|---|
| `payment.requested` | A payment intent was created | the payment |
| `payment.authorised` | A provider authorised; no value has moved | the attempt |
| `payment.captured` | A provider captured value. **M-13 posts against this** | the attempt |
| `payment.failed` | A provider refused. `failure_code` says why | the attempt |
| `payment.cancelled` | Cancelled before capture | the attempt |
| `payment.refunded` | Value was returned, partially or fully | the refund |

Every outbox id derives from the **attempt or refund** that produced the fact, never from the
payment: one payment is authorised, captured and refunded, and an id derived from the payment alone
would collide with itself on the second fact.

Amounts cross the wire as **strings**, always with `asset_code` and `asset_scale` beside them. A
consumer parsing `amount_minor` as a number would lose precision above 2^53 minor units — which for
a satoshi-scaled asset is not hypothetical — and a number without its asset is a quantity with no
unit.

---

## 10. Replacing the provider

No gateway SDK is imported in this module or anywhere below it. A gateway is reached through
`PaymentProvider`, and the adapter is injected via `resolveProvider`.

A replacement adapter is valid **exactly when it passes**
[`tests/contracts/payment-provider.contract.test.ts`](../../tests/contracts/payment-provider.contract.test.ts).
Implement `PaymentProvider`, describe which of your tokens produce which outcome, and call
`runPaymentProviderContract(subject)` from a small driver file. Do not edit the contract.

A provider is told **what to move, never who is moving it**: an amount, an asset, a rail, an opaque
token and an idempotency key. Not the payer, not the payee, not the order, not a name, not an
address. A gateway does not need to know who its counterparty's customers are in order to move
money, and an adapter cannot leak what it was never given.

---

## 11. What this module does not do yet

- **Nothing calls it.** No HTTP surface, and no business module consumes its outbox.
- **No live adapter ships.** `MockPaymentProvider` is deterministic and is the only implementation;
  BL-05 records that no payment sandbox is available. Decision D-006 requires a port and a mock
  before any live adapter, which is what exists.
- **M-13 does not yet consume `payment.captured`**, so no captured payment has been posted to the
  universal ledger and no mixed-value purchase has been settled end to end.
- **No relay dispatches the outbox.** Entries are written transactionally and nothing reads them.
- **No reconciliation job** compares the attempt trail against a provider's own record.
