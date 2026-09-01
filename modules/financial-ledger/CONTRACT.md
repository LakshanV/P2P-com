# M-13 Financial Ledger — contract

**Status:** foundation delivered.  
**Owner:** M-13, `modules/financial-ledger/`.  
**Layer:** L5. **Schema:** `module_financial_ledger`, created by
[`0032_create_module_financial_ledger_schema.up.sql`](../../db/migrations/0032_create_module_financial_ledger_schema.up.sql).  
**Depends on:** K-03 Accounts (identifier rules), K-10 Ledger Foundation (the journal), K-08 Event
Infrastructure, K-09 Audit Foundation.

---

## 1. What this module owns

K-10 is the journal: asset types, accounts, balanced transactions, and the three positions every
account carries. M-13 answers the two questions the journal deliberately does not.

**Where is a party's money?** A K-10 account is an anonymous position in one asset type. A `Wallet`
names it: this account, in this asset type, held by this party, *for this purpose*.

**How is one obligation paid from several kinds of value at once?** A `ValuePlan` and its `ValueLeg`s.

| Concern | Owned here |
|---|---|
| Which K-10 account holds whose value, and what for | `wallet` |
| How a wallet came to be frozen or closed | `wallet_state` — append-only |
| One obligation and the several kinds of value paying it | `value_plan` |
| One source of value against that obligation | `value_leg` |

It does **not** own:

- Every balance — **K-10**, which derives them by summing entries. **M-13 stores none.**
- Asset types and their attributes — **K-10**.
- What is owed, and what it costs — **M-04** for price, **M-14** for commission and fees, **M-05**
  for discounts. M-13 is told a total.
- The order — **M-11**, same layer, opaque id, reached by event.
- The payment that settles the external leg — **M-12**, same layer, opaque reference.
- Settlement and payout — **M-15**, **M-16**, same layer.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new FinancialLedgerService(repository, ledgerPort)

openWallet(request):        Promise<{ wallet, replayed }>
setWalletStatus(request):   Promise<{ wallet, record, replayed }>

allocatePlan(request):      Promise<{ plan, legs, replayed }>
commitPlan(request):        Promise<{ plan, legs, replayed }>
settleExternalLeg(request): Promise<{ plan, leg, replayed }>
cancelPlan(request):        Promise<{ plan, legs, replayed }>

getWallet(walletId)
listWallets(ownerAccountId)
getWalletHistory(walletId)
getPlan(planId)
getCoverage(planId)
listLegs(planId)
listPlansForObligation(obligationId)
listPlansForPayer(payerAccountId)
```

Every operation is idempotent by `idempotencyKey`, and every identifier and instant is supplied by
the caller.

### Refusals

| Code | When |
|---|---|
| `allocation-mismatch` | The legs do not sum to the obligation. See §3 |
| `rate-mismatch` | A leg's amount and its settlement equivalent disagree at its stated rate |
| `malformed-rate` | A rate has a zero or negative term |
| `empty-allocation` | A plan carries no legs |
| `multiple-external-legs` | More than one leg crosses the platform boundary |
| `external-leg-mismatch` | The external leg is not in the settlement asset, or not at 1:1 |
| `leg-asset-mismatch` | A leg names a wallet denominated in a different asset type |
| `leg-self-transfer` | A leg's source and destination are the same wallet |
| `wallet-exists` | One party may hold only one wallet per asset type and purpose |
| `wallet-frozen` / `wallet-closed` | Value may not leave the wallet |
| `illegal-transition` | The move is not in `PLAN_TRANSITIONS`, or the row moved underneath |
| `plan-terminal` | The plan is cancelled |
| `ledger-refused` | K-10 refused the posting; its own code is in the message |
| `foreign-concern` | The request carried a field belonging to another unit |

---

## 3. The allocation must be exact

This is the module's central invariant and the reason it exists:

```
Σ leg.settlementEquivalentMinor === plan.targetAmountMinor
```

Exact integer equality. No tolerance, no rounding, no remainder absorbed into whichever leg is
processed last. A plan that under-covers is a short payment nobody noticed; one that over-covers is
value taken for nothing. Both are worse than a refusal at allocation time, before anything has moved.

**A rate never rounds.** A rate is a pair of integers — never a decimal — and the check is a
cross-multiplication:

```
amountMinor × rate.numerator === settlementEquivalentMinor × rate.denominator
```

8 reward points at 3 cents per 2 points is exactly 12 cents and is accepted. 7 points at the same
rate is 10.5 cents; there is no honest integer answer, so there is no answer, and the allocation is
refused. A fraction of a cent lost per leg is a fraction of a cent somebody eventually audits.

---

## 4. The worked example

LKR 10,000 paid as 1,500 reward points + 500 merchant credit + 8,000 on a card:

| Leg | Asset | Amount | Rate | Worth |
|---|---|---|---|---|
| internal | `jaya_reward` | 150,000 points | 1:1 | 150,000 |
| internal | `merchant_credit` | 50,000 | 1:1 | 50,000 |
| external | `lkr` | 800,000 | 1:1 | 800,000 |
| | | | **total** | **1,000,000** |

Three units, so **three K-10 transactions**. K-10 refuses to put lines denominated in two units in
one transaction, and it is right to: such a line is not a line.

`commitPlan` posts the two internal legs and leaves the plan `committed`, waiting. When M-12's money
lands, whatever consumed `payment.captured` calls `settleExternalLeg`, the third transaction posts,
and the plan becomes `settled`. `getCoverage` then reports `internalMinor: 200000`,
`externalMinor: 800000`, and `postedMinor` equal to the target.

A plan with **no** external leg settles at commit: everything it needed has already moved.

---

## 5. The lifecycle

```
draft ──> committed ──> settled
  │           │            │
  └──────────┬┴────────────┘
             ▼
         cancelled
