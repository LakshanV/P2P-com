# K-07 Feature Flags — component contract

**Status:** foundation delivered (FND-004e). **Not complete.** No API, no UI, no console, no caller.
Nothing in this repository evaluates a flag, and nothing here has ever run against a PostgreSQL
server.

**Owner:** K-07 Feature Flags (`kernel/feature-flags/`).
**Authority:** v3 §36 (Feature Flags & Rollouts), v1.0 §94 (Feature Flag System).

---

## 1. What this component owns, and the five things it is not

K-07 answers exactly one question: **is this deployment currently running this piece of code, for
this subject, right now?**

That sentence is short, and everything about the design follows from what it excludes. A feature
flag is one `if` statement away from being an authorisation system — the code is identical, the
storage is identical — so the separations below are enforced rather than described:

| A flag is **not** | Why, and who decides instead |
|---|---|
| **a permission** | "May this party do this" is **K-04 Permissions**, decided from explicit grants against a published policy version, with deny precedence and an append-only revocation trail. A flag that gated authority would be an allow nobody granted, revocable only by a deploy |
| **an entitlement** | What a party has bought or been verified for belongs to the **Capability & Verification** module. A flag turning a paid feature on for 10% of accounts is a billing defect |
| **an experiment** | An A/B assignment must be stable, recorded and analysable against outcomes. That is **Analytics** (v3 §48). A rollout percentage is not a variant, and reading one as the other produces conclusions about a population nobody defined |
| **financial policy** | Fees, rates, hold periods and guarantee percentages are **K-06 / K-10**, versioned so that a historic transaction keeps the policy applied to it (v3 §35). A flag has no such semantics: it has no notion of the transaction it affected |
| **AI authority** | What an agent may decide is **K-04** plus v3 §38. A flag granting an agent a capability would be authority with no audit trail and no revocation |

**These are executable.** `registry.ts` refuses a flag key matching any of them — `assertFlagKey`
names the owning component in the refusal, because somebody reaching for `payout.commission.enabled`
has a real need and the useful answer is which component versions that decision. The same rule is a
`CHECK` in migration 0010 (`is_flag_key`), because the statement that matters is the one written
around the service. `tests/feature-flags.test.ts` asserts every case.

**What it also does not own:** the deployment itself, the code behind the flag, who is asking (it
takes an opaque subject key and hashes it — it never learns a subject id, an account or a name), and
the decision to stop something (an operator does that; this component records it).

---

## 2. Public contract

```ts
new FeatureFlagService({ repository, clock, configuration?, authority? })

publish(request): Promise<{ version, deduplicated }>
activate(request): Promise<{ activation, deduplicated }>
kill(request): Promise<{ event, deduplicated }>
retire(request): Promise<{ event, deduplicated }>
evaluate(request): Promise<Evaluation>
```

Five operations. Four write, and each write is **append-only**: there is no update, no delete, no
override, no "force on" and no bypass anywhere in the service, the port, the adapter or the schema.
`tests/feature-flags.test.ts` scans the whole surface for one.

`evaluate` **writes nothing**. That is a deliberate difference from K-04, which records a decision
per authorisation: a permission decision is rare and consequential, while a flag is evaluated on
every request through every guarded path, and a row per evaluation would be a write-amplification
defect wearing a compliance costume. What makes an evaluation accountable is that it is **pure and
reproducible** — see §5.

### Guarantees

