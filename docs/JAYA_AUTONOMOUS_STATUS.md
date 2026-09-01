# JAYA — Autonomous Development Status

**Updated:** 2026-09-01
**Branch:** `jaya-p2p-com-47859d`
**HEAD:** `e0b7761` — *Close the open door: authenticate and authorise every route*

This file says **where the work is right now**. It is deliberately short, and it is not the authority
on completeness.

| Question | Where the answer lives |
|---|---|
| What fraction of the original vision exists? | `JAYA_REQUIREMENTS_TRACEABILITY_MATRIX.md` |
| What is being built next, and in what order? | `JAYA_REMAINING_BACKLOG.md` |
| Why was something built the way it was? | `JAYA_DECISION_LOG.md` |
| What does the architecture permit? | `JAYA_MASTER_ARCHITECTURE.md`, `JAYA_MODULE_MAP.md` |

An earlier revision of this file was allowed to drift for a fortnight and ended up asserting that
K-04 had no callers, that K-10 through K-15 were uncommitted, and that the next task was work
already finished. A status document that is wrong is worse than none, because somebody acts on it.
Anything below that cannot be checked against the repository in under a minute has been removed.

---

## Where the work stands

**Just finished: the front door.** Every HTTP route now authenticates the caller, authorises the
action against a published policy, and checks the specific object against its owner. Before this
commit, `GET /v1/accounts/{anyone}/money` returned anyone's balances and
`POST /v1/payments/{id}/capture` moved money for whoever could reach the port.

Three things closed together:

- **K-02 can authenticate a real person.** A scrypt verifier behind the existing `Verifier` port —
  OWASP interactive parameters, parameters stored with the hash so the cost can be raised later,
  timing-safe comparison, and a decoy hash so an unknown account costs the same as a wrong password.
- **K-04 has callers.** `apps/api/access.ts` calls `authorize` before every handler, and
  `apps/api/policy.ts` is the V1 policy: what a CUSTOMER, SUPPLIER, DRIVER, SUPPORT, FINANCE or ADMIN
  may do. A buyer cannot capture or refund; a seller cannot create an order; a session holding no
  grant reaches nothing.
- **The webhook route no longer trusts its caller.** It read `signatureVerified` out of the request
  body, so anybody could post `{"signatureVerified": true, "assertedStatus": "captured"}` and move a
  payment. It is now HMAC-SHA256 over the raw bytes, with the timestamp inside the signed payload.

**Next**, in order: rate limits, then a durable password credential store, then joining the
transaction spine — `payment.captured` → `settleExternalLeg`, and order placement → inventory
reservation. Both of those last two are small: every piece exists and nothing calls across.

---

## Terminology

Used strictly throughout these documents, and not interchangeably.

| Term | Means |
|---|---|
| `ARCHITECTURE COMPLETE` | The unit has a place, a layer and enforced boundaries. No code. |
| `CONTRACT COMPLETE` | A written, precise contract exists. No working implementation. |
| `IMPLEMENTATION COMPLETE` | Code exists and does the thing. |
| `TESTED` | Unit tests pass. |
| `INTEGRATION TESTED` | Proven against live PostgreSQL, or over a real socket. |
| `UI-READY` | A person could use it, if a screen existed. |
| `PRODUCTION-READY` | Deployable: authenticated, authorised, rate-limited, backed up, observable. |
| `EXTERNALLY BLOCKED` | Cannot proceed without a credential or decision from outside this repository. |

Nothing in this repository is `PRODUCTION-READY`. See the deployment blockers in the matrix.

---

## Gates, and their last result

Every one of these runs locally and passes at HEAD. **None of them runs automatically** — see BL-10.

| Gate | Command | Last result |
|---|---|---|
| Types | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass |
| Format | `npm run format:check` | Pass |
| Build | `npm run build` | Pass |
| Boundaries | `npm run check:boundaries` | Pass — 264 files, 1060 imports, 0 violations |
| Migrations | `npm run check:migrations` | Pass — 94 files, 0 violations |
| Fixtures | `npm run check:fixtures` | Pass |
| Unit tests | `npm test` | **2,032 pass, 0 fail** |
| Integration | `npm run test:integration` | Live PostgreSQL 16, sequential |

The integration suite must run with `--test-concurrency=1`; it derives scratch databases and two
runners racing on `CREATE DATABASE` is not a recoverable state. Running two suites at once produces
`duplicate key value violates unique constraint "pg_database_datname_index"`, which is the harness
being correct rather than a defect.

---

## Blockers

| ID | Blocker | What it stops | Position |
|---|---|---|---|
| BL-10 | The repository credential lacks the Workflows permission | Nothing under `.github/workflows/` can be pushed, so no gate runs automatically | Every gate runs locally and passes. Needs a permission from the owner |
| BL-05 | No payment gateway sandbox | Every capture succeeds against a mock. The platform can take an order and never take the money | `main.ts` refuses to start in production unless the operator acknowledges it |
| BL-04 | No AI provider credentials | No model has ever been called; every AI capability is a mock | K-13's port and authority ceiling are real and tested |
| BL-07 | No email/SMS/WhatsApp credentials | Only the in-app notification provider ships | — |
| BL-01/BL-02 | No staging or production environment | Nothing is deployed anywhere | — |
| — | No object storage | No image, document or delivery evidence can be stored | Blocks image Need and dispute evidence |

None of these stops development. All of them stop deployment.

---

## Standing constraints

Decisions that bind future work, kept here because breaking one silently is easy.

- **Determinism.** Modules read no clock and generate no identifiers. The caller supplies every
  identifier and every instant; the HTTP request context is the one place nondeterminism enters. A
  test asserts modules contain no `Date.now`, `new Date`, `Math.random` or `crypto.randomUUID`.
- **Money is `bigint` minor units**, and crosses the wire as a decimal string. `JSON.stringify`
  throws on a bigint, so the pipeline converts them — a response carrying an order total would
  otherwise fail *after* the work committed. No `double precision`, `real`, `float` or `money`
  column may exist, and a check enforces it.
- **The financial authority zone may never import K-13 AI Gateway.** Orders, payments, the ledgers,
  commission, settlements and payouts. A boundary check fails the build.
- **`is_opaque_identifier` is byte-identical in every schema** that carries it, enforced by test. It
  refuses emails, telephone numbers, national identifiers, IBANs and anything credential-shaped.
- **No PAN, CVV or equivalent is ever persisted.** What a client sends is a provider token; M-12
  refuses an instrument by name.
- **Internal JAYA value never goes through an external payment provider.** Rewards, cashback,
  merchant credit, promotional credit, delivery credit and community credit settle in M-13, and
  `assertSettlementAsset` refuses them at the boundary.
- **Same-layer modules communicate by event, never by import.** Downward imports only; `platform`
  sits below `kernel` and may not import it.

---

## How to continue from a new session

1. `git status` and `git log --oneline -5`.
2. Read this file, then `JAYA_REMAINING_BACKLOG.md` for what is next.
3. `npm run db:up && npm run db:ready` if the database is not running.
4. `npm run verify` to confirm the foundation is green before changing anything.
5. Take the first unstruck item from the backlog's P0 table.

Work in vertical slices: one slice leaves every gate green and is committed on its own. Do not mark
anything done without named implementation files and a named test that passes — a README statement
is not proof, an interface is not proof, a mock alone is not proof, and a generated test that has
never run is not proof.
