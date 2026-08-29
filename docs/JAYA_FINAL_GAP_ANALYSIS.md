# JAYA — Final Gap Analysis (Independent Audit)

**Auditor:** Independent architecture / QA pass
**Date:** 2026-08-28
**Branch:** `jaya-p2p-com-47859d`
**Head commit:** `c730fda` (iteration 104), plus a large uncommitted working tree
**Method:** repository inspection and executed verification. No status document was taken on trust.
**Revision 2 (2026-08-29):** the two P0 kernel gaps this audit identified — K-10's value model and
K-13's authority controls — have since been closed by this same pass. Sections 3, 5 and 8 are updated
to describe what is now true, and section 12 records the work. One finding in revision 1 was
overstated and is corrected: K-13 already carried an `AIDecision` record with a 0–4 `policyLevel`,
so the gap was the absence of *enforcement*, not the absence of the concept.
**Revision 3 (2026-08-29):** M-01 Universal Account and M-02 Capability & Verification have since
been built, so section 0's statement that `modules/` holds no code is no longer true and layer L1 is
complete. Sections 13 and 14 record that work. Everything else in section 0 stands: 45 of 47 business
modules are unbuilt, `apps/` and `design-system/` are still empty, and the schedule assessment in
section 10 is unchanged.

---

## 0. Headline finding

> The kernel substrate is real, high quality and green.
> **No business capability exists.** `modules/` contains one README and no code.
> `apps/` contains one README and no code. `design-system/` contains one README and no code.

This is not a contradiction of the project's own documentation. `docs/CURRENT_IMPLEMENTATION_STATUS.md`
— authority rank 2, and itself under an executable contract in `tests/docs-contract.test.ts` — states
verbatim:

> **Overall status:** `TOOLCHAIN SUBSTRATE ONLY — NO BUSINESS CAPABILITY`
> "There is still **no CI, no database, no business module and no UI**."

Any statement that "much of the system is finished" is not supported by the repository or by the
repository's own status documents. What is finished is **Phase 0 + Phase 1: the commerce kernel**.

---

## 1. Verification run — executed, not quoted

Every command below was executed against the working tree on 2026-08-28.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **PASS** (0 errors) |
| Lint | `npm run lint` | **PASS** (0 problems) |
| Format | `npm run format:check` | **PASS** |
| Boundary rules | `npm run check:boundaries` | **PASS** — 181 files, 689 imports, 0 violations. *Revision 2: 691 imports, 0 violations* |
| Migration contract | `npm run check:migrations` | **PASS** — 42 files, 0 violations, 8 rules. *Revision 2: 46 files, 0 violations* |
| Fixture contract | `npm run check:fixtures` | **PASS** — 2 datasets, 13 rows |
| Unit tests | `npm test` | **PASS** — 1591 pass / 0 fail / 0 skipped, 111.7 s. *Revision 2: 1630 pass / 0 fail* |
| Integration tests | `npm run test:integration` | live PostgreSQL 16 on port 5434, run exclusively |

**One environmental defect found and attributed.** Running two integration processes concurrently
produces `duplicate key value violates unique constraint "pg_database_datname_index"`. The cause is
architectural, not a product bug: `platform/db/test-database.ts` *derives* a single test database
name (`jaya_dev_test`) from `DATABASE_URL` by design, so the integration suite is exclusive by
construction. `--test-concurrency=1` protects against file-level concurrency inside one run but
cannot protect against a second `npm run test:integration` process. See §7 GAP-INF-1.

---

## 2. What genuinely exists

### 2.1 Platform substrate (`platform/`) — COMPLETE for its scope

28 TypeScript modules. Architecture manifest, four executable boundary checks driven by the
TypeScript compiler API (not regex), migration runner with advisory locking and SHA-256 checksum
reconciliation, guarded test-database lifecycle, deterministic fixture runner, and the shared outbox
contract with a polling relay.

### 2.2 Commerce kernel (`kernel/`) — 15 of 15 components implemented