| Guarantee | Meaning |
|---|---|
| **Fail closed, always** | Every uncertainty resolves to *disabled*: an unknown flag, a retired one, an unsupported scope, a rule naming an attribute the request did not supply, a percentage rollout with no subject key, a deployment stage that could not be resolved. A flag exists to stop code running, so an unknown answer must be the stopped one |
| **The kill switch outranks everything** | Checked **first**, before the active version is even read, so stopping a feature during an incident never depends on what any definition says — including a version published afterwards, which is refused outright |
| **The caller never states the answer** | `enabled`, `disabled`, `on`, `off`, `bucket`, `variant`, `allowed`, `role`, `price` and their neighbours are refused **by name** (`caller-asserted-outcome`). A caller that could say whether a flag is on *is* the flag |
| **The caller never states the author** | No mutation request carries an author. The identity written into every row comes from the injected administration authority (§3), which **defaults to refusing**. K-04 shipped with authorship as a request field and any caller could sign a change in somebody else's name (CURRENT_IMPLEMENTATION_STATUS §11.28) |
| **Immutable versioned definitions** | A version is never edited. A change is a new version with a higher number, numbered per flag key, and which version is *current* is a separate appended fact — so "what was this flag doing at 14:05" is answerable from rows that still exist |
| **Publishing is not activating** | A definition can be written and reviewed without being live for the moments in between. `publish` turns nothing on |
| **Guarded activation** | An activation names the version it supersedes. Two operators reacting to one incident cannot both win: the second is `stale-activation` and re-reads. Enforced in the service, in the reference repository **at commit**, and by two partial unique indexes in 0010 |
| **Bounded temporal activation** | `notBefore` / `notAfter`, both inclusive of the instant they name, honoured against the injected clock. A window containing no instant is refused at publication (`invalid-activation-window`) rather than published as a permanently-off flag that reads as scheduled |
| **Hierarchical supported scopes** | `global` → `country` → `category` → `account`. A version declares which levels it may be evaluated at; any other level is disabled with `unsupported-scope`, because a flag written per account and evaluated globally is a full rollout nobody chose |
| **Deterministic percentage rollout** | The bucket is `sha256(flagKey : rolloutSalt : subjectKey)` over 10 000 buckets — no clock, no randomness, no process state. Monotonic: raising a percentage never removes anybody. At 0% nobody is included; at 100% everybody is |
| **Allowlisted typed targeting** | Four registered attributes (`country`, `category`, `channel`, `cohort`), four predicate kinds, no negation. A rule over an unregistered attribute is refused at publication, because it would otherwise never match and a flag that never matches looks exactly like a rollout that has not started |
| **Exact idempotency** | Every mutation stores a SHA-256 fingerprint of the inputs it was decided from. An identical retry converges; a key reused for a different request is `idempotency-key-reuse` naming the field that moved |
| **Convergence after a lost race** | Two copies of one call that overlap converge on the row that landed, compared exactly as a retry is compared. A convergence checking less than a retry would be the same hole reached by another route |
| **No PII, no secrets** | Every identifier — flag version id, salt, subject key, scope id, rule value, context value — passes K-01's opacity rules. An email, a telephone number, a document number or a credential is refused (`natural-identifier`, `secret-bearing-input`) |
| **Explanations leak nothing** | An explanation names the flag, the version and what decided it. It never contains an attribute **value**, a subject key, a scope id or a configuration value — it is the thing most likely to be logged |

### Refusals

`malformed-identifier`, `natural-identifier`, `secret-bearing-input`, `caller-asserted-outcome`,
`not-a-feature-flag`, `unsupported-predicate`, `unsupported-scope`, `invalid-activation-window`,
`duplicate-flag-version`, `duplicate-activation`, `duplicate-lifecycle-event`,
`idempotency-key-reuse`, `stale-activation`, `no-such-flag-version`, `administration-refused`,
`flag-terminated`, `nested-transaction`, `immutable-history`, `malformed-record`.

---

## 3. The trust model, stated as assumptions

Three injected ports, each satisfied **structurally** — this component imports no implementation of
any of them, and `ports.ts` is the only file that names them.

| Port | Supplied by | Default | What the default costs |
|---|---|---|---|
| `Clock` | the caller | none — required | — |
| `ConfigurationLookup` | **K-05 Configuration**, through its public `resolve` | `NO_CONFIGURATION`, which resolves nothing | An `internal-only` flag is **off**, so an internal pilot cannot leak into production because nobody wired configuration up |
| `FlagAdministrator` | the deployment | `NO_ADMINISTRATION`, which refuses | Nothing may be published, activated, killed or retired. A flag service anybody reaching it could change is a switch on every guarded code path in the platform |

