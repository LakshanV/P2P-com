# K-02 Authentication — contract

**Status:** foundation delivered by FND-004c. **Not complete** — see §8.
**Owner:** K-02, `kernel/authentication/`.
**Schema:** `kernel_authentication`, created by
[`0008_create_kernel_authentication_schema.up.sql`](../../db/migrations/0008_create_kernel_authentication_schema.up.sql).
**Depends on:** K-01 Identity, through an injected lookup and nothing else (§3); a `Verifier`, a
`Clock` and an `EntropySource`, all injected and none shipped with a real implementation (§3, §8).

---

## 1. What this component owns

One question: **is the party making this request the K-01 subject it claims to be, and how strongly
do we know that?** It answers by *asking a verifier*, never by believing a caller.

Three record types, and the split is the design.

| Record | What it is | Lifecycle |
|---|---|---|
| **Binding** | An opaque link between a K-01 subject and the `(provider, providerReference)` pair a verifier knows it by. Carries **no secret**: no password hash, no key, no recovery code | Append-only. No update, no delete |
| **Evidence** | A write-once record of one successful authentication: which verifier, which factor categories, what assurance, when it verified and when this platform recorded it | Append-only. No update, no delete |
| **Session** | A short-lived bearer of that authentication, with an absolute and an idle expiry. Holds a SHA-256 of a secret it never stores | Two changes, both guarded: rotate the secret, or revoke |

The session is the only thing here with a lifecycle, and it is deliberately tiny. There is no
general session update, because a general update is how a session acquires a longer absolute
expiry.

### What it does not own, and who does

A request carrying any of these is **refused by name**. Silently dropping one would leave the caller
believing it had set something.

| Concern | Owner |
|---|---|
| Whether authentication succeeded, which factors were checked, what assurance was reached | **The verifier.** A caller that could state these is not being authenticated; it is being formatted |
| Passwords, keys, one-time codes, biometric templates — any raw proof | **The provider's verifier.** K-02 hands proof over and drops it; it never holds, stores or logs one |
| The session secret a caller would like to have | **Nobody but this component.** It is generated here from the injected entropy source |
| What kind of party a subject is | **K-01 Identity** |
| The universal account | **K-03 Accounts** |
| Roles, grants, permission evaluation | **K-04 Permissions.** Authentication is not authorisation |
| Capability activation, verification level | Capability & Verification module |
| Name, email, phone, address, IP address, user agent | A profile core, and device telemetry this component does not collect. Personal data has no home here |
| Who did what, recorded for later | **K-09 Audit Foundation** |
| Telling anybody a sign-in happened | **K-08 Event Infrastructure** |

The executable versions are `ASSERTED_AUTHENTICATION_FIELDS` and `FOREIGN_FIELDS` in `registry.ts`.
`tests/authentication.test.ts` asserts every entry explains itself rather than carrying a label.

---

## 2. Public contract

```ts
new AuthenticationService({ repository, providers, verifiers, subjects, clock, entropy, sessionPolicy? })

bind(request): Promise<{ binding, deduplicated }>
authenticate(request): Promise<{ session, evidence, token, deduplicated }>
validate(presentedToken): Promise<AuthenticationSession>
rotate(request): Promise<{ session, token }>
revoke(request): Promise<AuthenticationSession>
findSession(sessionId): Promise<AuthenticationSession | null>
bindingsForSubject(subjectId): Promise<readonly AuthenticationBinding[]>
```

Seven operations. There is no password check, no credential store, no "sign in as", no impersonation
path, no bypass and no delete; `tests/authentication.test.ts` scans the whole surface for one.

### Guarantees

