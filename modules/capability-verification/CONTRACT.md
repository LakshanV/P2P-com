# M-02 Capability & Verification — contract

**Status:** foundation delivered. **Not complete** — see §7.
**Owner:** M-02, `modules/capability-verification/`.
**Layer:** L1. **Schema:** `module_capability_verification`, created by
[`0025_create_module_capability_verification_schema.up.sql`](../../db/migrations/0025_create_module_capability_verification_schema.up.sql).
**Depends on:** K-03 Accounts (the account being verified, by opaque id), K-08 Event
Infrastructure, K-09 Audit Foundation.

M-01 Universal Account owns which roles an account may act in. M-02 owns **how far anybody has
actually checked**, and on what evidence. They are the same layer and never call each other.

---

## 1. What this module owns

Three things, and the outbox that publishes changes to them:

1. **Verification cases** (`module_capability_verification.verification_case`) — one verification
   effort, for one account, for one purpose, carrying the level it is trying to reach and the level
   it has reached. One *open* case per `(account, purpose)`.
2. **Evidence** (`module_capability_verification.evidence`) — one row per submitted piece of
   evidence, as an **opaque reference** to an artefact another system stores. Append-only.
3. **Level records** (`module_capability_verification.level_record`) — the append-only log of level
   changes behind `achievedLevel`, so "verified to what, since when, and why" is answerable.

It does **not** own:

- The universal account — **K-03 Accounts**. M-02 holds an opaque `accountId` and never joins to
  `kernel_accounts`.
- Which capabilities the account holds — **M-01 Universal Account**. `capability` and
  `capabilities` are refused by name. M-01 and M-02 are the same layer: they communicate by event.
- What a verified account is *permitted* to do — **K-04 Permissions**. A level is a fact; authority
  is a grant.
- **The evidence itself.** No document, no image, no passport number, no tax number, no bank
  account number. See §3.

### What it does not own, and who does

| Concern | Owner |
|---|---|
| The universal account | **K-03 Accounts** |
| Identity, subjects, party kinds | **K-01 Identity** |
| Authentication, sessions, credentials | **K-02 Authentication** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Which capabilities an account holds | **M-01 Universal Account** |
| Every monetary amount | **K-10 Ledger Foundation** |
| The stored artefact behind a piece of evidence | A document store outside this repository |
| Event routing and subscriptions | **K-08 Event Infrastructure** |
| Audit storage and authority classification | **K-09 Audit Foundation** |

The full list, with the owning unit named for each entry, is `FOREIGN_FIELDS` in `registry.ts`.

---

## 2. Public contract

```ts
new CapabilityVerificationService(repository)

startVerification(request):   Promise<{ case, record, replayed }>
submitEvidence(request):      Promise<{ evidence, case, replayed }>
evaluateLevel(request):       Promise<{ case, record, replayed }>
rejectVerification(request):  Promise<{ case, record, replayed }>

getCase(caseId):              Promise<VerificationCase | null>
listCases(accountId):         Promise<readonly VerificationCase[]>
listEvidence(caseId):         Promise<readonly Evidence[]>
getLevelHistory(caseId):      Promise<readonly LevelRecord[]>
currentLevel(accountId):      Promise<VerificationLevel>
```

`currentLevel` is the question every other module will actually ask: the highest `achievedLevel`
across that account's approved cases, or `none`.

### Refusals

| Code | When |
|---|---|
| `case-already-open` | the account already has an open case for that purpose under a different id |
| `case-not-found` | the case id is unknown |
| `case-not-open` | the case is `approved`, `rejected` or `withdrawn` |
| `level-regression` | `evaluateLevel` was asked to move the level *down* |
| `idempotency-key-reuse` | the key was used for a different request |
| `malformed-reference` | the evidence reference is not an opaque handle |
| `malformed-purpose` | the purpose is not a lowercase kebab vocabulary word of 1–64 characters |

A level is never taken away by `evaluateLevel`. Removing standing is a new case with its own
evidence and its own decision, not an edit to the record that granted it.