Each component ships the same disciplined shape: `types.ts`, `validate.ts`, `immutable.ts`,
`registry.ts` (identifier rules plus a named foreign-field table), `repository.ts` (port plus an
in-memory reference implementation with commit-time conflict detection), `postgres-repository.ts`,
`service.ts`, `outbox.ts`, `index.ts`, `CONTRACT.md`, a numbered migration, and a substantial test
suite. Money is `bigint` minor units throughout. Instants are caller-supplied; nothing reads a clock.
Timestamps are projected through `to_char` so the driver never parses them.

| ID | Component | Migration | Verdict |
|---|---|---|---|
| K-01 | Identity | 0006 | COMPLETE (foundation) |
| K-02 | Authentication | 0008 | COMPLETE (foundation) — **MockVerifier only**, no real verifier |
| K-03 | Accounts | 0007 | COMPLETE (foundation) |
| K-04 | Permissions | 0009 | PARTIAL — no read-back API; **no caller anywhere guards a path** |
| K-05 | Configuration | 0003 / 0013 | COMPLETE (foundation) |
| K-06 | Policy Engine | 0011 / 0014 | COMPLETE (foundation) — **no financial consumer** |
| K-07 | Feature Flags | 0010 / 0015 | COMPLETE (foundation) |
| K-08 | Event Infrastructure | 0004 | COMPLETE (foundation) |
| K-09 | Audit Foundation | 0005 | COMPLETE (foundation) |
| K-10 | Ledger Foundation | 0017 / 0022 | COMPLETE (foundation) — multi-value model closed by this pass, §3 |
| K-11 | Commerce Unit Registry | 0012 / 0016 | COMPLETE (foundation) |
| K-12 | Conversation Foundation | 0018 | COMPLETE (foundation) — no caller |
| K-13 | AI Gateway | 0019 / 0023 | COMPLETE (foundation) — authority controls closed by this pass, §3a. Mock provider adapter only |
| K-14 | Notifications | 0020 | PARTIAL — in-app provider only |
| K-15 | Search Foundation | 0021 | COMPLETE (foundation) — no caller |

"COMPLETE (foundation)" means: the library, its persistence, its contract and its tests are real and
pass. It does **not** mean production-complete: none of these has an HTTP API, a UI, or a business
caller. Every one of them is a library nothing yet uses.

### 2.3 Transactional outbox — GENUINELY WORKS

This was verified rather than assumed. `platform/outbox/` defines `OutboxEntry`, `OutboxTransaction`
and `OutboxSource`; each producing module owns its own `outbox` table in its own schema (migrations
0013–0016 and the per-component schemas); `platform/outbox/relay.ts` polls, dispatches, marks
processed, records `lastError` and increments `retryCount`; `kernel/event-infrastructure/outbox-publisher.ts`
and `kernel/audit-foundation/outbox-recorder.ts` are the two consumers.

