# M-01 Universal Account — contract

**Status:** foundation delivered. **Not complete** — see §7.
**Owner:** M-01, `modules/universal-account/`.
**Layer:** L1. **Schema:** `module_universal_account`, created by
[`0024_create_module_universal_account_schema.up.sql`](../../db/migrations/0024_create_module_universal_account_schema.up.sql).
**Depends on:** K-03 Accounts (the account this capability belongs to, by opaque id),
K-08 Event Infrastructure, K-09 Audit Foundation.

This is the first business module in the repository. Everything above L1 that needs to know whether
an account may sell, host, drive or introduce reads it from here.

---

## 1. What this module owns

Two things, and the outbox that publishes changes to them:

1. **Account capabilities** (`module_universal_account.account_capability`) — one row per
   `(account, capability)`, holding the current status of one role an account may act in. The
   vocabulary is closed: `buyer`, `seller`, `host`, `provider`, `introducer`, `driver`,
   `business-purchaser`.
2. **Capability state** (`module_universal_account.capability_state`) — the append-only log of how
   a capability reached its current status. One row per transition, carrying the status it came
   from, the status it went to and a required reason.

It does **not** own:

- The universal account — **K-03 Accounts** owns that. M-01 holds an opaque `accountId` and never
  joins to `kernel_accounts`.
- The identity behind the account — **K-01 Identity**.
- Whether the holder has been verified to any level, and the evidence for it — **M-02 Capability &
  Verification**. A capability says what an account may act as; a verification level says how much
  the platform has checked. Conflating them would put an unaudited claim in the same row as a
  granted role.
- What a capability is *permitted to do* — **K-04 Permissions**. Holding the seller capability is
  not authority; it is the fact a grant can be written against.

### What it does not own, and who does

| Concern | Owner |
|---|---|
| The universal account | **K-03 Accounts** |
| Identity, subjects, party kinds | **K-01 Identity** |
| Authentication, sessions, credentials | **K-02 Authentication** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Verification levels, evidence, tax and payout identifiers | **M-02 Capability & Verification** |
| Every monetary amount | **K-10 Ledger Foundation** |
| Listings, orders, payments, quotes | The business modules that own each |
| Event routing and subscriptions | **K-08 Event Infrastructure** |
| Audit storage and authority classification | **K-09 Audit Foundation** |

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`. A
request carrying one of those fields is refused by name with `foreign-concern` rather than ignored,
so a caller learns which unit to ask instead of silently losing the value.

---

## 2. Public contract

```ts
new UniversalAccountService(repository)

activateCapability(request): Promise<{ capability, state, replayed }>
deactivateCapability(request): Promise<{ capability, state, replayed }>
listCapabilities(accountId): Promise<readonly AccountCapability[]>
getCapabilityHistory(capabilityId): Promise<readonly CapabilityState[]>
```

Everything a consumer may depend on is re-exported from
[`index.ts`](./index.ts). Anything not exported there is internal and may change without notice.

### `activateCapability`

Activates a capability, or returns a deactivated or suspended one to `active`.

Refusals:

| Code | When |
|---|---|
| `capability-already-active` | the account already holds an active capability of that role under a different id |
| `duplicate-capability-id` | the id exists with different content |
| `idempotency-key-reuse` | the key was used for a different request |
| `unknown-capability` | the capability word is not in the closed vocabulary |
| `malformed-reason` | the reason is empty, whitespace-only, or longer than 500 characters |

A replay with the same idempotency key and the same content returns the stored record with
`replayed: true` and writes nothing further. Reactivation keeps the same `capabilityId`, clears
`deactivatedAt`, and appends a transition — so a consumer that stored the id keeps a valid handle
for the whole life of the role.

### `deactivateCapability`

Refuses `capability-not-found` for an unknown id and `capability-not-active` for one already
deactivated. On success the row moves to `deactivated`, `deactivatedAt` is set, a transition is
appended, and both outbox entries are written.

### Reads

`listCapabilities` returns one account's capabilities, sealed, ordered by capability.
`getCapabilityHistory` returns the transition log for one capability, oldest first.

---

## 3. Domain model

A capability has one identity for its whole life. It is activated, may be suspended or deactivated,
and may be activated again — and every one of those is the *same row* moving, with the movement
recorded beside it.

That split is the module's central decision. The current state answers "may this account sell?" in
one indexed lookup, and `UNIQUE (account_id, capability)` makes the answer unambiguous at the
database level rather than by convention. The history answers "since when, and why?" without the
current-state table accumulating a row per change. `capability_state` is append-only, enforced by a
trigger, so the answer to the second question cannot be edited after the fact.

Determinism: the caller supplies every identifier and every instant. Nothing in this module reads a
clock or generates randomness, which is why a replayed request produces a byte-identical record and
why the tests need no fake timers.

---

## 4. Immutability and mutability

| Record | Mutable? |
|---|---|
| `account_capability` | Yes, and only through the service: status, `activatedAt`, `deactivatedAt`, `updatedAt`. |
| `capability_state` | No. The database trigger refuses `UPDATE` and `DELETE`. |
| `outbox` | Only the relay's dispatch columns. |

Every record crossing the service boundary is sealed. Mutating one throws rather than silently
diverging from what was stored.

---

## 5. The K-03 dependency

`accountId` is an opaque K-03 identifier, checked against the same `is_opaque_identifier` rule set
every other unit uses, carried in M-01's own schema as a character-for-character copy.

There is **no foreign key** to `kernel_accounts`, and no SQL in this module reaches that schema.
MODULE_MAP §10.4 forbids one unit joining to another's tables, because a join is the coupling that
makes later extraction to a service impossible. The cost is stated rather than hidden: the database
will not stop a capability being written for an account that does not exist. The same trade K-03
made against K-01, for the same reason.

M-01 does not currently call K-03 to check existence. When an entry point exists that can, it will
read through K-03's public contract — never by query.

---

## 6. Events and audit

Through the module-owned outbox, in the same transaction as the state change:

| Fact | Event | Audit action |
|---|---|---|
| A capability was activated or reactivated | `capability.activated` | recorded |
| A capability was deactivated | `capability.deactivated` | recorded |

MODULE_MAP §10.1–10.3: consumers above L1 subscribe to these rather than calling upward or reading
this schema.

---

## 7. What is not delivered

- **Nothing calls this module.** No API, no UI, no consumer of either event. No account has had a
  capability activated outside a test.
- **No suspension operation.** `suspended` is in the vocabulary and the schema accepts it, but the
  service exposes no way to reach it. It is there because the transition log and the CHECK
  constraints had to decide the vocabulary once; the operation lands with the moderation slice.
- **No K-02 authentication and no K-04 authorisation** behind activation. Anyone holding the
  repository can activate anything. The permission grant that should gate this is exactly what K-04
  exists for, and no caller wires it yet.
- **No verification.** A capability can be activated with no evidence whatsoever; M-02 owns that and
  is not built.
- **No account-existence check** — see §5.
- **Nothing applied to a live server.** Migration 0024 runs in the integration suite against a live
  PostgreSQL 16 and nowhere else.

---

## 8. Verification

```
npm run typecheck
npm run lint
npm run format:check
npm run check:boundaries      # M-01 imports only platform/ and kernel/
npm run check:migrations      # 0024 is paired, transactional and module-owned
npm test                      # tests/universal-account*.test.ts
npm run test:integration      # tests/integration/universal-account.integration.ts, live PostgreSQL
```
