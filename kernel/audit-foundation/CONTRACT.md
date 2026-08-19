# K-09 Audit Foundation — module contract

**Component:** K-09, `kernel/audit-foundation`
**Schema:** `kernel_audit_foundation` (derived from the architecture manifest)
**Build step:** B-2 — depends only on the platform substrate today; see §6
**Delivered by:** FND-003c

An audit record answers a question asked much later, usually by somebody who was not there and is
not inclined to take anybody's word for it: *who did this, when, to what, and what happened*.

The whole value of the answer rests on the record being impossible to change afterwards. That is
not a feature of this component, it is the only reason it exists — everything below follows from
it.

---

## 1. What this component owns

| Owns | Does not own |
|---|---|
| The audit record contract, the action registry, and evidence classification | What any action *means*. Actions belong to the units that take them |
| The append-only store and deterministic filtered retrieval | Who may read which classification — that is **K-04 Permissions** |
| The `kernel_audit_foundation` schema and everything in it | Any other unit's schema. This component reads and writes nothing else |
| Which actor may author a record | Establishing that the actor is who they claim — that is **K-02 Authentication** |

It touches no other schema, in code or in SQL, and `tests/audit-repository.test.ts` asserts that
mechanically against both the adapter and the migration.

---

## 2. Public contract

Everything another unit may use is exported from `kernel/audit-foundation/index.ts`.

```ts
service.record(request): Promise<RecordResult>        // append, idempotent by key
service.recordById(recordId): Promise<AuditRecord>
service.query({ action?, actorId?, resourceOwner?, resourceType?, resourceId?,
                outcome?, correlationId?, from?, before?, after?, limit? }): Promise<AuditPage>
service.queryAll(query, maxRecords?): Promise<readonly AuditRecord[]>
```

**There is no fourth operation.** Nothing amends, redacts, expires or removes a record — not in the
service, not in the port, not in the adapter, and not in the database, where a trigger refuses
`UPDATE` and `DELETE` outright. A component that can rewrite its own history proves nothing about
anybody else's.

**Provider-neutral.** No storage vocabulary appears in any type. A PostgreSQL table, an append-only
log service and a SIEM are all implementations of the port in `repository.ts`.

