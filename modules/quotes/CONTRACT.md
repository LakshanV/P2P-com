# M-10 Quotes — contract

**Status:** foundation delivered; no HTTP route yet.  
**Owner:** M-10, `modules/quotes/`.  
**Layer:** L4. **Schema:** `module_quotes`, created by
[`0053_create_module_quotes_schema.up.sql`](../../db/migrations/0053_create_module_quotes_schema.up.sql).  
**Depends on:** K-03 Accounts (the supplier, by opaque id), K-08 Event Infrastructure, K-09 Audit
Foundation, and **M-09 RFQ through a two-method port** — never by import of its service.

---

## 1. What this module owns

Two things, and the outbox that publishes changes to them:

1. **Quotes** (`quote`) — one supplier's offer against one tender: kind, quantity, unit price,
   landed total, currency, lead time, delivery terms, validity, and the evidence attached.
2. **The comparison** (`ranking.ts`) — the score, rank, explanation and single recommendation over
   a set of offers. **Computed, never stored.**

It does **not** own:

- The tender, its specification or its invitations — **M-09 RFQ**, reached through `TenderSource`.
- The customer's words — **M-03 Commerce Request**. A supplier never receives them.
- Supply, listings or stock reservations — **M-04 Universal Listing**. A quote holds nothing.
- The order an accepted offer becomes — **M-11 Orders**, which subscribes to `quote.accepted`.
- Whether a supplier is verified — **M-02 Capability & Verification**.
- Authentication, authorisation or identity — **K-01, K-02, K-04**.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new QuoteService(repository, tenders)

submitQuote(request):    Promise<{ quote, replayed }>
withdrawQuote(request):  Promise<{ quote, replayed }>   // supplier, own offer only
acceptQuote(request):    Promise<{ quote, replayed }>   // buyer
rejectQuote(request):    Promise<{ quote, replayed }>   // buyer

