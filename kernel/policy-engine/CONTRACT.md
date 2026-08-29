# K-06 Policy Engine — component contract

**Status:** foundation delivered (FND-005b). **Not complete.** No API, no UI, no policy studio, no
caller. Nothing in this repository evaluates a policy, and nothing here has ever run against a
PostgreSQL server.

**Owner:** K-06 Policy Engine (`kernel/policy-engine/`).
**Authority:** v3 §35 (Configuration-First Business Rules), §24 (Commission Rule Engine), §20
(Seller Payout & Risk), §38 (Financial Architecture), §50 (acceptance — "policy version retained").

---

## 1. What this component owns

K-06 answers: **what does business policy say about this situation, and which version said it?**

The second half is why the component exists. v3 §35 requires that *historic transactions retain the
policy version originally applied*; v3 §24 requires that *every transaction stores the exact
commission policy version applied at purchase time* and that *changing future policy must not
rewrite historical economics*. Those are promises a caller can only keep if the engine hands it
something to store — so **every successful evaluation returns a `policyVersionId`**, and there is no
code path that returns an answer without one.

Where it sits between its neighbours:

| Question | Component |
|---|---|
| What is the current value of one setting | **K-05 Configuration** — one key, one value, one version |
| What does policy say, given these facts | **K-06** — rules over facts, typed outputs, one version |
| Is this code path running | **K-07 Feature Flags** — a deployment control, never a business rule |
| May this party do this | **K-04 Permissions** — authority, from grants |
| What is this amount | **K-10 Ledger foundation** — K-06 returns the *rate*; it never multiplies |

That last row is a boundary, not a detail. K-06 hands back `1.7500` and the version that said so; it
does not compute a commission. A policy engine that did the arithmetic would be a second place money
is calculated, and v3 §38 wants exactly one.

**What it also does not own:** who may change policy (deferred, §9), what a seller or category *is*
(opaque handles it never resolves), and whether anybody is allowed to act on the answer.

`registry.ts` refuses a policy key naming authority, deployment state or credentials, with the
owning component named in the refusal — and migration 0011's `is_policy_key` refuses the same keys,
because the statement that matters is the one written around the service.

---

## 2. Public contract

```ts
new PolicyService({ repository, clock, configuration?, authority? })

draft(request): Promise<{ draft, deduplicated }>
publish(request): Promise<{ version, deduplicated }>
activate(request): Promise<{ activation, deduplicated }>
retire(request): Promise<{ retirement, deduplicated }>
evaluate(request): Promise<PolicyDecision>
```

Five operations. Four write, and each write is **append-only**: there is no update, no delete and no
override anywhere in the service, the port, the adapter or the schema. `tests/policy-engine.test.ts`
scans the whole surface for one, and for any method that sounds like it computes an amount.

`evaluate` **writes nothing**. K-06 sits on the path of every priced transaction, and a row per
evaluation would be a write there. What makes a decision accountable is that the caller stores the
`policyVersionId` in *its own* record — the ledger entry, the order — and that the version remains
readable forever.

### Guarantees

