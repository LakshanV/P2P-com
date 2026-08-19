# K-05 Configuration — module contract

**Component:** K-05, `kernel/configuration`
**Schema:** `kernel_configuration` (derived from the architecture manifest)
**Build step:** B-1 — depends only on the platform substrate
**Delivered by:** FND-003a

Configuration is registered keys, immutable version records, and the ability to answer *what was
the value at instant T, and which exact version produced it*. The second half is why this is not a
settings table: a decision taken last March has to remain explicable in terms of the configuration
that produced it, and a store that overwrites values in place makes that permanently unanswerable.

---

## 1. What this component owns

| Owns | Does not own |
|---|---|
| Registered configuration keys and their value schemas | Financial policy values — commission, fees, price, payout, settlement, tax, refund, interest. Those are **K-06 Policy Engine**'s |
| Immutable version records, their lifecycle and their effective times | Secrets of any kind. Configuration versions cannot be deleted, so a credential here could never be revoked |
| Scoped overrides and their precedence | Who is allowed to change what — that is **K-04 Permissions** |
| The `kernel_configuration` schema and everything in it | Any other unit's schema. This component reads and writes nothing else |

It touches no other schema, in code or in SQL, and `tests/configuration-repository.test.ts`
asserts that mechanically against both the adapter and the migration.

---

## 2. Public contract

Everything another unit may use is exported from `kernel/configuration/index.ts`. Anything else is
internal.

```ts
service.publish(request): Promise<PublishResult>
service.resolve({ key, scope, at }): Promise<Resolution>
service.resolveForDecision({ key, scope, at }): Promise<ConfigurationDecisionRecord>
service.versionById(versionId): Promise<ConfigurationVersion>
service.history(key, scope): Promise<readonly ConfigurationVersion[]>
```

**Callers record `versionId`, not the value.** A decision that stores only the value cannot say
where it came from; one that stores only the key cannot be reproduced at all once a later version
lands. `resolveForDecision` returns exactly what should be persisted alongside the decision.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Immutable versions | Publishing never edits an existing record. Only `status` and `supersededAt` are ever stamped, and never the value, the effective time or the id. |
| Draft to active | A version is validated before it becomes active. Nothing half-written is resolvable. |
| Effective time | A version applies from an instant. `resolve` at a past instant answers with what was in force then — **not** bounded by when a successor was published, which is a different and usually earlier instant. |
| Optimistic concurrency | A publication states the version it believes it is replacing. The second of two concurrent editors is refused, never silently applied. |
| Idempotent publication | A retry with the same idempotency key returns the version the first attempt created. A dropped response cannot become a second version. |
| Determinism | `now`, `versionId` and `idempotencyKey` come from the caller. This component reads no clock and generates no randomness. |
| Provider neutrality | Nothing here knows a model provider exists. No AI import, direct or transitive. |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-key` | An unregistered key has no schema, so nothing can say what a valid value is. |
| `invalid-value` | The value does not satisfy the key's declared schema, or an instant is not ISO-8601 UTC. |
| `scope-not-permitted` | The key does not declare that scope level. |
| `scope-escalation` | Authority at a narrower scope may not change a broader one. Broader authority acting narrowly is delegation and is allowed. |
| `retroactive-change` | An effective time in the past would rewrite what earlier decisions were made under, which no version history can undo. |
| `ambiguous-active-version` | Two versions effective at the same instant cannot be ordered, and two active versions for one key and scope cannot be resolved. |
| `concurrent-modification` | The active version is not the one the caller expected, or it changed during the transaction. |
| `secret-bearing-value` | The key name or the value carries a credential. |
| `financial-policy-value` | The key is K-06's. |
| `origin-not-permitted` | See below. |

### AI is not an authority here

`PublicationOrigin` includes `ai-suggested` **so that it can be refused explicitly** rather than
being absent and therefore un-refusable. AI may propose a change to a human, who publishes it and
owns it. It may not publish, and it may not be the source a resolution answers from — `publish` is
the only writer, and the database `CHECK` constraint refuses the origin as well, so a write that
bypassed the service still could not record one.

### Scope precedence

`tenant` → `region` → `global`, most specific first, ending at global. A named broader scope is
not implied by a narrower one: a tenant does not know which region it belongs to at this layer, so
a tenant lookup falls through to global, not to a region. `scopeChain` is exported and tested.

---

## 3. Persistence

An injected `ConfigurationRepository` port with two implementations:
`InMemoryConfigurationRepository` (the reference implementation, used by the tests) and
`PostgresConfigurationRepository`. Every mutation runs inside one transaction, because a
publication both inserts the new version and supersedes the old one — a database that committed
one without the other would hold two active versions, which is exactly the ambiguity this
component exists to prevent.

The migration adds a partial unique index on `(config_key, scope_level, scope_id) WHERE status =
'active'`, so the invariant holds even if something writes around the service.

---

## 4. Deliberately deferred

| Deferred | Waiting on | Why it is not here |
|---|---|---|
| Administrative API | **K-02** Authentication, **K-04** Permissions | An endpoint that changes configuration before there is anyone to authenticate or authorise is a hole, not a feature |
| Administrative UI | the above, plus the design system | Same reason, with a larger surface |
| Change audit trail | **K-09** Audit Foundation | `origin` and `publishedAt` are recorded, but there is no actor identity to record and nowhere durable to record it |
| Change events | **K-08** Event Infrastructure | Nothing can subscribe yet; emitting into a void would be untested behaviour |
| Enforced authority | **K-04** Permissions | `authorityLevel` is supplied by the caller and checked. A component that adds the check later is one that shipped without it in the meantime |
| Financial policy values | **K-06** Policy Engine | Money decisions need their own deterministic evaluation and approval path |

---

## 5. Migration limitations

- **Never executed.** No PostgreSQL runtime is available to this repository, so
  `0003_create_kernel_configuration_schema` has been validated statically and applied nowhere. Its
  SQL is unproven.
- The rollback drops the schema with `RESTRICT`, so it fails rather than removing objects no
  migration described. That is deliberate, and it means a rollback will refuse if anything
  unexpected was created inside the schema.
- Values are stored as text plus a kind rather than as `jsonb`. A configuration value is a scalar
  of a declared schema; JSON would invite structure the schema does not describe.
- There is no data migration path for a key whose schema changes. Narrowing a schema while old
  versions violate it is not yet handled — those versions remain readable, but re-validating
  history is future work.

---

## 6. Verification

```bash
npm run verify                                       # everything, including the tests below
npm run check:migrations                             # the FND-002a contract over db/migrations
node --test tests/configuration.test.ts              # service: lifecycle, concurrency, refusals
node --test tests/configuration-repository.test.ts   # port conformance, adapter, module contract
npm run test:integration                             # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
