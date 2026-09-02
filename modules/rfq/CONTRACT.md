# M-09 RFQ / Reverse Marketplace — contract

**Status:** foundation delivered; no HTTP route yet.  
**Owner:** M-09, `modules/rfq/`.  
**Layer:** L4. **Schema:** `module_rfq`, created by
[`0052_create_module_rfq_schema.up.sql`](../../db/migrations/0052_create_module_rfq_schema.up.sql).  
**Depends on:** K-03 Accounts (the buyer and the suppliers, by opaque id), K-08 Event
Infrastructure, K-09 Audit Foundation.

---

## 1. What this module owns

Three things, and the outbox that publishes changes to them:

1. **Tenders** (`rfq`) — the requirement as a supplier sees it: category, a short supplier-facing
   description, quantity, unit, structured attributes, delivery district, date, condition, quality
   requirements, substitution policy and attachment references, plus the lifecycle.
2. **Invitations** (`rfq_invitation`) — which supplier was asked, by which rung of the sourcing
   ladder, with what score, and **why**. Append-only.
3. **Transitions** (`rfq_event`) — one row per status change. Append-only.

It does **not** own:

- The customer's words — **M-03 Commerce Request**. They never reach this module. See §3.
- The sourcing ladder that decided a tender was necessary — **M-07 Matching**, referenced by
  `matchRunId`.
- The offers that come back — **M-10 Quotes**, referenced by the winning `awardedQuoteId`.
- The order an award becomes — **M-11 Orders**, which subscribes to `rfq.awarded`.
- Whether a supplier is verified — **M-02 Capability & Verification**.
- Notifying an invited supplier — **K-14 Notifications**, by event.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new RfqService(repository)

openRfq(request):        Promise<{ rfq, replayed }>
inviteSupplier(request): Promise<{ invitation, replayed }>
closeRfq(request):       Promise<{ rfq, replayed }>
awardRfq(request):       Promise<{ rfq, replayed }>
cancelRfq(request):      Promise<{ rfq, replayed }>

getRfq(rfqId)
listInvitations(rfqId)
listHistory(rfqId)
listRfqsForAccount(accountId)
listRfqsForRequest(requestId)