| Guarantee | Meaning |
|---|---|
| **Every answer is pinned** | `PolicyDecision.policyVersionId` and `.version` are never optional. When an output reads K-05, the configuration version id is pinned beside it in `configurationVersions` |
| **Immutable versioned definitions** | A version is never edited. A change is a new version with a higher number, numbered per policy key. v3 §24's "changing future policy must not rewrite historical economics" is that sentence expressed as a schema with no `UPDATE` path |
| **Explicit lifecycle** | draft → publish → activate → retire, each a separate append. A draft cannot be evaluated; publishing does not put anything in force; the publish request carries no rules, so what goes live is what was reviewed; retiring stops new evaluations without erasing the versions historic decisions are pinned to |
| **No floating point** | Rates, thresholds and amounts are `{ units, scale }` decimals carried as exact text end to end. Comparison goes through `BigInt`. `1234.56 * 0.175` is not `216.048` in a double, and money computed from an inexact rate is money nobody can reconcile |
| **Precedence by specificity, ties refused** | The matching rule binding the most scope dimensions wins. Two matching rules of equal specificity are `ambiguous-precedence` — refused, not resolved by row order, because the alternative makes a commission depend on a query plan |
| **Fail closed** | A fact a matching rule needs but the request omitted is `missing-fact`, never a fall-through to a less specific rule. No match and no declared defaults is `no-matching-rule`. A version outside its window is `version-not-effective`. Each is a refusal because the caller is about to write the answer into a financial record |
| **Defaults only where declared** | There is no built-in zero, no implicit false, no empty-string fallback. A policy that has not said what happens when nothing matches has not been asked yet |
| **Bounded effective windows** | `effectiveFrom` / `effectiveUntil`, both inclusive, against the injected clock. A window containing no instant is refused at publication rather than published as a version that reads as scheduled and can never apply |
| **The caller never states the answer** | `outputs`, `rate`, `commission`, `ruleId`, `total`, `allowed`, `enabled` and their neighbours are refused **by name**. On `evaluate` only, so are `policyVersionId`, `version` and `draftId`: naming the version you want to be decided by is choosing the economics of your own transaction |
| **The caller never states the author** | No mutation request carries an author. The identity comes from the injected authority, which **defaults to refusing** |
| **No AI author** | There is no `ai` origin kind in the component at all — absent from the type, not refused at the boundary. v3 §38 says AI must never be the financial authority, and the commission rate is that authority written down |
| **No executable policy** | Six literal predicate shapes, no arithmetic, no regular expressions, no functions. Depth and breadth are bounded (4 deep, 8 wide, 64 rules), because a condition nobody can hold in their head is one nobody can confirm |
| **Allowlisted facts** | Five registered facts, all from v3 §24's list. None describes a person: no name, no address, no payment instrument, no purchase history |
| **Exact idempotency** | Every mutation stores a SHA-256 fingerprint of its validated content. An identical retry converges — including one that differs only in key order or how a decimal was spelled — and a key reused with *any* authority-bearing input changed is refused |
| **Convergence after a lost race** | Two overlapping copies of one call converge on the row that landed, compared exactly as a retry is |
| **Guarded activation** | An activation names the version it supersedes. Two operators cannot both win. Enforced in the service, in the reference repository **at commit**, and by two partial unique indexes in 0011 |
| **No PII, no secrets** | Every identifier — ids, seller and category handles, rule values — passes K-01's opacity rules |
| **Explanations leak nothing** | An explanation names the policy, the version, the rule and the reason. It never contains a fact **value** |

### Refusals

`malformed-identifier`, `natural-identifier`, `secret-bearing-input`, `caller-asserted-outcome`,
`no-such-policy`, `no-such-version`, `missing-fact`, `ambiguous-precedence`, `no-matching-rule`,
`unsupported-predicate`, `unsupported-output`, `unsupported-scope`, `malformed-decimal`,
`lossy-numeric-value`, `unbounded-structure`, `invalid-effective-window`, `version-not-effective`,
`duplicate-draft`, `duplicate-policy-version`, `duplicate-activation`, `duplicate-retirement`,
`idempotency-key-reuse`, `stale-activation`, `authoring-refused`, `policy-retired`,
`nested-transaction`, `immutable-history`, `malformed-record`.

---

## 3. The trust model, stated as assumptions

Three injected ports, each satisfied **structurally** — this component imports no implementation of
any of them, and `ports.ts` is the only file that names them.

| Port | Supplied by | Default | What the default costs |
|---|---|---|---|
| `Clock` | the caller | none — required | — |
| `ConfigurationLookup` | **K-05 Configuration**, through its public `resolve` | `NO_CONFIGURATION`, which refuses | A policy declaring a `configured` output cannot be evaluated at all |
| `PolicyAuthority` | the deployment | `NO_AUTHORITY`, which refuses | Nothing may be drafted, published, activated or retired |