**Deterministic.** `recordedAt`, the record id and the idempotency key come from the caller. This
component reads no clock and generates no randomness.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Immutability | A record is written once. No update or delete exists at any layer, and the database refuses both by trigger, so a connection that bypasses this component still cannot edit history |
| Content fingerprint | SHA-256 over the record's canonical content, computed at append. A reader can recompute it without trusting the row it came from |
| Idempotent recording | A retry with the same key returns the original record **only when the whole logical content matches**. Two retries that overlap in time converge on the winner rather than one failing — a caller retrying after a timeout has done nothing wrong |
| Classified evidence | Every evidence field is declared with a classification at registration. An undeclared field is refused, not stored |
| Deterministic retrieval | Ordered by `(recordedAt, recordId)` ascending, always. Audit records arrive in bursts and two can share an instant; ordering by time alone makes a paginated read skip or repeat rows |
| Stable pagination | The cursor is the pair, and the SQL compares it as a tuple. A page boundary is exact even when every record in the log shares one instant |
| Bounded reads | A page is at most 1000 records. An unbounded audit query is how one investigation takes a database down |
| Transaction composition | `PostgresAuditRepository.enlist(client)` appends inside a transaction the caller already opened, so a domain write and its audit record commit together or not at all |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-action` | An unregistered action has no declared evidence, so nothing can say whether the record is complete or safe to keep |
| `malformed-record` | An identifier, instant, outcome or resource type is not well formed, or the reason is empty. A record with no reason explains nothing to the person reading it during an incident, which is the only time anybody reads one |
| `invalid-evidence` | A declared field is missing, wrongly typed, or null where it is required |
| `unclassified-evidence` | A field the action never declared, or a classification outside the permitted set. A field nobody classified is a field nobody can decide about when it is read |
| `secret-bearing-evidence` | A field name or a value carries a credential. An audit log is the longest-lived store in the system; a credential in one is published for the whole retention period. Record `REDACTED` instead — that the field existed is worth keeping, its value is not |
| `ai-not-permitted` | AI tried to author a record. See below |
| `actor-not-permitted` | The record claims a session or an authentication method that cannot exist yet |
| `resource-not-owned` | A unit tried to record an action against another unit's resource, or a resource type its action never declared |
| `duplicate-record-id` | A record is written once and never rewritten |
| `idempotency-key-reuse` | The key was already used for a different record. Returning the earlier one would attest to something that was never recorded |
| `no-such-record` | Nothing to read |
| `invalid-query` | A limit outside 1–1000, an unknown outcome, an unregistered action, or a malformed instant or cursor |
| `nested-transaction` | An enlisted append tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. The transaction belongs to the caller |
| `concurrent-modification` | Something moved underneath the transaction |

### AI is not an authority here

`actor.kind: 'ai'` is refused for every registered action, and the database `CHECK` refuses it too,
so a write that bypassed the service still could not record one. Every registered action is either
security-sensitive or business-authoritative, so there is no category of record AI could safely
author.

An audit record is the evidence a later investigation relies on, and a fabricated one is
indistinguishable from a real one to everybody who reads it. AI may prompt a human or a
deterministic system to record an action; that actor owns the record.

---

## 3. The actor is a placeholder in exactly one respect

**K-02 Authentication does not exist.** Nothing verifies that an actor is who the caller says. The
record therefore carries what it can honestly carry:

| Field | Today | When K-02 lands |
|---|---|---|
| `actor.kind` | supplied and checked (`human`, `system`; never `ai`) | unchanged |
| `actor.id` | supplied and checked for shape | derived from the verified principal |
| `actor.authentication` | **must be `unauthenticated`** — anything else is refused | `session` or `service-credential` |
| `actor.sessionId` | **must be null** — a claimed session is refused | the verified session |

Refusing the optimistic values rather than accepting them is the point. A record written today that
claimed a verified session would be asserting a verification that never happened, and a reader in
two years could not tell which records had a real actor and which did not. The migration carries the
matching `CHECK`, and relaxing it is a later migration's job rather than a silent change of meaning.

---

## 4. Persistence

An injected `AuditRepository` port with three implementations:

| Implementation | Owns a transaction? | For |
|---|---|---|
| `InMemoryAuditRepository` | yes, modelled | the reference implementation, used by the tests |
| `PostgresAuditRepository` | yes, its own `BEGIN … COMMIT` | a caller that is only recording |
| `EnlistedAuditRepository` | no — it uses the caller's | a unit coupling a domain write to its audit record |

Timestamps are projected as UTC text through `to_char`, never left to the driver's `Date` parser:
`Date` holds milliseconds where the column holds microseconds, and both ordering and pagination
compare instants. Decoding is fail-closed — a row that is not exactly what the projection emits, or
whose actor kind, outcome, fingerprint or evidence is not what the contract declares, is refused
rather than approximated. A wrong audit record is worse than a missing one, because it is read as
fact.

---

## 5. Retention and access

Both are **assumptions recorded here, not mechanisms delivered here.**

- **Retention is indefinite.** Nothing expires, archives or partitions a record. The table grows
  without bound, and that is deliberate: deleting evidence needs a policy, a retention period agreed
  with whoever answers for the data, and — given the immutability trigger — a migration that
  deliberately suspends it. None of those exist, and inventing a default would be choosing the one
  decision here that is genuinely not a technical one.
- **Access is unrestricted at the component boundary.** `query` applies no entitlement check,
  because there is nothing to check against. Every evidence field carries a classification so that
  the check **K-04** will add has something to act on, and so that the decision is made by whoever
  understood the field rather than by whoever later needs to expose it.
- **Personal data may be present.** A `personal` classification exists precisely because an action's
  evidence can name somebody. Nothing here erases it, so a subject-erasure request currently has no
  answer in this component — see the deferred table below.

---

## 6. Deliberately deferred

| Deferred | Waiting on | Why it is not here |
|---|---|---|
| Producer integrations | a unit that records something | **No unit records an audit record.** Not K-05, not K-08, not any financial module. The registry is a mechanism and the actions in the tests are fixtures; registering an action on a unit's behalf would claim it is audited when it records nothing |
| Enforced authority | **K-04** Permissions | `query` returns whatever matches. Classifications are recorded so the check has something to act on |
| Verified actor identity | **K-02** Authentication | See §3. The placeholder is refused into honesty rather than left optimistic |
| Administrative API and UI | K-02 and K-04 | An endpoint exposing an audit log before anything can decide who may read which classification is a disclosure waiting to happen |
| Retention and erasure | an agreed policy | See §5 |
| Tamper-evident chaining | a threat model | Each record is fingerprinted individually. Chaining records into a hash chain would detect deletion as well as edit, and is worth doing once somebody has decided what the log is being defended against |
| Export and streaming to a SIEM | an operational requirement | The port makes it another implementation rather than a rewrite |

**Build step.** MODULE_MAP §9 places K-09 in B-2, after the identity chain, because it *will* depend
on K-02 and K-04. Today it depends only on the platform substrate, which is what makes this
foundation buildable now; the dependencies arrive with the integrations above.

---

## 7. Migration limitations

- **Never executed.** No PostgreSQL runtime is available to this repository, so
  `0005_create_kernel_audit_foundation_schema` has been validated statically and applied nowhere.
  Its SQL is unproven — including the append-only trigger, which is the strongest claim this
  component makes and has never refused anything.
- The rollback drops the trigger before the function it references, and the schema with `RESTRICT`.
- **Rolling back discards the audit trail**, and is the one rollback in this repository that
  destroys evidence rather than merely state. The trigger is dropped first, which is the only moment
  those rows are deletable at all. Export the table first.
- There is no partitioning. At volume an audit table wants time-based partitions; adding them later
  is a migration, adding them now is a guess about volume nobody has measured.

---

## 8. Verification

```bash
npm run verify                                 # everything, including the tests below
npm run check:migrations                       # the FND-002a contract over db/migrations
node --test tests/audit.test.ts                # record contract, registry, refusals
node --test tests/audit-repository.test.ts     # port conformance, adapter, pagination, contract
node --test tests/audit-concurrency.test.ts    # retry convergence, enlistment, immutability
npm run test:integration                       # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