| Guarantee | Meaning |
|---|---|
| The caller never states the outcome | `authenticated`, `verified`, `factors`, `assurance`, `assertion`, `skipVerification` and their neighbours are refused by name (`caller-asserted-authentication`) |
| The verifier's answer is checked | Provider and reference must match what was asked, the assertion must not be expired **by this platform's clock**, and its shape is validated before a byte is written |
| An assertion authenticates exactly once | `UNIQUE (provider, assertion_id)` on evidence. A repository constraint rather than a read-then-write, because two replays can both pass a read |
| No secret is stored | Sessions hold a SHA-256 hex digest. The secret is generated here, returned once, and never written, logged or echoed — §5 |
| A caller cannot choose a session secret | The entropy source is injected and its output is shape-checked; `sessionToken`, `token` and `tokenHash` on a request are refused |
| Evidence and session commit together | One transaction. Evidence without a session consumes an assertion and hands back nothing; a session without evidence is a session nobody can account for |
| Evidence and session agree | Both records carry the assurance and the factor categories, and both copies must match — with the chronology — before either convergence path may return them (§7) |
| Absolute expiry is never extended | Rotation moves the idle expiry only, capped at the absolute one. Enforced in the service, in the port (`rotateSession` has no field for it), and by trigger in the database |
| Validation is read-only | `validate` does not extend the idle window. "Idle" here means "not rotated", not "not read"; a validation that wrote would make every read a write |
| Guarded lifecycle changes | Rotation carries the hash it expects; revocation carries "not already revoked". A stale caller loses rather than overwriting the winner — §6 |
| Exact idempotency, and no second secret | A retry under the same key returns the original session and evidence **only on a complete match**, and hands back a token that has already been spent — §7 |
| Opaque identifiers | K-01's rule set, re-raised in K-02's vocabulary. An identifier that looks like an email, telephone number, document number, IBAN, URL, domain or personal name is refused, at creation and on every row read back |
| Determinism | Identifiers, idempotency keys and proof come from the caller; time from an injected `Clock`; secrets from an injected `EntropySource`. This component reads no wall clock and calls no RNG directly |
| Immutability at every boundary | Every binding, evidence record and session crossing a boundary is deep-frozen and severed from the caller's objects by a single seal, including the `factors` array |
| Transaction composition | `PostgresAuthenticationRepository.enlist(client)` writes inside a transaction the caller already owns — §8 |

### Refusals

Every code in `AuthenticationErrorCode`, and why it exists.

| Code | Refused because |
|---|---|
| `unknown-subject` | The binding names a subject K-01 does not have. Issuing a session would authenticate a party that does not exist |
| `unknown-provider` | The provider is not registered, is registered twice, is misnamed, or has no verifier wired. None of those may mean "skip verification" |
| `unknown-binding` | Nothing links that handle to a subject, so a successful proof would authenticate nobody in particular |
| `duplicate-binding` | A binding already exists for that `(provider, reference)`. One reference authenticates one subject, or two parties share a login |
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier names or looks like a credential |
| `malformed-instant` | An instant is not a real UTC instant, or the injected clock returned something that is not one |
| `caller-asserted-authentication` | The request tried to state an authentication outcome. See §1 |
| `foreign-concern` | The request carried a field owned by K-01, K-03, K-04, a profile or a financial module — or a field this component does not recognise at all |
| `ai-not-permitted` | Reserved, and **not currently raised**: no path here accepts an authored origin. It is declared so that an AI-authored authentication decision has a refusal waiting rather than an argument about one |
| `invalid-assertion` | The verifier refused (its reason is deliberately not repeated), or answered about a different provider or reference, or returned something that is not an assertion |
| `assertion-replayed` | That verifier assertion has already been consumed — whether the second presentation is an attack or a confused client |
| `assertion-expired` | The assertion is past its own expiry, judged by this platform's clock so a verifier with a slow clock cannot extend its own assertions |
| `insufficient-factors` | The confirmed factor **categories** do not meet the provider's policy, or a policy itself is nonsensical or weaker than the platform floor — §4 |
| `invalid-token` | The presented secret matches no live session, is not the shape this component issues, or a one-time token was read twice. One refusal for "no such session" and "wrong secret", deliberately |
| `session-expired` | The absolute or the idle expiry has passed |
| `session-revoked` | The session was revoked, with the instant and the reason |
| `stale-session-state` | A rotation or revocation lost a race, or a whole transaction's guarded update lost at commit. The loser is told, and never applied over the winner — §6 |
| `insufficient-entropy` | The entropy source produced an unusable secret, or two sessions produced the same token hash |
| `idempotency-key-reuse` | The key was already used for a *different* logical authentication or binding. Returning the earlier one would hand back a session for something the caller did not ask for |
| `no-such-session` | Nothing to read |
| `nested-transaction` | An enlisted write tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. The transaction belongs to the caller |
| `malformed-record` | A stored row, or a candidate record, is not what this component writes — including a session policy that could never apply |

---

## 3. The verifier trust boundary, and the K-01 dependency

**The `Verifier` port is the security boundary of the whole component.** Everything else here is
bookkeeping around it.

```ts
interface Verifier {
  readonly provider: string;
  verify(challenge: { provider, providerReference, proof }): Promise<VerifierAssertion>;
}
```

K-02 does not decide whether a proof is good, because deciding would mean holding the proof. It
hands `proof` over untouched — typed `unknown` so that no code here is invited to inspect it — and
then checks the answer against what was asked. A verifier that throws has refused: the thrown value
is not inspected, interpolated or re-raised, because a provider's error object is exactly the sort
of thing that carries a fragment of the proof in its message.