getQuote(quoteId)
listQuotesForRfq(rfqId)
listQuotesForSupplier(supplierAccountId)
evaluateQuotes({ rfqId, now, reliability?, ranking? }): Promise<readonly QuoteEvaluation[]>
```

There is **no update, edit, amend or reprice operation**, and adding one would fail
`tests/quotes.test.ts`.

### The tender port

```ts
interface TenderSource {
  findTender(rfqId): Promise<TenderFacts | null>;
  isInvited(rfqId, supplierAccountId): Promise<boolean>;
}
```

Two methods and no more. M-10 has no business closing tenders or reading somebody else's
invitations, and a narrow port makes it obvious when the module starts depending on a third fact.

### Refusals

| Code | When |
|---|---|
| `not-invited` | the supplier was not asked to this tender |
| `rfq-not-open` | the tender is closed, awarded or cancelled |
| `not-your-quote` | a supplier acted on an offer that is not theirs |
| `quote-closed` | the offer has ended and refuses further transition |
| `illegal-transition` | the status change is not in `QUOTE_TRANSITIONS` |
| `quote-not-found` | the quote id, or the tender id, is unknown |
| `duplicate-quote-id` | the quote id already exists |
| `idempotency-key-reuse` | the key was already used for a **different** offer |
| `malformed-quantity` | zero, more than the tender asked for, or a `full` offer covering less |
| `malformed-amount` | a negative price, or a number that is not a safe integer |
| `malformed-validity` | the offer expires at or before it was submitted |
| `undeclared-substitution` | a substitute with nothing declared, or a declaration on a non-substitute |
| `substitution-not-permitted` | the tender's policy is `none` |
| `foreign-concern` | a field belonging to another unit, named with its owner |
| `malformed-record` / `malformed-instant` | a record that fails validation, from either direction |

---

## 3. An offer binds, so it cannot be edited

This is the module's central decision, and everything else follows from it.

A supplier who quoted 250,000 has said they will supply for 250,000. A market where that can be
quietly revised is one where the offer you accepted is not the offer you saw. Changing a price means
**withdrawing and submitting a new offer**, which leaves both on the record and lets a buyer see
that the price moved.

Enforced at three layers, because each survives a different mistake:

- the **service** has no operation that would try;
- the **adapter's** UPDATE sets four columns — status, `updated_at`, `closed_at`, `closure_reason`;
- the **trigger** `quote_terms_are_immutable` refuses any UPDATE that changes a term, refuses
  DELETE, and refuses to move an offer that has already ended.

The third is the one that survives somebody editing the first two.

---

## 4. A supplier acts only on their own offer

Checked in the service, not only at the HTTP edge. The edge knows who is calling; this is where
whose offer it is is actually known, and a rule enforced only at the edge is a rule a second caller
walks around. Withdrawing a competitor's offer would otherwise be the cheapest way to win a tender.

**Only an invited supplier may quote**, and the invitation is checked against M-09 rather than read
from the request. There is no `invited` field, and one supplied is refused as a foreign concern: a
supplier who could assert their own invitation would be a supplier who needs no invitation.

---

## 5. Ranking is not price, and it is advice

`rankQuotes(quotes, context, options)` is a pure function — no I/O, no clock, no hidden state — so a
deployment that wants a learned model swaps it and the rest of the module does not notice.

| Factor | Default weight | What it measures |
|---|---|---|
| `cost` | 350 | landed total, relative to the cheapest eligible offer |
| `reliability` | 200 | the supplier's delivery record |
| `leadTime` | 200 | against the buyer's date, or the fastest offer when they gave none |
| `completeness` | 150 | how much of the quantity the offer covers |
| `quality` | 100 | whether the evidence the buyer asked for was attached |

Weights sum to 1000 and are **data**: a buyer sourcing cement for Friday weighs lead time
differently from one stocking a warehouse. Cost is the largest single weight and deliberately not a
majority — it is what a customer notices first and what they regret last.

Four properties hold:

- **A supplier with no record scores 600, not 0.** Scoring a new entrant as an unreliable one closes
  the market to new entrants.
- **Every score explains itself** in words a customer could read, and the factor breakdown agrees
  with the score.
- **Unavailable offers are shown with their reason**, ranked last, never dropped and never
  recommended. A customer looking at two offers when three suppliers were invited deserves to know
  that the third withdrew.
- **Exactly one offer is recommended, and the customer may accept any other eligible one.** A
  recommendation is advice; one that could not be overridden would be a decision taken from them.

Scores are integers per mille. Nothing in this module is a float, and no score, rank or
recommendation is stored: a ranking depends on the weights in force and on what else was offered,
and a stale score presented as current is worse than none.

---

## 6. Partial and substitute offers

`partial` is first-class because three of them make a split that no single supplier could fill, and
a market that only accepted all-or-nothing would lose those orders. It is scored proportionally
rather than excluded.

`substitute` is first-class because a supplier who has something equivalent is more useful than one
who says no — **provided the difference is declared**. A CHECK ties `kind = 'substitute'` to
`substitution_note` in both directions: an undeclared substitution is how a buyer discovers on
delivery day that they did not get what they ordered, and a note on a `full` offer says something
differs when the offer claims nothing does. A substitute carries a fixed completeness discount
rather than a proportional one, because the difference is in kind, not in degree.

---

## 7. Money

Amounts are `bigint` minor units. No floating point exists in this module, and migration 0053
declares no `double precision`, `real`, `float` or `money` column. The validator accepts a `bigint`,
a non-negative **safe** integer, or a digits-only string — the three forms every amount in this
repository accepts.

`total_minor` is carried **separately** from `unit_price_minor * quantity`, because the difference —
delivery, duties, handling — is exactly where a cheap offer becomes an expensive one, and a
comparison that ignored it would rank on the wrong number.

---

## 8. State machine

```
submitted -> withdrawn, expired, accepted, rejected
withdrawn -> (terminal)
expired   -> (terminal)
accepted  -> (terminal)
rejected  -> (terminal)
```

`rejected` is distinct from `expired` on purpose: a supplier is owed the difference between
"somebody else won" and "you were too slow", because only one of those is worth changing anything
about next time.

---

## 9. Events and audit

Through the module-owned outbox, in the same transaction as the state change:

| Fact | Event |
|---|---|
| A supplier offered | `quote.submitted` |
| The supplier took it back | `quote.withdrawn` |
| Its validity passed | `quote.expired` |
| The buyer took it | `quote.accepted` |
| The buyer took another | `quote.rejected` |

**No price travels in any of them.** What a supplier quoted is the most commercially sensitive
number they give this platform, and the event log is read by every subscriber and kept indefinitely.
A consumer gets the quote id, the tender, the supplier, the kind, the status, the currency and the
validity — enough to route and to schedule an expiry, and not enough to read the market.

The **audit record does** carry the quantity, unit price, landed total and lead time. That is
deliberate: the audit trail is a separate, access-controlled store whose purpose is to answer what
was actually agreed months later, and one that omitted the price would not answer the only question
anyone asks of it. `quote.status_changed` is `business-authoritative`.

---

## 10. Determinism

The caller supplies every identifier and every instant. `tests/quotes.test.ts` asserts by reading
the sources that no file in this module calls `Date.now()`, `new Date()`, `Math.random()` or
`crypto.randomUUID()`. Determinism is what lets a retry converge and a test pin time.

Idempotency compares the offer and **not** `correlationId` or `submittedAt`: a retry arrives later
and carries a fresh correlation id by definition, and comparing either would report an honest retry
as key reuse — advice which, if followed, makes the supplier offer twice. A **different** offer
under an existing key is refused rather than converged, because answering with the offer that key
belongs to would tell a supplier they had quoted when they had not.

---

## 11. Proof

- `tests/quotes.test.ts` — 38 tests: submission rules, the invitation check, ownership, the state
  machine, idempotency in both directions, the full ranking surface, immutability of returned
  records, the foreign-field table, and the determinism scan.
- `tests/integration/quotes.integration.ts` — 9 tests against a live PostgreSQL server: amounts
  larger than a double survive the round trip, microsecond validity survives, the trigger refuses a
  reprice, a delete and a reopen, the CHECKs refuse an undeclared substitution and a
  lapsed-on-arrival offer, the adapter and the in-memory reference agree on both the stored shape
  and the ranking, and an acceptance commits its event and audit record with it.
