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
service.createDraft(request): Promise<CreateDraftResult>
service.publishDraft({ draftId, expectedActiveVersionId, now }): Promise<PublishResult>
service.publish(request): Promise<PublishResult>              // createDraft + publishDraft
service.resolve({ key, scope, region?, at }): Promise<Resolution>
service.resolveForDecision({ key, scope, region?, at }): Promise<ConfigurationDecisionRecord>
service.versionById(versionId): Promise<ConfigurationVersion>
service.history(key, scope): Promise<readonly ConfigurationVersion[]>
```

**Publication is two steps.** `createDraft` validates and stores an immutable draft, which
resolution ignores. `publishDraft` supersedes the expected incumbent and *then* activates that
same record. `publish` composes the two, so there is exactly one activation path rather than a
second one to keep in step.

**Callers record `versionId`, not the value.** A decision that stores only the value cannot say
where it came from; one that stores only the key cannot be reproduced at all once a later version
lands. `resolveForDecision` returns exactly what should be persisted alongside the decision.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Immutable versions | Content — id, key, scope, value, effective time, origin, idempotency key — is fixed at creation. Only lifecycle state moves: `status`, `publishedAt`, `previousVersionId`, `supersededAt`. |
| Replacement ordering | A replacement supersedes the incumbent **before** activating the draft. The partial unique index is checked per statement, so the reverse order asks the database to hold two active rows and it refuses. Both updates are predicated on the status they expect, which is also the concurrency control. |
| All-or-nothing replacement | Supersession and activation share one transaction. A failure leaves the incumbent active and the draft still a draft — never an incumbent superseded with nothing to replace it. |
| Draft to active | A version is validated before it becomes active. Nothing half-written is resolvable. |
| Effective time | A version applies from an instant. `resolve` at a past instant answers with what was in force then — **not** bounded by when a successor was published, which is a different and usually earlier instant. |
| Canonical instants | Every instant is validated against the real calendar and compared as a point in time, never as text. `2026-01-01T00:00:00Z`, `…T00:00:00.000Z` and `…T00:00:00.000000Z` are one moment for ordering, for the retroactive check, for resolution and for idempotency; `…T00:00:00.5Z` follows `…T00:00:00Z`. Impossible dates are refused rather than rolled forward into the following month. |
| Optimistic concurrency | A publication states the version it believes it is replacing. The second of two concurrent editors is refused, never silently applied. |
| Idempotent publication | A retry with the same idempotency key returns the original result **only when the whole logical request matches** — key, scope, value, effective time, origin and version id. Reusing a key for different content is a caller bug, not a duplicate delivery, and is refused: answering it would report success for a change that never happened. The effective time is matched as an instant, so a retry that spells one moment with a different precision is still a retry. |
| Retries outlive supersession | `publishDraft` on a version that was published and has since been replaced returns that publication's original result rather than a failure. A redelivery arriving after a third version took over is still a redelivery of work that succeeded. Nothing is written and the current incumbent is untouched. |
| Determinism | `now`, `versionId` and `idempotencyKey` come from the caller. This component reads no clock and generates no randomness. |
| Provider neutrality | Nothing here knows a model provider exists. No AI import, direct or transitive. |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-key` | An unregistered key has no schema, so nothing can say what a valid value is. |
| `invalid-value` | The value does not satisfy the key's declared schema, or an instant is not a real ISO-8601 UTC point in time — `2026-02-30T00:00:00Z` is refused rather than read as 2 March. |
| `scope-not-permitted` | The key does not declare that scope level. |
| `scope-escalation` | Authority at a narrower scope may not change a broader one. Broader authority acting narrowly is delegation and is allowed. |
| `retroactive-change` | An effective time in the past would rewrite what earlier decisions were made under, which no version history can undo. |
| `ambiguous-active-version` | Two versions effective at the same instant cannot be ordered, and two active versions for one key and scope cannot be resolved. |
| `concurrent-modification` | The active version is not the one the caller expected, the incumbent or draft changed status during the transaction, or a competing publication took the one active row first. The loser of a race keeps its draft and may retry against the new incumbent. |
| `idempotency-key-reuse` | The key was already used for different content. |
| `draft-not-found` | No such version to publish. |
| `not-a-draft` | A superseded version was named for a *new* activation. A retired version never becomes active again. Not raised for a retry of that version's own publication — see below. |
| `region-mismatch` | A region was supplied for a non-tenant request, or the supplied scope is not a region. |
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