**No verifier ships in this slice.** No password checking, no OAuth or OIDC SDK, no passkey or
WebAuthn library, no TOTP implementation, no email or SMS delivery. `refusingVerifier(provider)` is
the honest default and refuses everything, because a missing verifier must not mean "skip
verification" — it means nobody can authenticate through that provider. **Nothing here can
currently authenticate a real person**, and §8 says so without hedging.

What K-02 checks about an assertion, and what it cannot: it can prove the assertion names the
provider and reference that were asked for, is within its own expiry, and has never been used
before. It cannot detect a verifier that lies about having checked anything. A wired verifier is
trusted to be the authority for its own provider — that is the boundary, and §9 states it as an
assumption rather than a guarantee.

The K-01 dependency is one question, asked through K-01's public contract:

```ts
interface SubjectLookup {
  exists(subjectId: string): Promise<boolean>;
}
```

`IdentityService` satisfies it structurally, exactly as it does for K-03, and
`tests/authentication.test.ts` wires the real K-01 service to prove it. `NO_SUBJECTS` is the
fail-closed default: a caller with no identity component wired authenticates nobody. **There is no
foreign key from `kernel_authentication` into `kernel_identity` and no SQL of K-02's names another
unit's schema** — the same decision K-03 §5 records, for the same ownership reason, with the same
cost stated plainly: nothing at the database level guarantees that `subject_id` names a real
subject.

---

## 4. Factors, assurance, and the MFA policy

Factor **categories**, never mechanisms: `knowledge`, `possession`, `inherence`. A password is
knowledge, a passkey or TOTP code is possession, a fingerprint is inherence, and K-02 never learns
which — knowing would mean holding something about how the proof works.

Categories rather than mechanisms is also what makes "multi-factor" mean anything: two passwords are
not two factors; two *categories* are. `satisfiesPolicy` counts `new Set(factors).size`, and a
duplicated category is refused outright on decode rather than collapsed silently.

Assurance is ordered, weakest first: `single-factor` → `multi-factor` → `hardware-backed`.
`ASSURANCE_RANK` is exported so a caller can compare without reimplementing the order.

The policy is a floor:

- `DEFAULT_MFA_POLICY` is one category at `single-factor`. Deliberately weak — this slice ships no
  provider, so a floor tuned for a provider that does not exist would be a guess. What matters is
  that the floor is configurable, enforced, and **can only be raised**.
- A provider entry may raise it and **may never lower it**. `ProviderRegistry` refuses a weaker
  entry at construction rather than at authentication time, because a registry that could lower the
  floor would make the floor advisory, and the first integration under deadline pressure is where it
  would be lowered.
- Factors are stored **canonically**: sorted and frozen by one seal, so two equal sets compare
  equal. Evidence and session each carry a copy, and §7 requires the two to agree.

---

## 5. The session secret: presented once, stored as a hash

A session secret is the only thing in this repository worth stealing on its own. Holding one *is*
being the subject, for as long as the session lives. So:

- **It exists in one place, for one moment.** `authenticate` and `rotate` each return a
  `SessionToken` whose `reveal()` works exactly once; a second call throws. A component that could
  re-read the secret has, in effect, stored it.
- **It cannot reach a log by accident.** `toString()`, `toJSON()` and Node's inspector all return
  `[redacted session secret]`, so `log({ result })` — which everybody writes — cannot leak it.
- **What is stored is a SHA-256 hex digest**, and the database `CHECK` enforces that shape. Not a
  password hash: this is a 32-byte random value, not a low-entropy human secret, so a slow KDF would
  buy nothing against an attacker holding the table and would cost every request that validates a
  session. What it does buy is that a database read yields no usable tokens.
- **The shape of the secret is checked before it is issued.** At least 43 base64url characters; a
  degraded entropy source is refused (`insufficient-entropy`) rather than allowed to mint guessable
  sessions in silence.
- **Hash comparison is constant-time**, through `timingSafeEqual` on the decoded digests.
- **No secret is ever a SQL parameter.** `tests/authentication-repository.test.ts` inspects every
  parameter of every statement the adapter issues and fails the suite on any value shaped like a
  secret rather than a hash.

---

## 6. Expiry, rotation, revocation, and who wins a race

Every session carries both expiries. The absolute one is the hard stop; the idle one is moved
forward by rotation and is capped at the absolute one, so **a session cannot live for ever by being
used**. The default policy is twelve hours absolute and thirty minutes idle — short, because this
component has no recovery flow, and the cost of being wrong is that people sign in again. A policy
whose idle window exceeds its absolute lifetime is refused at construction as `malformed-record`,
because it could never apply and guessing which was meant would be worse.

