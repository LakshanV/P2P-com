# M-49 Organisations — contract

**Status:** module delivered; HTTP routes and the K-04 acting-for path follow in the same slice.
**Owner:** M-49, `modules/organisations/`.
**Layer:** L1. **Schema:** `module_organisations`.
**Depends on:** K-03 Accounts (the business's account and the person's, by opaque id), K-08 Event
Infrastructure, K-09 Audit Foundation.

---

## 1. Why this module exists

Every commercial record in this platform names an **account**: a listing's `accountId`, an order's
`sellerAccountId`, a wallet's `ownerAccountId`, a directory entry's `accountId`. Until now that
account was always a **person's**, which is true of a sole trader and false of every business with
two people in it. The first shop that wants somebody to answer tenders while somebody else keeps
the stock has nowhere to put the second person.

The tempting fix — let one personal account act as another — is the wrong one twice over. It makes
impersonation the mechanism, and it destroys the audit trail: "who actually did this" stops having
an answer.

## 2. The model

**An organisation is a K-03 account of its own**, owned by a K-01 subject of kind `organisation`.
That single decision is what makes the rest cheap: every module that owns a commercial record
already references an account, so a listing, an order and a wallet belong to the **business** with
no change to any of them. A business that adds staff or changes owners rewrites nothing.

**A membership** says one person may act for one organisation, in named roles. It is scoped by
construction: a FINANCE membership at organisation A is a different row from anything at
organisation B, so it confers nothing there.

**The human is never lost.** K-04 records the deciding subject and the account the action was taken
in, so every business action carries both the person and the organisation — which is exactly the
pair an argument about "who let them do that" needs.

```
Person ──membership(OWNER)──▶ Supplier X   (account acct_x — owns X's listings, orders, wallets)
   │
   ├────membership(FINANCE)──▶ Merchant Y   (account acct_y — confers nothing at X)
   │
   └────own account──────────▶ their own orders as a customer
```

## 3. What this module owns

- **`organisation`** — the business: its account, kind, trading name and standing.
- **`organisation_membership`** — one person's place in one business, and the roles it carries.
- **`membership_event`** and **`organisation_event`** — append-only histories, each carrying the
  human who made the change and why.

It does **not** own:

- Authority itself — **K-04 Permissions**. A membership is what a grant is made *from*; it is not a
  grant, and this module writes none.
- Credentials or sessions — **K-02 Authentication**.
- Whether a business is verified — **M-02 Capability & Verification**.
- What a business deals in, or where — **M-48 Supplier & Merchant Directory**. The directory is a
  *market presence*; this is the business.
- Any balance, listing, or order. Those name the organisation's account and belong to their own
  modules.

`FOREIGN_FIELDS` in `registry.ts` refuses each of these by name.

---

## 4. Public contract

```ts
new OrganisationService(repository)

createOrganisation(request):   Promise<{ organisation, replayed }>  // + OWNER, atomically
activateOrganisation(request): Promise<{ organisation, replayed }>  // admission; not its own act
suspendOrganisation(request):  Promise<{ organisation, replayed }>
closeOrganisation(request):    Promise<{ organisation, replayed }>  // terminal

inviteMember(request):        Promise<{ membership, replayed }>   // confers nothing yet
acceptMembership(request):    Promise<{ membership, replayed }>   // only the invited person
changeRoles(request):         Promise<{ membership, replayed }>
suspendMembership(request):   Promise<{ membership, replayed }>
reinstateMembership(request): Promise<{ membership, replayed }>
revokeMembership(request):    Promise<{ membership, replayed }>
leaveOrganisation(request):   Promise<{ membership, replayed }>   // your own act, and only yours

getOrganisation(id) / getOrganisationForAccount(accountId)
getMembership(id) / findActingMembership(organisationId, personSubjectId)
listMembers(organisationId) / listMembershipsForPerson(personSubjectId)
listMembershipHistory(membershipId) / listOrganisationHistory(organisationId)
```

`findActingMembership` is the one the authorisation path calls: it returns a membership **only** when
it is in a status that can act, so "suspended loses access immediately" is a property of the query
rather than of each caller remembering to filter.

### Refusals

