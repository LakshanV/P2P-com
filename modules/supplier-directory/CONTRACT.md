# M-48 Supplier & Merchant Directory — contract

**Status:** delivered, reachable over HTTP, and read by the `known` and `verified` sourcing rungs.
**Owner:** M-48, `modules/supplier-directory/`.
**Layer:** L2. **Schema:** `module_supplier_directory`, created by
[`0057_create_module_supplier_directory_schema.up.sql`](../../db/migrations/0057_create_module_supplier_directory_schema.up.sql).
**Depends on:** K-03 Accounts (the trading party, by opaque id), K-08 Event Infrastructure, K-09
Audit Foundation.

---

## 1. Why this module exists

M-07's sourcing ladder has five rungs — catalogue, known supplier, verified network, external
discovery, RFQ. Until this module existed, two of them had nothing to read. `known` and `verified`
returned `unavailable` on every Need, so the ladder consulted the catalogue and then escalated:
**every Need that no published listing answered became a tender**, which is exactly the behaviour
the ladder is ordered to prevent. A directory is not a nicety around matching. It is the data
without which two thirds of the ladder is decoration.

## 2. What this module owns

Four things, and the outbox that publishes changes to the first:

1. **The directory entry** (`directory_entry`) — one row per trading party: kind (`supplier` or
   `merchant`), display name, status, whether they are open for orders, and a daily capacity
   ceiling. **One account, one entry**, by `UNIQUE (account_id)`.
2. **Facets** (`supplier_facet`) — what a party deals in, as codes: `category`, `brand`,
   `capability`, `district`. Declared and withdrawn; a withdrawal moves the row's status rather
   than adding a second row for the same value.
3. **Locations** (`supplier_location`) — branches, each in a district, at most one of them primary
   among the open ones.
4. **History** (`directory_event`) — the append-only sequence of status changes, with the reason.

It does **not** own:

- Whether a party is verified, or at what level — **M-02 Capability & Verification**. There is no
  verification column here and there may never be one: a copy of M-02's answer is the stale answer
  somebody sources against.
- How reliable a supplier has proved — **M-11 Orders**. A delivery record is computed from what
  happened, not declared by the party it describes.
- Supply, listings, prices or stock — **M-04 Universal Listing**. `dailyCapacity` here is a ceiling
  a party states about itself, not stock anybody can reserve.
- Which roles an account holds — **M-01 Universal Account**. A "capability" facet is a trading
  capability (`bulk-delivery`), not an M-01 role.
- Identity, authentication, authorisation — **K-01, K-02, K-04**.
- Precise addresses or coordinates. A location carries a **district**, because that is what the
  platform routes on and a street address is personal data this module has no reason to hold.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`,
and a request carrying one of those fields is refused with `foreign-concern` rather than ignored.

---

## 3. Public contract

```ts
new DirectoryService(repository)

registerSupplier(request):  Promise<{ entry, replayed }>   // starts pending, closed for orders
activateSupplier(request):  Promise<{ entry, replayed }>
suspendSupplier(request):   Promise<{ entry, replayed }>   // reversible
closeSupplier(request):     Promise<{ entry, replayed }>   // terminal
setAvailability(request):   Promise<{ entry, replayed }>

declareFacet(request):      Promise<{ facet, replayed }>
withdrawFacet(request):     Promise<{ facet, replayed }>
addLocation(request):       Promise<{ location, replayed }>
closeLocation(request):     Promise<{ location, replayed }>