Rotation and revocation are **guarded updates** that carry the state they expect to find:

- `rotateSession` expects the current token hash and a session that is not revoked. It replaces the
  hash, moves the idle expiry, increments `rotationCount`, and has no field for the absolute expiry
  at all.
- `revokeSession` expects a session that is not already revoked, and records the instant and one of
  `signed-out`, `rotated-out`, `operator-revoked`, `security-event`.

Both return `false` rather than throwing when the guard does not match **what the transaction can
see** — "somebody else got there first" is a normal outcome of a race, and the service turns it into
`stale-session-state` after re-reading. Revoking an already-revoked session converges on the first
revocation rather than rewriting it: signing out twice is not an error, and the first revocation is
the one that counts.

A guard that loses to a transaction that **overlapped** this one is different, because by then the
`true` has already been handed back. There is no answer left to correct, so the *transaction* is
refused: the commit raises `stale-session-state` and writes nothing at all, including any inserts it
made. The reference in-memory repository preflights every queued guarded update against a temporary
copy of the current sessions and publishes that copy only once every uniqueness check and every
guard has won — so the loser of a rotation race never receives a token whose secret was silently
dropped.

The database enforces the same shape from underneath. A `BEFORE UPDATE OR DELETE` trigger refuses
every write to bindings and evidence; a second trigger allows a session `UPDATE` to change only the
token hash, the idle expiry, the rotation count and the revocation columns, refuses deletion
outright, refuses rotating a revoked session back into use, and refuses rewriting an existing
revocation.

---

## 7. Idempotency, convergence, and the spent token

A retry is recognised at two moments, because it can arrive at two.

**Before the verifier.** If evidence already exists under this idempotency key, the proof is *not*
re-presented — an assertion is consumed once, so a second presentation would be refused as a replay
and a caller retrying after a timeout would be told it had attacked the platform.

**After the write is refused.** Two identical calls can overlap, and the loser is refused by
whichever unique constraint the store happened to check first: evidence id, `(provider,
assertionId)`, either idempotency key, session id, or token hash. Which one fired is the database's
own business and carries no meaning for the caller, so every code they normalise to
(`idempotency-key-reuse`, `assertion-replayed`, `malformed-record`, `insufficient-entropy`) is
offered the same recovery.

What decides the outcome is not the constraint but a **complete comparison** of what is stored under
that key against the request — and of the stored records against each other:

| Compared | Why |
|---|---|
| `evidenceId`, `sessionId`, `provider`, both idempotency keys | The identifiers the caller supplied |
| `providerReference`, read from the **binding** | Evidence records a provider but never a reference, so without the binding a key reused against a different handle on the same provider compares equal on every field there is |
| Binding ↔ evidence ↔ session: binding id, subject, the session's evidence id | Convergence is the path taken when something has already gone wrong; records that do not name each other are not a coherent authentication |
| Assurance, and the canonical factor set | Both records carry a copy, and the *session's* copy is what a caller reads. A session claiming `hardware-backed` over `single-factor` evidence is a privilege escalation sitting in two individually well-formed rows |
| Chronology: a session issued before its proof was verified, or before the evidence that accounts for it; evidence recorded before it was verified | Impossible orderings this component's own writer cannot produce, because both instants come from one reading of the clock |

Anything short of a complete match **preserves the refusal the caller already had** on the
post-conflict path, and raises `idempotency-key-reuse` naming the disagreeing field on the
pre-verifier path. A replay under a fresh idempotency key finds nothing to converge on and stays
`assertion-replayed`; a token-hash collision between unrelated sessions stays `insufficient-entropy`;
evidence with no session is half an authentication and converges on nothing.

A converged retry receives the original session and evidence, and a **spent token**: one whose
`reveal()` throws, because the secret was presented once, to the call that actually authenticated.
**Exactly one usable token is issued per authentication**, and a retry never receives a second.

The same rule applies to `bind`: a retry converges only when the whole binding matches — id,
subject, provider and reference — and anything else re-raises the original refusal.

---

## 8. Persistence, ownership, and what is deferred

An injected `AuthenticationRepository` port with three implementations:
`InMemoryAuthenticationRepository` (the reference implementation, not a convenience double — it
enforces the same uniqueness the database does, **at commit against the store as it stands**),
`PostgresAuthenticationRepository`, and `EnlistedAuthenticationRepository` for a caller that already
owns a transaction.

