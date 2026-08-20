# K-04 Permissions — contract

**Status:** foundation delivered by FND-004d. **Not complete** — see §9.
**Owner:** K-04, `kernel/permissions/`.
**Schema:** `kernel_permissions`, created by
[`0009_create_kernel_permissions_schema.up.sql`](../../db/migrations/0009_create_kernel_permissions_schema.up.sql).
**Depends on:** K-02 Authentication and K-03 Accounts, each through an injected port and nothing
else (§3); K-01 Identity's identifier rules, re-raised in this component's vocabulary.

---

## 1. What this component owns

One question: **may this authenticated subject take this action on this resource, in this account,
right now?**

It answers `deny` unless something explicitly says otherwise, and **it never asks the caller**. The
subject comes from a session K-02 validated, the account from K-03's public contract, and the
authority from grants this component stored itself.

Four record types, all **append-only**, because authority history is evidence.

| Record | What it is | Lifecycle |
|---|---|---|
| **Policy version** | An immutable, numbered snapshot of the role vocabulary and what each role may do | Append-only. A change is a new version, never an edit |
| **Grant** | One explicit `allow` or `deny`, scoped to an account, a resource and an action, optionally conditioned and optionally purpose-limited | Append-only. Withdrawn by appending a revocation |
| **Revocation** | A grant withdrawn: when, why, and by whom. One per grant | Append-only, and final |
| **Decision** | What was decided, for whom, on what, and **why** | Append-only |

### What it does not own, and who does

A request carrying any of these is **refused by name**. Silently dropping one would leave the caller
believing it had claimed something.

| Concern | Owner |
|---|---|
| Whether the request is authorised, and what the effect is | **This component.** A caller that could state it is not being authorised |
| Who is asking | **K-02 Authentication**, through a validated session. A caller that could name the subject could authorise itself as anybody |
| Which account the subject holds | **K-03 Accounts**, through its public contract |
| What kind of party a subject is | **K-01 Identity** |
| Credentials, sessions, MFA | **K-02 Authentication** |
| Capability activation, verification level | Capability & Verification module |
| Every monetary amount | **K-10 Ledger foundation** |
| Who did what, recorded for later | **K-09 Audit Foundation** |
| Telling anybody a decision happened | **K-08 Event Infrastructure** |

The executable versions are `ASSERTED_AUTHORIZATION_FIELDS` and `FOREIGN_FIELDS` in `registry.ts`,
and `tests/permissions.test.ts` asserts every entry explains itself rather than carrying a label.

---

## 2. Public contract

```ts
new PermissionService({ repository, sessions, accounts, clock })

publishPolicy(request): Promise<{ policy, deduplicated }>
grant(request): Promise<{ grant, deduplicated }>
revoke(request): Promise<Revocation>
authorize(request): Promise<{ decision, deduplicated }>
findGrant(grantId) / findDecision(decisionId) / activePolicy()
```

Seven operations, three of which are reads. There is no update, no delete, no super-user path, no
"force allow" and no bypass; `tests/permissions.test.ts` scans the whole surface for one.

### Guarantees

| Guarantee | Meaning |
|---|---|
| **Deny by default** | The answer is `deny` before anything is examined. Only an explicit, in-force, policy-permitted grant moves it, and any later check may move it back |
| **The caller never states the outcome** | `allowed`, `effect`, `decision`, `subjectId`, `role`, `permissions`, `purposeSatisfied`, `bypass`, `superAdmin`, `policyVersionId` and their neighbours are refused by name (`caller-asserted-authorization`) |
| **The subject comes from a validated session** | Resolved through K-02's port and then **re-checked here**: revoked, past its absolute expiry, past its idle expiry, or carrying an unrecognised assurance are all refused. Deny-by-default means not assuming somebody else's check ran |
| **Account isolation** | The account in the request must be the one the session's subject holds. Anything else is `cross-account-access` **before any grant is read**, because reading another account's grants is already the wrong shape |
| **Deny precedence** | If any applicable grant denies, the answer is `deny` — whatever else allows, however specific. There is no scoring, no specificity rule and no most-recent-wins, because each is a way for an allow to beat a deny by accident |
| **Least privilege** | Expressed by what a grant omits: a `resourceId` scopes to one resource, its absence to the type *inside one account*. There is no grant shape covering every account |
| **Temporal validity** | `notBefore` and `expiresAt` are honoured on every decision, against the injected clock |
| **Revocation history** | A grant is never edited or deleted. Withdrawal appends a revocation with a time and a reason, and a second one is refused rather than allowed to rewrite when authority ended |
| **Purpose limitation** | A staff role must declare a purpose from a closed vocabulary, and it must be the purpose the grant names. Enforced in the service, in the record validator and by a database `CHECK` |
| **Typed ABAC** | Conditions are one of six predicate kinds over an **allowlisted** context. A predicate over an undeclared attribute is refused when the grant is written, because it would otherwise never match and the grant would silently never apply |
| **Deterministic explanations** | The same inputs produce the same decision *and the same words*. Ties break by grant id. A decision nobody can reproduce is one nobody can appeal |
| **Exact idempotency** | A retry under the same key returns the decision that was taken — but only after its session is validated, and only when a stored SHA-256 over every authoritative input, the ABAC context included, matches exactly (§8). A key reused for a different question, session or context is refused |
| **Concurrency safety** | Uniqueness is enforced at commit against the store as it stands, in the reference repository and by constraints in PostgreSQL. Two identical grants racing produce one grant; two revocations produce one revocation |
| **Immutability at every boundary** | Every record crossing a boundary is deep-frozen, including nested condition trees and capability lists |
| **Determinism** | Identifiers, keys and context come from the caller; time from an injected `Clock`. This component reads no wall clock and generates no randomness |
| **Transaction composition** | `PostgresPermissionRepository.enlist(client)` writes inside a transaction the caller already owns, and may not issue transaction control |