getSupplier(supplierId):            Promise<DirectoryEntry | null>
getSupplierForAccount(accountId):   Promise<DirectoryEntry | null>
listFacets(supplierId):             Promise<readonly SupplierFacet[]>
listLocations(supplierId):          Promise<readonly SupplierLocation[]>
listHistory(supplierId):            Promise<readonly DirectoryEvent[]>
getProfile(supplierId):             Promise<DirectoryProfile | null>
findSuppliers(query):               Promise<readonly DirectoryProfile[]>
```

Every returned record is frozen (`immutable.ts`), so a caller cannot edit the directory by editing
what it handed them.

### Refusals

| Code | When |
| --- | --- |
| `malformed-identifier` | An id that is not an opaque identifier. |
| `natural-identifier` | An id, or a facet code, carrying a telephone number or an email address. |
| `secret-bearing-input` | An id that looks like a secret. |
| `malformed-instant` | An instant that is not a canonical UTC timestamp. |
| `foreign-concern` | A field another unit owns — `verified`, `rating`, `latitude`, and the rest. |
| `malformed-record` | A field of the wrong shape, including a facet code that is not a code. |
| `malformed-name` | An empty display name, or one over 200 characters. |
| `malformed-reason` | A status change with no reason, or one under 8 characters. |
| `malformed-capacity` | A negative or non-integer daily capacity. |
| `idempotency-key-reuse` | An existing key presented with different content. |
| `duplicate-supplier-id` | An id already in the directory. |
| `duplicate-facet-id` | A facet id already used. |
| `duplicate-location-id` | A location id already used. |
| `already-registered` | This account already trades under an entry. One account, one entry. |
| `supplier-not-found` | No such entry. |
| `facet-not-found` | Withdrawing something never declared. |
| `location-not-found` | No such branch. |
| `unknown-kind` | A kind that is not `supplier` or `merchant`. |
| `unknown-status` | A status outside the vocabulary. |
| `unknown-facet-kind` | A facet kind outside `category`, `brand`, `capability`, `district`. |
| `illegal-transition` | A status change the machine does not allow. |
| `supplier-closed` | Any change to a closed entry. Closure is terminal. |
| `primary-location-exists` | A second primary branch, which makes "the main one" ambiguous. |
| `ungated-query` | `findSuppliers` with no category. The gate is not optional — see §6. |

---

## 4. Registration is not activation

A new entry starts `pending` with `acceptsOrders: false`, and the caller cannot ask for anything
else. This is the whole safety property of the module: a party who has filled in a form is not yet
somebody a Need should be routed to, and a directory that made registration sufficient would send
a customer's requirement to whoever registered most recently.

```
pending ──▶ active ──▶ suspended ──▶ active
   │           │            │
   └───────────┴────────────┴──▶ closed   (terminal)