K-02 owns exactly one schema, `kernel_authentication`, derived from the architecture manifest. No
statement it issues names another unit's schema, and its `is_opaque_identifier` function is a
character-for-character copy of K-01's for the same reason K-03's is — a `CHECK` calling another
schema's function would be exactly the coupling refused in §3. `tests/authentication-repository.test.ts`
extracts the bodies and fails if they differ.

Every instant is projected as UTC text through `to_char`, never left to the driver's `Date` parser.
Decoding is fail-closed and runs the **same validators the service calls**, so a row written around
the adapter is refused rather than authenticated on. Enlisted writes are wrapped in a client that
refuses transaction control (`nested-transaction`): a `COMMIT` issued by an enlisted path would
commit rows its caller had not finished writing.

### Deliberately deferred

- **No verifier, so nothing here can authenticate a real person.** No password checking, no OAuth or
  OIDC, no passkey or WebAuthn, no TOTP, no email or SMS delivery, no device attestation.
- **No recovery.** No reset, no recovery codes, no account-takeover path — `recoveryCode` on a
  request is refused by name rather than half-supported.
- **No registration.** Nothing here creates a K-01 subject or a K-03 account; `bind` links a subject
  that already exists.
- **No permissions (K-04).** Authentication is not authorisation. A validated session says who the
  party is and how strongly that is known, and nothing about what it may do.
- **No audit trail (K-09).** Signing in, rotating and revoking are exactly the actions K-09 was
  built to record, and **none of them is recorded**. K-09 exists; wiring K-02 to it is separate work.
- **No events (K-08).** A sign-in publishes nothing, so nothing can react to one.
- **No API and no UI.** There is no endpoint, no cookie handling, no CSRF story, no rate limiting,
  no lockout and no throttling. Those belong to the caller and to work that has not been scheduled.
- **No session management surface** beyond `findSession` and `bindingsForSubject`: no listing of a
  subject's live sessions, no "sign out everywhere", no device names.
- **No unbinding.** Bindings are append-only; removing a verifier handle from a subject is
  undelivered, and doing it as a mutation would transfer every session issued under it.
- **The enlisted path is a capability, not an integration.** No unit uses it. The sign-in-and-provision
  path it exists for is undelivered.
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, every `CHECK`, both write-once triggers and the session-rewrite guard are declared
  and **unproven**.

---

## 9. Threat assumptions

Stated as assumptions, because each is something this component cannot verify for itself.

| Assumed | What it means if it is false |
|---|---|
| The wired verifier is the authority for its provider and answers honestly about what it checked | K-02 validates the *shape* of an assertion, its provider, its reference and its expiry. A verifier that reports factors it never checked is believed, and the assurance recorded is a fiction |
| The injected clock is correct | Every expiry, and the assertion-expiry check, is relative to it. A clock behind reality keeps sessions alive past their stated life |
| The entropy source is cryptographic | Only the *shape* of a secret can be checked here. A source that is long, base64url and predictable passes, and the session secrets are then guessable |
| The transport is confidential | A session secret is a **bearer** credential: whoever holds it is the subject until it expires or is revoked. There is no device binding, no channel binding, no IP or user-agent check — and the last two on purpose, because they are personal data this component does not collect |
| Nothing hostile can write to `kernel_authentication` | The store defends against reads: it holds hashes, so a stolen dump yields no usable tokens. A party that can *write* rows can mint a session, and no trigger stops an insert |
| Proof material is short-lived at the provider | Assertions carry their own expiry and are consumed once, which bounds a captured assertion. A provider that issues long-lived assertions widens that window and K-02 cannot narrow it |

What is *not* assumed, and is enforced instead: that the caller is honest about the outcome (§1),
that a stale caller loses a race (§6), that a retry is not a replay (§7), and that a database read
yields nothing usable (§5).

Not defended against, and worth naming: online guessing of proof material (there is no rate limit or
lockout here — the verifier or the caller must supply one), a compromised verifier, and traffic
analysis. Session-secret guessing is impractical by construction — 32 bytes of entropy, refused if
shorter — rather than by throttling.

---

## 10. Verification

```bash
npm run verify                                    # everything, including the tests below
npm run check:migrations                          # the FND-002a contract over db/migrations
node --test tests/authentication.test.ts          # the trust boundary, refusals, the real K-01 dependency
node --test tests/authentication-sessions.test.ts # secrets, expiry, rotation, revocation, replay
node --test tests/authentication-repository.test.ts # port conformance, adapter, this contract
node --test tests/authentication-concurrency.test.ts # overlapping rotation and revocation
node --test tests/authentication-convergence.test.ts # convergence under each constraint the server may pick
npm run test:integration                          # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and **a skipped run is not evidence of anything** — see the last entry in §8.
