# M-04 Universal Listing — contract

**Status:** foundation delivered, **listing half only**. **Not complete** — see §7.
**Owner:** M-04, `modules/universal-listing/`.
**Layer:** L2. **Schema:** `module_universal_listing`, created by
[`0026_create_module_universal_listing_schema.up.sql`](../../db/migrations/0026_create_module_universal_listing_schema.up.sql).
**Depends on:** K-03 Accounts (the supplying account, by opaque id), K-11 Commerce Unit Registry
(the unit type being offered, by opaque id), K-08 Event Infrastructure, K-09 Audit Foundation.

M-04 is being built in two slices. **This contract covers slice A: the listing itself.** The
inventory interface — `getAvailability`, `reserve`, `release`, `commit`, `receive`, `adjust` — is
slice B, and it is the module's replaceability requirement; it gets its own migration, its own
section here, and a contract-test suite any replacement must pass.

---

## 1. What this module owns

Four things, and the outbox that publishes changes to them:

1. **Listings** (`listing`) — the stable identity of an offer to supply one CommerceUnit type, and
   its current status: `draft`, `published`, `suspended` or `withdrawn`.
2. **Listing versions** (`listing_version`) — one row per published version. Append-only and
   immutable.
3. **Listing media** (`listing_media`) — opaque references to media artefacts stored elsewhere,
   pinned to a version. Append-only.
4. **Listing declarations** (`listing_declaration`) — what the supplier asserts about what they are
   offering: condition, origin, compliance, warranty, restriction. Append-only.

It does **not** own:

- The supplying account — **K-03 Accounts**, referenced by opaque id.
- What a CommerceUnit type *is* — **K-11 Commerce Unit Registry**, referenced by opaque id.
- Whether the supplier is verified — **M-02 Capability & Verification**, which M-04 may read
  through its public contract (M-02 is L1, M-04 is L2) but whose fields it refuses to hold.
- Which roles the account may act in — **M-01 Universal Account**.
- Orders, payments and quotes — the L3+ modules that own each. Their identifiers are refused by
  name.
- **The media artefact itself.** M-04 stores a handle; a document store holds the bytes.

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract — slice A

```ts
new UniversalListingService(repository)

createListing(request):     Promise<{ listing, replayed }>
publishListing(request):    Promise<{ listing, version, replayed }>
addMedia(request):          Promise<{ media, replayed }>
addDeclaration(request):    Promise<{ declaration, replayed }>
suspendListing(request):    Promise<{ listing, replayed }>
withdrawListing(request):   Promise<{ listing, replayed }>

getListing(listingId)
getVersion(versionId)
listVersions(listingId)
listMedia(versionId)
listDeclarations(versionId)
listListingsByAccount(accountId)
```

### Refusals

| Code | When |
|---|---|
| `listing-already-exists` | the listing id exists with different content |
| `listing-not-found` | the listing id is unknown |
| `listing-withdrawn` | the listing is withdrawn, and withdrawal is terminal |
| `version-not-found` | the version id is unknown |
| `version-not-current` | media or a declaration was attached to a version that is not the listing's current one |
| `version-number-conflict` | two publications raced for the same version number |
| `negative-amount` / `negative-quantity` | a price or quantity below zero, or not an exact integer |
| `malformed-currency` | not three uppercase letters |
| `malformed-reference` | a media reference that is not an opaque handle |

---

## 3. A listing is versioned, never edited

This is the module's central decision, and the reason three of its four tables are append-only.

An order placed in March is against **listing L, version 3**. Publishing version 4 in June must not
change what version 3 said, because version 3 is the agreement. `UNIQUE (listing_id,
version_number)` in the migration is what makes that pair a permanent address for one set of terms,
and the append-only trigger on `listing_version` is what stops the terms being rewritten after the
fact.

The same reasoning extends to declarations. A declaration is what the supplier asserted — the
condition, the origin, the compliance claim — and it is the thing a dispute is later judged against.
A claim that can be edited after a dispute begins is not evidence of anything.

`publishListing` on an already-published listing therefore appends a **new** version. There is no
operation that edits one.

---

## 4. Money

Prices are `bigint` minor units. No floating point exists in this module, and migration 0026
declares no `double precision`, `real` or `money` column. The validator accepts a `bigint`, a
non-negative **safe** integer, or a digits-only string — the same three forms K-10 Ledger Foundation
accepts, and for the same reason: the string form is what PostgreSQL returns for a `bigint`, and the
safe-integer check is what stops a value that has already lost precision from being stored as if it
had not.

Events carry `unit_price_minor` and `quantity_available` as **strings**, because a `bigint` does not
survive JSON.

---

## 5. Media holds a reference, never the artefact

`listing_media.reference` is an opaque handle checked against the same `is_opaque_identifier` rule
set as every identifier — in the service and again as a database `CHECK`. That rule set refuses
emails, long digit runs, IBAN shapes, URLs, domains and credential-shaped values.

The reasoning is M-02's, applied to a different table: a listing outlives its media, and a URL or a
natural key written into a row is disclosed for as long as the platform exists. A document store
holds the bytes and hands back a handle; M-04 stores the handle.

---

## 6. Events and audit

Through the module-owned outbox, in the same transaction as the state change:

| Fact | Event |
|---|---|
| A listing was created | `listing.created` |
| A version was published | `listing.published` |
| A listing was suspended | `listing.suspended` |
| A listing was withdrawn | `listing.withdrawn` |

Outbox ids derive from the append-only record a fact produced — the version id — or from the
caller-supplied decision id, never from the listing id alone. A listing is published many times, and
an id derived from the listing would collide with itself on the second publication; M-01 shipped
that bug and `outbox_pkey` refused the write.

---

## 7. What is not delivered

- **The inventory interface is not built.** `getAvailability`, `reserve`, `release`, `commit`,
  `receive` and `adjust` do not exist, and neither does `inventory_snapshot`. This is slice B, and
  it carries the module's replaceability requirement: it will ship with a contract-test suite that
  any replacement implementation must pass, per `docs/JAYA_TEST_MATRIX.md` §1.3.
- **Nothing calls this module.** No API, no UI, no consumer of any of the four events.
- **No verification gate.** M-04 does not ask M-02 whether the supplier is verified before letting
  them publish. It can — M-02 is a layer below — and it does not yet; the policy for which levels
  may publish what does not exist.
- **No K-02 authentication and no K-04 authorisation.** Anyone holding the repository can publish a
  listing as any account.
- **No commerce-unit-type check.** `commerceUnitTypeId` is not verified against K-11, for the reason
  in §1: no join across a unit boundary.
- **No search integration.** K-15 exists and nothing indexes a listing into it.
- **No pricing rules, no availability windows, no geographic scoping, no bulk import.**
- **Nothing applied to a live server.** Migration 0026 runs in the integration suite against a live
  PostgreSQL 16 and nowhere else.

---

## 8. Verification

```
npm run typecheck
npm run lint
npm run format:check
npm run check:boundaries      # M-04 is L2: platform/, kernel/ and L1 modules only, never K-13
npm run check:migrations      # 0026 is paired, transactional and module-owned
npm test                      # tests/universal-listing*.test.ts
npm run test:integration      # tests/integration/universal-listing.integration.ts
```