---

## 3. Evidence holds a reference, never the artefact

`evidence.reference` is an opaque handle to something another system stores, and it runs through
the same `is_opaque_identifier` rule set as every identifier in this repository — in the service
and again as a database `CHECK`. That rule set already refuses emails, long digit runs,
IBAN-shaped values, URLs, domains and anything credential-shaped, which is exactly the set of
things a verification record must not contain.

This is the single most important property of the module. A verification record outlives the thing
it verifies: a passport number written into one is disclosed for as long as the platform exists,
and no later deletion policy can recall it. The refusal is therefore enforced twice, and
`tests/integration/capability-verification.integration.ts` proves the database refusal by issuing
the offending `INSERT` rather than by asserting that the service does not.

---

## 4. Immutability and mutability

| Record | Mutable? |
|---|---|
| `verification_case` | Yes, and only through the service: status, `achievedLevel`, `decidedAt`, `updatedAt`. |
| `evidence` | No. The database trigger refuses `UPDATE` and `DELETE`. |
| `level_record` | No. Same trigger. |
| `outbox` | Only the relay's dispatch columns. |

Every record crossing the service boundary is sealed.

---

## 5. One open case per purpose

Enforced three times, deliberately: in the service, in the in-memory repository at commit, and by a
**partial** unique index in the migration —
`UNIQUE (account_id, purpose) WHERE status NOT IN ('approved','rejected','withdrawn')`.

Partial rather than plain, because a decided or withdrawn case must not block the next attempt. An
account that failed seller onboarding in March has to be able to try again in June, and a plain
`UNIQUE` would make that impossible without deleting history.

---

## 6. Events and audit

Through the module-owned outbox, in the same transaction as the state change:

| Fact | Event |
|---|---|
| A case was opened | `verification.started` |
| Evidence was submitted | `verification.evidence_submitted` |
| The level changed | `verification.level_changed` |
| A `seller-onboarding` case was approved at `standard` or above | `seller.verified` |

Each carries a matching K-09 audit action. `seller.verified` is the event MODULE_MAP names as
M-02's, and the one M-16, M-17 and M-37 will consume; it is emitted from the level decision rather
than from a separate call, so it cannot be raised without a case behind it.

Outbox ids derive from the append-only record a fact produced — the level record id, the evidence
id — never from the case id alone. A case changes level more than once, and an id derived from the
case would collide with itself on the second change; M-01 shipped that bug and `outbox_pkey`
refused the write. There is a regression test for it here and there.

---

## 7. What is not delivered

- **Nothing calls this module.** No API, no UI, no consumer of any of the four events.
- **No verifier.** M-02 records the level a caller says was reached; it checks nothing itself. There
  is no document-verification provider, no sanctions or PEP screening, no liveness check, and no
  integration with any identity bureau. The `evaluateLevel` caller is the authority, and today there
  is no such caller.
- **No K-02 authentication and no K-04 authorisation** behind any operation. Anyone holding the
  repository can approve any case. The permission grant that should gate this is what K-04 exists
  for, and no caller wires it.
- **No account-existence check** — `accountId` is not verified against K-03, for the reason in §1.
- **No evidence expiry or re-verification schedule**, and no retention policy on the references.
- **No withdrawal operation.** `withdrawn` is in the vocabulary and the schema accepts it, because
  the partial index and the CHECK constraints had to decide the vocabulary once; the operation
  lands with the case-management slice.
- **Nothing applied to a live server.** Migration 0025 runs in the integration suite against a live
  PostgreSQL 16 and nowhere else.

---

## 8. Verification

```
npm run typecheck
npm run lint
npm run format:check
npm run check:boundaries      # M-02 imports platform/ and kernel/ only, and never M-01
npm run check:migrations      # 0025 is paired, transactional and module-owned
npm test                      # tests/capability-verification*.test.ts
npm run test:integration      # tests/integration/capability-verification.integration.ts
```