**The K-05 dependency is exactly one key**, `platform.deployment.stage`, and it is read only when the
active version is `internal-only`. v3 §36's "internal only" stage is a statement about the
*deployment*, not about the flag, so a definition that hardcoded which deployment is internal would
have to be republished to move between environments. K-07 imports nothing from K-05: the port has
the shape of `ConfigurationService.resolve`, and if K-05's resolution model changes, the compiler
says so. A stage that is absent, unrecognised, of the wrong type, or that K-05 refuses to resolve,
is `null` — never "probably internal".

**What K-07 assumes and does not check:** that the subject key it is handed is stable for one
subject (it checks the shape, not the provenance), that the deployment behind an authority is the
one it claims to be, and that the code behind a flag is actually deployed. Nothing here can verify
any of the three.

---

## 4. Ownership boundaries

| Question | Owner |
|---|---|
| May this party do this | **K-04 Permissions** |
| Who is this party | **K-01 Identity** / **K-03 Accounts** |
| Is this session valid | **K-02 Authentication** |
| What is this setting's current value | **K-05 Configuration** |
| What is this fee, rate or hold period | **K-06 Policy** / **K-10 Ledger foundation** |
| Who did what, recorded for later | **K-09 Audit Foundation** |
| Telling anybody a flag changed | **K-08 Event Infrastructure** |
| Which variant did this user see | Analytics (v3 §48) |

K-07 references **none** of them in its schema: no foreign key, no cross-schema statement, no
subject id, no account id, no policy version. A scope id is an opaque handle this component never
resolves. `tests/feature-flags-repository.test.ts` asserts it.

---

## 5. How an evaluation is made

`decide.ts` is pure. Given the active version, the lifecycle rows, the request and the resolved
stage, it returns the same answer on any machine, forever — which is what makes an incident
**replayable** rather than merely logged.

The precedence order is fixed, total, and the order itself is load-bearing:

1. **kill** — the emergency stop. Outranks every definition, including `on`.
2. **retire** — the orderly end of a flag's life.
3. **no active version** — nothing was ever activated, so there is nothing to run.
4. **scope** — the request named a level this version was not published for.
5. **window** — now is outside the bounded activation window.
6. **state** — and only now does the definition get a say: `off`, `on`, `internal-only`, `targeted`
   (a rule must match, and a rule naming an attribute the request did not supply is undecidable and
   therefore off), or `percentage` (bucket below the ceiling; no subject key means off).

Nothing later can re-enable what an earlier rule turned off. There is no override and no escape
hatch, because a kill switch a definition could argue with is not one.

---

## 6. Persistence and ownership

Schema `kernel_feature_flags`, created by `db/migrations/0010_create_kernel_feature_flags_schema.up.sql`
and reversed by `db/migrations/0010_create_kernel_feature_flags_schema.down.sql`. The schema name is
derived from the architecture manifest, not remembered.

| Table | Holds |
|---|---|
| `feature_flag_version` | Immutable numbered definitions |
| `feature_flag_activation` | The append-only activation **chain**; the current version is the row nothing supersedes |
| `feature_flag_lifecycle` | `kill` and `retire`, at most **one per flag key** |

Three triggers refuse `UPDATE` and `DELETE` on all three tables. Every instant is projected as UTC
text through `to_char`; nothing parses a driver `Date` (K-05 lost microseconds that way, §11.13).
Every row decoded from PostgreSQL runs the same validators the service runs, and a row that fails is
refused rather than evaluated.

`is_opaque_identifier` is K-07's own copy of the rule set K-01, K-02, K-03 and K-04 also carry. Five
copies exist because each schema must be independently creatable; all five are required to be
character-for-character identical by test.

