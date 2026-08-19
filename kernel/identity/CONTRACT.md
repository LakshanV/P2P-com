# K-01 Identity — contract

**Status:** foundation delivered by FND-004a. **Not complete** — see §7.
**Owner:** K-01, `kernel/identity/`.
**Schema:** `kernel_identity`, created by
[`0006_create_kernel_identity_schema.up.sql`](../../db/migrations/0006_create_kernel_identity_schema.up.sql).

---

## 1. What this component owns

One thing: **the stable, opaque, internal handle for a party.**

An identity subject answers "what do we call this party in our own records" and nothing else. It
carries no name, no email, no phone number, no password, no session, no account, no capability and
no verification level. Six fields, all of them structural.

| Field | Meaning |
|---|---|
| `subjectId` | Caller-supplied opaque handle. Never a natural key |
| `kind` | `person`, `organisation` or `system` — what the party *is* |
| `createdAt` | Canonical UTC instant, caller-supplied |
| `origin` | Who caused the creation: `{ kind: 'human' \| 'system', id }` |
| `idempotencyKey` | Stable across retries of one logical creation |

### What it does not own, and who does

This table is the contract. A create request carrying any of these fields is **refused by name**
rather than ignored, because a caller that passes `accountId` is not making a typo — it is modelling
the thing wrongly, and silently dropping the field would leave it believing the link was stored.

| Concern | Owner |
|---|---|
| Passwords, credentials, MFA, sessions, tokens | **K-02 Authentication** |
| The one universal account, its profile core, capabilities | **K-03 Accounts** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Verification level, KYC, tax identity, identity documents | Capability & Verification module |
| Who did what to which identity | **K-09 Audit Foundation** |

---

## 2. Public contract

```ts
new IdentityService(repository)

create(request): Promise<{ subject, deduplicated }>
findSubject(subjectId): Promise<IdentitySubject | null>
requireSubject(subjectId): Promise<IdentitySubject>
exists(subjectId): Promise<boolean>
```