**The K-05 dependency exists because v3 §35's list spans two systems.** *Payout delay* varies by
category and milestone — a rule set, K-06. *AI confidence threshold* is one number — K-05. A policy
that could not reference the second would force operators to keep two copies of it and hope they
stay in step. So an output may be declared `configured`, and evaluation resolves it through K-05's
public contract. Two properties keep that from undermining reproducibility: the **configuration
version id is pinned into the decision**, and a key K-05 cannot resolve **refuses the evaluation** —
there is no default and no cached last value, because an unresolvable input to a financial decision
is a decision that should not be made. K-06 is asked for exactly one key per `configured` output,
and only when the version in force declares one.

**What K-06 assumes and does not check:** that the seller, category and country handles it is given
name the things the caller believes they name, and that the deployment behind an authority is the
one it claims to be. Neither is verifiable here.

---

## 4. Ownership boundaries

| Question | Owner |
|---|---|
| May this party do this | **K-04 Permissions** |
| Who is this party | **K-01 Identity** / **K-03 Accounts** |
| Is this session valid | **K-02 Authentication** |
| What is this setting's current value | **K-05 Configuration** |
| Is this code path running | **K-07 Feature Flags** |
| What is this amount | **K-10 Ledger foundation** |
| Who did what, recorded for later | **K-09 Audit Foundation** |
| Telling anybody policy changed | **K-08 Event Infrastructure** |
| Authoring and approving policy | M-43 Policy / Configuration Studio (does not exist) |

K-06 references **none** of them in its schema: no foreign key, no cross-schema statement, no
subject id, no account id. `tests/policy-engine-repository.test.ts` asserts it.

---

## 5. How an evaluation is made

`decide.ts` is pure. Given the version in force, the facts and the instant, it returns the same
answer on any machine, forever — which is what makes a historic decision **replayable** rather than
merely recorded, and `evaluate({ at })` is how a caller replays one.

1. **The effective window** — outside it, `version-not-effective`.
2. **Selector match** — a rule whose bound dimensions the facts contradict is out; one whose bound
   dimension the facts *omit* is undecidable, not out.
3. **Condition** — the same three-valued logic. An `all` settles on any definite false; an `any` on
   any definite true.
4. **Undecidable rules** — if any remain, `missing-fact`, naming the facts and never their values.
5. **Specificity** — the highest wins; a tie is `ambiguous-precedence`.
6. **Nothing matched** — the declared defaults, or `no-matching-rule`.

---

## 6. Persistence and ownership

Schema `kernel_policy_engine`, created by
`db/migrations/0011_create_kernel_policy_engine_schema.up.sql` and reversed by
`db/migrations/0011_create_kernel_policy_engine_schema.down.sql`. The outbox table is added by
`db/migrations/0014_create_kernel_policy_engine_outbox.up.sql` and reversed by
`db/migrations/0014_create_kernel_policy_engine_outbox.down.sql`. The schema name is derived from
the architecture manifest, not remembered.

| Table | Holds |
|---|---|
| `policy_draft` | Candidates. Immutable, never evaluated |
| `policy_version` | Immutable numbered versions — what a transaction pins |
| `policy_activation` | The append-only activation **chain**; the version in force is the row nothing supersedes |
| `policy_retirement` | The end of a policy key, at most one per key |
| `outbox` | Transactional outbox for policy lifecycle events and audit records, dispatched by a relay |

Four triggers refuse `UPDATE` and `DELETE` on all four tables. Every instant is projected as UTC
text through `to_char`; nothing parses a driver `Date` (K-05 lost microseconds that way, §11.13).
Every decimal lives inside `jsonb` in its exact `{ units, scale }` form — **there is no
`double precision` column in this schema and there never will be**. Every row decoded from
PostgreSQL runs the same validators the service runs, and a row that fails is refused rather than
evaluated: a malformed rule row that decoded cleanly would be a commission rate nobody authored.

`is_opaque_identifier` is K-06's own copy of the rule set K-01, K-02, K-03, K-04 and K-07 also
carry. Six copies exist because each schema must be independently creatable; all six are required to
be character-for-character identical by test.