### Refusals

Every code in `PermissionErrorCode`, and why it exists.

| Code | Refused because |
|---|---|
| `unknown-subject` | The session asserts a subject that is not a well-formed opaque handle |
| `unknown-account` | The subject holds no K-03 universal account, so there is nothing to scope authority to |
| `invalid-session` | The session was refused by the port, is revoked, is past an expiry, or asserts an assurance this component does not recognise |
| `cross-account-access` | The request names an account the session's subject does not hold |
| `missing-purpose` | A staff role acted, or was granted authority, without declaring a purpose |
| `mismatched-purpose` | The declared purpose is not a declared one, or not the one the grant permits |
| `unsupported-action` | The action is not registered, or an `allow` would exceed the policy version it is made under |
| `unsupported-resource` | The resource type is not registered |
| `unsupported-role` | The role is not in the vocabulary |
| `unsupported-predicate` | The predicate names an unknown kind, an undeclared context attribute, or an empty branch |
| `caller-asserted-authorization` | The request stated an outcome, an identity, a role, a purpose satisfaction or a policy version |
| `foreign-concern` | The request carried a field owned by K-01, K-02, K-03 or another component — or one this component does not recognise at all |
| `ai-not-permitted` | AI tried to author policy or a grant, or to hold authority it may never hold (§6) |
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier or context value looks like an email, telephone number, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier or context value names or looks like a credential |
| `malformed-instant` | An instant is not a real UTC instant, or the injected clock returned something that is not one |
| `idempotency-key-reuse` | The key was already used for different logical content, or for a different question |
| `stale-revocation` | The grant has already been revoked, and the first revocation is when authority ended |
| `no-such-grant` | Nothing to revoke |
| `no-such-policy` | No policy version has been published, so nothing permits anything |
| `duplicate-grant` | A grant with this id already exists, and a grant is never rewritten |
| `duplicate-policy-version` | That version number is taken. Numbers order authority history |
| `nested-transaction` | An enlisted write tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT` |
| `immutable-history` | Reserved for a write that would rewrite authority history. **Not currently raised**: there is no such path in the service, the port or the adapter, and the database refuses one by trigger — the code exists so the refusal has a name if a path is ever added |
| `malformed-record` | A stored row, or a candidate record, is not what this component writes |

---

## 3. The trust model

Three ports, and each exists because the alternative is that K-04 believes its caller.

```ts
interface SessionValidator { validate(presentedToken): Promise<SessionAssertion> }
interface AccountLookup { findAccountForSubject(subjectId): Promise<AccountAssertion | null> }
interface Clock { now(): string }
```

**The session port is the identity boundary.** K-02's `AuthenticationService.validate` satisfies it
structurally — no adapter, no translation layer — and `tests/permissions.test.ts` wires the real
K-01, K-02 and K-03 services together to prove it. The port is deliberately provider-neutral: it
names no K-02 type and imports nothing from K-02, so a different authentication component could
satisfy it.

**What the port asserts is checked, not believed.** A validator that returns a revoked or expired
session is refused. This is not distrust of K-02; it is what deny-by-default means when the thing
being decided is access.

**A validator that throws is normalised without being inspected.** Its message is not read, not
interpolated and not re-raised — a session error can carry a fragment of the presented secret, and
this component has no business repeating one.

**The account port is the isolation boundary.** Authority is scoped to a K-03 account, so a caller
naming an account its session's subject does not hold is refused before any grant is read.

Assumptions, stated as assumptions because K-04 cannot verify them:

| Assumed | If it is false |
|---|---|
| The session validator is the authority on who holds a session | K-04 authorises whoever the validator names. It checks the assertion's own claims and cannot check the claim of identity itself |
| The account lookup returns the account the subject actually holds | Authority is scoped to the wrong account, and isolation fails silently |
| The injected clock is correct | Every validity window and expiry is relative to it |
| Nothing hostile can write to `kernel_permissions` | The triggers refuse UPDATE and DELETE, but nothing stops an INSERT by a party with write access. A grant inserted around this component is authority nobody granted, which is why decoding is fail-closed |
| The caller enforces the answer | K-04 decides; it does not intercept. A caller that ignores a `deny` is not stopped by anything here |

---

## 4. Roles, and why none of them means anything by itself

The vocabulary is the v1.0 guide §52 list, in its declared order: `CUSTOMER`, `SUPPLIER`,
`SERVICE_PROVIDER`, `DRIVER`, `STAFF`, `OPERATIONS`, `FINANCE`, `SUPPORT`, `MANAGER`, `ADMIN`,
`SUPER_ADMIN`, `AI_AGENT`.

**There is no role-to-authority mapping anywhere in this component's code.** What a role may do
lives in a published policy version, which is data, is numbered, and is auditable. A hardcoded map
would make the permission matrix unversioned and unreviewable, and would mean a change to what
`FINANCE` can do was a code deploy rather than a recorded decision.

**`SUPER_ADMIN` confers nothing.** It is in the list because the guide lists it. It has no implicit
authority, no bypass and no special case: it needs a grant like every other role, and that grant
cannot exceed the policy version it was made under. There is no code path in this component that
checks for it.

The one property attached to a role rather than to a grant is **staff-ness**: `STAFF`,
`OPERATIONS`, `FINANCE`, `SUPPORT`, `MANAGER`, `ADMIN` and `SUPER_ADMIN` act on somebody else's
data, so v3 §5.3's "role-based, purpose-based and audited" applies. A grant to one of them without
a purpose is refused; a grant to a non-staff role *with* one is refused too, because a purpose
recorded where none is enforced reads as a control that is not there.

---

## 5. How a decision is made

Fixed order, in `decide.ts`, which is pure and takes no repository:

1. **Deny.** That is the answer until something changes it.
2. **Filter to grants that address the request** — right subject, right account, right action, right
   resource. Nothing else is evidence about this request.
3. **Discard what is not in force**: revoked, outside its validity window, or naming a capability
   the active policy version does not give that role.
4. **Purpose limitation** for staff roles.
5. **Condition**, evaluated against the presented context and the session's assurance. An attribute
   the caller did not supply makes the predicate false — deny-by-default, one level down.
6. **Deny precedence.** Any surviving deny wins.
7. Otherwise, a surviving allow wins. Otherwise the denial reports the most actionable failure and
   names the grant that would have applied.

The decision record carries the machine-readable `reason`, a human `explanation`, the deciding grant
(or `null`), the policy version, the session id and the purpose. An `allow` always names a grant —
the database refuses one that does not, because an authorisation nobody can trace to a decision
somebody made is not auditable.

---

## 6. AI has no authority here

Three separate checks, because they fail for three different reasons:

- **AI may not author authority.** `origin.kind: 'ai'` is refused on a policy version, a grant and a
  revocation, by the service and by a database `CHECK`.
- **AI may never hold a forbidden action or resource.** `grant-permission`, `approve`,
  `impersonate`, `delete` and `export`; `permission`, `ledger-entry` and `payment`. v3 §38 —
  AI is never the financial authority — and authority over authority is the same argument.
- **AI may hold only `invoke-tool` on `tool`.** Stated positively as well as negatively on purpose:
  an action added to the registry later is denied to `AI_AGENT` by this rule even if nobody
  remembers to add it to the negative list.

A published policy version that tries to widen `AI_AGENT` beyond tool capabilities is refused at
publication, and the database `CHECK` refuses the grant row independently.

---

## 7. Persistence and ownership

An injected `PermissionRepository` port with three implementations:
`InMemoryPermissionRepository` (the reference implementation, which enforces the same uniqueness the
database does, **at commit against the store as it stands**), `PostgresPermissionRepository`, and
`EnlistedPermissionRepository` for a caller that already owns a transaction.

K-04 owns exactly one schema, `kernel_permissions`, derived from the architecture manifest. **No
statement it issues names another unit's schema, and there is no foreign key out of it** —
`subject_id` and `account_id` are K-01's and K-03's handles, checked through their public contracts
at write time, not joined to. The cost is stated rather than glossed: **there is no database-level
guarantee that a `subject_id` or `account_id` names anything real.** A row inserted around this
component can name anything the opacity rules accept.

`is_opaque_identifier` is a character-for-character copy of K-01's, K-02's and K-03's, because a
`CHECK` calling another schema's function would be exactly the coupling refused above. All four
bodies are compared by `tests/permissions-repository.test.ts`.

Every instant is projected as UTC text through `to_char`, never left to the driver's `Date` parser.
Decoding is fail-closed and runs the **same validators the service runs**, so a row written around
the adapter is refused rather than decided upon.

---

## 8. What a decision record means

It is a record of a **decision that was taken**, not a cache of what the answer would be now. A
retry under the same idempotency key returns the recorded decision even if the underlying grant has
since been revoked — because re-deciding would let a caller retry until the answer changed, and
because the record is the evidence of what was permitted at that moment.

A caller that wants the *current* answer asks a new question with a new key. The two are different
questions and the API makes them look different.

**An idempotency key is not a bearer token for an answer.** Two rules make that true, and both were
added as a correction after the first revision got them wrong:

1. **The session is validated before anything is read from storage.** A retry resolves its subject
   through K-02's port and its account through K-03's, and is refused for a bad session or a
   mismatched account *before* the key is looked up at all. The first revision looked the key up
   first, which meant presenting somebody else's key with any garbage token returned their `allow`
   without the caller ever holding a session.
2. **Every decision stores a SHA-256 over all of its authoritative inputs** — decision id, subject,
   **session**, account, action, resource type and id, purpose, and the **allowlisted ABAC
   context**, in a canonical form (`fingerprint.ts`). A stored decision is returned only when the
   retry's fingerprint matches it exactly. The context is in there because it is not a column: a
   grant conditioned on one region could otherwise be satisfied once and replayed from anywhere.

Two consequences worth stating, because both are deliberate:

- **Idempotency keys are scoped to the session that earned the answer.** The same person on a
  rotated session is asking a new question and gets a new decision rather than the old one.
- **Anything short of a complete match is refused, not answered** — `idempotency-key-reuse`, naming
  the input that moved. The same comparison runs on the post-conflict convergence path, because a
  convergence that checked less than a retry checks would be the same hole reached by another route.

The equality checks on policy versions, grants and revocations follow the same rule: every
caller-supplied authority-bearing field is compared, **including the author** (`publishedBy`,
`grantedBy`, `revokedBy`). Only the service-generated instants (`publishedAt`, `grantedAt`,
`revokedAt`) are excluded, because including them would make every retry a mismatch and idempotency
impossible.

Decision records are append-only and are never pruned by this component. Retention is undelivered
work (§9), and until it exists the table grows without bound — stated here because a growing table
is an operational fact somebody should learn from a contract rather than from a disk alert.

---

## 9. Deliberately deferred

- **No API and no UI.** No endpoint, no policy studio, no role-matrix screen, no admin surface. A
  policy version is published by a caller with code access, which is not an operational answer.
- **No caller.** Nothing in this repository calls `authorize`. It is a capability, not an
  integration, and the enlisted path has no caller either.
- **No real verifier behind K-02.** K-02 ships **no verifier**, so no real person can authenticate,
  so no real session reaches K-04. Every decision so far is about a subject a test created.
- **No audit trail (K-09).** A permission decision, a grant and a revocation are exactly the actions
  v3 §53 lists as auditable, and **none of them is recorded to K-09**. K-09 exists; wiring is
  separate work.
- **No events (K-08).** A grant or revocation publishes nothing, so nothing can react to one.
- **No business-module actions.** The registered action and resource vocabularies are the kernel's
  own. There is no mechanism for a module to register its own, and inventing one before a module
  exists would be guessing.
- **No operational role matrix.** v3 §47 Level 4 requires a permission matrix before release. The
  vocabulary and the policy structure make one derivable; nobody has derived or reviewed one.
- **No delegation, no groups, no role hierarchy, no inheritance.** Each is a real need and each
  makes "who could do this" harder to answer; none is implemented rather than half-implemented.
- **No retention or pruning** of decision records (§8).
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, every `CHECK`, all four append-only triggers and every constraint are declared and
  **unproven**. `tests/integration/permissions.integration.ts` is the opt-in suite that would prove
  them, and it **skips** with a stated reason wherever no database is configured — which is
  everywhere so far. A skipped run is not evidence.

---

## 10. Verification

```bash
npm run verify                                     # everything, including the tests below
npm run check:migrations                           # the FND-002a contract over db/migrations
node --test tests/permissions.test.ts              # the trust boundary, refusals, AI limits
node --test tests/permissions-decisions.test.ts    # RBAC, ABAC, deny precedence, purpose, isolation
node --test tests/permissions-concurrency.test.ts  # races, idempotency, append-only history
node --test tests/permissions-idempotency.test.ts  # stolen keys, changed context, changed session, authors
node --test tests/permissions-repository.test.ts   # port conformance, adapter, migration, this contract
npm run test:integration                           # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and **a skipped run is not evidence of anything** — see the last entry in §9.