```

`suspended` and `closed` are deliberately different facts. A suspension is reversible and a
suspended party is entitled to know why, which is why `reason` is required, bounded below at 8
characters, and recorded in both the audit trail and the append-only history. "suspended" is not a
reason, and a platform that suspends without one is a platform nobody can appeal to.

`acceptsOrders` is a **third** axis, not a synonym for the status. An active supplier who is full
this week closes for orders without being suspended, because those are different things to a buyer
looking at them and to the supplier being told.

---

## 5. A declaration does not travel

`supplier.registered`, `supplier.activated`, `supplier.suspended` and `supplier.closed` carry the
entry id, the account, the kind, the status, whether the party is open, and the instant. **They do
not carry the party's categories, brands, capabilities or districts.**

What a business sells is commercially useful to its competitors. The event log is read by every
subscriber and kept indefinitely, so a directory that broadcast its own contents would be a
market-intelligence feed nobody agreed to publish. A consumer that needs a profile reads it through
a route that can check who is asking.

The outbox id is keyed on the caller's **transition** id, not on the status. A directory status
genuinely cycles — active, suspended, active again — so keying on `supplierId:status` would refuse
the second activation as a duplicate outbox row and the platform would silently stop publishing
reinstatements. This was a real defect, found by a suspend-then-reactivate test.

---

## 6. A search is gated on a category

`findSuppliers` refuses a query with no category (`ungated-query`). An ungated directory query is
"list every supplier on the platform", which is the platform's commercial map: who trades here, how
many of them, and how to reach each one. It is the single most valuable thing a competitor could
take, and it would leave through a search endpoint built for sourcing.

Districts filter **permissively**: a supplier who declared no district is not excluded, because
declaring nothing means "no restriction stated", not "serves nowhere". Excluding them would make
the honest supplier who left the field alone invisible.

By default a query returns only `active` parties with `acceptsOrders`. A caller administering the
directory may ask for another status explicitly.

---

## 7. Codes, not identifiers

Facet values are held to a **code** rule — lower case, 2 to 64 characters, at least one letter —
and deliberately not to the platform's opaque-identifier rule. That rule demands at least eight
characters because an identity space anybody can enumerate lets them count the platform's parties.
A shared vocabulary is the opposite case: `cement` and `matale` are *meant* to be enumerable,
because a buyer picks one from a list, and forcing them to eight characters would mean inventing
padded nonsense for the words the product actually uses.

What still applies is that a code travels into every invitation the supplier receives. So a value
with no letter in it, or with a long run of digits, is refused: those are telephone numbers, and
one pasted into a category field would be published for good. The same rule exists in the database
as `is_facet_code`, so a writer bypassing the service cannot store what the service refuses.

---

## 8. Database rules

- `UNIQUE (account_id)` on `directory_entry` — one party, one entry. A party with two rows can be
  invited twice to one tender and answer once.
- `directory_entry_closed_is_shut` — a closed entry cannot be open for orders.
- `UNIQUE (supplier_id, facet_kind, value)` — declaring `cement` twice is impossible rather than
  merely discouraged, so a withdrawal cannot leave a live duplicate behind.
- `supplier_facet_value_is_code` — the code rule, in the database.
- `supplier_location_one_primary_idx` — a partial unique index over open branches, so a supplier
  has exactly one primary branch and never two. A closed branch leaves the index rather than the
  table, because an order already placed still names it.
- `directory_event_is_append_only` — the history of how a party reached its status cannot be
  edited or deleted. It is what an appeal is judged against.

---

## 9. Determinism

The caller supplies every identifier and every instant. `tests/supplier-directory.test.ts` asserts
by reading the sources that no file in this module calls `Date.now()`, `new Date()`,
`Math.random()` or `crypto.randomUUID()`.

Idempotency compares the content and **not** `correlationId` or the record's own creation instant:
a retry arrives later and carries a fresh correlation id by definition, so comparing either would
report an honest retry as key reuse — advice which, if followed, makes the party register twice.
Different content under an existing key is refused rather than converged.

---

## 10. Over HTTP

`apps/api/routes/directory.ts` serves the module. Three things the routes add that the module
cannot, because none of them is about the record:

- **The party is the session.** `POST /v1/suppliers` takes no `accountId`, and sending one is
  `caller-asserted-party` (400). A caller who could name the party could register a competitor.
- **Admission is a different verb.** A party holds `create` and `update` over their own entry;
  letting them into the market is `admit` on `POST /v1/suppliers/:id/status`, which **no trading
  role holds**. K-04 refuses a supplier activating themselves before any handler runs, and the
  handler then refuses an operator deciding their **own** entry (`not-your-decision`, 409) — the
  case K-04 cannot see.
- **A staff act declares why.** `admit` reaches another party's record, so the route is marked
  `actsOnAnotherParty` in the access policy: the ownership check is skipped (it would refuse the
  act the route exists for), the caller must send `x-access-purpose`, and K-04 checks that purpose
  against the grant and records it on the decision. No purpose, no decision — 400.

`GET /v1/suppliers/:id` and everything under it is the party's **own** entry. Other parties are
reached only through `GET /v1/suppliers?category=…`, which is why a registered-but-not-admitted
party is invisible to everybody except themselves.

---

## 11. Proof

- `tests/supplier-directory.test.ts` — 23 tests: registration and the pending start, the status
  machine including the reversible suspension and the terminal closure, the reason rule, facets
  declared and withdrawn without duplication, the single primary branch, the gated search, the
  permissive district filter, idempotency in both directions, immutability of returned records,
  the foreign-field table, the code rule, and the determinism scan.
- `tests/directory-api.test.ts` — 20 route tests: the party is the session, a caller cannot register
  somebody else or register themselves as admitted, one account holds one entry, a retry converges,
  `/me` resolves without an identifier, a supplier cannot admit themselves, an operator cannot admit
  their own entry, the purpose is required and checked, the cross-party exemption is per route
  rather than per resource type, and the gated search returns the open parties and nobody else.
- `tests/supplier-source.test.ts` — 10 tests over the adapter that fills M-07 two supplier rungs.
- `tests/integration/sourcing-rungs.integration.ts` — 4 tests against a live PostgreSQL server:
  the `known` rung finds a supplier this buyer actually completed an order with and not one who
  merely promised, the `verified` rung finds the party M-02 verified and not the one it did not,
  and a Need that used to escalate is answered by a rung instead.
- `tests/integration/supplier-directory.integration.ts` — tests against a live PostgreSQL server:
  the one-account-one-entry UNIQUE, the facet-once-per-value UNIQUE, the single-primary partial
  index and its behaviour when a branch closes, the append-only trigger, the code CHECK refusing
  what the service refuses, capacities larger than a double surviving the round trip, the gated
  search running as one statement, and the adapter agreeing with the in-memory reference.