**Module files:** `types.ts` (domain types and the error union), `decimal.ts` (exact decimals, no
floating point), `registry.ts` (vocabularies and the ownership refusals), `immutable.ts` (the
sealing boundary), `validate.ts` (one validator per record, for requests and stored rows),
`fingerprint.ts` (canonical forms and SHA-256), `decide.ts` (the pure evaluator), `ports.ts` (the
three injected ports), `repository.ts` (the port and its in-memory reference),
`postgres-repository.ts` (the adapter and the enlisted composition), `service.ts` (the five
operations), `outbox.ts` (event and audit definitions for the transactional outbox), `index.ts`
(the public surface).

---

## 7. What a record means

A **draft** is what somebody proposes. It is never evaluated, so no decision is taken against
something an author is still working on.

A **version** is what was decided, and it is true forever: never edited, so an evaluation from March
can be replayed against the definition that was in force in March.

An **activation** is when a version took effect. Separate from publication because reviewing and
switching over are separate acts, and because the transition is what an incident review asks about.

A **retirement** ends the policy. It does not remove the versions — a retired policy whose history
vanished would make every transaction it ever priced unexplainable.

A **decision** is not a record here. It is a function of the rows above and the facts, and the
caller stores its `policyVersionId` in the record the decision was *for*.

---

## 8. Deliberately deferred

- **No API and no UI.** No endpoint, no policy studio, no approval workflow, no diff view. A version
  is drafted by a caller with code access, which is not an operational answer. There is therefore
  also **no unauthenticated administrative surface**, because there is no surface. M-43 Policy /
  Configuration Studio is the module that will own authoring; it does not exist.
- **No caller.** Nothing in this repository evaluates a policy, so no amount anywhere has been
  priced by one, and no record has yet pinned a version id. It is a capability, not an integration.
- **No K-02 authentication and no K-04 authorisation behind authoring.** The injected
  `PolicyAuthority` is the honest placeholder: injected rather than asserted, refusing by default,
  but identifying a *deployment capability* rather than a person. The end state is an authenticated
  K-02 session and an explicit K-04 grant, which is a change to one method (`#author`). Until then,
  **who changed a commission rate is recorded as the authority that was injected**, not as a human.
- **No approval workflow.** v3 §32's "approval as required" for production changes is not modelled:
  a draft can be published by whoever can draft it. A second pair of eyes is exactly what the studio
  and the K-04 wiring are for.
- **Transactional outbox rows are written, but no consumers are wired.** Publish, activate and
  retire each append an event and an audit row to K-06's own outbox table inside the same transaction.
  A relay can dispatch those rows to K-08 Event Infrastructure and K-09 Audit Foundation, but no
  subscriber or reader depends on them yet.
- **No direct audit trail (K-09).** While audit rows are written to the outbox, nothing consumes them
  into K-09 yet.
- **No direct events (K-08).** While event rows are written to the outbox, nothing subscribes to them
  yet.
- **No simulation or diff.** There is no "what would this draft have charged last quarter" path,
  which is the single most useful thing a policy studio offers and the reason `evaluate({ at })`
  takes an instant.
- **No arithmetic.** K-06 returns rates; it never multiplies an order total by one. That is K-10.
- **No per-output scope resolution.** One version applies to every fact combination its rules cover;
  there is no per-scope layering as in K-05.
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, every `CHECK`, all four append-only triggers, both partial unique indexes and every
  constraint are declared and **unproven**. `tests/integration/policy-engine.integration.ts` is the
  opt-in suite that would prove them, and it **skips** with a stated reason wherever no database is
  configured — which is everywhere so far. A skipped run is not evidence.

---

## 9. Verification

```bash
npm run verify                                        # everything, including the tests below
npm run check:migrations                              # the FND-002a contract over db/migrations
node --test tests/policy-engine.test.ts               # the boundary, version pinning, refusals
node --test tests/policy-engine-evaluation.test.ts    # precedence, ambiguity, temporal, K-05
node --test tests/policy-engine-decimal.test.ts       # exact decimals and threshold boundaries
node --test tests/policy-engine-lifecycle.test.ts     # draft→publish→activate→retire, races
node --test tests/policy-engine-outbox.test.ts        # outbox append and relay dispatch
node --test tests/policy-engine-repository.test.ts    # port conformance, adapter, migration, this contract
npm run test:integration                              # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and **a skipped run is not evidence of anything** — see the last entry in §8.
