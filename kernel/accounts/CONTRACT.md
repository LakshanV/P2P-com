# K-03 Accounts — contract

**Status:** foundation delivered by FND-004b. **Not complete** — see §7.
**Owner:** K-03, `kernel/accounts/`.
**Schema:** `kernel_accounts`, created by
[`0007_create_kernel_accounts_schema.up.sql`](../../db/migrations/0007_create_kernel_accounts_schema.up.sql).
**Depends on:** K-01 Identity, through an injected lookup and nothing else (§5).

---

## 1. What this component owns

One thing: **the single universal account belonging to one party.**

The guide's §4 is the design: *do not create separate identities for buyers, sellers, hosts or
service providers; create one JAYA Account with capabilities*. K-01 made that true at the identity
layer by refusing a role as a subject kind. K-03 makes it true one level up — at most one account
per subject, carrying no capability at all.

| Field | Meaning |
|---|---|
| `accountId` | Caller-supplied opaque handle. Never a natural key |
| `subjectId` | The K-01 subject this account belongs to. Fixed at creation, never relinked |
| `createdAt` | Canonical UTC instant, caller-supplied |
| `origin` | Who caused the creation: `{ kind: 'human' \| 'system', id }` |
| `idempotencyKey` | Stable across retries of one logical opening |

### What it does not own, and who does

This table is the contract, and it is the reason the component stays small. An open request carrying
any of these fields is **refused by name** — a caller passing `capabilities` is not making a typo, it
is modelling the thing wrongly, and silently dropping the field would leave it believing a seller
capability had been activated.

| Concern | Owner |
|---|---|
| What kind of party a subject is | **K-01 Identity** |
| Passwords, credentials, MFA, sessions, tokens | **K-02 Authentication** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Capability activation, personas, seller/buyer state | Capability & Verification module, and the cockpit modules |
| Verification level, KYC, tax identity | Capability & Verification module |
| Name, email, phone, address, preferences | The account profile core — separate, undelivered work |
| Every monetary amount, balance, credit and payout | **K-10 Ledger foundation**, Payments, Seller Payouts |
| Points and rewards | Rewards module |
| Who did what to which account | **K-09 Audit Foundation** |

The full list, with a reason for each, is `FOREIGN_FIELDS` in `registry.ts`, and
`tests/accounts.test.ts` asserts that every entry names a real owner rather than carrying a label.

---

## 2. Public contract

```ts
new AccountService(repository, subjectLookup)

open(request): Promise<{ account, deduplicated }>
findAccount(accountId): Promise<UniversalAccount | null>
requireAccount(accountId): Promise<UniversalAccount>
findAccountForSubject(subjectId): Promise<UniversalAccount | null>
hasAccount(subjectId): Promise<boolean>
```

Five operations, four of which are reads. There is no update, no relink, no close, no deletion and
no merge — see §4. There is no login, capability activation, role grant or balance operation either,
and `tests/accounts.test.ts` scans the whole surface for one.

### Guarantees