buildSpecification({ structured, itemDescription, substitutionPolicy, qualityRequirements })
```

### Refusals

| Code | When |
|---|---|
| `private-text-in-specification` | a field looks like a pasted customer message. See §3 |
| `rfq-not-found` | the tender id is unknown |
| `rfq-closed` | a supplier was invited to a tender that is no longer open |
| `illegal-transition` | the status change is not legal — including a **second, different award** |
| `duplicate-rfq-id` | the tender id already exists |
| `duplicate-invitation` | a second row for the same supplier on the same tender |
| `idempotency-key-reuse` | the key was already used for a different record |
| `malformed-specification` | a specification that fails validation |
| `malformed-reason` | a reason shorter than the minimum or longer than 1000 characters |
| `unknown-status` / `unknown-visibility` / `unknown-substitution-policy` | a value outside its vocabulary |
| `foreign-concern` | a field belonging to another unit, named with its owner |

---

## 3. The customer's words never reach a supplier

This is the module's central decision.

A Need is a sentence somebody wrote. It is deliberately exempt from the identifier rules in M-03,
and it may hold a telephone number, an address, a name or a hint about what the buyer will pay. **A
tender goes to strangers.** What a supplier receives is a *specification*: the structured facts they
need in order to quote, written for them.

Defended from four directions, because each catches a different mistake:

- **The allowlist.** `buildSpecification` carries only the keys in `CARRIED_KEYS`. A reading's
  unrecognised keys do not travel, whatever they are called.
- **The guard.** `assertNoPrivateText` refuses a string that looks like a pasted message wherever it
  appears.
- **The shape.** There is no free-text field wide enough to hide a Need in. `item_description` is
  capped at 500 characters — a field long enough to hold a customer message will eventually hold
  one, pasted there by somebody who thought it easier than filling in the attributes.
- **The schema.** The specification is stored across named, typed columns rather than as one `jsonb`
  blob, so there is nowhere to put one instead. The integration suite asserts the column set
  exactly, so adding a `notes` column fails a test rather than passing for want of a pattern nobody
  thought of.

The third and fourth are what actually hold. The first two are what catch the mistake somebody makes
at five o'clock.

**No specification travels in an event either.** An `rfq.*` event says a tender exists, who opened
it, in what category, how many suppliers were invited and when it closes. A private tender whose
contents sit in a shared log read by every subscriber is not private; an invited supplier fetches
the requirement through a route that can check they were invited.

---

## 4. An RFQ is the last rung, not the first

A tender exists **because M-07's sourcing ladder could not solve the Need any other way**: the
catalogue was searched, the buyer's own suppliers were asked, the verified network was checked and
external discovery was tried. `matchRunId` records which run reached that conclusion, and it is the
justification — it names every rung that was tried and why each did not answer.

An RFQ nobody can justify is one a supplier is entitled to resent. That is also why
`rfq_invitation.reason` has a minimum length and is required: a supplier receiving an irrelevant
tender is how a platform trains people to ignore it, so every invitation has to answer "why me".

---

## 5. An award names exactly one winner

`CONSTRAINT rfq_award_names_winner CHECK ((status = 'awarded') = (awarded_quote_id IS NOT NULL))` —
in both directions. An awarded tender with no winner cannot be explained to the suppliers who lost;
a winner on an unawarded tender claims a decision nobody made.

Awarding an already-awarded tender to a **different** offer is `illegal-transition`, not a replay.
The module shipped the opposite once: an idempotent shortcut treated a second decision as a retry
and answered "replayed" while changing nothing, telling the caller it had succeeded. Re-awarding the
**same** quote still converges, which is what idempotency is for.

---

## 6. Inviting somebody twice is not a second invitation

`UNIQUE (rfq_id, supplier_account_id)`. A second rung finding the same supplier is not a reason to
ask again — it is a duplicate email, and a platform that sends those is one people filter out.

The service converges on the invitation that already exists and keeps the **original** reason and
rung: the record says why they were actually asked, not why a later rung would have asked. Exactly
one `rfq.supplier_invited` event is published. The unique index is the layer that survives a
concurrent caller getting past the service's check.

Invitations and transitions are **append-only**, enforced by trigger. Uninviting somebody is not a
thing: they have already seen it, and rewriting the record would make it disagree with what
happened.

---

## 7. Visibility

`private` — only invited suppliers. `network` — the verified network may see it.

A private tender is private in the schema, in the events and in the routes that will read it, not
merely in a flag somebody remembers to check.

---

## 8. State machine

```
open      -> closed, awarded, cancelled
closed    -> awarded, cancelled
awarded   -> (terminal)
cancelled -> (terminal)
```

`cancelled` is distinct from `closed` on purpose: suppliers who quoted are owed the difference
between "somebody else won" and "it is not happening", and a supplier who cannot tell them apart
cannot tell whether quoting here is worth their time.

---

## 9. Events and audit

| Fact | Event |
|---|---|
| A tender was opened | `rfq.created` |
| Quoting has ended | `rfq.closed` |
| One offer was chosen | `rfq.awarded` |
| The buyer withdrew it | `rfq.cancelled` |
| A named supplier was asked | `rfq.supplier_invited` |

`rfq.status_changed` and `rfq.supplier_invited` are recorded as `business-authoritative` audit
actions. Quantity travels as a **string**, because a `bigint` does not survive JSON.

---

## 10. Determinism

The caller supplies every identifier and every instant, including each transition's `eventId`. A
module that read a clock could not be replayed, and one that minted an id could not be made
idempotent.

---

## 11. Proof

- `tests/rfq.test.ts` — the privacy boundary from three directions, the specification builder, the
  state machine, invitations, and the award rule.
- `tests/integration/rfq.integration.ts` — 8 tests against a live PostgreSQL server: a quantity
  larger than a double survives the round trip, microsecond precision survives on `closes_at`, the
  description cap and the exact column set leave nowhere to hide a customer's words, a second
  invitation converges and publishes nothing, the append-only triggers refuse an edit and a delete,
  the award CHECK bites in both directions, a second different award is refused, the adapter and
  the in-memory reference agree, and no specification appears in any published event.