`tenant` → `region` → `global`, most specific first, ending at global.

**A region is consulted only when the caller names it.** `resolve` accepts an explicit `region`
alongside a tenant scope; without one, the chain goes straight from tenant to global. This
component holds no tenant-to-region map, and inferring the relationship would mean either
inventing data or silently answering from a neighbouring region — both worse than answering from
global. Supplying a region for a non-tenant request is refused rather than ignored.
`scopeChain(scope, region?)` is exported and tested.

---

## 3. Persistence

An injected `ConfigurationRepository` port with two implementations:
`InMemoryConfigurationRepository` (the reference implementation, used by the tests) and
`PostgresConfigurationRepository`.

The port offers three mutations, and their shape is dictated by the index rather than by taste:

| Operation | Effect | Guard |
|---|---|---|
| `insertDraft` | appends a draft, which is outside the partial unique index | refuses a non-draft, a duplicate id, a reused idempotency key |
| `supersedeActiveVersion` | the incumbent leaves the index | conditional on it still being active |
| `activateDraft` | the replacement enters the index | conditional on it still being a draft |

The in-memory implementation enforces the same partial unique index the migration declares, and
enforces it **after every mutation** rather than at commit — PostgreSQL rejects the second active
row when the statement runs, so an ordering mistake must fail at the same point in both.

It also commits the way a database does. A transaction reads a snapshot taken on entry, so two
publications that overlap both find no active version and both correctly expect none; neither is
wrong about what it saw, and the service's own check cannot separate them. On commit only the rows
the transaction wrote are applied, and applying them is refused if those rows moved underneath it or
if the result would hold two active rows. An earlier revision swapped the whole working copy in,
which let the second commit overwrite the first and leave two active rows with no error raised
anywhere — a state the reference implementation must not be able to reach when the database it
stands in for cannot.

### Constraint violations are refusals, not driver errors

The adapter translates SQLSTATE 23505 on a named constraint into the refusal it actually means. A
raw driver error carries no code, appears in no table here, and tells an operator about an index
rather than about what happened:

| Constraint | Refusal |
|---|---|
| `config_version_one_active_per_scope` | `concurrent-modification` — another publication took the active row first |
| `config_version_idempotency_unique` | `idempotency-key-reuse` |
| `config_version_pkey` | `immutable-version` |

Anything else is rethrown untouched: an I/O failure dressed up as a race would be retried forever
by a caller that retries races. The platform client carries the SQLSTATE and constraint name across
its redaction boundary — neither contains a credential — so this decision is never made by matching
English error text.

The one-active-row violation is reported as a race rather than as an ordering mistake because the
database cannot tell the two apart. The service supersedes before activating on every path, so the
reachable cause in production is a competing transaction; the in-memory implementation *does*
distinguish them and reports an ordering mistake as `ambiguous-active-version` at the statement
that causes it.

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
- **Sub-millisecond precision survives only when the driver returns a string.** `timestamptz`
  holds microseconds; a JavaScript `Date` holds milliseconds. The adapter rebuilds a string result
  directly rather than parsing it, so microseconds are preserved on that path, but a driver
  configured to parse timestamps into `Date` objects has already discarded them before the adapter
  sees the value, and nothing here can recover it. Two versions whose effective times differ by less
  than a millisecond would then read back as the same instant. Untested against a live server, like
  everything else in this section.

---

## 6. Verification

```bash
npm run verify                                       # everything, including the tests below
npm run check:migrations                             # the FND-002a contract over db/migrations
node --test tests/configuration.test.ts              # service: lifecycle, concurrency, refusals
node --test tests/configuration-repository.test.ts   # port conformance, adapter, module contract
node --test tests/configuration-lifecycle.test.ts    # drafts, replacement ordering, idempotency
node --test tests/configuration-temporal.test.ts     # instants, races, retries after supersession
npm run test:integration                             # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