| Guarantee | Meaning |
|---|---|
| One party, one account | At most one account per K-01 subject. Enforced three times: read-then-refuse in the service, a uniqueness check at commit in the reference repository, and `UNIQUE (subject_id)` in migration 0007. The second two exist because the first is a race |
| Immutable linkage | `subjectId` is fixed at creation. No operation relinks an account at any layer, and the database refuses `UPDATE` by trigger |
| Referential validity at creation | The subject must exist, checked through K-01's public contract **before** an account transaction opens. A malformed request never reaches K-01 at all |
| Opaque identifiers | K-01's rule set, applied to every K-03 identifier and re-raised in K-03's vocabulary. An account id that looks like an email, telephone number, document number, IBAN, URL, domain or personal name is refused, as is a credential-shaped one |
| One rule, three enforcement points | The same rules apply at creation, on every row decoded from PostgreSQL, and in the `CHECK` constraints |
| Idempotent opening | A retry with the same key returns the original account **only when the whole logical account matches** — account id, subject, instant and origin. Two retries that overlap converge on the winner rather than one failing |
| Convergence independent of which constraint fired | An identical concurrent opening violates all three uniqueness constraints at once, and PostgreSQL reports whichever index it checked first. Convergence is decided by **content**, never by which constraint was reported, so a genuine retry is not refused because of a choice the server made. Anything that is not an identical opening re-raises the **original** refusal — a different account for a party that already has one still hears `subject-already-has-account`, not a complaint about a key it never reused |
| Determinism | The caller supplies the account id, the instant and the key. This component reads no clock and generates no randomness |
| Immutability in the process | Every account crossing a boundary — a service result, a repository read, a decoded row — is deep-frozen and severed from the caller's objects by a single seal |
| Transaction composition | `PostgresAccountRepository.enlist(client)` opens an account inside a transaction the caller already owns, so a subject and its account can commit together |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-subject` | The subject id names no K-01 subject. An account is the party a contract is with; creating one for a party nobody recorded would invent one |
| `subject-already-has-account` | That party already holds an account. A second would split one person across two histories that can never be reconciled |
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name — at creation or in a row read back from storage |
| `secret-bearing-input` | An identifier names or looks like a credential |
| `malformed-instant` | `createdAt` is not a real UTC instant. 31 April is refused rather than rolled forward |
| `ai-not-permitted` | `origin.kind` is `ai`. See §6 |
| `foreign-concern` | The request carried a field owned by K-01, K-02, K-04, verification, a profile or a financial module — or a field this component does not recognise at all |
| `duplicate-account-id` | An account with this id exists. An account is created once |
| `idempotency-key-reuse` | The key was already used for a *different* account. Returning the earlier one would hand back the wrong party's account |
| `no-such-account` | Nothing to read |
| `nested-transaction` | An enlisted write tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. The transaction belongs to the caller |
| `malformed-record` | A stored row, or a candidate account, is the wrong runtime shape |

---

## 3. Why the account carries nothing

Every field a reasonable person would add here is a field that makes the one-account rule harder to
keep.

Suppose the account carried `isSeller`. The next question is what to do about somebody who sells
under two businesses, and the answer immediately available is a second account — at which point the
platform has two histories for one person, two reputations, two payment methods, and no way to
reason about them as one counterparty. The same argument runs for `verificationLevel` (verified for
what?), for `balance` (K-10 is the authority, and two systems that both hold an amount will
eventually disagree), and for `email` (personal data in a table that claims to hold none).

So the account is a **link and a provenance record**. Capabilities are activated *against* it by the
components that own them, and the account itself never learns which ones. That is what makes "one
universal account" a structural fact rather than an intention.

---

## 4. Immutability, and why there is no relink, close or merge

An account is created and never changed. Not by an admin path, not by an internal one.

Orders, payments, settlements, ledger entries and audit records will all name account ids. An
account whose `subjectId` could change would silently reattribute every one of them to a different
party, with nothing in any of them recording that it happened. One that could be deleted would leave
them all pointing at nothing.

Enforced at four layers: no such operation in the service, none in the port, none in the adapter,
and a `BEFORE UPDATE OR DELETE` trigger in migration 0007. `tests/accounts-repository.test.ts`
inspects the transaction object at runtime and fails if an operation matching update, delete, relink
or merge appears — a rule enforced by a type is a rule a cast can undo.

**Closure and merge are deferred, not forgotten.** Both are real needs. Closure is most likely a
K-04 permission decision plus a capability deactivation rather than a column here; merge needs a
linkage record, a surviving id, an audited decision and a rule for the balances on both sides.
Implementing either as a mutation is how an account system becomes unable to explain its own
history.

---

## 5. The K-01 dependency: a port, not a foreign key

K-03 is the **first real consumer of K-01**. The whole surface of the dependency is one question,
asked through K-01's public contract:

```ts
interface SubjectLookup {
  exists(subjectId: string): Promise<boolean>;
}
```

`IdentityService` satisfies it structurally — no adapter, no translation layer — and
`tests/accounts.test.ts` wires the real K-01 service to the real K-03 service to prove it.

**There is no foreign key from `kernel_accounts.universal_account.subject_id` into
`kernel_identity`, and no SQL of K-03's names another unit's schema.** That is a decision:

- A cross-schema foreign key would make the two components one object. `kernel_identity` could not
  be migrated, rolled back or moved to another database without `kernel_accounts`' permission, and
  K-01's rollback uses `RESTRICT` precisely so it fails loudly rather than taking something else with
  it. The schema-ownership rule (MODULE_MAP §10) exists for this.
- It would also be enforcement in the wrong layer. The useful refusal is "this subject does not
  exist", raised before an account transaction opens, naming the subject. A foreign-key violation
  arrives as SQLSTATE 23503 after the write and every caller has to translate it back.

**What is given up is stated rather than glossed: there is no database-level guarantee that
`subject_id` names a real subject.** A row inserted around this component can name anything the
opacity rules accept. The cost is small today because K-01 subjects are write-once — nothing deletes
one, so a link checked at creation stays valid — and because no unit opens accounts yet. It would
grow if K-01 ever acquired deletion, and that is the moment to revisit it.

One consequence is visible in the migrations: `kernel_accounts.is_opaque_identifier` is a
character-for-character copy of `kernel_identity.is_opaque_identifier`, because a `CHECK` calling
the other schema's function would be exactly the coupling refused above. The duplication is
unavoidable and therefore guarded: `tests/accounts-repository.test.ts` extracts both bodies and
fails if they differ.

---

## 6. AI has no authority here

`origin.kind: 'ai'` is refused by the service, by the database `CHECK`, and again on decode if a row
somehow holds it.

An account is the party every order, payment and settlement is with. One that AI decided should
exist is a counterparty nobody agreed to — and the financial modules bar AI from authority outright
(MODULE_MAP §11). AI may draft the request or prompt an operator; the human or deterministic system
that acts on it owns the account.

---

## 7. Persistence, and what is deferred

An injected `AccountRepository` port with three implementations — `InMemoryAccountRepository` (the
reference implementation, which enforces the same three uniqueness rules the database does, checked
at commit against the store as it stands), `PostgresAccountRepository`, and
`EnlistedAccountRepository` for a caller that already owns a transaction.

`created_at` is projected as UTC text through `to_char`, never left to the driver's `Date` parser.
Decoding is fail-closed and runs the **same `validateAccount` the service calls**, so a row written
around the adapter is refused rather than returned. K-01 needed a correction to reach that shape
(CURRENT_IMPLEMENTATION_STATUS §11.22); K-03 starts there.

### Deliberately deferred

- **No unit opens an account.** The registration path this makes possible — a K-01 subject and a
  K-03 account created in one transaction through both enlisted paths — is undelivered. The enlisted
  path is a capability, not an integration.
- **No authentication (K-02), no permissions (K-04).** Nothing verifies that the `origin` is who the
  caller says, and nothing decides who may open an account.
- **No profile core.** Name, email, phone and preferences have no home yet. When they get one it
  will be a separate table with its own retention and erasure rules, precisely because this one
  holds no personal data.
- **No capability or verification model.** The Capability & Verification module owns both.
- **No events (K-08).** Opening an account is exactly the sort of thing other modules will want to
  react to, and nothing is published.
- **No audit trail (K-09).** Opening an account is exactly the sort of action K-09 was built to
  record, and nothing is recorded. K-09 exists; wiring K-03 to it is separate work.
- **No closure, relink, merge or erasure.** §4.
- **No listing or search.** `findAccountForSubject` is singular by construction, which is the
  one-per-subject rule showing up in the signature.
- **Nothing has run against a live PostgreSQL server.** No runtime is available to this repository,
  so the schema, the constraints and the write-once trigger are declared and unproven.

---

## 8. Verification

```bash
npm run verify                                 # everything, including the tests below
npm run check:migrations                       # the FND-002a contract over db/migrations
node --test tests/accounts.test.ts             # contract, refusals, the real K-01 dependency
node --test tests/accounts-repository.test.ts  # port conformance, adapter, module contract
node --test tests/accounts-concurrency.test.ts # one-per-subject races, retry convergence, enlistment
node --test tests/accounts-convergence.test.ts  # convergence under each constraint the server may pick
npm run test:integration                       # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