```

**`settled` is not terminal, deliberately.** An order paid for in full still gets cancelled: the
goods come back, the seller cannot supply, a dispute is decided. Making `settled` a dead end would
put the only route back outside the ledger, which is another way of saying no route back.

Cancelling reverses every posted leg with a **compensating transaction** — never a deletion. The
original posting stays in the journal because it happened, and a ledger that can be edited to say
otherwise is not evidence of anything. Cancelling a plan that would leave a posted leg unreversed is
refused: it would strand the value with nobody accountable for it.

A **partial** return is not a status. It is a new plan in the opposite direction with its own legs
and its own arithmetic, because half-reversing a plan would make its central invariant false.

---

## 6. Two uniqueness rules about double payment

**One wallet per (owner, asset type, purpose).** Two spending wallets in rupees for the same party
would split their money in half with nothing to say which half is theirs.

**One live plan per obligation** — a rule that ignores cancelled plans, so a failed attempt does not
block the next one, but two committed plans against one order cannot both exist. Two would be the
same thing paid for twice, and downstream it would look like two ordinary payments.

---

## 7. Ordering, and the gap it leaves

K-10 opens its own transaction, so a leg's journal entry and M-13's record of it commit separately.

M-13 posts to the journal **first** and records the leg **second**. That order makes the failure mode
the recoverable one: a process that dies in between leaves the money moved and the leg still
`planned`, and a retry under the same key gets `deduplicated` from K-10 and completes the marking.
The other order would leave a leg claiming a posting that never happened, which no retry could
detect.

**The remaining gap is a leg nobody retries.** The value has moved and M-13 does not know. This is
stated rather than papered over, and closing it needs one of two things: a `LedgerPort`
implementation that enlists in M-13's own transaction, or a reconciliation job that compares legs
against K-10. Neither exists yet — see §10.

---

## 8. Events

| Event | When | Fact id |
|---|---|---|
| `wallet.opened` | A wallet was opened over a K-10 account | the wallet |
| `wallet.status-changed` | Frozen, unfrozen or closed | the state record |
| `value-plan.allocated` | An obligation was allocated. Nothing has moved | the caller's event id |
| `value-plan.committed` | Every internal leg posted | the caller's event id |
| `value-plan.settled` | Every leg posted | the caller's event id |
| `value-plan.cancelled` | Every posted leg was reversed | the caller's event id |
| `value-leg.posted` | One leg moved value | the leg |
| `value-leg.reversed` | One leg was undone | the leg |

Every amount is a **string** and travels with its asset type. In a multi-value platform an amount
without its unit is not imprecise, it is meaningless: `1500` is 1,500 reward points or 1,500 rupee
cents depending on a field a lazy consumer might not read, and those are not the same amount of
anything.

A leg's event carries **both** figures — what moved, in its own asset, and what that counted for
against the obligation — plus the K-10 transaction id. A consumer with only the second could not
reconcile against the journal; one with only the first could not tell whether the obligation was
covered.

---

## 9. The journal port

`LedgerPort` names the two operations M-13 needs out of K-10's six, so the whole of the coupling
fits on one screen. `K10LedgerPort` is the adapter.

The port exists mainly so the implementation that matters for §7 — one that enlists in M-13's own
transaction — can be dropped in without changing the service.


---

## 10. The database enforces the arithmetic too

Migration 0032 creates `module_financial_ledger` and puts two of this module's rules where code
cannot quietly drop them.

`value_leg_rate_is_exact` is the no-rounding rule as a CHECK, written as a multiplication rather
than a division, so a rate that does not divide evenly cannot be stored at all.

`value_plan_legs_sum_to_target` is a **deferred constraint trigger**, because the invariant spans
rows and no CHECK can express it. It fires at commit, so a transaction may write the plan and its
legs in any order and still be judged on the whole picture — and a plan that under-covers or
over-covers its obligation is refused by the database, not only by the service.

Alongside them: a partial unique index giving one live plan per obligation while leaving cancelled
attempts out of the way, `wallet_position_unique`, `wallet_ledger_account_unique` (two wallets
naming one K-10 account would each report the whole balance as their own), the status/timestamp
agreement CHECKs, and an append-only trigger on the wallet history.

**There is still no balance column anywhere in the schema, and there never may be.**

---

## 11. What this module does not do yet

- **Nothing calls it.** No HTTP surface, no UI, and no unit consumes M-12's `payment.captured` to
  drive `settleExternalLeg`, so no mixed-value purchase has been settled end to end outside a test.
- **No relay dispatches the outbox.** Entries are written transactionally and nothing reads them.
- **No reconciliation job** closes the gap in §7.
- **No spending limit.** M-13 will post a leg that takes a wallet negative: K-10 is a journal, not an
  overdraft policy, and neither is this. Whichever module owns "may this party spend this" has not
  been built.
- **No expiry.** K-10 records an asset type's `expiryDays` and expires nothing; M-13 does not either.