**Module files:** `types.ts` (domain types and the error union), `registry.ts` (vocabularies and the
five separations), `immutable.ts` (the sealing boundary), `validate.ts` (one validator per record,
for requests and stored rows), `rollout.ts` (deterministic bucketing), `fingerprint.ts` (canonical
forms and SHA-256), `decide.ts` (the pure evaluator), `ports.ts` (the three injected ports),
`repository.ts` (the port and its in-memory reference), `postgres-repository.ts` (the adapter and
the enlisted composition), `service.ts` (the five operations), `outbox.ts` (event and audit
definitions for the transactional outbox), `index.ts` (the public surface).

---

## 7. What a record means

A **version** is what somebody decided a flag should do, and it is true forever: it is never edited,
so an evaluation from March can be replayed against the definition that was current in March.

An **activation** is when that decision took effect. It is a separate row because publishing and
deploying are separate acts, and because the transition — not the definition — is what an incident
review asks about.

A **kill** is an assertion that a feature must stop now, and it is **not reversible through this
component**. Restoring a killed feature means a new flag key. That is deliberate: an emergency stop
somebody can quietly lift is not an emergency stop.

An **evaluation** is not a record. It is a function of the rows above and the request, and it is
reproducible from them.

---

## 8. Deliberately deferred

- **No API and no UI.** No endpoint, no flag console, no rollout dashboard, no admin surface. A
  version is published by a caller with code access, which is not an operational answer. There is
  therefore also **no unauthenticated administrative surface**, because there is no surface.
- **No caller.** Nothing in this repository evaluates a flag. It is a capability, not an
  integration, and the enlisted path has no caller either.
- **No K-02 authentication and no K-04 authorisation behind administration.** The injected
  `FlagAdministrator` is the honest placeholder: it is injected rather than asserted and it refuses
  by default, but it identifies a *deployment capability*, not a person. The end state is an
  authenticated K-02 session and an explicit K-04 administration grant, which is a change to one
  method (`#administrator`) and nothing else. Until then, **who killed a flag is recorded as the
  authority that was injected**, not as a human being.
- **No audit trail (K-09).** A publication, an activation and a kill are exactly the actions v3 §53
  lists as auditable, and **none of them is recorded to K-09**. K-09 exists; wiring is separate work.
- **No events (K-08).** Killing a flag publishes nothing, so nothing can react to one — no cache
  invalidation, no alert, no dashboard. For a control whose entire purpose is to be used during an
  incident, this is the most conspicuous absence in the component.
- **No control plane.** No propagation, no caching, no client SDK, no polling, no push. Every
  evaluation reads the store, which is correct and will not be fast enough for a hot path.
- **No per-scope overrides.** A version applies to every level it supports; `scopeChain` exists and
  nothing resolves through it. "This flag is on in one country and at 10% in another" is not
  expressible, and pretending otherwise would need a second precedence axis nobody has designed.
- **No dependencies between flags**, no prerequisite flags, no flag groups.
- **No retirement of history** and no pruning.
- **No `variant` and no experiment support**, deliberately (§1).
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, every `CHECK`, all three append-only triggers, both partial unique indexes and every
  constraint are declared and **unproven**. `tests/integration/feature-flags.integration.ts` is the
  opt-in suite that would prove them, and it **skips** with a stated reason wherever no database is
  configured — which is everywhere so far. A skipped run is not evidence.

---

## 9. Verification

```bash
npm run verify                                        # everything, including the tests below
npm run check:migrations                              # the FND-002a contract over db/migrations
node --test tests/feature-flags.test.ts               # the boundary, the five separations, refusals
node --test tests/feature-flags-evaluation.test.ts    # precedence, kill switch, temporal, targeting
node --test tests/feature-flags-rollout.test.ts       # bucket boundaries, determinism, distribution
node --test tests/feature-flags-concurrency.test.ts   # idempotency, races, append-only history
node --test tests/feature-flags-repository.test.ts    # port conformance, adapter, migration, this contract
npm run test:integration                              # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and **a skipped run is not evidence of anything** — see the last entry in §8.