| Code | When |
| --- | --- |
| `malformed-identifier`, `natural-identifier`, `secret-bearing-input` | An id that is not opaque. |
| `malformed-instant` | An instant that is not a canonical UTC timestamp. |
| `foreign-concern` | A field another unit owns — `verified`, `grants`, `password`, `email`, … |
| `malformed-record` | A field of the wrong shape. |
| `malformed-name` | An empty trading name, or one over 200 characters. |
| `malformed-reason` | A change with no reason, or one under 8 characters. |
| `idempotency-key-reuse` | An existing key presented with different content. |
| `duplicate-organisation-id`, `duplicate-membership-id` | An id already used. |
| `organisation-not-found`, `membership-not-found` | No such record. |
| `account-already-organisation` | That account already trades as a business. One account, one business. |
| `already-a-member` | That person already holds a place here. |
| `unknown-kind`, `unknown-status`, `unknown-role` | Outside the vocabulary. |
| `illegal-transition` | A status change the machine does not have. |
| `organisation-closed` | Any change to a closed business. Closure is terminal. |
| `no-roles` | A membership that permits nothing. |
| `not-permitted-in-organisation` | The actor's own membership does not allow this. |
| `cannot-confer-role` | Handing out a role the actor does not hold. |
| `not-your-decision` | Acting on your own membership where somebody else must. |
| `not-your-invitation` | Accepting an invitation addressed to somebody else. |
| `last-owner` | Suspending, removing, demoting or walking out on the only owner. |

---

## 5. The six rules

**A business is created with an owner, atomically.** There is no window in which an organisation
exists that nobody can administer, and no operator has to bind the founder by hand.

**Creating a business is not being admitted to one.** A new organisation is `pending`; admission is
somebody else's act. A supplier with ten employees and no admission is still not sourceable.

**Joining is agreed to.** An invitation puts a person at `invited` and confers nothing; only that
person may accept. An invitation that took effect on its own would let anybody attach anybody
else's name to a business's acts.

**Nobody confers what they do not hold.** OWNER and ADMIN may build a team; only an OWNER may make
another OWNER, or change or remove one. Demotion is the quiet takeover — nothing about "change
their roles" reads as removing anybody — so it is checked in `changeRoles` as well as on removal.

**Nobody decides their own place.** Changing your own roles, suspending or removing yourself is
refused. *Leaving* is the exception, and it is a separate call for exactly that reason: needing
permission to stop working somewhere is not a thing a platform should impose.

**A business always has an active owner.** The last one cannot be suspended, revoked, demoted or
leave. The way back from a business nobody owns is an operator editing rows, and that is not a way
back.

---

## 6. What travels, and what does not

`organisation.created/activated/suspended/closed` and
`organisation.member_invited/joined/suspended/removed` carry the business, the account, the person
and the status. **No role travels in an event.** Who holds what authority in a company tells a
competitor who to approach and who has just left; the event log is read by every subscriber and
kept indefinitely.

The **audit record** does carry the roles, and the `actor_subject_id` of the human who conferred
them. It answers a different question — what authority was actually given, by whom — and it is not
a subscription anybody can read.

Outbox ids are keyed on the caller's **transition** id rather than on the status, because a
membership and an organisation both genuinely cycle. M-48 had the `id:status` defect and it was
found by a suspend-then-reactivate test; this module was written with it already known.

---

## 7. Determinism

The caller supplies every identifier and every instant. `tests/organisations.test.ts` asserts by
reading the sources that no file in this module calls `Date.now()`, `new Date()`, `Math.random()`
or `crypto.randomUUID()`.

Idempotency compares the content and **not** `correlationId` or the record's creation instant: a
retry arrives later with a fresh correlation id by definition, and comparing either would report an
honest retry as key reuse — advice which, followed, founds a second business.

---

## 8. Proof

- `tests/organisations.test.ts` — 27 tests: atomic creation with the owner, one account one
  business, convergence on retry, the invitation that confers nothing, only the invited person
  accepting, an ordinary member unable to invite, an ADMIN able to build a team and unable to
  confer or touch ownership, nobody changing their own roles, suspension taking effect immediately
  through every path, removal being terminal, leaving as one's own act, the last owner protected
  four ways, scoping across two businesses, one person holding several places, the history carrying
  the actor and reason, no role in any event, the roles present in the audit record, immutability of
  returned records, the foreign-field table, and the determinism scan.