Confirmed present: event persistence, relay dispatch, retry counting, error capture, processed-state
skipping (`if (options.row.processedAt !== null) return 'skipped'`), module-owned tables, and
transactional atomicity (the outbox insert enlists in the producer's transaction).

**Not present:** exponential backoff or a next-attempt schedule (retries are immediate on the next
poll), a dead-letter terminal state and a max-retry ceiling at the relay level, and any long-running
worker process that actually runs the relay in production. See §7 GAP-INF-2.

---

## 3. The K-10 multi-value gap (P0) — CLOSED

`kernel/ledger-foundation/types.ts` implements a correct double-entry core: `bigint` minor units,
balanced transactions, per-asset-type accounts, derived balances, idempotency keys, and
`ASSET_CLASSES = ['fiat', 'reward', 'digital_asset', 'community']`. The four classes the brief calls
for are all present, which is the hard part and it is done well.

**As found.** An `AssetType` carried only `assetTypeId`, `assetClass`, `symbol`, `precision`,
`transferability`, `withdrawability`, `valuationSource`. The brief (§12) requires each value type to
be able to declare **issuer, unit, redemption, convertibility, expiry, restrictions,
custody/provider and jurisdiction** — none of which existed. `AccountBalance` derived only
`available`, where the brief (§12, §16) requires **available / pending / locked** as distinct
positions.

**Consequence at the time of the audit:** the ledger could not express "Rs 1,500 JAYA rewards,
non-withdrawable, expiring in 180 days, redeemable only against merchant X" as anything other than an
unrestricted balance in a reward-classed account.

### What was built

Migration **0022** and the K-10 library now carry both halves.

**Eight asset-type attributes**, each required rather than optional, so "unrestricted" is a decision
on the record rather than an absence: `issuer` (who a holder has a claim against — refused if it is
not an opaque handle), `unit`, `redeemable`, `convertible`, `expiryDays` (null means never),
`restrictions` (arbitrary JSON, deep-frozen), `custodyProvider` and `jurisdiction` (ISO 3166-1
alpha-2 or `GLOBAL`).

**Three balance positions per account** — `available`, `pending`, `locked` — derived rather than
stored. `balance_state` is a column on `ledger_entry`, not on the account, so a reservation is an
ordinary balanced transaction that debits one position and credits another on the same account. The
account total does not change when its spendability does, the journal stays append-only, and there is
still no balance column that can disagree with the entries. The entry primary key widened to
`(transaction_id, account_id, side, balance_state)` to allow it.

Two rules had to change to make this correct, and both changes are narrowing, not loosening:

- The old "an account may appear at most once per transaction" rule became "each
  `(account, position)` pair may move at most once". The original protection — debiting and
  crediting one balance in one movement, which nets to nothing and hides what was meant — is
  preserved exactly where it applied.
- `registerAssetType` returned the validated record **unsealed**, so a caller held a live handle onto
  the `restrictions` object it had passed in. That was a pre-existing defect, found by writing a
  test for the new field. It is now sealed at the service boundary as well as in the repository.

**What K-10 still does not do, deliberately:** it records that a reward expires in 180 days and may
only be spent at one merchant; it does not expire it, block a withdrawal, or check a basket.
Enforcement belongs to the module spending the value, which is the only unit that knows what it is
being spent on. A position may also go negative — K-10 reports that accurately rather than clamping
it, so a caller can detect it. Both limits are stated in the contract and pinned by tests.

**Evidence:** migration 0022 applies and rolls back cleanly against live PostgreSQL 16 (verified:
`asset_type` 15 columns → 7, `ledger_entry` 5 → 4, then re-applied); 20 new cases in
`tests/ledger-foundation-multi-value.test.ts`.

---

## 3a. The K-13 authority gap (P0) — CLOSED

**Correction to revision 1.** K-13 already had an `AIDecision` record carrying a 0–4 `policyLevel`,
an `approved` flag and an `explanation`. The gap was narrower and worse than "no authority model":
the level was **recorded and never consulted**. `executeTask` did not read it, so any registered task
could be invoked with any authority anybody claimed, and nothing could be switched off.

### What was built

Migration **0023** adds `kernel_ai_gateway.task_authority`: an append-only version history of what
one task is permitted to do, carrying a 0–4 ceiling, a `suspended` flag that is the kill switch, and
a **required, non-empty** `rationale` — a grant nobody explained is a grant nobody can review.
`ai_run` gains `authority_level`, the level the run actually executed under.

`executeTask` now gates before a provider is resolved and before a token is spent, with the most
specific refusal winning:

| Situation | Refusal |
|---|---|
| No grant in force at the run's `startedAt` | `no-authority-grant` |
| The grant is suspended | `authority-suspended` — at **every** level, including 0 |
| Requested level above the ceiling | `authority-exceeded`, naming both levels by number and name |
| Level not on the scale | `invalid-authority-level` |

`requestedAuthority` is required and never defaulted: a run whose authority nobody stated is a run
nobody authorised, and a default would put the gateway's own guess into the audit record. The gate
reads the grant **in force at the run's start instant**, not the newest grant, so tightening a
ceiling later does not retroactively forbid a past run, and loosening it does not retroactively
permit one.

Grants are versions, never edits — enforced by an append-only database trigger — so raising a
ceiling, lowering it and pulling the kill switch are all the same operation, and "who allowed this,
and when" always has an answer. Every grant emits a K-08 event and a K-09 audit record carrying the
rationale.

**The limit of the claim, stated because it is easy to overread.** K-13 executes models, not business
actions. It cannot stop a caller treating a level-1 recommendation as a level-3 instruction, and no
test here claims it can — one test pins that limit down explicitly. What makes that safe is a
different, stronger guarantee that already existed: the deterministic financial authority zone may
not import K-13 **at all**, enforced executably by `npm run check:boundaries`.

**Evidence:** migration 0023 applies and rolls back cleanly against live PostgreSQL 16; 19 new cases
in `tests/ai-gateway-authority.test.ts`. The change also required updating the K-13 surface test from
four operations to six, and the shared test helper now grants authority when it registers a task —
because a task that has not been authorised no longer runs, which is the point.

---

## 4. Business modules — 0 of 47 started

`platform/architecture/manifest.ts` declares 47 business modules across layers L1–L8. `modules/`
contains `README.md` and nothing else. `docs/JAYA_MODULE_MAP.md` marks all 47 **NOT STARTED**, and
that marking is accurate.

| Layer | Modules | Implemented |
|---|---|---|
| L1 Account | M-01 Universal Account, M-02 Capability & Verification | 0 / 2 |
| L2 Primitives | M-03 Commerce Request, M-04 Universal Listing, M-05 Product Catalog | 0 / 3 |
| L3 Discovery | M-06 Search & Discovery, M-07 Matching | 0 / 2 |
| L4 Negotiation | M-08 Offers, M-09 RFQ, M-10 Quotes | 0 / 3 |
| L5 Financial core | M-11 Orders, M-12 Payments, M-13 Financial Ledger, M-14 Commission Rules | 0 / 4 |
| L6 Settlement / risk | M-15 Settlements, M-16 Seller Payouts, M-17 Seller Risk, M-18 Listing Risk | 0 / 4 |
| L7 Fulfilment | M-19 Logistics, M-20 Returns, M-21 Disputes, M-22 Warranty | 0 / 4 |
| L8 Verticals and cockpits | M-23 … M-47 (25 modules) | 0 / 25 |
| **Total** | | **0 / 47** |

---

## 5. Gap analysis against the audit brief, section by section

The brief asked for verification of 30+ capability areas. This table records what was actually found.

| Brief section | Capability | State | Evidence |
|---|---|---|---|
| 5 | Core flow ASK to LEARN | **NOT STARTED** | No module implements any step of it |
| 6 | Need Engine (multimodal, original preserved, confidence, correction) | **NOT STARTED** | M-03 has no directory |
| 7 | Sourcing ladder L1–L5 | **NOT STARTED** | `grep -ri sourcing kernel platform modules apps` returns 0 files |
| 8 | RFQ / tendering, partial bids, split supply | **NOT STARTED** | M-09/M-10 have no directory |
| 9 | Match engine, explainable, overridable | **NOT STARTED** | M-07 has no directory |
| 10 | Inventory contract (`reserve`/`release`/`commit`…) | **NOT STARTED** | M-04 has no directory |
| 11 | Payment orchestration and provider abstraction | **NOT STARTED** | M-12 has no directory; no `PaymentProvider` port exists |
| 12 | Universal multi-value ledger | **DONE (kernel)** | Closed by this pass — 8 asset attributes and 3 balance positions, migration 0022 (section 3). No business module posts to it yet |
| 13 | Double-entry ledger, balancing invariants | **PARTIAL** | K-10 enforces balance and `bigint`; **no business posting exists** |
| 14 | Value routing / mixed-value payment with consent | **NOT STARTED** | Depends on section 12 and M-12 |
| 15 | Cockpit read models (NOW / MY COMMERCE / …) | **NOT STARTED** | M-36/M-37/M-38 have no directory; no projection engine |
| 16 | Financial cockpit data | **NOT STARTED** | Depends on section 15 |
| 17 | Life budget / wellbeing | **NOT STARTED** | M-31 Budgeting has no directory |
| 18 | Introducer / peer marketing | **NOT STARTED** | M-29/M-30 have no directory |
| 19 | Merchant / supplier / member systems | **NOT STARTED** | No module |
| 20 | Demand intelligence, Demand Clouds | **NOT STARTED** | M-32/M-33 have no directory |
| 21 | Wholesale / Singha connector | **NOT STARTED** | No connector interface, no mock, no tests |
| 22 | Logistics / Yaanadiri | **NOT STARTED** | M-19 has no directory; no `LogisticsProvider` port |
| 23 | Route consolidation | **NOT STARTED** | — |
| 24 | AI gateway / router / provider adapters | **PARTIAL** | K-13 is real: `PROVIDERS = [mock, openai, anthropic, kimi, deepseek, local]`, task router, cost tracking, `AIRun`/`AIDecision`, `adapters/ai-provider.ts` port plus `mock-ai-provider.ts`. **Only the mock is implemented; no fallback chain.** |
| 25 | 16 specialist agents | **NOT STARTED** | None exists — correctly, no fake autonomy was faked |
| 26 | AI authority levels 0–4, kill switch | **DONE (kernel)** | Closed by this pass — migration 0023 (section 3a). Revision 1 overstated this: K-13 already recorded a 0–4 `policyLevel` on `AIDecision`; what was missing was enforcement |
| 27 | Privacy / contextual commerce consent | **NOT STARTED** | No consent module |
| 28 | Services vertical | **NOT STARTED** | M-24 has no directory |
| 29 | Security review (authn/authz/IDOR/injection/…) | **NOT ASSESSABLE** | There is no API, no HTTP surface, no file upload and no session-bearing endpoint to attack. Kernel-level hygiene is strong (see section 6) |
| 30 | Failure / chaos behaviour | **PARTIAL** | Outbox retry, idempotency and concurrency convergence are genuinely tested at kernel level. No provider-failure, webhook-reorder or worker-restart scenarios exist because no provider, webhook or worker exists |
| 31 | Demo / seed environment | **NOT STARTED** | 2 fixture datasets, 13 rows, both kernel-internal. No persona, no Need, no RFQ, no order |
| 34/35 | UI | **NOT STARTED** | `apps/` and `design-system/` are empty. There is no functional placeholder UI to repair |

---

## 6. What the security posture actually is

A conventional application security review (brief section 29) cannot be performed: there is no HTTP
surface, no session-bearing endpoint, no upload path, no template rendering and no SQL string
interpolation of user input to attack. What *can* be assessed is the kernel's own hygiene, and it is
unusually strong:

- **Secret-bearing input refusal.** Every kernel `registry.ts` refuses identifiers containing
  `password`, `token`, `apikey`, `bearer`, … and refuses values matching private-key headers,
  `sk-…`, `ghp_…`, `AKIA…`, JWTs and `postgres://user:pass@` URLs.
- **Natural-key refusal.** Identifiers that look like emails, phone numbers, IBANs, URLs, domains or
  `first.last` names are refused, with the erasure-request rationale stated in the error.
- **Parameterised SQL only.** No string-concatenated user input was found in any repository.
- **Append-only enforcement in the database.** 34 triggers across 34 tables refuse UPDATE/DELETE.
  K-02's session trigger permits exactly two mutations (rotate secret, record revocation).
- **Session secrets stored as SHA-256 only**, presented once, with absolute and idle expiry.
- **Test-database blast-radius guards.** Loopback-only host and a mandatory `_test` name suffix,
  asserted at three separate layers.

**Unresolved Critical/High issues: none found — because the attack surface does not exist yet.**
This must not be read as "the platform is secure". It means the security review is deferred, not
passed. The K-04 finding below is the one item that becomes High the moment an API exists.

| ID | Severity | Finding |
|---|---|---|
| SEC-1 | **High (latent)** | K-04 Permissions exists and **nothing calls it**. No code path in the repository is authorisation-guarded. This is P0 the instant the first endpoint ships |
| SEC-2 | **Medium (latent)** | K-02 ships only `MockVerifier`. Nothing can authenticate a real person |
| SEC-3 | **Medium (latent)** | K-04 has no read-back API, so authority cannot be displayed or reviewed — an operational and audit gap |
| SEC-4 | Low | `.env` is committed with a development-only password. It is loopback-bound and disposable, and the file says so, but it is still a committed credential-shaped file |

---

## 7. Infrastructure and process gaps

| ID | Severity | Gap |
|---|---|---|
| GAP-INF-1 | Medium | The integration suite is exclusive by construction (single derived `jaya_dev_test`). Two concurrent runs corrupt each other with a `pg_database` unique violation. Needs either a per-worker database name or a documented lock |
| GAP-INF-2 | Medium | The outbox relay has no backoff schedule, no max-retry ceiling and no dead-letter terminal state, and **no worker process runs it**. Today the relay only advances when a test drives it |
| GAP-INF-3 | High | **No CI.** Blocked by BL-10 (missing Workflows credential permission). Every check is local and manual |
| GAP-INF-4 | Medium | No observability: no structured logging, no metrics, no tracing, no health endpoint |
| GAP-INF-5 | Medium | No HTTP/API layer at all. `apps/` is empty, so no module can be reached by anything |
| GAP-INF-6 | Medium | **A component's schema stops being rollback-isolated the moment it is extended.** The runner rolls back in strict reverse order, one version at a time (`rollback-not-latest`). While each component owned exactly one migration at the head, "roll this component back" and "roll the newest migration back" were the same act. Now that 0022 extends K-10 across four other components' migrations, and 0023 extends K-13 across three, neither component's schema can be removed without removing theirs first. Nothing is broken by this — forward migration, per-migration rollback and re-application all work, and both were verified round-tripping against live PostgreSQL — but the "rolls back independently of other schemas" property is gone for any extended component, and the two tests asserting it were rewritten to assert the narrower thing that is still true. A per-component migration ledger, or grouping a component's DDL under one reversible unit, would restore it; both are larger changes than this pass should make unannounced |

---

## 8. Module scorecard (requested table format)

`—` means the dimension does not exist to be scored.

| Module | Impl % | Functional? | Persisted? | API? | Perms? | Tests? | Prod integration? | Outstanding | Priority |
|---|---|---|---|---|---|---|---|---|---|
| platform substrate | 95% | Yes | Yes | — | — | Yes | Local only | CI, observability | P0 |
| K-01 Identity | 90% | Yes | Yes | No | No | Yes | No | API, callers | P1 |
| K-02 Authentication | 75% | Yes | Yes | No | No | Yes | No | Real verifier | P0 |
| K-03 Accounts | 90% | Yes | Yes | No | No | Yes | No | API, callers | P1 |
| K-04 Permissions | 65% | Yes | Yes | No | n/a | Yes | No | Read-back API; **wire to every path** | P0 |
| K-05 Configuration | 95% | Yes | Yes | No | No | Yes | No | — | P3 |
| K-06 Policy Engine | 85% | Yes | Yes | No | No | Yes | No | Financial consumer | P1 |
| K-07 Feature Flags | 95% | Yes | Yes | No | No | Yes | No | — | P3 |
| K-08 Event Infrastructure | 90% | Yes | Yes | No | No | Yes | No | Real producers | P1 |
| K-09 Audit Foundation | 90% | Yes | Yes | No | No | Yes | No | Real producers | P1 |
| K-10 Ledger Foundation | 85% | Yes | Yes | No | No | Yes | No | Business callers; no module posts to it yet | P1 |
| K-11 Commerce Unit Registry | 90% | Yes | Yes | No | No | Yes | No | Callers | P2 |
| K-12 Conversation Foundation | 85% | Yes | Yes | No | No | Yes | No | Callers | P2 |
| K-13 AI Gateway | 75% | Yes | Yes | No | No | Yes | No | Fallback chain, real provider adapters (externally blocked) | P2 |
| K-14 Notifications | 70% | Yes | Yes | No | No | Yes | No | Live channel adapters | P2 |
| K-15 Search Foundation | 85% | Yes | Yes | No | No | Yes | No | Callers, semantic search | P2 |
| **M-01 … M-47** | **0%** | **No** | **No** | **No** | **No** | **No** | **No** | **Everything** | **P0–P3** |
| apps/ (API and UI) | 0% | No | — | No | No | No | No | Everything | P0 |
| design-system/ | 0% | — | — | — | — | No | No | Everything | P2 |

---

## 9. Prioritised backlog

### P0 — architecture, financial correctness, security, data integrity

1. ~~**K-10 multi-value completion.**~~ **DONE** — migration 0022, section 3.
2. ~~**K-13 AI authority model.**~~ **DONE** — migration 0023, section 3a.
3. ~~**M-01 / M-02** — Universal Account and Capability & Verification.~~ **DONE** — migrations 0024
   and 0025, 74 unit tests and 13 live-PostgreSQL integration tests, sections 13 and 14. L1 is
   complete.
4. **M-04 Universal Listing / Inventory contract** — the replaceability requirement (brief section 10)
   is the single most-cited architectural requirement in the brief and nothing implements it.
5. **M-11 / M-12 / M-13** — Orders, Payments (with a `PaymentProvider` port and mock adapter),
   Financial Ledger posting onto K-10.
6. **Wire K-04 Permissions into every service entry point.**
7. **Outbox relay worker** with backoff, retry ceiling and dead-letter.

### P1 — core commerce workflows

8. M-03 Commerce Request (Need Engine) with original-request preservation, structured interpretation,
   confidence and user correction.
9. Sourcing ladder (L1 inventory, L2 known, L3 verified, L4 discovery, L5 RFQ).
10. M-09 RFQ / M-10 Quotes with partial bids and split fulfilment.
11. M-07 Matching with configurable, explainable, overridable factors.
12. M-06 Search and Discovery over K-15.
13. M-14 Commission Rules / M-15 Settlements.

### P2 — production operation

14. M-19 Logistics with a `LogisticsProvider` port; Yaanadiri adapter skeleton plus mock.
15. Singha connector interface plus mock plus contract tests.
16. M-28 Rewards, M-29 Referrals, M-30 Attribution (introducer model).
17. M-36/M-37/M-38 cockpit projections and read models.
18. HTTP API layer in `apps/`.
19. Observability, CI (unblock BL-10).

### P3 — advanced AI

20. Specialist agents against the K-13 gateway, once authority controls exist.
21. Demand intelligence and Demand Clouds.
22. Semantic / visual search.

---

## 10. Honest schedule assessment

At the quality bar this repository already holds — roughly 2,400 lines of source plus 60–100 tests
per kernel component, with a contract document, a migration and an in-memory reference repository —
the outstanding work is:

- 47 business modules at roughly 2,500 LOC each, about **115,000 lines** of production code
- plus roughly 3,500 tests
- plus an HTTP API layer, a worker runtime, an observability stack, a demo dataset and the UI

This is a multi-month programme for a team, not a single session's work, and no honest process can
compress it. **The codebase is not ready to begin final UI/UX**, because the contracts the UI would
bind to — Need, Listing, Order, Payment, Cockpit projection — do not exist in any form.

The right next move is to build the L1 to L5 commerce spine (M-01, M-02, M-03, M-04, M-09, M-10,
M-07, M-11, M-12, M-13) onto the kernel that is already there, and to close the two P0 kernel gaps in
K-10 and K-13 first, because every module above them depends on those contracts being right.

---

## 11. What was verified versus what was inferred

**Executed:** typecheck, lint, format, boundary checks, migration checks, fixture checks, the
1591-case unit suite, a live-PostgreSQL integration run, and direct reading of every kernel
component's `types.ts`, plus the relay, the outbox contract, the boundary checker and the
architecture manifest.

**Inferred from file absence, then confirmed against the manifest and the module map:** the 0/47
business-module count and the empty `apps/` and `design-system/` roots.

**Not verified at the time of writing:** the live integration suite's per-file pass counts; a
baseline run was in progress. Nothing in this document depends on that number.

---

## 12. Work completed during this audit pass

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Independent verification of the whole tree | Done | Section 1 |
| 2 | This gap analysis | Done | This document |
| 3 | **P0-1 K-10 universal multi-value model** | Done | Migration 0022, 20 tests, section 3 |
| 4 | **P0-2 K-13 AI authority controls** | Done | Migration 0023, 19 tests, section 3a |
| 5 | Latent defect: unsealed asset type at the K-10 service boundary | Fixed | Found by test, section 3 |
| 6 | Ledger transaction uniqueness rule narrowed to `(account, position)` | Fixed | Section 3 |
| 7 | K-13 `invalid-authority-level` now owns its whole check | Fixed | `1.5` was refused with the wrong code |
| 8 | Two integration tests pinned a stale schema/code pairing | Fixed | They migrated to 0017 / 0019 and drove current repositories |
| 9 | Rollback isolation is lost when a component is extended | Recorded, not fixed | GAP-INF-6; the two affected tests now assert the narrower property that is still true |
| 10 | K-13 end-to-end outbox count was 4, now 6 | Fixed | A grant emits an event and an audit record like every other fact |

Test count moved from 1591 to 1630 unit cases. Everything else in section 9's backlog is untouched:
**0 of 47 business modules exist**, and the conclusion in section 10 is unchanged.

---

## 13. Work completed after the audit — M-01 Universal Account

**Date:** 2026-08-29. Section 0's headline finding — "**No business capability exists.** `modules/`
contains one README and no code" — is no longer true of `modules/`. It remains true of `apps/` and
`design-system/`, and 46 of the 47 business modules are still unbuilt.

| # | Item | Evidence |
|---|---|---|
| 1 | M-01 domain, service, in-memory repository, PostgreSQL adapter, contract | `modules/universal-account/` |
| 2 | The first module-owned schema | Migration 0024, `module_universal_account` |
| 3 | 32 unit tests | `tests/universal-account.test.ts`, `tests/universal-account-repository.test.ts` |
| 4 | 6 live-PostgreSQL integration tests | `tests/integration/universal-account.integration.ts` |
| 5 | Defect: an outbox id collided with itself on reactivation | Found by test, fixed; ids derive from the transition |
| 6 | Defect: a whitespace-only reason passed TypeScript and would have been refused by the migration's `btrim` CHECK | Found by test, fixed |
| 7 | `tests/migrations.test.ts` asserted no business module owned a schema | Replaced by the property that survives M-01 |
| 8 | `tests/status-docs.test.ts` counted only kernel units as implemented | Now counts business modules on the same terms |

**What M-01 does not do**, and what section 10's schedule assessment therefore still holds: nothing
calls it. No API, no UI, no consumer of `capability.activated` or `capability.deactivated`, no
`suspend` operation, no K-02 authentication and no K-04 authorisation behind activation, and no
check that the K-03 account it names exists. It is a foundation, on the same terms as every kernel
component above it.

---

## 14. Work completed after the audit — M-02 Capability & Verification

**Date:** 2026-08-29. With M-01 and M-02 both delivered, **layer L1 is complete**: an account holds
roles, and the platform records how far it has checked them. Section 9's backlog item 3 is closed.
45 of the 47 business modules remain unbuilt, `apps/` and `design-system/` are still empty, and
section 10's schedule assessment is unchanged.

| # | Item | Evidence |
|---|---|---|
| 1 | M-02 domain, service, in-memory repository, PostgreSQL adapter, contract | `modules/capability-verification/` |
| 2 | Migration 0025, with a **partial** unique index and two append-only triggers | `db/migrations/0025_*` |
| 3 | 42 unit tests | `tests/capability-verification*.test.ts` |
| 4 | 7 live-PostgreSQL integration tests | `tests/integration/capability-verification.integration.ts` |
| 5 | Defect: rejecting a case emitted nothing at all | Fixed — `verification.rejected` and its audit record |
| 6 | Defect: a purpose beginning with a digit passed TypeScript and would have been refused by the migration's CHECK | Fixed — the validator now requires a leading letter |
| 7 | `occurredAt` on a rejection request was a field the module ignored | Removed rather than left in the surface |

### The property this module exists to hold

`evidence.reference` is an opaque handle to an artefact another system stores, checked against the
same `is_opaque_identifier` rule set as every identifier — **twice**, in the service and as a
database `CHECK`. The integration suite proves the second by issuing five inserts that each carry
something real and forbidden — an email, a passport-shaped digit run, an IBAN, a URL to the document
itself, a credential — and asserting the database refuses each by constraint name.

A verification record outlives the thing it verifies and is copied into every downstream projection.
A document number written into one is disclosed for as long as the platform exists, and no later
deletion policy can recall it. That is why the refusal is enforced in the schema rather than only in
the code that writes to it.

### What M-02 does not do

**No verifier exists.** M-02 records the level a caller says was reached and checks nothing itself:
no document verification, no sanctions or PEP screening, no liveness check, no identity bureau. The
`evaluateLevel` caller is the authority, and there is no such caller. There is also no API, no UI, no
consumer of any of the five events, no `withdraw` operation, no evidence expiry or re-verification
schedule, and no K-02 authentication or K-04 authorisation behind approval — anyone holding the
repository can approve any case.