Four operations, three of which are the same read. There is no update, no deactivation, no deletion
and no merge — see §4.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Immutability | A subject is written once. No update or delete exists at any layer, and the database refuses both by trigger, so a connection that bypasses this component still cannot rewrite an identity |
| Opaque identifiers | A subject id, origin id or idempotency key that looks like an email, a telephone number, a document number, an IBAN, a URL, a domain or a `first.last` name is refused. So is one shorter than 8 characters, and one that names or looks like a credential |
| One rule, three enforcement points | The same rules apply at creation, on every read decoded from PostgreSQL, and in the `CHECK` constraints — the last so a write around the adapter is judged by the same standard as a call. A test drives one corpus through all three and fails if any two disagree (§6) |
| Closed kind registry | Exactly `person`, `organisation`, `system`. Unknown kinds are refused, and the list is closed on purpose (§3) |
| Idempotent creation | A retry with the same key returns the original subject **only when the whole content matches**. Two retries that overlap in time converge on the winner rather than one failing — a caller retrying after a timeout has done nothing wrong |
| Determinism | The caller supplies the id, the instant and the key. This component reads no clock and generates no randomness, so the same request twice is the same subject |
| Immutability in the process | Every subject crossing a boundary — a service result, a repository read, a decoded row — is deep-frozen and severed from the caller's objects by a single seal. Writing `subject.origin.id` throws; editing an object you passed in does not reach what is stored |
| Transaction composition | `PostgresIdentityRepository.enlist(client)` creates inside a transaction the caller already opened, so a future account and its subject commit together or not at all |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-subject-kind` | The kind is not in the closed registry. A role is not a kind (§3) |
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric. A short id is guessable, and an enumerable identity space lets anybody count the platform's parties |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name — at creation or in a row read back from storage. See §3 and §6 |
| `secret-bearing-input` | The id names or looks like a credential. An identity record is permanent; a secret in one is disclosed for as long as the platform exists |
| `malformed-instant` | `createdAt` is not a real UTC instant. 31 April is refused rather than rolled forward |
| `ai-not-permitted` | `origin.kind` is `ai`. See §5 |
| `foreign-concern` | The request carried a field owned by K-02, K-03, K-04, verification or a profile — or a field this component does not recognise at all |
| `duplicate-subject-id` | A subject with this id exists. An identity is created once |
| `idempotency-key-reuse` | The key was already used for a *different* subject. Returning the earlier one would hand back an identity for a party the caller never asked about |
| `no-such-subject` | Nothing to read |
| `nested-transaction` | An enlisted write tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. The transaction belongs to the caller |
| `malformed-record` | A stored row or a candidate subject is the wrong runtime shape: a column that is not text, an instant that is not what the projection emits, an unknown `origin.kind`, or a field the subject may not carry |

---

## 3. Why the registry is closed, and why identifiers must be opaque

**The kind registry is closed** at `person`, `organisation`, `system`. There is no `buyer`, no
`seller`, no `host`, no `supplier`, no `staff`.

The guide's §4 is explicit: *do not create separate identities for buyers, sellers, hosts or service
providers; create one JAYA Account with capabilities*. If a role were a kind, the platform would
need one subject per role, and a person who both buys and sells would be two parties who cannot see
each other's history, cannot share a payment method and cannot be reasoned about as one
counterparty. Every open enumeration in an identity system eventually acquires a role because
somebody needs one and adding it is a one-line change — so the list is closed here and the reason is
written down next to it.

The three that remain each pass one test: would two parties of this kind ever need to be told apart
by something the identity layer itself stores? A person and a company differ in what law applies and
in what can be verified about them. A `system` actor exists so a worker's actions can be attributed
to something rather than appearing to come from nobody.

**Identifiers must be opaque** because a subject id is copied into every account, order, ledger
entry and audit record that ever references the party, for the life of the platform. If the id is
somebody's email address, then the platform has published personal data into every one of those
places, has no index of where, and has no answer to an erasure request that is not "rebuild the
database". Refusing at the door costs the caller one line.

The refusals are shape-based and therefore imperfect: a random-looking string that happens to be an
employee number will pass. That is stated rather than hidden. What they catch is the overwhelmingly
common case — `subjectId: user.email`, because it was to hand — and catching that is worth far more
than the false negatives cost.

---

## 4. Immutability, and why there is no merge

A subject is created and never changed. Not by an admin path, not by an internal one.

Everything downstream will reference these ids. An id whose meaning can change silently reattributes
history: the orders, ledger entries and audit records already pointing at it now describe a
different party, and nothing in any of them records that they used to describe another. An id that
can be deleted leaves every one of those rows pointing at nothing.

Enforced at four layers: no such operation in the service, none in the port, none in the adapter,
and a `BEFORE UPDATE OR DELETE` trigger in migration 0006 that refuses both at the database.
`tests/identity-repository.test.ts` inspects the transaction object at runtime and fails if an
operation matching update, delete or merge ever appears — a rule enforced by a type is a rule a cast
can undo.

**Merge is deferred, not forgotten.** Two subjects that turn out to be one party is a real
situation. The answer is a deliberate design — a linkage record, a surviving id, an audit trail of
the decision, and a rule for what happens to the balances on both sides — and not an `UPDATE` here.
Implementing merge as a mutation is how an identity system becomes unable to explain its own
history.

---

## 5. AI has no authority here

`origin.kind: 'ai'` is refused by the service, by the database `CHECK`, and again on decode if a row
somehow holds it.

An identity subject is the root of attribution for every account, order and ledger entry that
references it. A fabricated one is indistinguishable from a real party to everything downstream —
including the financial modules, where AI is barred from authority outright (MODULE_MAP §11). AI may
draft the request, prompt an operator, or propose that a party should exist; the human or
deterministic system that acts on that owns the record.

The `ai` value exists in `ORIGIN_KINDS` precisely so the refusal can be expressed and tested. A
value that were unrepresentable would also be unexamined.

---

## 6. Persistence

An injected `IdentityRepository` port with three implementations:

| Implementation | Owns a transaction? | For |
|---|---|---|
| `InMemoryIdentityRepository` | yes, modelled | the reference implementation, used by the tests |
| `PostgresIdentityRepository` | yes, its own `BEGIN … COMMIT` | a caller that is only creating an identity |
| `EnlistedIdentityRepository` | no — it uses the caller's | a unit coupling a domain write to a subject creation |

The in-memory implementation is a **reference implementation, not a test double**: it enforces the
same uniqueness the database does, and it checks conflicts at commit against the store as it stands
rather than against the snapshot the transaction read. Two creators that overlap therefore behave
here as they would against a server. K-08 shipped without that parity and every concurrency
guarantee proved against it was worth less than it appeared (CURRENT_IMPLEMENTATION_STATUS §11.15).

Every subject that leaves any of them passes through one boundary, `sealSubject` in `immutable.ts`,
which copies the subject and its `origin` and freezes both. One function rather than a convention,
because a shallow `{ ...subject }` looks like a copy and shares its children — the defect K-09
shipped with (§11.20).

`created_at` is projected as UTC text through `to_char`, never left to the driver's `Date` parser:
`Date` holds milliseconds where the column holds microseconds.

### A stored subject is held to exactly what creation demands

Decoding runs in two stages, and the split is deliberate. **Shape** is the adapter's job, because
only it knows what the driver hands back: is the column text at all, and is `created_at` exactly
what the projection emits. **Domain** is `validateSubject` in `validate.ts` — *the same function the
service calls on the way in*. Every stored subject id, origin id, idempotency key, kind, origin and
instant is therefore judged by the rules that governed its creation: opacity, natural- and
PII-shape refusal, credential refusal, the closed kind registry, the AI prohibition, and runtime
shape. A row failing any of them is refused before it is returned, and the refusal says that the row
was not written by this component — because that is a database problem, not a caller's.

The first revision did not do this. It asked only whether each column was non-empty text and whether
two of them held a known enum value, so a row written around the adapter decoded cleanly and came
back as a real party while carrying exactly the natural key creation exists to keep out. That
asymmetry was the wrong way round: validation on the way *in* protects the store from a caller,
validation on the way *out* protects every consumer from the store, and the store is the thing this
component controls least. A wrong identity is worse than a missing one, because it is treated as a
real party.

The same rule set exists a third time, in SQL, as `kernel_identity.is_opaque_identifier` — one
function, called by the `CHECK` on all three identifier columns, so a direct write is judged by the
same standard as a call. `tests/identity-persisted.test.ts` extracts that function's clauses from
migration 0006, translates them, and runs one shared corpus through all three enforcement points,
failing if any two disagree. It **throws** rather than passing when a clause is rewritten into a
form it cannot evaluate, so the check cannot quietly stop checking.

---

## 7. Deliberately deferred

Recorded here rather than implied, because a reader who mistakes a foundation for a finished
component will build on a guarantee that does not exist.

- **No unit creates an identity subject.** Not K-03, not any module. This slice delivers the
  mechanism; the enlisted path exists as a capability, not an integration.
- **No login, password, OAuth, MFA or session.** K-02.
- **No account, capability, profile or verification.** K-03 and the Capability & Verification
  module.
- **No API and no UI.** An endpoint that creates identities before K-02 Authentication and K-04
  Permissions can decide who may call it is a hole, not a feature.
- **No audit trail.** Creating an identity is exactly the sort of action K-09 exists to record.
  K-09 is built; wiring K-01 to it is separate, undelivered work.
- **No merge, no deactivation, no erasure.** §4. Erasure in particular has no answer in this
  component today: the subject holds no personal data, which is the point, but the *linkage* between
  a subject and a person will live in K-03 and erasure will be that component's problem to solve.
- **No listing or search.** `findSubject` takes an id and nothing else. A lookup that took personal
  data would be an identity layer that stores personal data.
- **`identity_document`** — MODULE_MAP §3 lists it among K-01's tables. It holds verification
  evidence and is deferred with the verification work.
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, the constraints and the write-once trigger are declared and unproven.

---

## 8. Verification

```bash
npm run verify                                 # everything, including the tests below
npm run check:migrations                       # the FND-002a contract over db/migrations
node --test tests/identity.test.ts             # subject contract, kind registry, refusals
node --test tests/identity-repository.test.ts  # port conformance, adapter, module contract
node --test tests/identity-concurrency.test.ts # retry convergence, enlistment, immutability
node --test tests/identity-persisted.test.ts   # decoded rows and the SQL rule set, held to §6
npm run test:integration                       # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
