# JAYA — CURRENT IMPLEMENTATION STATUS

**Overall status:** `TOOLCHAIN SUBSTRATE ONLY — NO BUSINESS CAPABILITY`
**Baseline established:** 2026-08-19 by task DOC-001
**Last updated:** 2026-08-26 by task FND-005h (K-15 Search Foundation: search document and query-log primitives, keyword full-text search with a generated `tsv` tsvector, idempotent indexing and query logging, foreign-field refusal, append-only query log, deterministic caller-supplied identifiers and instants, an injected repository port with in-memory and PostgreSQL adapters, and migration 0021 under `kernel_search_foundation`. **No caller indexes or searches anything.**). Preceded by FND-004c (K-02 Authentication foundation: authentication by asking an injected verifier and checking its answer, append-only bindings and evidence, assertions consumed exactly once, factor categories and a per-provider MFA floor that may be raised and never lowered, and sessions whose secret is presented once and stored only as a SHA-256, with absolute and idle expiry, guarded rotation and revocation, and exact-idempotency convergence. **No verifier ships**, so nothing in it can authenticate a real person). Preceded by FND-004b (K-03 Universal Account foundation, and the first real K-01 consumer), FND-004a (K-01 Identity foundation), and FND-003c (K-09 Audit Foundation: an immutable audit-record contract with classified evidence, an append-only store refused at four layers, idempotent recording and deterministic paginated retrieval). Preceded by FND-002d, as corrected twice (seed and fixture foundation: a versioned deterministic manifest contract, an injected transactional seed runner with two target guards, and development datasets for the K-05 and K-08 foundations; then mandatory validation on every runner path, a single-transaction replacement, and recomputed payload fingerprints; then complete runtime shape validation for programmatic callers and required evidence on every event row). Preceded by FND-003b, as corrected (K-08 Event Infrastructure foundation: envelope and type registry, durable append, at-least-once delivery with consumer receipts, bounded retry, dead-lettering and operator-explicit replay; then commit-time conflict parity with PostgreSQL, convergent concurrent retries, and a transaction-scoped append path a producer can enlist in its own transaction). Preceded by FND-003a, as corrected three times (explicit draft lifecycle, replacement ordering that respects the partial unique index, content-matched idempotency, explicit region in resolution; then canonical instant comparison, deterministic refusal of competing publications, and retries answered after supersession; then timestamps projected as UTC text so the driver cannot truncate them). Preceding updates: FND-002a (PostgreSQL selection, migration contract, schema namespaces), FND-001d (contributor documentation), FND-001b (source roots, architecture manifest, four executable boundary checks).
**Authority rank:** 2 per `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` §1 — second only to the master guide
**Branch:** `conductor/jaya-p2p-com-47859d`

**Related baseline documents:**
- [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md)
- [MODULE_MAP.md](./MODULE_MAP.md)

> **Read this first.** The repository now installs, builds, type-checks, lints, format-checks and tests from a clean dependency state. That is the whole of what exists in code.
>
> Four of the eight architectural checks in [MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification) are now executable and run inside `npm run verify`, each proven by a committed planted-violation fixture.
>
> Local provisioning is delivered (FND-002c): `compose.yaml` pins PostgreSQL 16.10 with a health check, a named data volume and loopback-only binding; `db:up`/`db:ready`/`db:migrate`/`db:status`/`db:reset`/`db:down`/`db:destroy` drive it; and the integration suites derive a guarded, isolated test database rather than touching the development one. A Docker runtime is available in this environment, so `npm run test:integration` now passes when `DATABASE_URL` is configured; when no runtime is available the suites **skip** with their reason stated, and a skipped run is not evidence.
>
> The data foundation has begun. FND-002a selected PostgreSQL 16+, delivered the migration file contract enforced by `npm run check:migrations` with a planted-invalid fixture per rule, and derived the schema-namespace ownership convention from the architecture manifest. FND-002b added the runner: a PostgreSQL adapter, advisory locking, SHA-256 checksum reconciliation, and atomic application of each migration with its ledger row, all written against an injected database interface and covered by 35 deterministic tests.
>
> **No database is provisioned and no migration has been executed against a live server.** No PostgreSQL runtime is available to this repository; the runner is proved against a fake, and the opt-in integration test skips with its reason stated. A skipped test is not evidence, so P0-14 and P0-15 stay incomplete.
>
> Contributor documentation and git conventions are delivered (FND-001d) and are themselves under an executable contract: [docs/CONTRIBUTING.md](./CONTRIBUTING.md) is read by `tests/docs-contract.test.ts`, which fails the build if a documented guarantee is deleted or softened.
>
> There is still **no CI, no database, no business module and no UI**. **Fourteen** kernel components now have cores — **K-01 Identity** (§11.21–§11.22), **K-02 Authentication** (§11.25), **K-03 Accounts** (§11.23–§11.24), **K-04 Permissions** (§11.26–§11.29), **K-05 Configuration** (§11.10–§11.13), **K-06 Policy Engine** (§11.31), **K-07 Feature Flags** (§11.30), **K-08 Event Infrastructure** (§11.14–§11.15), **K-09 Audit Foundation** (§11.19–§11.20), **K-10 Ledger Foundation** (§11.33), **K-12 Conversation Foundation** (§11.34), **K-13 AI Gateway** (§11.35), **K-14 Notifications** (§11.36) and **K-15 Search Foundation** (§11.37) — and none is complete: no API, no producing or consuming unit, no caller, and nothing applied to a live server. Build steps **B-1 and B-2 are covered**, and **B-3 is open** with K-06, K-10, K-12, K-13, K-14 and K-15. **K-02 exists and ships no verifier**, so the component that would authenticate a real person cannot yet do so; **K-04 exists and nothing asks it**, so no path in this repository is actually guarded; its surface is four operations — publish a policy version, grant, revoke, authorise — and **no way to read authority back**, the three read methods having been removed rather than guarded (§11.29). **K-06 exists and nothing evaluates a policy**, so no amount anywhere has been priced by one and no record has yet pinned a policy version id — which is the whole reason the component exists (v3 §35, §24). **K-10 exists and nothing calls it**, so no value has moved and no consumer reads its outbox. **K-12 exists and nothing calls it**, so no conversation, participant or message is created by any unit. **K-13 exists and nothing calls it**, so no task is executed by a real provider adapter and no business module consumes its outbox. **K-14 exists and nothing calls it**, so no business module sends a notification and no live provider adapter delivers one. **K-15 exists and nothing calls it**, so no caller indexes or searches anything and no live consumer reads its query log. FND-001 is **not complete** — subtask FND-001c (CI) is **blocked by BL-10**: the repository credential lacks the Workflows permission, so no change touching `.github/workflows/` can reach the remote. `modules/`, `design-system/` and `apps/` exist as tracked, documented roots and are **empty of implementation**; `kernel/` holds the fourteen component foundations above.
>
> Exact commands and results: §11.1 (FND-001a), §11.2 (FND-001b) and §11.4 (FND-001d).

---

## Table of contents

- [1. Status summary](#1-status-summary)
- [2. What actually exists in the repository](#2-what-actually-exists-in-the-repository)
- [3. Decision — guide hierarchy](#3-decision--guide-hierarchy)
- [4. Absent infrastructure](#4-absent-infrastructure)
- [5. Current risks](#5-current-risks)
- [6. Blockers](#6-blockers)
- [7. P0 / P1 defect tracking](#7-p0--p1-defect-tracking)
- [8. Next highest-priority unblocked task](#8-next-highest-priority-unblocked-task)
- [9. Selected first implementation slice](#9-selected-first-implementation-slice)
- [10. Release gate summary](#10-release-gate-summary)
- [11. Evidence register](#11-evidence-register)
- [12. Update protocol](#12-update-protocol)

---

## 1. Status summary

| Dimension | State |
|---|---|
| Phase | Phase 0 — Foundation. **In progress.** Toolchain, boundary enforcement, the migration and fixture contracts, and **fourteen** kernel component foundations (K-01, K-02, K-03, K-04, K-05, K-06, K-07, K-08, K-09, K-10, K-12, K-13, K-14 and K-15). No database server has ever been started here. |
| Application code | None. Substrate only: `platform/runtime/` (2 modules), `platform/architecture/` + `platform/checks/` (4 modules) and `platform/db/` (7 modules) — version pins, boundary enforcement, documentation and migration contracts, and the migration runner. One runtime dependency: `pg`, used only by the runner. |
| Database | **Selected and provisionable, never started here.** PostgreSQL 16.10 pinned in `compose.yaml` (FND-002c), started with `npm run db:up`. A runner exists (FND-002b) and the `pg` driver is declared, so code in this repository *does* open connections when invoked — but no Docker runtime is available to this repository, so no server has ever been started and no connection has ever succeeded. |
| Seed data | 2 datasets (K-05 configuration history, K-08 delivery states), validated by `npm run check:fixtures` and by every runner path (FND-002d, as corrected). **Never loaded into a live server.** No business-module, financial-policy or production data. |
| Migrations | 25 forward + 25 rollback, validated statically by `npm run check:migrations`, applied by `npm run db:migrate` (FND-002b). Migrations 0013–0016 added module-owned transactional outbox tables for K-05 (`kernel_configuration.outbox`), K-06 (`kernel_policy_engine.outbox`), K-07 (`kernel_feature_flags.outbox`) and K-11 (`kernel_commerce_unit_registry.outbox`), so each module can append domain events and audit records atomically with its own business mutation. Migration 0018 adds the `kernel_conversation_foundation` schema with K-12's conversation, participant, message and outbox tables. Migration 0017 adds the `kernel_ledger_foundation` schema with K-10's asset-type registry, ledger accounts, balanced transactions, entries and outbox. Migration 0019 adds the `kernel_ai_gateway` schema with K-13's task-definition, model-binding, AI-run, AI-decision and outbox tables. Migration 0020 adds the `kernel_notifications` schema with K-14's channel, notification, delivery-attempt and outbox tables. Migration 0021 adds the `kernel_search_foundation` schema with K-15's document, query-log and outbox tables. Migration 0022 extends K-10 with the universal multi-value model: eight asset-type attributes (`issuer`, `unit`, `redeemable`, `convertible`, `expiry_days`, `restrictions`, `custody_provider`, `jurisdiction`) and a `balance_state` column on `ledger_entry` that splits every account into three derived positions — available, pending and locked — with the entry primary key widened to match, so a transaction may move value between two positions of one account without changing its total. Migration 0023 adds K-13's `task_authority` table — an append-only version history of what one task is permitted to do, carrying a 0-4 ceiling, a suspension flag that is the kill switch, and a required rationale — plus an `authority_level` column on `ai_run` recording the level each run actually executed under. `executeTask` now refuses a task with no grant in force, a suspended task at every level including observe, and any request above the granted ceiling. They create the `platform` schema, the migration ledger, the `kernel_configuration` schema with K-05's version and outbox tables, the `kernel_event_infrastructure` schema with K-08's event log, delivery and receipt tables, and the `kernel_audit_foundation` schema with K-09's append-only audit table, the `kernel_identity` schema with K-01's write-once subject table, the `kernel_accounts` schema with K-03's universal-account table and its `UNIQUE (subject_id)` one-account-per-party constraint, the `kernel_authentication` schema with K-02's binding, evidence and session tables, the `kernel_permissions` schema with K-04's policy-version, grant, revocation and decision tables, the `kernel_feature_flags` schema with K-07's flag-version, activation, lifecycle and outbox tables, the `kernel_policy_engine` schema with K-06's draft, version, activation, retirement and outbox tables, the `kernel_commerce_unit_registry` schema with K-11's type-version, activation, retirement and outbox tables, the `kernel_ledger_foundation` schema with K-10's asset-type, account, transaction, entry and outbox tables, and the `kernel_conversation_foundation` schema with K-12's conversation, participant, message and outbox tables, and the `kernel_ai_gateway` schema with K-13's task-definition, model-binding, AI-run, AI-decision and outbox tables. Thirty-eight triggers across thirty-eight tables refuse to update or delete a row — all four of K-04's, because authority history is append-only; K-13's `task_authority` trigger, because a grant is a new version and never an edit; K-12's three, because conversation records are append-only; K-02's session trigger permits exactly two changes — rotate the secret, record a revocation — and refuses everything else; K-14's two, because channel and delivery-attempt records are append-only; and M-01's `capability_state` trigger, because the log of how a capability reached its current status is append-only. Migration 0024 creates the first business-module schema, `module_universal_account`, with M-01's `account_capability` table (one row per account and capability, `UNIQUE (account_id, capability)`), its append-only `capability_state` transition log and its outbox. Its `account_id` is an opaque K-03 identifier and deliberately not a foreign key: Migration 0025 creates the second business-module schema, `module_capability_verification`, with M-02's verification-case table, its append-only `evidence` and `level_record` tables and its outbox. A partial unique index allows one *open* case per (account, purpose) while leaving a decided or withdrawn case unable to block the next attempt, and `evidence.reference` runs through the same opacity rule set as every identifier, which is what keeps a passport number, a tax number or a document URL out of a verification row. |
| Tests | 1591 passing (`npm test`, exit 0) — substrate, boundary enforcement, documentation contract, migration contract, migration runner, seed/fixture contract, and the K-01 Identity, K-02 Authentication, K-03 Accounts, K-04 Permissions, K-05 Configuration, K-06 Policy Engine, K-07 Feature Flags, K-08 Event Infrastructure, K-09 Audit Foundation, K-10 Ledger Foundation, K-12 Conversation Foundation, K-13 AI Gateway, K-14 Notifications and K-15 Search Foundation suites. K-05, K-06, K-07 and K-11 each gained an outbox suite (`configuration-outbox` 2, `policy-engine-outbox` 4, `feature-flags-outbox` 4, `commerce-unit-registry-outbox` 5 cases). K-04 accounts for 104 of them across six suites (`permissions` 19, `permissions-decisions` 21, `permissions-administration` 20, `permissions-repository` 18, `permissions-idempotency` 14, `permissions-concurrency` 12), K-07 for 88 across five (`feature-flags` 17, `feature-flags-evaluation` 20, `feature-flags-repository` 21, `feature-flags-concurrency` 18, `feature-flags-rollout` 12), and K-06 accounts for 81 of them across five suites (`policy-engine-repository` 22, `policy-engine-evaluation` 18, `policy-engine-lifecycle` 15, `policy-engine` 13, `policy-engine-decimal` 13). K-10 accounts for 25 of them across two suites (`ledger-foundation` 15, `ledger-foundation-repository` 10), K-12 accounts for 71 across two (`conversation-foundation` 43, `conversation-foundation-repository` 28), K-13 accounts for 80 across three (`ai-gateway` 47, `ai-gateway-repository` 30, `ai-gateway-mock-provider` 3), and K-14 accounts for 63 across two (`notifications` 36, `notifications-repository` 27), and K-15 accounts for 57 across two (`search-foundation` 30, `search-foundation-repository` 27). A further 91 live-PostgreSQL tests exist; when a PostgreSQL runtime is configured they **pass**, and when none is configured they **skip** with their reason stated |
| CI | None — FND-001c, blocked by BL-10. Every check runs locally via `npm run verify`; nothing runs automatically on a change. |
| Environments | None (local only; no staging, no production) |
| Deployment | None |
| Monitoring | None |
| Modules implemented | 15 of 62 partially — **K-01 Identity** (FND-004a), **K-02 Authentication** (FND-004c), **K-03 Accounts** (FND-004b), **K-04 Permissions** (FND-004d), **K-05 Configuration** (FND-003a), **K-06 Policy Engine** (FND-005b), **K-07 Feature Flags** (FND-004e), **K-08 Event Infrastructure** (FND-003b), **K-09 Audit Foundation** (FND-003c), **K-10 Ledger Foundation** (FND-005c), **K-12 Conversation Foundation** (FND-005d), **K-13 AI Gateway** (FND-005e), **K-14 Notifications** (FND-005g) **K-15 Search Foundation** (FND-005h) and **M-01 Universal Account** (the first business module), cores only; 1 of 47 business modules. All 62 registered in the architecture manifest |
| Boundary rules enforced | 4 of 8 (`layer-direction`, `kernel-purity`, `financial-zone-ai`, `provider-import`); the other 4 need a schema, policy values or module contracts to exist |
| Module contracts written | 15 of 62 — [`kernel/identity/CONTRACT.md`](../kernel/identity/CONTRACT.md), [`kernel/authentication/CONTRACT.md`](../kernel/authentication/CONTRACT.md), [`kernel/accounts/CONTRACT.md`](../kernel/accounts/CONTRACT.md), [`kernel/permissions/CONTRACT.md`](../kernel/permissions/CONTRACT.md), [`kernel/configuration/CONTRACT.md`](../kernel/configuration/CONTRACT.md), [`kernel/policy-engine/CONTRACT.md`](../kernel/policy-engine/CONTRACT.md), [`kernel/feature-flags/CONTRACT.md`](../kernel/feature-flags/CONTRACT.md), [`kernel/event-infrastructure/CONTRACT.md`](../kernel/event-infrastructure/CONTRACT.md), [`kernel/audit-foundation/CONTRACT.md`](../kernel/audit-foundation/CONTRACT.md), [`kernel/ledger-foundation/CONTRACT.md`](../kernel/ledger-foundation/CONTRACT.md), [`kernel/conversation-foundation/CONTRACT.md`](../kernel/conversation-foundation/CONTRACT.md), [`kernel/ai-gateway/CONTRACT.md`](../kernel/ai-gateway/CONTRACT.md), [`kernel/notifications/CONTRACT.md`](../kernel/notifications/CONTRACT.md) [`kernel/search-foundation/CONTRACT.md`](../kernel/search-foundation/CONTRACT.md) and [`modules/universal-account/CONTRACT.md`](../modules/universal-account/CONTRACT.md) |
| Tracked requirements | 474, each with an explicit status; **4 of 472 implementation items complete** (P0-03, P0-11, P0-12, P0-13). 42 are `IN PROGRESS`, 19 are `COMPLETE` (14 kernel module contracts and P0-01 documentation artefact), 9 are `BLOCKED`. |
| Release gates met | 0 of 26 |
| Open P0 defects | 0 |
| Open P1 defects | 0 |
| Open blockers | 9, none on the current critical path |
| Permitted completion language | *"Planning baseline established; toolchain and boundary enforcement delivered."* Not "FND-001 complete", not "Phase 0 complete", not "MVP candidate". |

**Per v3 §64**, no completion claim beyond the substrate may be made. Per v3 §54, nothing containing a placeholder may be called complete. The accurate description of this repository is: **a specification with a planning baseline, a working build/test harness, enforced architectural boundaries, and no product.**

---

## 2. What actually exists in the repository

Verified by direct inspection of the working tree at baseline time.

| Path | Type | Description |
|---|---|---|
| `.conductor/brief/JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` | Specification | 2,211 lines. The authoritative master guide (68 sections). |
| `.conductor/brief/JAYA___Autonomous_Build_Master_Development_Guide___Completion_Checklist_v1.0.md` | Specification | 2,861 lines. The v1.0 guide and completion checklist (108 sections). |
| `.conductor/state.json` | Orchestration state | Plan, decisions, concerns, last instruction. |
| `docs/CURRENT_IMPLEMENTATION_STATUS.md` | Planning baseline | This document. Created by DOC-001. |
| `docs/MASTER_IMPLEMENTATION_CHECKLIST.md` | Planning baseline | Created by DOC-001. |
| `docs/MODULE_MAP.md` | Planning baseline | Created by DOC-001. |
| `docs/tools/validate-doc-links.mjs` | Documentation tooling | Link and anchor validator for the `/docs` Markdown set. Created by DOC-001. Not application code, not part of any module; requires only a Node runtime and no package manifest. |

**Added by FND-001a:**

| Path | Type | Description |
|---|---|---|
| `package.json`, `package-lock.json`, `.nvmrc` | Toolchain | **Pinned development toolchain:** Node 26.7.0 (`.nvmrc`), npm 11.19.0 (`packageManager`). **Supported ranges:** `engines.node >=22.18.0`, `engines.npm >=10.0.0`. Six devDependencies pinned to exact versions with a committed lockfile. |
| `tsconfig.json`, `tsconfig.build.json` | Toolchain | Strict TypeScript; erasable-syntax-only so Node runs the sources directly with no build step between editing and testing. |
| `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore` | Toolchain | Type-aware lint, formatting, line-ending and ignore rules. |
| `platform/runtime/node-version.ts` | Substrate | Version parsing, comparison and minimum-range checking, so the `engines.node` range is verifiable from code instead of only declared. |
| `platform/runtime/package-manager.ts` | Substrate | Parses the `packageManager` pin, accepting only an exact `name@x.y.z` and rejecting range syntax. |
| `platform/README.md` | Substrate | Ownership note for the substrate root. |
| `tests/node-version.test.ts` | Tests | 7 tests, including one asserting the running Node satisfies the declared `engines.node`. |
| `tests/toolchain.test.ts` | Tests | 8 tests binding the exact pins (`.nvmrc`, `packageManager`) to the supported ranges (`engines.*`). |

**Added by FND-001b:**

| Path | Type | Description |
|---|---|---|
| `kernel/`, `modules/`, `design-system/`, `apps/` | Source roots | Tracked, each with a README recording its ownership rules. **Empty of implementation at FND-001b**, which is the state this table describes; `kernel/` has since gained K-01, K-02, K-03, K-05, K-08 and K-09, and `modules/`, `design-system/` and `apps/` are still a README each. |
| `platform/architecture/manifest.ts` | Substrate | Machine-readable encoding of MODULE_MAP: 15 kernel components, 47 modules, layer depths, the financial authority zone as path prefixes, the provider SDK list. |
| `platform/checks/boundaries.ts` | Substrate | The four boundary checks, extracting imports through the TypeScript compiler API. |
| `platform/checks/cli.ts` | Substrate | `npm run check:boundaries`; exits 1 on any violation. |
| `tests/manifest.test.ts` | Tests | 7 tests guarding the manifest's structural invariants. |
| `tests/boundaries.test.ts` | Tests | 10 tests: positive cases plus a planted-violation proof per check. |
| `tests/fixtures/**` (22 files) | Fixtures | Committed non-conforming trees, one per rule, plus a clean control. Excluded from TypeScript, ESLint and Prettier. |
| `tests/README.md` | Tests | Ownership note, including why fixtures must not be "fixed". |

**That was the entire repository at FND-001b**, the point this inventory describes: no CI configuration, no database, no migration directory, no environment configuration, no kernel component, no business module and no UI. FND-002, FND-003 and FND-004 have since added the migration set, the runner, local provisioning, the seed/fixture foundation and six kernel component cores (K-01, K-02, K-03, K-05, K-08, K-09); §4 and §11 carry the current picture.

DOC-001 created no source file. FND-001a was scoped to the toolchain. FND-001b was scoped to the source roots and boundary enforcement and created **no CI, database, kernel, business-module or UI functionality** — at that point `kernel/` and `modules/` contained one README each and nothing else. FND-002, FND-003 and FND-004 have since populated `platform/db/`, `platform/fixtures/` and six directories under `kernel/`; `modules/`, `design-system/` and `apps/` are still a README each.

---

## 3. Decision — guide hierarchy

**Decision ID:** D-001
**Date:** 2026-08-19
**Status:** ADOPTED

### 3.1 The decision

`JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` is the **authoritative specification**. `JAYA___Autonomous_Build_Master_Development_Guide___Completion_Checklist_v1.0.md` is **subordinate**, used only for compatible elaborating detail. Where the two conflict on any point, v3 governs without exception.

### 3.2 Why

v3 §1 defines the hierarchy of authority and places `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE.md` at rank 1, above the status document, the checklist, architecture, module specifications, contracts, tests, existing implementation and temporary run instructions. The file present in this repository at `.conductor/brief/JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` is that document; the `_v3` suffix is a filename detail and does not diminish its rank. v1.0 is an earlier, narrower revision of the same programme and is not referenced anywhere in the v3 authority list.

### 3.3 Resulting effective hierarchy for this repository

1. `.conductor/brief/JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md`
2. `docs/CURRENT_IMPLEMENTATION_STATUS.md` (this document)
3. [`docs/MASTER_IMPLEMENTATION_CHECKLIST.md`](./MASTER_IMPLEMENTATION_CHECKLIST.md)
4. `docs/ARCHITECTURE.md` *(not yet created)*
5. Module specifications — [`docs/MODULE_MAP.md`](./MODULE_MAP.md) and the per-module contracts *(not yet created)*
6. API / database / event contracts *(not yet created)*
7. Existing tests — `tests/` (68 tests: version pins, reproducibility contract, manifest integrity, boundary enforcement, documentation contract)
8. Existing implementation — `platform/runtime/`, `platform/architecture/`, `platform/checks/` (substrate only; no kernel component, module or UI)
9. Temporary chat / run instructions
10. `JAYA___Autonomous_Build_Master_Development_Guide___Completion_Checklist_v1.0.md` — **compatible detail only**

### 3.4 Conflicts identified and resolved

| # | Conflict | v1 position | v3 position | Resolution |
|---|---|---|---|---|
| C-1 | Phase programme | 14 phases (0–13), procurement-centric | 19 phases (0–18), universal commerce | **v3 phase map governs.** v1 phase content folded in as detail. Recorded as RC-02 in the checklist. |
| C-2 | Identity model | Separate Customer and Supplier entities | One universal JAYA Account with capabilities (v3 §4) | **v3 governs.** v1 supplier-as-separate-identity marked OUT OF SCOPE (RC-01). |
| C-3 | Primary demand primitive | "Need" | "Request / Need" with a broader object (v3 §13) | **v3 naming and object govern.** v1 §10 Need field detail reused where compatible. |
| C-4 | Product scope | Procurement, suppliers, RFQ, logistics | Adds accommodation, services, vehicles, used goods, rewards, budgeting, finance marketplace, three cockpits | **v3 scope governs.** |
| C-5 | Module inventory | 17 example directories (v1 §8) | 50 named modules (v3 §9) | **v3 governs.** v1 directory shape is a compatible subset. |
| C-6 | Staff surface | "Admin / Operations Control Centre" (v1 §58) | "Internal Operations Cockpit" (v3 §5.3), broader | **v3 governs;** v1 §58 view list retained as detail. |
| C-7 | Settlement model | Not specified in detail | Standard hold ~45 days, accelerated ~24h, 50% security coverage, all configurable (v3 §20) | **v3 governs.** |

### 3.5 Where the guides agree (both cited as support)

Modular monolith first; AI recommends while deterministic systems execute; explicit status for every requirement; evidence required for completion; P0–P3 severity with stop rules; no placeholder completion; continuous four-level testing; versioned policy over source constants; the `/docs` set as persistent development memory.

---

## 4. Absent infrastructure

This is the honest inventory, not a backlog summary. Items delivered by FND-001a are marked present; everything else is absent.

### 4.1 Development infrastructure

| Item | State | Checklist ID |
|---|---|---|
| Runtime / language toolchain | **Present** (FND-001a) | P0-04 |
| Package manifest and lockfile | **Present** | P0-04 |
| Source directory structure | **Present** — all six roots tracked and documented (FND-001b) | P0-03 |
| Build pipeline | **Present** — compilation to `dist/`; no runnable entry point exists yet | P0-05 |
| Type checking | **Present** | P0-06 |
| Lint and formatting | **Present** | P0-07 |
| Test framework | **Present** (68 tests) | P0-08 |
| CI pipeline | Absent — FND-001c, **blocked by BL-10** (credential lacks the Workflows permission) | P0-09 |
| Boundary / layering enforcement | **Present for 4 of 8 checks** (FND-001b); the other 4 need a schema, policy values or module contracts | P0-10, P0-11 |
| Contributor documentation | **Present** — [docs/CONTRIBUTING.md](./CONTRIBUTING.md), enforced by `tests/docs-contract.test.ts` (FND-001d) | P0-12 |
| Git workflow conventions | **Present** — [docs/CONTRIBUTING.md §11–§13](./CONTRIBUTING.md#11-atomic-changes) (FND-001d) | P0-13 |

### 4.2 Data infrastructure

| Item | State | Checklist ID |
|---|---|---|
| Database selection | **Decided** — PostgreSQL 16+ (FND-002a) | P0-14 |
| Local database provisioning | **Present and exercised** — `compose.yaml` pins PostgreSQL 16.10 with a health check and a named data volume; `db:up`/`db:ready`/`db:down`/`db:reset`/`db:destroy` drive it (FND-002c). A Docker runtime is available in this environment, so the service has been started and `npm run test:integration` passes | P0-14 |
| Migration file contract and validator | **Present** — `db/migrations/`, `npm run check:migrations`, ten checks with planted-invalid fixtures | P0-15 |
| Migration runner | **Present and exercised** — `npm run db:migrate`/`db:status`/`db:rollback` (FND-002b), with advisory locking, checksum reconciliation and ledger-atomic application. Driver `pg` declared and locked, so `npm ci` yields a runnable runner. Run against a live server by `npm run test:integration` | P0-15 |
| Connection configuration | `DATABASE_URL` only, read from the environment and never logged. **No pooling, no secret storage, no provisioning** | P0-14 |
| Schema-namespace ownership convention | **Present and enforced for migrations** — `platform/db/schema-namespaces.ts`, derived from the architecture manifest | P0-16 |
| Isolated test-database lifecycle | **Present and exercised** — derived from `DATABASE_URL`, guarded against non-loopback hosts, non-test names and shared-environment names, and the **only** path any live suite has to a database (FND-002c) | T-21 |
| Seed and fixture data | Absent | P0-17 |
| Object / file storage | Absent | P0-18 |
| Search index | **Foundation only** — K-15 Search Foundation: `document`, `query_log` and `outbox` primitives, keyword full-text search with a generated `tsv` tsvector, idempotent indexing and query logging, foreign-field refusal, append-only query log, and outbox events; **no caller, no API, no UI, no live search consumer** | K-15 |
| Event bus / queue | Absent | K-08 |

### 4.3 Platform capability

This table is corrected as components land. "Foundation only" means a core with a fixed contract,
an injected port and a migration, and **no API, no UI, no enforced authority and nothing applied to
a live server** — a foundation is not a finished component.

| Item | State | Checklist ID |
|---|---|---|
| Identity | **Foundation only** — FND-004a, §11.21–§11.22. K-03 is its first consumer | K-01 |
| Accounts | **Foundation only** — FND-004b, §11.23–§11.24. One account per subject; no caller | K-03 |
| Authentication | **Foundation only** — FND-004c, §11.25. Bindings, evidence and sessions with rotation and revocation; **no verifier ships**, so nothing can authenticate a real person, and no unit consumes a session | K-02 |
| Permissions framework | **Foundation only** — FND-004d, §11.26. Deny by default, explicit grants, deny precedence, staff purpose limitation; **nothing calls it**, so no path is guarded | K-04 |
| Audit framework | **Foundation only** — FND-003c, §11.19–§11.20. No unit records anything | K-09 |
| Configuration | **Foundation only** — FND-003a, §11.10–§11.13 | K-05 |
| Policy engine | **Foundation only** — FND-005b, §11.31. Versioned policy whose every evaluation returns the version id a transaction pins; nothing evaluates one | K-06 |
| Event infrastructure | **Foundation only** — FND-003b, §11.14–§11.15. No producer, no consumer | K-08 |
| Feature flags | **Foundation only** — FND-004e, §11.30. Deployment control that is nothing else; nothing evaluates a flag | K-07 |
| Ledger foundation | **Foundation only** — FND-005c, §11.33. Double-entry asset types, accounts, balanced transactions and derived balances; **nothing calls it**, so no value has moved | K-10 |
| AI gateway / provider abstraction | **Foundation only** — task registry, model bindings, AI run and AI decision storage, deterministic mock provider, cost capture, idempotency, outbox events; **no live provider adapter ships** | K-13 |
| Notifications | **Foundation only** — FND-005g, §11.36. Channel-neutral delivery with in-app provider, idempotency, foreign-field refusal, append-only channel and delivery-attempt tables, and outbox events; **no live email/SMS/push/WhatsApp provider adapter ships** | K-14 |
| Search foundation | **Foundation only** — FND-005h, §11.37. Search document and query-log primitives, keyword full-text search with a generated `tsv` tsvector, idempotent indexing and query logging, foreign-field refusal, append-only query log, and outbox events; **no caller indexes or searches anything** | K-15 |
| Conversation foundation | Foundation only — conversation, participant, message and outbox primitives; no AI provider, business-module or financial dependency | K-12 |
| Account capabilities | **Foundation only** — the first business module and the first module-owned schema. Which roles an account holds over a closed vocabulary, with `UNIQUE (account_id, capability)` making one active role per account a database fact and an append-only transition log behind it; **nothing calls it**, no API, no UI, no `suspend`, no authorisation behind activation | M-01 |
| Commerce unit registry | Absent | K-11 |
| Design system | Absent | P0-41 |

### 4.4 Operational infrastructure

| Item | State | Checklist ID |
|---|---|---|
| Local environment configuration | Absent | P0-20 |
| Secrets management | Absent | P0-21 |
| Staging environment | Absent — blocked | P0-22 / BL-01 |
| Production environment | Absent — blocked | P0-24 / BL-02 |
| Structured logging | Absent | P0-25 |
| Error monitoring | Absent — blocked | P0-26 / BL-03 |
| Metrics and health endpoints | Absent | P0-27 |
| Deployment pipeline and rollback | Absent — blocked | P0-28 / BL-09 |

### 4.5 Documentation still absent

Of the v3 §42 `/docs` set, three exist (this document, the checklist, the module map). The following seventeen do not: `MASTER_PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `API_CONTRACTS.md`, `EVENT_CATALOG.md`, `AI_ARCHITECTURE.md`, `AI_MODEL_REGISTRY.md`, `SECURITY_MODEL.md`, `PERMISSIONS_MATRIX.md`, `POLICY_CATALOG.md`, `TEST_STRATEGY.md`, `UX_SYSTEM.md`, `DEPLOYMENT_GUIDE.md`, `OPERATIONS_RUNBOOK.md`, `DECISIONS_LEDGER.md`, `KNOWN_LIMITATIONS.md`, `CHANGELOG.md`. Tracked as P0-02.

---

## 5. Current risks

Risks are ranked by expected damage to the programme, not by likelihood alone.

| ID | Risk | Severity | Why it matters | Mitigation | Owner |
|---|---|---|---|---|---|
| R-01 | **Unverifiable baseline.** ~~Nothing is executable.~~ **Largely mitigated by FND-001a and FND-001b.** | Was High, now Low | A test can now run, so a completion claim can be checked rather than asserted. Two residues remain: the harness proves only substrate behaviour, because no business behaviour exists yet; and with no CI, it runs only when somebody chooses to run it. | Toolchain and harness delivered — `npm run verify` chains eight gates and 702 tests, all green from a clean install. The residues close as CI lands (FND-001c, blocked by BL-10) and as modules arrive with their own tests. | Closed for substrate; CI residue owned by FND-001c, now blocked by BL-10 |
| R-02 | **Boundary rules are partly unenforced.** Four of the eight checks in [MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification) are executable; four are not. | Was High, now Medium | The four that matter before any module exists — layer direction, kernel purity, financial-zone AI exclusion, provider-import — now fail `npm run verify`, each proven by a committed planted-violation fixture. The remainder (table ownership, policy-literal scan, contract presence, cycle detection) still depend on artefacts that do not exist. Two further limits: the checks read static imports only, and the kernel is treated as one layer. | Delivered in FND-001b. The remaining four land in B-1 alongside FND-002/FND-003, when there is something for them to check. | FND-002, FND-003 |
| R-03 | **Financial-authority drift.** v3 §38 forbids AI as financial authority; the natural implementation path (asking a model to compute or approve) violates it silently. | High (P0 class) | A single AI-sourced monetary value or authorisation is a P0 defect that stops all progression. | Financial zone declared in [MODULE_MAP.md](./MODULE_MAP.md) §11 with rules F-1…F-9; CI check X-44 forbids the AI Gateway import inside the zone. | M-11…M-16 owners |
| R-04 | **Policy values leaking into source.** The ~45-day hold, ~24-hour accelerated payout and 50% coverage target read naturally as constants. | High | v3 §20 and §35 require them to be versioned configuration. Constants make historical economics unrewritable in the wrong direction and force a code deploy for a commercial change. | Policy engine (K-06) lands before the financial core (B-3 before B-10); policy-literal scan in CI. | K-06 / M-14 / M-16 owners |
| R-05 | **Scope-to-verification mismatch.** 19 phases, 62 owned units and two adversarial suites is a large programme; the failure mode is shallow completion ("the page renders"). | High | v3 §33, §51 and §54 explicitly reject this. Shallow completion is discovered late and is expensive. | Definition of Done (v3 §55) and the evidence block are mandatory per item; the UI/UX gate is an independent release gate. | Reviewer |
| R-06 | **Requirement loss across a long programme.** Requirements spread over two guides and 19 phases are easy to drop silently. | Medium-High | v3 §53 forbids silent loss. | Every requirement carries an explicit status in the checklist; superseded items move to `[o]` and stay visible; §J records the v1/v3 reconciliation. | Reviewer |
| R-07 | **External dependency exposure.** Payments, AI providers, storage, messaging, KYC and finance providers are all third-party and all currently uncredentialed. | Medium | Late discovery of a provider constraint can invalidate an interface design. | Provider-neutral abstractions at every boundary (K-13, M-12, M-34); blockers registered early (§6); sandbox credentials requested before Phase 6. | Human owner |
| R-08 | **Legal and jurisdictional ambiguity.** Tax identifier schemes, guarantee instrument legality, permitted hold periods, and finance licensing vary by jurisdiction. | Medium | Hardcoding one jurisdiction is explicitly forbidden (v3 §18) and would require rework across verification, payout and finance modules. | Jurisdiction-configurable from the start; legal decisions escalated as BL-08 rather than guessed. | Human owner |
| R-09 | **Two-guide drift.** Future contributors may read v1 as current. | Medium | Contradictory implementation from a superseded source. | Decision D-001 (§3) is recorded here at authority rank 2, with the conflict table and the reconciliation register in checklist §J. | Reviewer |
| R-10 | **Accommodation forking the platform.** v3 §22 requires accommodation to reuse shared infrastructure; built early or independently it becomes a second codebase. | Medium | Duplicate identity, payment, settlement and dispute logic is the exact outcome v3 forbids. | Accommodation deliberately sequenced at build step B-15, after payments, ledger, settlement and disputes exist to be reused. | Architecture |
| R-11 | **Cost and effort waste in development.** v3 §46 requires active optimisation of model usage; unbounded tasks and repeated repository rediscovery are the main leaks. | Low-Medium | Wasted budget, slower delivery. | Bounded module-sized tasks; this document as the context entry point instead of repository re-reads; usage tracking under X-56. | Supervisor |

---

## 6. Blockers

Ten blockers are open. **One — BL-10 — is now on the critical path**; the other nine concern an external account, credential or legal decision that Phase 0 local foundation work does not require.

| ID | Blocker | Blocks | Escalation category |
|---|---|---|---|
| BL-01 | No staging environment / cloud account | P0-22 | Credentials / access |
| BL-02 | No production environment / cloud account | P0-24 | Credentials / access |
| BL-03 | No error-monitoring service account | P0-26 | Credentials / access |
| BL-04 | No AI provider credentials for a live adapter | P0-40 | Credentials / access |
| BL-05 | No payment provider sandbox account | P6-04 | Credentials / access — needed by Phase 6 |
| BL-06 | No object-storage credentials | P0-19 | Credentials / access |
| BL-07 | No email/SMS provider credentials | K-14 live delivery | Credentials / access |
| BL-08 | Jurisdiction and legal decisions (tax identifiers, guarantee instruments, hold periods, finance licensing) | P3-02, P7-04, P14-04 | Legal / regulatory |
| BL-09 | No deployment target or domain | P0-28 | Credentials / access |
| BL-10 | **Repository credential lacks the Workflows permission** — pushes touching `.github/workflows/` are refused by the remote, and the Contents API rejects the same file with 403 | P0-09, FND-001c, every CI-dependent gate | Credentials / access |

Full detail: [MASTER_IMPLEMENTATION_CHECKLIST.md §I](./MASTER_IMPLEMENTATION_CHECKLIST.md#i-blocker-register).

**Escalation posture (v3 §65):** **BL-10 is escalated now.** It is the only blocker stopping work today: FND-001c has been authored and validated repeatedly, and each attempt is rejected by the remote, so P0-09 cannot progress and FND-001 cannot complete by any local means. Clearing it needs one action from the human owner — grant **Workflows: Read and write** on the fine-grained token for `LakshanV/P2P-com`, or paste the workflow through the GitHub web editor.

The remaining nine are recorded, not escalated as urgent. Each is genuinely a human-owner decision (credentials or legal), but none stops work today. The first that will actually block progress is **BL-04**, at build step B-3 when the AI Gateway needs one live adapter to be verifiable end to end. **BL-05** follows at build step B-10. Recommended action for the human owner, in that order, with no work paused meanwhile.

---

## 7. P0 / P1 defect tracking

| Severity | Definition (v3 §52) | Open | Rule |
|---|---|---|---|
| **P0** | Money lost or corrupted; unrecoverable paid transaction; cross-user data exposure; severe auth/security flaw; destructive migration or data loss; settlement corruption | **0** | STOP all progression until fixed |
| **P1** | Primary workflow broken; significant security flaw; major financial inconsistency; core module unavailable | **0** | Must fix before phase completion |
| **P2** | Important | **0** | May proceed only if documented and non-blocking |
| **P3** | Minor | **0** | Backlog permitted |

**Zero open defects still means almost no code.** FND-001a and FND-001b added five substrate modules and 32 passing tests; FND-001d added a sixth and 36 more; FND-002a added three more and 29 more; FND-002b added four more and 41 more; FND-002c added five more and 62 more; FND-003a added the first kernel component and 110 more tests; FND-003b added the second and 82 more (67 at delivery, 15 by its correction); FND-002d added the fixture foundation and 57 more (31 at delivery, 26 across two corrections); FND-003c added a third kernel component and 81 more (64 at delivery, 17 by its correction); FND-004a added a fourth and 80 more (67 at delivery, 13 by its correction); FND-004b added a fifth and 85 more (74 at delivery, 11 by its correction); FND-004c added a sixth and 95 more across delivery and four corrections; FND-004d added a seventh and 104 more (69 at delivery, 35 across its three corrections); FND-004e added an eighth and 88 more, FND-005b added a ninth and 81 more, FND-005c added a tenth and 25 more, FND-005d added an eleventh and 71 more, and FND-005e has now added a twelfth and 80 more, and FND-005g has added a thirteenth and 63 more, and FND-005h has added a fourteenth and 57 more, for 1591 today after the K-05/K-06/K-07/K-11/K-10/K-13 outbox extension added 15 outbox cases and earlier under-reported counts were reconciled — the last assertions being the documentation counts this slice had to keep true. Eight defects were found in FND-003a by review after delivery and corrected in three passes (§11.11, §11.12, §11.13); no defect was found in the earlier tasks; two were found in FND-003b by review and corrected (§11.15), one of them a reference implementation that refused fewer conflicts than the database it stands in for; three were found in FND-003c by review and corrected (§11.20), the sharpest being an immutable record whose actor and resource were writable; three were found in FND-004a by review and corrected (§11.22) — a decoder that asked far less than creation, and a migration whose comments claimed to prohibit natural keys that its predicates admitted; one was found in FND-004b by review and corrected (§11.24) — retry convergence that depended on which unique index PostgreSQL happened to report, invisible because the in-memory repository always reported the same one; and **three were found in FND-004d by review and corrected (§11.27, §11.28, §11.29), all three of them security defects and each more serious than anything above it in this paragraph**.

**The three K-04 defects, stated plainly, because they are the most serious this register has recorded.** Each was an authority control that could be walked around, and each was found by review of delivered code rather than by a test that already existed:

| Correction | The defect | What it granted an attacker |
|---|---|---|
| [§11.27](#1127-correction--fnd-004d-idempotency-was-a-bearer-token-for-somebody-elses-answer) | `authorize` looked up the stored decision **before** validating the presented session, and compared six of the nine facts the decision depended on | Somebody else's `allow`, obtained by presenting their idempotency key with no working session at all — an authorisation without authenticating |
| [§11.28](#1128-correction--fnd-004d-authority-administration-was-unauthenticated-and-self-asserted) | `publishPolicy`, `grant` and `revoke` took **no session at all** and accepted the author of the change as a field in the request | Any caller who could reach the service could grant themselves anything and sign it in somebody else's name. Deny-by-default is worth nothing when the caller writes its own allow |
| [§11.29](#1129-correction--fnd-004d-the-read-surface-and-a-migration-corrupted-by-its-own-edit) | `findGrant`, `findDecision` and `activePolicy` took an identifier and nothing else — no session, no account, no authorisation | Whose authority was granted by whom, and what somebody else had been allowed to do, read by anybody holding an id or a retry buffer |

None was reachable by a caller in this repository, because nothing calls K-04. That is luck rather
than mitigation, and it is the window in which defects of this shape are cheapest to fix. All three
are closed, each with adversarial tests that were mutation-checked by reintroducing the hole and
observing the expected cases fail.

The same correction pass also found a **non-security defect with a security-shaped cause**: migration
0009 had been corrupted by an earlier automated edit into 2389 lines with sixteen `COMMIT;`
statements and four unterminated string literals, and it was **committed in that state** — the
static migration contract check passes over it, because that check does not parse SQL. It is
repaired to 374 lines (§11.29). The lesson is recorded there rather than here: a gate that cannot
fail on a class of defect is not evidence about that class. The register will carry little information about system health until business capability exists to defect — a green suite over a toolchain is a much weaker signal than a green suite over a commerce platform.

**Recording protocol.** Each defect, when found, records: id, severity, description, owning module, reproduction steps, detection source, the regression test that reproduces it, the fix commit, and — per v3 §58 — whether the defect was introduced by a previous correction, in which case the failed invariant and the adjacent flows inspected are recorded too.

Register: [MASTER_IMPLEMENTATION_CHECKLIST.md §H](./MASTER_IMPLEMENTATION_CHECKLIST.md#h-p0--p1-defect-register).

---

## 8. Next highest-priority unblocked task

### TASK FND-001 — Platform substrate, boundary enforcement, and test harness

**Status:** IN PROGRESS. Subtasks FND-001a, FND-001b and FND-001d delivered. **FND-001c is BLOCKED by BL-10** — it is the only remaining subtask, and it cannot be delivered by any local means.

**Fourteen kernel components now have foundations**, and none is complete. **Build steps B-1 and B-2 are both covered, and B-3 is open.** B-1 is K-05 Configuration (§11.10–§11.13) and K-08 Event Infrastructure (§11.14–§11.15); B-2 is K-09 Audit Foundation (§11.19–§11.20), K-01 Identity (§11.21–§11.22), K-03 Accounts (§11.23–§11.24), K-02 Authentication (§11.25), K-04 Permissions (§11.26–§11.29) and K-07 Feature Flags (§11.30); and B-3 is K-06 Policy Engine (§11.31), K-10 Ledger Foundation (§11.33), K-12 Conversation Foundation (§11.34), K-13 AI Gateway (§11.35), K-14 Notifications (§11.36) and K-15 Search Foundation (§11.37). K-09 was buildable ahead of its declared K-01 dependency because the audit *mechanism* needs no identity; K-01 has now landed underneath it, and K-02, K-03 and K-04 on top of it.

**Every link of the kernel's internal chain `K-01 → K-02/K-03 → K-04` now exists in code, and none of them has a caller.** K-02 asks K-01 whether a subject exists; K-03 asks the same; K-04 asks K-02 who is asking and K-03 which account they hold, each through a one-method public contract and nothing else. Thirteen transaction-enlisted paths now exist (K-01, K-02, K-03, K-04, K-06, K-07, K-08, K-09, K-10, K-12, K-13, K-14 and K-15), each letting a caller couple a domain write to a kernel write in one transaction; all thirteen are capabilities and **no unit uses any of them**. What every one of the fourteen components still lacks is the same list: no API, no UI, no caller, and nothing ever applied to a running PostgreSQL server. For K-06 that absence has a particular shape: **no record anywhere has yet pinned a policy version id**, so the guarantee the component was built to make possible (v3 §35, §24) is implemented and unexercised.

FND-002d (seed and fixture strategy, P0-17), named here previously as the next task, was delivered and twice corrected (§11.16–§11.18). FND-003c delivered K-09 (§11.19) and was corrected once (§11.20). FND-004a delivered K-01 (§11.21) and was corrected once (§11.22). FND-004b delivered K-03 (§11.23) and was corrected once (§11.24). FND-004c delivered K-02 (§11.25). FND-004d delivered K-04 (§11.26) and was corrected **three times** — §11.27, §11.28 and §11.29, all three security corrections (§7). FND-004e delivered K-07 (§11.30), **which covers build step B-2**. FND-005b delivered K-06 (§11.31), **which opens B-3**. FND-005c delivered K-10 (§11.33), the first ledger component. FND-005d delivered K-12 (§11.34), the conversation component. FND-005e has now delivered K-13 (§11.35), the AI gateway component. Each of those was, when selected, the next genuinely unblocked task; this section records the current one below.

**Next genuinely unblocked task: FND-005f — K-11 Commerce Unit Registry, the next component of build step B-3.**

It is selected on the build order rather than on judgement about what is most useful, which is the
discipline this section is for. B-1 and B-2 are covered; MODULE_MAP §12 orders B-3 as **K-06, K-11,
K-13, K-15, K-14, K-12, K-10**. K-06 landed as FND-005b (§11.31), K-10 landed as FND-005c (§11.33) and K-12 landed as FND-005d (§11.34); K-11 is next in that list.

It is genuinely unblocked, in the strict sense. Its single declared dependency, **K-05
Configuration, is delivered** (§11.10–§11.13), and it needs no external credential, no HTTP surface
and no live database to be written and tested, so no blocker in §6 touches it. **K-13 AI Gateway has now cleared the abstraction and test-double part of that bar**: the task registry, model bindings, routing, cost capture, decision recording, in-memory repository and PostgreSQL adapter are delivered, and the mock provider makes the suite deterministic; only a live provider adapter remains blocked by BL-04 (no AI provider credentials).

**R-04 is now partly mitigated rather than open.** The ~45-day hold, the ~24-hour accelerated payout
and the 50% coverage target read naturally as constants, and v3 §20 and §35 require them to be
versioned policy; K-06 is the place they now belong, and its evaluation returns the version id a
transaction pins. What remains of the risk is that **no module puts them there yet** — the values
are still nowhere, rather than being constants in the wrong place.

**Why not the provider adapter behind K-02's `Verifier` port**, which this section named two tasks ago.
It is real and it is still the change that would turn the kernel chain into something a person can
use: K-02 ships no verifier, so no real person can authenticate, so no real session reaches K-04,
so no authorisation decision here has ever been about anybody. But it is **completion work inside a
B-2 component that already has its foundation**, not the next component in the build order, and the
two candidate shapes each carry an unresolved dependency that K-07 does not: a passkey/WebAuthn
adapter needs an HTTP origin and a browser ceremony, and this repository has **no API layer at
all**; an email or SMS one-time-code verifier needs BL-07 (no email/SMS provider credentials). A
password verifier is the one shape that needs neither, and it is also the shape v3 is least
interested in. That reasoning belongs in the evidence block of whoever picks it up; it is recorded
here so the choice is visible rather than quietly dropped. It remains a real candidate, and it is
the first thing that should follow B-3's opening if an HTTP surface arrives before then.

The other alternatives, and why each waits:

- **The registration path** — a K-01 subject and a K-03 account created in one transaction through
  both enlisted paths — is still unblocked and still small. It would give K-01 and K-03 their first
  real caller. It waits because a registration path with no verifier behind it is a way to fill the
  party table with anything, and that argument has not weakened.
- **Wiring K-09 audit and K-08 events to K-02 and K-04** is the integration the two most obviously
  need: v3 §53 lists permission changes and account changes as auditable, and neither is recorded.
  It waits because auditing decisions nobody makes about parties nobody authenticated records
  nothing worth reading, and because K-09's actor `CHECK` needs a bounded migration to accept a
  real authenticated actor — which should happen once there is one.
- **K-10 Ledger foundation** is unblocked and sits **last** in MODULE_MAP §12's B-3 order, which is
  the right place for it: a ledger built before the policy engine would be one whose rates are
  constants, and that ordering is now satisfied rather than merely intended.
- **The operational role matrix** (v3 §47 Level 4) is now derivable from K-04's vocabulary and
  policy structure, and nobody has derived or reviewed one. That is a documentation slice, not a
  foundation slice.

Also still unblocked, and still worth doing: collapsing K-05's private instant module onto
`platform/time/instant.ts` (§11.14) and `platform/fixtures/fingerprint.ts` onto K-08's
`fingerprintPayload` (§11.17). A third recorded duplication joined them in FND-004b —
`kernel_accounts.is_opaque_identifier` against `kernel_identity.is_opaque_identifier` — but that one
is unavoidable rather than accidental (each schema must be independently creatable) and is already
guarded by a character-for-character comparison. And K-06 Policy Engine, whose declared dependency
K-05 is satisfied.

What changed in this slice is that a **PostgreSQL runtime is now available in this environment**, so the live-database gates are no longer blocked on provisioning. The validated migration set, the runner, the schema-namespace convention and the provisioned local database now have evidence: `npm run test:integration` passes 91 opt-in live cases against a real server, each using an isolated `_test` database that is created for the test and dropped afterwards. When no runtime is available the suites still **skip** with their reason stated, and a skipped run is not evidence. §11.29 records what the previous no-runtime state cost: migration 0009 was committed **syntactically invalid**, and every static gate passed over it, because no gate in this repository parses SQL.

The superseded reasoning, kept because it still explains why the kernel proceeds while FND-002 waits: **kernel build step B-1 (K-05 Configuration, K-08 Events).** The data foundation now has everything a module needs from it that can be built without a running server: a validated migration set, a runner, a schema-namespace convention and a provisioned local database. What FND-002 still lacks — one verified live run — is blocked on a PostgreSQL runtime rather than on engineering, and a kernel component does not wait on it: K-05 and K-08 depend only on the substrate. FND-002d (seed and fixture strategy, P0-17) is the alternative, and is equally unblocked.

**FND-001c — GitHub Actions CI — remains BLOCKED on BL-10** and is not the next task despite being older. It is the only remaining item on the critical path to a boundary rule that holds without somebody remembering to run a command, and it is stalled on a credential permission rather than on any technical question. The workflow has been authored and validated locally on several occasions; every attempt to land it is rejected by the remote because the token lacks the Workflows permission (BL-10, §6). Until that is granted, FND-001 stays IN PROGRESS and no CI-dependent gate may be marked complete.

### Subtask breakdown

FND-001 is being delivered in bounded increments so each one is committed against a verified,
reproducible result rather than as a single large change.

| Subtask | Scope | Checklist items | State |
|---|---|---|---|
| **FND-001a** | Pinned Node/TypeScript/npm toolchain, lockfile, minimal `platform/` and `tests/` structure, working clean-install `build` / `typecheck` / `lint` / `format:check` / `test` | P0-04 fully; P0-03, P0-05…P0-08 partially | **Delivered** — evidence §11.1. Nothing marked COMPLETE. |
| **FND-001b** | Remaining source roots (`kernel/`, `modules/`, `design-system/`, `apps/`), architecture manifest, and the four executable boundary checks with planted-violation fixtures | P0-03 and P0-11 fully; P0-10 partially | **Delivered** — evidence §11.2 |
| **FND-001c** | GitHub Actions CI running every command, plus dependency audit | P0-09 | **BLOCKED — BL-10.** Authored and locally validated; cannot reach the remote |
| **FND-001d** | Contributor documentation and git workflow conventions, under an executable documentation contract | P0-12, P0-13 | **Delivered** — evidence §11.4 |

**Four items are COMPLETE: P0-03, P0-11, P0-12 and P0-13**, each backed by a checklist evidence row
and an evidence block (§11.2 for the first two, §11.4 for the last two). P0-04 through P0-08 remain `IN PROGRESS` — satisfied by FND-001a but held
there while FND-001 is unfinished — and P0-10 is `IN PROGRESS` because it references
[MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification), which lists eight checks of
which four are built. P0-09 is `BLOCKED` (BL-10).

FND-001 itself cannot be complete until FND-001c lands, and FND-001c cannot land while BL-10 is
open. Its acceptance criterion that each boundary check demonstrably rejects a planted violation
**is** met (§11.2), and contributor documentation **is** delivered (§11.4). What is not met is CI
running the chain — and that is now a credential problem, not an engineering one.

| Field | Value |
|---|---|
| **TASK ID** | FND-001 |
| **MODULE** | Platform substrate (no business module) |
| **BUILD STEP** | B-0 ([MODULE_MAP.md §9](./MODULE_MAP.md#9-build-order)) |
| **PHASE** | Phase 0 — Foundation |
| **OBJECTIVE** | Establish a repository that builds, type-checks, lints, tests, and mechanically enforces the module boundaries — so that every subsequent claim of completion is verifiable by running a command. |
| **BUSINESS PURPOSE** | Nothing in this programme can be honestly marked complete until a test can run. This is the single dependency shared by all 62 owned units. |
| **CURRENT STATE** | Subtasks FND-001a, FND-001b and FND-001d delivered. Pinned toolchain (Node 26.7.0 via `.nvmrc`, npm 11.19.0 via `packageManager`, exact devDependency pins, committed lockfile); all six source roots tracked and documented; architecture manifest encoding 15 kernel components and 47 modules; four executable boundary checks wired into `npm run verify`, each proven by a committed planted-violation fixture; contributor documentation under an executable contract. 68 tests passing from a clean install. Still absent: **CI** (FND-001c, blocked by BL-10) and the four B-1 checks that need a schema, policy values or module contracts to exist. |
| **IN SCOPE** | Runtime and package manifest (P0-04); source directory structure per [MODULE_MAP.md §2](./MODULE_MAP.md#2-architectural-shape--modular-monolith) (P0-03); build (P0-05); type checking (P0-06); lint and format (P0-07); test framework with at least one real assertion exercising the harness (P0-08); CI running build + typecheck + lint + test on every change, plus the existing documentation link validator (P0-09); import-boundary and layering checks (P0-10); financial-zone and AI-provider-import checks (P0-11); contributor documentation (P0-12); git workflow conventions (P0-13). |
| **OUT OF SCOPE** | Database, migrations, authentication, permissions, any kernel component, any business module, any UI, the design system, deployment, cloud environments. Those are FND-002 and later. |
| **DEPENDENCIES** | None. This is the root of the build order. |
| **OWNED FILES/DATA** | Repository root configuration, `/platform`, `/tests` harness. No business data. |
| **PUBLIC CONTRACTS** | The boundary rules become executable: layer direction, kernel purity, financial-zone AI exclusion, provider-import restriction. |
| **DATA CHANGES** | None. |
| **API CHANGES** | None. |
| **UI/UX CHANGES** | None. The UI/UX gate does not apply; record `N/A — no user-facing surface` in the evidence block. |
| **EVENTS** | None. |
| **SECURITY** | Secret-scanning and dependency-scanning configuration may be included; no secrets are committed. |
| **FAILURE CASES** | Boundary checks must fail a deliberately-planted violating import — proving the check works, not merely that it runs. |
| **TESTS REQUIRED** | Harness self-test; one passing unit test; one deliberately violating fixture per boundary check, asserted to fail. |
| **ACCEPTANCE CRITERIA** | A clean clone runs install, build, typecheck, lint and test successfully with documented commands; CI runs all five on push; each of the four boundary checks demonstrably rejects a planted violation. |
| **DEFINITION OF DONE** | All the above, plus checklist items P0-03 through P0-13 updated with evidence blocks, this document updated, and an atomic commit. |

### Why this task and not another

- **It is the only genuinely unblocked root.** Everything else in build order B-1 and later depends on a repository that builds and tests. No blocker (BL-01…BL-09) touches it.
- **It converts documentation into enforcement.** Risks R-01 and R-02 are the two highest-severity items in §5, and this task is the direct mitigation for both. The boundary checks in particular are far cheaper to add now than after modules exist.
- **It is what v3 §59 Phase 0 lists first** — repository/doc structure, CI, test infrastructure — and what v1 §64 opens with.
- **It obeys the "no placeholder completion" rule.** A boundary check that runs but cannot fail is a placeholder; the planted-violation requirement is what makes this task's completion real.

### Task sequence after FND-001

| Order | Task | Scope | Blocked? |
|---|---|---|---|
| 1 | **FND-001** | Substrate, CI, boundary checks, test harness | No — **start here** |
| 2 | FND-002 | Database, migration system, schema-namespace convention, seed strategy (P0-14…P0-17). **FND-002a delivered** — selection, migration contract and namespace convention (§11.5). **FND-002b delivered** — migration runner, adapter, locking, checksums (§11.6). Remaining: local provisioning and one verified live run (P0-14), then FND-002c seed/fixture strategy (P0-17) | No |
| 3 | FND-003 | K-05 Configuration, K-08 Events (build step B-1 — the kernel components that depend only on the substrate) | No |
| 4 | FND-004 | K-01 Identity (**delivered**, §11.21), K-02 Authentication (**delivered**, §11.25), K-03 Accounts (**delivered**, §11.23), K-09 Audit (**delivered**, §11.19), K-04 Permissions (**delivered and three times corrected**, §11.26–§11.29), then K-07 Feature Flags (**next**, §8) — the last unstarted component of build step B-2 | No |
| 5 | FND-005 | K-06 Policy, K-10 Ledger foundation, K-11 Commerce Unit Registry, K-12 Conversation, K-13 AI Gateway, K-14 Notifications, K-15 Search (build step B-3) | K-13 live adapter needs BL-04; the abstraction and a test double for the test suite do not |
| 6 | FND-006 | Design system foundation (build step B-4) | No |
| 7 | DOC-002 | Remaining v3 §42 `/docs` set, written against the now-real architecture (P0-02) | No |

---

## 9. Selected first implementation slice

**Selected slice:** *Platform substrate and verification harness* — the scope of FND-001 above.

### The decision

v3 §44 and v1 §3.1 ask for complete vertical slices. A vertical slice is the right unit **once a platform exists to slice through**. When this slice was selected there was no runtime, no database, no test runner and no CI, so the first user-visible vertical slice — "a user registers an account" — would have to invent all of them along the way, inside one task, with no way to test any of it. That is the failure mode v3 §54 and §56 are written to prevent: work that looks finished and cannot be shown to be.

The first slice is therefore **horizontal by necessity and deliberately thin**: the minimum substrate that makes the *second* slice verifiable, and nothing more. It carries no business logic, so it cannot pre-empt or constrain any module boundary.

### First *vertical* slice, for the record

The first true vertical slice is scheduled as **build step B-5 / Phase 1**: *account registration and capability activation on one universal JAYA Account, with a user cockpit shell that reads real data* — traversing K-01/K-02/K-03/K-04, M-01/M-02 and M-36, with permissions, events, audit, tests and UI states. It becomes available once FND-001 through FND-004 land, and its Definition of Done is the full v3 §55 layer list.

### Bounds on this slice

- No business module may be created by FND-001.
- No database schema may be created by FND-001.
- Nothing user-facing is produced, so the UI/UX gate records `N/A` with that reason rather than being skipped silently.
- The slice is complete only when a planted boundary violation is demonstrably rejected — a check that cannot fail is a placeholder (v3 §54).

---

## 10. Release gate summary

**0 of 26 gates met.** The build-and-quality commands now exist and are green on this tree; every other gate still awaits an implementation to assess. Full definitions: [MASTER_IMPLEMENTATION_CHECKLIST.md §G](./MASTER_IMPLEMENTATION_CHECKLIST.md#g-release-gates).

| Group | Gates | Met | State |
|---|---|---|---|
| Build and quality (G-01…G-07) | 7 | 0 | Build, typecheck, lint, format check and tests all run and pass — but a gate is assessed against a release candidate, and none exists |
| Safety (G-08…G-15) | 8 | 0 | No adversarial suites, no permissions (K-04), no authentication anybody can actually use (K-02 ships no verifier), no migration ever applied to a live server, no monitoring |
| Experience (G-16…G-20) | 5 | 0 | No UI, no design system |
| Governance (G-21…G-26) | 6 | 0 | Registers exist and are empty; no deployment |

**Phase 0 exit gate:** not met (P0-G1…P0-G5, all `NOT STARTED`).

**Production completion rule (v3 §64):** the project may not be described as complete until every gate above is met, no P0 or P1 defect is open, the critical journeys and adversarial suites pass, and this document is accurate. None of those conditions holds. Permitted description today: **"planning baseline established; toolchain and boundary enforcement delivered."** Not "FND-001 complete", not "Phase 0 complete", not "MVP candidate".

---

## 11. Evidence register

Per v3 §56, completion requires evidence. Below is every evidence claim currently made in this repository: four documentation artefacts from DOC-001 and fifteen delivered engineering tasks, each backed by named commands with recorded exit codes. Seven of those tasks were subsequently corrected after review, and each correction has its own numbered block rather than being folded into the original — an over-claim that is quietly edited away teaches nobody anything. The full set of blocks is §11.1–§11.31. **FND-004d carries three corrections, all of them security corrections**, which is more than any other task in this register and is recorded in §7 as well as here.

| Item | Status | Evidence type | Evidence |
|---|---|---|---|
| P0-01a — status baseline | COMPLETE | File | `docs/CURRENT_IMPLEMENTATION_STATUS.md` (this document) |
| P0-01b — checklist baseline | COMPLETE | File | [`docs/MASTER_IMPLEMENTATION_CHECKLIST.md`](./MASTER_IMPLEMENTATION_CHECKLIST.md) |
| P0-01c — module map baseline | COMPLETE | File | [`docs/MODULE_MAP.md`](./MODULE_MAP.md) |
| P0-01d — link validator | COMPLETE | File + reproducible command | `docs/tools/validate-doc-links.mjs`, run as `node docs/tools/validate-doc-links.mjs` |
| FND-001a — pinned toolchain and test harness | DELIVERED | Commands + exit codes | See §11.1. P0-04 satisfied; P0-05…P0-08 satisfied but held `IN PROGRESS` while FND-001 is unfinished. |
| FND-001b — source roots, architecture manifest, boundary enforcement | DELIVERED | Commands + exit codes + planted fixtures | See §11.2. **P0-03 and P0-11 COMPLETE**; P0-10 `IN PROGRESS` (four of the eight MODULE_MAP §13 checks are built). |
| FND-001d — contributor documentation and git conventions | DELIVERED | Commands + exit codes + planted erosions | See §11.4. **P0-12 and P0-13 COMPLETE**, each guarantee covered by a planted-erosion test. |
| FND-002a — database selection, migration contract, schema namespaces | DELIVERED | Commands + exit codes + planted-invalid migrations | See §11.5. **Nothing marked COMPLETE.** P0-14, P0-15 and P0-16 move to `IN PROGRESS`; P0-17 stays `NOT STARTED`. No database was provisioned and no migration was executed. |
| FND-002b — migration runner, PostgreSQL adapter, locking, checksums | DELIVERED | Commands + exit codes + 35 deterministic tests against an injected fake | See §11.6, corrected in §11.7. **Nothing marked COMPLETE.** P0-14 and P0-15 stay `IN PROGRESS`: the runner exists and is proved against a fake, but has never been executed against a live PostgreSQL, and the integration test that would prove it **skipped**. |
| FND-002c — local provisioning and isolated test-database lifecycle | DELIVERED | Commands + exit codes + integration-safety checks | See §11.8, corrected in §11.9. **Nothing marked COMPLETE.** No Docker runtime is available here, so no server has been started. |
| FND-002d — seed and fixture foundation | DELIVERED | Commands + exit codes + `npm run check:fixtures` | See §11.16, corrected in §11.17 and §11.18. **Nothing marked COMPLETE.** P0-17 stays `IN PROGRESS`: no fixture has been loaded into a live server. |
| FND-003a — K-05 Configuration foundation | DELIVERED | Commands + exit codes + planted regressions | See §11.10, corrected in §11.11, §11.12 and §11.13. **Nothing marked COMPLETE.** No API, no enforced authority, no audit, migration never applied. |
| FND-003b — K-08 Event Infrastructure foundation | DELIVERED | Commands + exit codes + planted regressions | See §11.14, corrected in §11.15. **Nothing marked COMPLETE.** No producer, no consumer, no broker binding, migration never applied. |
| FND-003c — K-09 Audit Foundation | DELIVERED | Commands + exit codes + planted regressions | See §11.19, corrected in §11.20. **Nothing marked COMPLETE.** No unit records an audit record; the append-only trigger has never refused anything. |
| FND-004b — K-03 Universal Account foundation | DELIVERED | Commands + exit codes + thirteen planted regressions | See §11.23, corrected in §11.24. **Nothing marked COMPLETE.** The checklist K-03 row moves to `IN PROGRESS`: no caller, no authentication, no permissions, no profile, no capability model, and `UNIQUE (subject_id)` has never refused an insert. |
| FND-004a — K-01 Identity foundation | DELIVERED | Commands + exit codes + sixteen planted regressions | See §11.21, corrected in §11.22. **Nothing marked COMPLETE.** The checklist K-01 row moves to `IN PROGRESS`: no consumer, no authentication, no permission check, no audit integration, and the write-once trigger has never refused anything. |
| FND-004c — K-02 Authentication foundation | DELIVERED | Commands + exit codes + planted regressions on every guard | See §11.25. **Nothing marked COMPLETE.** The checklist K-02 row moves to `IN PROGRESS`: **no verifier ships**, so nothing can authenticate a real person; no API, no UI, no permissions (K-04), no audit (K-09), no events (K-08), no registration, no recovery, and the schema has never been applied to a live server. |
| FND-004d — K-04 Permissions foundation | DELIVERED | Commands + exit codes + planted regressions on every guard | See §11.26. **Nothing marked COMPLETE.** The checklist K-04 row moves to `IN PROGRESS`: **nothing calls it**, so no path in this repository is guarded; no API, no UI, no policy studio, no audit record (K-09), no event (K-08), no business-module actions, no operational role matrix, and the schema has never been applied to a live server. |
| FND-004d — K-04 idempotency correction | DELIVERED | Commands + exit codes + a planted regression failing 5 of 13 adversarial cases | See §11.27. **Nothing marked COMPLETE.** An idempotency key was a bearer token for somebody else’s decision: the stored answer was returned before the presented session was validated, and the retry comparison omitted the subject, the session and the ABAC context. Both are closed, and every decision now stores a fingerprint of its own inputs. |
| FND-004d — K-04 authority-administration correction | DELIVERED | Commands + exit codes + 20 adversarial cases | See §11.28. **Nothing marked COMPLETE.** `publishPolicy`, `grant` and `revoke` took no session and accepted their own author as a request field, so any caller could grant itself anything and sign it in somebody else's name. Administration now authenticates through K-02, resolves the K-03 account, derives authorship from that binding and requires an explicit administration grant, with one enumerated bootstrap authority that is injected, refuses by default, cannot mint a grant and leaves permanent evidence. |
| FND-005b — K-06 Policy Engine foundation | DELIVERED | Commands + exit codes + two planted regressions found by test | See §11.31. **Nothing marked COMPLETE.** The checklist K-06 row moves to `IN PROGRESS`, and **build step B-3 is opened**. Every successful evaluation returns the policy version id a transaction pins (v3 §35, §24), every rate is an exact decimal with no floating point anywhere in the component, and two equally specific matching rules are refused rather than resolved by row order. **Nothing evaluates a policy**, so no amount has been priced by one and no record has pinned a version; no API, no studio, no approval workflow, authoring is not authenticated (K-02/K-04 deferred), no audit (K-09), no event (K-08), and nothing applied to a live server. |
| FND-005c — K-10 Ledger Foundation | DELIVERED | Commands + exit codes | See §11.33. **Nothing marked COMPLETE.** The checklist K-10 contract row moves to `COMPLETE` and its implementation row moves to `IN PROGRESS`. Asset types, accounts, balanced double-entry transactions and derived balances; every amount is an exact integer in minor units and no floating point exists. **Nothing calls it**, so no value has moved; no API, no UI, no caller, no audit (K-09), no event consumer (K-08) and nothing applied to a live server. |
| FND-004e — K-07 Feature Flags foundation | DELIVERED | Commands + exit codes + two planted regressions found by test | See §11.30. **Nothing marked COMPLETE.** The checklist K-07 row moves to `IN PROGRESS`, and **build step B-2 is covered**. A flag says whether code is running and never whether something is permitted, owed, priced or assigned — enforced in the service and by a database `CHECK`. **Nothing evaluates a flag**; no API, no UI, no control plane, administration is not authenticated (K-02/K-04 deferred), no audit (K-09), no event (K-08) follows a kill, and nothing applied to a live server. |
| FND-004d — K-04 read-surface removal and migration 0009 repair | DELIVERED | Commands + exit codes + a planted regression + a programmatic SQL balance check | See §11.29. **Nothing marked COMPLETE.** `findGrant`, `findDecision` and `activePolicy` returned authority data to anybody holding an id, and are **removed rather than guarded**: the surface is four operations and no reads. Migration 0009 was also found committed syntactically invalid — 2389 lines, sixteen `COMMIT;` statements — and is repaired to 374; the static migration gate passed over it because no gate here parses SQL. |

**Evidence block for DOC-001:**

```text
ITEM ID:            P0-01 (DOC-001)
MODULE / PHASE:     Documentation / Phase 0
STATUS:             COMPLETE (documentation artefact — not an implementation capability)
IMPLEMENTED:        Three baseline planning documents under /docs — current implementation
                    status, master implementation checklist, module map — plus a
                    reproducible link/anchor validator at docs/tools/validate-doc-links.mjs.
TESTED:             Every relative file link and every Markdown anchor across the /docs
                    Markdown set. Fenced code blocks excluded from heading extraction;
                    external links reported as skipped, not silently ignored. The validator
                    itself was negative-tested against planted violations. No application
                    code exists to test.
TEST COMMANDS:      node docs/tools/validate-doc-links.mjs
                    (exit 0 = pass, exit 1 = at least one broken link or anchor)
TEST RESULTS:       PASS — exit 0.
                      files scanned  : 3
                      CURRENT_IMPLEMENTATION_STATUS.md    internal links: 31  anchors: 34
                      MASTER_IMPLEMENTATION_CHECKLIST.md  internal links: 31  anchors: 61
                      MODULE_MAP.md                       internal links: 17  anchors: 25
                      internal links : 79
                      external links : 0 (skipped — out of scope)
                      broken         : 0
                    Negative test: a temporary copy of the validator run over a planted
                    fixture containing one missing file link and one missing anchor
                    reported broken = 2 and exited 1, confirming the check can fail.
SECURITY:           N/A — no application code, no data, no credentials introduced. The
                    validator reads Markdown from the repository and writes nothing.
UI/UX REVIEW:       N/A — no user-facing surface.
MIGRATIONS:         None.
EVENTS:             None.
CONFIG / POLICY:    None. No business constants introduced; policy values in v3 §20 are
                    recorded as configuration requirements, not as values.
KNOWN LIMITATIONS:  (As recorded at FND-001a. Superseded in part by FND-001b — see §11.2.)
                    Documents describe intent only. None of the architectural rules was
                    machine-enforced at this point; FND-001b has since delivered four of the
                    eight MODULE_MAP §13 checks (risk R-02, now Medium). The validator checks document integrity, not the correctness of
                    any statement inside a document. External URLs are not checked. The
                    validator requires a Node runtime; the repository now pins one —
                    Node 26.7.0 via .nvmrc and npm 11.19.0 via packageManager, added by
                    FND-001a under P0-04.
DEFERRED:           17 of the 20 v3 §42 /docs files (tracked as P0-02); all 62 module
                    contracts (tracked in checklist §B and §C).
COMMITS:            Recorded at commit time for this branch.
FILES:              docs/CURRENT_IMPLEMENTATION_STATUS.md
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md
                    docs/MODULE_MAP.md
                    docs/tools/validate-doc-links.mjs
FOLLOW-UP:          FND-001 (§8). Then FND-002…FND-006, DOC-002. FND-001 should add
                    `node docs/tools/validate-doc-links.mjs` to CI (P0-09) so documentation
                    integrity is enforced on every change rather than on request.
```

**Every other item in the checklist records `NONE — no implementation`.** That is the accurate value.

### 11.1 Evidence — FND-001a (pinned toolchain and test harness)

Every command below was run from a **clean dependency state**: `node_modules/` and `dist/`
deleted, then `npm ci` against the committed lockfile.

```text
ITEM ID:            FND-001a (first subtask of FND-001)
MODULE / PHASE:     Platform substrate / Phase 0, build step B-0
STATUS:             DELIVERED — but no checklist item is marked COMPLETE.
                    P0-04 is satisfied; P0-03, P0-05..P0-08 are partial; all are IN PROGRESS.
                    FND-001 as a whole is IN PROGRESS.

IMPLEMENTED:        Reproducibility contract — two distinct claims, kept distinct:

                      PINNED DEVELOPMENT TOOLCHAIN (exact; what this repository is actually
                      developed and verified against)
                        Node  26.7.0   .nvmrc
                        npm   11.19.0  package.json "packageManager": "npm@11.19.0"

                      SUPPORTED RUNTIME RANGES (minimums; what the project will run on)
                        Node  >=22.18.0   package.json engines.node
                        npm   >=10.0.0    package.json engines.npm

                    The pins name one version each; the ranges stay open. A lockfile fixes the
                    dependency graph but not the tool that resolves it, so the package manager
                    is pinned explicitly rather than left to whatever npm happens to be present.
                    Six devDependencies pinned to exact versions (no carets) with a committed
                    package-lock.json.
                    Strict TypeScript: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
                    noUnusedLocals/Parameters, verbatimModuleSyntax, erasableSyntaxOnly — the last
                    of which lets Node run the sources directly, so there is no build step between
                    editing and testing.
                    ESLint 10 flat config with type-aware typescript-eslint; Prettier.
                    platform/runtime/node-version.ts — parseVersion, compareVersions,
                    satisfiesMinimum. Makes the engines.node pin checkable from code rather than
                    merely declared in a manifest. Refuses version ranges it does not understand
                    instead of silently accepting them.
                    tests/node-version.test.ts — 7 tests.
                    platform/runtime/package-manager.ts — parsePackageManager, which accepts an
                    exact name@major.minor.patch pin (tolerating Corepack's +integrity suffix)
                    and rejects range syntax outright. A "pin" that admits a span of versions
                    is not a pin.
                    tests/toolchain.test.ts — 8 tests binding the pins to the ranges.

TESTED:             15 tests, all real assertions.

                    Version handling (7): parsing including prerelease and build metadata;
                    rejection of six malformed inputs; ordering that is numeric rather than
                    lexicographic (22.18.0 > 22.9.0); inclusive minimum boundary; refusal of five
                    unsupported range forms; and the running Node satisfying engines.node.

                    Reproducibility contract (8): parsePackageManager accepting exact pins and
                    the Corepack integrity suffix, and rejecting ten non-exact forms
                    (^, ~, >=, partial, x, *, latest, bare name, bare version, empty);
                    .nvmrc being an exact version rather than a range or alias;
                    THE EXACT .nvmrc RUNTIME SATISFYING engines.node;
                    packageManager PINNING AN EXACT npm VERSION THAT SATISFIES engines.npm;
                    the ranges remaining minimums while the pins remain exact; and the npm
                    actually running the scripts matching the pin (read from
                    npm_config_user_agent, skipped when invoked outside an npm script).

                    These read the real .nvmrc and package.json rather than restating their
                    contents, so they catch drift instead of documenting it.

TEST COMMANDS:      npm ci
                    npm run typecheck
                    npm run lint
                    npm run format:check
                    npm run build
                    npm test
                    (npm run verify chains the last five in order)

TEST RESULTS:       npm ci                exit 0   added 91 packages
                    npm run typecheck     exit 0   tsc -p tsconfig.json --noEmit
                    npm run lint          exit 0   eslint .
                    npm run format:check  exit 0   All matched files use Prettier code style!
                    npm run build         exit 0   tsc -p tsconfig.build.json
                                                   emitted dist/runtime/node-version.js,
                                                   .d.ts and .js.map
                    npm test              exit 0   tests 15, pass 15, fail 0, cancelled 0,
                                                   skipped 0, todo 0
                    npm run verify        exit 0   full chain, clean dependency state

                    Harness failure proof: node --test over a throwaway failing assertion,
                    run outside the repository, exits 1 and reports the failure — so a green
                    suite is a real signal, not a runner that cannot fail.

                    Reproducibility-contract failure proof — each contradiction was planted in
                    the working tree, observed to fail, then reverted:
                      .nvmrc set to 20.0.0 (below engines.node)
                        npm test exit 1, pass 14, fail 1
                        ".nvmrc pins Node 20.0.0, which does not satisfy engines.node >=22.18.0"
                      packageManager set to "npm@^11.19.0" (a range, not a pin)
                        npm test exit 1, 3 tests failed
                        "Invalid packageManager \"npm@^11.19.0\": expected an exact pin of the
                         form \"name@major.minor.patch\""
                    Both pins were restored and the suite returned to 15/15, exit 0.

SECURITY:           No secrets committed; .env* git-ignored. No authentication, permissions,
                    network access or data handling exists to review. Dependency audit is NOT
                    configured — that belongs to FND-001c.

UI/UX REVIEW:       N/A — no user-facing surface.

MIGRATIONS:         None. No database, no migration system. Out of scope; FND-002.

EVENTS:             None. No event infrastructure exists.

CONFIG / POLICY:    No business constants introduced. No policy values.

KNOWN LIMITATIONS:  1. No CI. Every command was verified locally only; nothing runs automatically
                       on a change. FND-001c.
                    2. No boundary enforcement. Every architectural rule in MODULE_MAP is still
                       advisory, enforced by review only. Risk R-02 is unmitigated. FND-001b.
                    3. Source layout is partial: platform/ and tests/ only. kernel/, modules/,
                       design-system/ and apps/ do not exist, so P0-03 is not satisfied.
                    4. build is a compilation check. Nothing executable is emitted yet, because
                       no entry point exists — so the build proves the code compiles, not that a
                       shipped artefact runs.
                    5. satisfiesMinimum supports only the ">=x.y.z" form actually used by this
                       repository, and parsePackageManager only the exact "name@x.y.z" form.
                       Deliberate: a checker that silently accepts syntax it does not understand
                       is worse than none.
                    7. The packageManager pin is declarative. Nothing in this repository installs
                       or switches npm; honouring the pin requires Corepack or an equivalent, and
                       the "npm actually running the scripts" assertion is what surfaces a
                       mismatch. It also self-skips when the suite is invoked outside an npm
                       script, since there is then no npm to compare against.
                    6. No contributor documentation and no git workflow conventions. FND-001d.

DEFERRED:           P0-03 completion, P0-09, P0-10, P0-11, P0-12, P0-13 to FND-001b/c/d.
                    P0-14..P0-18 (data layer) to FND-002.

COMMITS:            Recorded at commit time for this branch.

FILES:              .nvmrc, .gitignore, .gitattributes, .editorconfig, .prettierrc.json,
                    .prettierignore, package.json, package-lock.json, tsconfig.json,
                    tsconfig.build.json, eslint.config.mjs, platform/README.md,
                    platform/runtime/node-version.ts, platform/runtime/package-manager.ts,
                    tests/node-version.test.ts, tests/toolchain.test.ts
                    Also modified: docs/tools/validate-doc-links.mjs — one redundant regex
                    escape removed so that "npm run lint" passes across the repository.
                    Behaviour unchanged: validator output identical before and after the
                    change. (Absolute link counts move as the documents change; the current
                    figure is whatever the validator prints — see the DOC-001 block above.)

FOLLOW-UP:          FND-001b (source roots + boundary enforcement) — since DELIVERED, §11.2.
                    Then FND-001c (CI), then FND-001d (contributor docs). FND-001 stays
                    IN PROGRESS until both land.
```

**Reproducing it:** `npm ci && npm run verify` from a clean clone. Exit 0 means every claim above
still holds.

---

### 11.2 Evidence — FND-001b (source roots, architecture manifest, boundary enforcement)

Every command below was run from a **clean dependency state**: `node_modules/` and `dist/`
deleted, then `npm ci`.

```text
ITEM ID:            P0-03 (COMPLETE), P0-11 (COMPLETE), P0-10 (IN PROGRESS)
MODULE / PHASE:     Platform substrate / Phase 0, build step B-0
STATUS:             DELIVERED. P0-03 and P0-11 are COMPLETE. P0-10 is IN PROGRESS because it
                    references MODULE_MAP §13, which lists eight checks; four are built.
                    FND-001 as a whole remains IN PROGRESS: FND-001c (CI) and FND-001d
                    (contributor docs, git conventions) are not started.

IMPLEMENTED:        Source roots: kernel/, modules/, design-system/, apps/ created, tracked and
                    documented with per-root ownership READMEs. All four are empty of
                    implementation.
                    platform/architecture/manifest.ts — machine-readable encoding of
                    docs/MODULE_MAP.md: 15 kernel components, 47 business modules, layer depths
                    L1..L8, the financial authority zone as PATH PREFIXES (so the Rewards entry
                    names modules/rewards/ledger specifically, which is what §11 places in the
                    zone), and the model-provider SDK list.
                    platform/checks/boundaries.ts — four checks:
                      layer-direction    imports point downward only; same-layer modules must
                                         use events; unregistered units are rejected because
                                         their layer is unknown
                      kernel-purity      the kernel never imports a module, the design system
                                         or an app
                      financial-zone-ai  the financial authority zone never imports K-13 (P0)
                      provider-import    only kernel/ai-gateway may import a provider SDK
                    Imports are extracted with the TypeScript compiler API, not by regular
                    expression, so multi-line imports, dynamic import(), export-from,
                    import-equals-require and commented-out code are handled exactly.
                    platform/checks/cli.ts — npm run check:boundaries, exit 1 on any violation,
                    with --root, --json and --quiet.

INTEGRATION:        npm run verify now chains:
                      typecheck -> lint -> format:check -> build -> check:boundaries -> test
                    build additionally runs a postbuild step executing the EMITTED
                    dist/checks/cli.js, so the compiled artefact is proven to run rather than
                    merely to compile.

TESTED:             32 tests (15 from FND-001a, 17 added here).
                    tests/manifest.test.ts (7): counts, unique and kebab-case slugs, sequential
                    ids, known and ascending layer depths, the AI Gateway being registered,
                    every financial-zone prefix naming a registered unit, path-boundary
                    matching, and provider detection covering subpaths and scopes without
                    matching lookalikes such as "openai-schema-validator".
                    tests/boundaries.test.ts (10): the real source tree passing; a clean
                    fixture exercising every allowed edge; one planted-violation proof per
                    check; an unregistered-unit case; a coverage test asserting every declared
                    check id has a fixture; plus unit tests for import extraction and unit
                    classification.

TEST COMMANDS:      npm ci
                    node docs/tools/validate-doc-links.mjs
                    npm run typecheck
                    npm run lint
                    npm run format:check
                    npm run build
                    npm run check:boundaries
                    npm test
                    npm run verify

TEST RESULTS:       npm ci                    exit 0   added 91 packages
                    validate-doc-links        exit 0   3 files, 79 internal links, 0 broken
                    npm run typecheck         exit 0
                    npm run lint              exit 0
                    npm run format:check      exit 0
                    npm run build             exit 0   postbuild ran dist/checks/cli.js ->
                                                       "PASS — 5 files, 8 imports, 0 violations"
                    npm run check:boundaries  exit 0   5 files, 8 imports scanned
                                                       layer-direction    PASS
                                                       kernel-purity      PASS
                                                       financial-zone-ai  PASS
                                                       provider-import    PASS
                    npm test                  exit 0   tests 32, pass 32, fail 0, cancelled 0,
                                                       skipped 0, todo 0
                    npm run verify            exit 0   full chain, clean dependency state

                    Persistent planted-violation fixtures, each run through the CLI:
                      violation-layer-direction     exit 1   P1 layer-direction x2
                                                             (L2->L5 upward; L7->L7 sibling)
                      violation-kernel-purity       exit 1   P1 kernel-purity
                      violation-financial-zone-ai   exit 1   P0 financial-zone-ai x2
                      violation-provider-import     exit 1   P1 provider-import x2
                      violation-unregistered-unit   exit 1   P1 layer-direction
                      clean (control)               exit 0   no violations
                    Control inside the financial-zone fixture: modules/rewards/ui is NOT
                    flagged, proving the zone matches on path boundaries rather than on the
                    module name.

FIXTURE ISOLATION:  Fixtures are excluded from TypeScript (tsconfig.json), ESLint
                    (eslint.config.mjs) and Prettier (.prettierignore). Two of the three
                    exclusions were shown to be load-bearing by removing them:
                      tsconfig exclusion removed  -> npm run typecheck exit 2, 3 x TS2307
                                                     ("Cannot find module 'openai'")
                      eslint exclusion removed    -> npm run lint exit 1, 23 parsing errors
                                                     ("was not found by the project service")
                      prettier exclusion removed  -> format:check still exit 0; the fixtures
                                                     happen to be Prettier-conformant, so this
                                                     one is defence in depth rather than
                                                     currently load-bearing
                    All three exclusions were restored and the chain re-run green.

SECURITY:           No secrets; no credentials; no network access. The checks read source files
                    and write nothing. No authentication, permissions or data handling exists
                    to review.

UI/UX REVIEW:       N/A — no user-facing surface.

MIGRATIONS:         None. No database. Out of scope; FND-002.

EVENTS:             None. No event infrastructure exists; K-08 is build step B-1.

CONFIG / POLICY:    No business constants introduced. The financial zone and provider list in
                    the manifest are architectural facts, not commercial policy.

KNOWN LIMITATIONS:  1. STATIC IMPORTS ONLY. The checks read import/export/dynamic-import/require
                       specifiers. Runtime indirection — a service locator, dependency
                       injection by name, or raw SQL reaching another module's table — is
                       invisible to them. The B-1 table-ownership check narrows this.
                    2. Four of the eight MODULE_MAP §13 checks are not built: table ownership,
                       policy-literal scan, contract presence, cycle detection. Each needs an
                       artefact that does not exist yet.
                    3. The kernel is treated as ONE layer. Its internal ordering
                       (K-01 -> K-02/K-03 -> K-04) is not checked.
                    4. NO CI. Every check runs only when someone runs it. FND-001c.
                    5. The provider list is an allowlist of known SDKs. An unlisted provider is
                       an unenforced provider; the list must be extended when one is adopted.
                    6. The checks currently scan 5 files, because kernel/ and modules/ contain
                       no source. Their real load-bearing test arrives with the first module.

DEFERRED:           P0-09 (CI) to FND-001c. P0-12, P0-13 (contributor docs, git conventions) to
                    FND-001d. The four B-1 checks to FND-002/FND-003.

COMMITS:            Recorded at commit time for this branch.

FILES:              kernel/README.md, modules/README.md, design-system/README.md,
                    apps/README.md, tests/README.md,
                    platform/architecture/manifest.ts, platform/checks/boundaries.ts,
                    platform/checks/cli.ts, tests/manifest.test.ts, tests/boundaries.test.ts,
                    tests/fixtures/** (22 files),
                    modified: package.json (check:boundaries, postbuild, verify),
                    tsconfig.json, eslint.config.mjs, .prettierignore (fixture exclusions)

FOLLOW-UP:          FND-001c (CI), then FND-001d (contributor docs and git conventions).
                    FND-001 stays IN PROGRESS until both land.
                    Risk R-13 (cockpits are same-layer with the modules they compose) will be
                    hit by layer-direction at build step B-5 and needs an architectural
                    decision, not a disabled check.
```

---

### 11.3 Corrections applied to the DOC-001 baseline after first review

Two defects were found in the DOC-001 baseline by review and corrected. Recorded here per v3 §58 rather than silently patched.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **Build order contradicted declared dependencies.** [MODULE_MAP.md](./MODULE_MAP.md) §3 declares K-09 Audit as depending on K-01 and K-04, yet the §9 build order scheduled K-09 in step B-1 while K-01 and K-04 land in B-2 — the component was sequenced ahead of its own dependencies. Inspection of adjacent entries found the identical defect in **K-07 Feature Flags** (declared deps K-03 and K-05; also scheduled in B-1 ahead of K-03). | Build order must be a topological order of the declared dependency graph — the same acyclicity discipline the document imposes on modules (MR-2) was not applied to its own schedule. | K-07 and K-09 moved to B-2, after the identity chain. B-1 now contains only K-05 and K-08, whose sole dependency is the substrate. An explicit ordering rule was added to [MODULE_MAP.md §9](./MODULE_MAP.md#9-build-order) so the constraint is stated, not just satisfied once. Propagated to checklist §B (K-07, K-09 build step) and to the FND-003 / FND-004 task scopes in §8 of this document. |
| 2 | **Wrong risk reference.** [MODULE_MAP.md](./MODULE_MAP.md) §13 attributed the unenforced-boundary-rules gap to risk R-05, which is scope-to-verification mismatch. | Cross-document references must resolve to the thing they name. | Corrected to **R-02 — boundary rules are unenforced**, and made a deep link to [§5](#5-current-risks) so the reference is now machine-checkable by the validator rather than only by eye. |

Neither defect changed any status, count or gate: the baseline remains 474 tracked requirements with 0 of 472 implementation items complete.

---

### 11.4 Evidence — FND-001d (contributor documentation and git conventions)

Documentation is the one deliverable that can be wrong without anything failing. So this subtask
delivers the document **and** the mechanism that stops it rotting:
`platform/checks/docs-contract.ts` states each guarantee the document must keep, and
`tests/docs-contract.test.ts` — run by `npm test`, and so by `npm run verify` — deletes or softens
each one in turn and requires the contract to catch it. The expectations are read from the
repository (`.nvmrc`, the `verify` script, `CHECK_IDS`, the architecture manifest, the fixture
directory) rather than restated, so when the repository changes the contract follows it and the
document is what has to catch up.

```text
ITEM ID:            P0-12, P0-13 (FND-001d)
MODULE / PHASE:     Platform substrate — documentation / Phase 0
STATUS:             COMPLETE (both items)

IMPLEMENTED:        docs/CONTRIBUTING.md — 13 sections covering: exact prerequisites
                    (Node 26.7.0, npm 11.19.0) and how to obtain them; clean-clone setup via
                    npm ci, with the reason npm install is not used; the pinned toolchain and
                    its distinction from the supported ranges; every verification command,
                    including the six gates npm run verify chains, the link validator and the
                    dependency audit; the six planted-violation fixtures and why they must not
                    be "fixed"; module ownership and the six dependency rules; the prohibition
                    on AI holding financial authority, with the zone enumerated; the
                    confinement of provider SDK imports to K-13; secrets handling; the
                    atomic-change convention; the six review questions; and branch, commit and
                    Conductor-managed Git conventions.

                    platform/checks/docs-contract.ts — 15 named guarantees
                    (prerequisites, clean-clone, toolchain-pins, verification-commands,
                    boundary-checks, planted-fixtures, module-ownership, dependency-rules,
                    financial-ai-prohibition, provider-import-restriction, secrets-handling,
                    atomic-changes, review, branch-conventions, link-integrity), each
                    returning a named violation. Fenced code blocks are stripped before prose
                    checks, so a command quoted in an example cannot satisfy a prose rule.

                    tests/docs-contract.test.ts — 36 cases: 5 asserting the document as
                    written, 30 planted erosions, and 1 asserting every declared guarantee has
                    at least one erosion covering it.

TESTED:             68 tests (32 from FND-001a and FND-001b, 36 added here). The erosion cases
                    each mutate a copy of the REAL document, not a fixture, so they stay honest
                    as the document evolves; the mutation helper asserts its own pattern still
                    matches, so a stale test fails loudly instead of passing vacuously.

TEST COMMANDS:      npm run verify
                    node docs/tools/validate-doc-links.mjs
                    npm audit --audit-level=high
                    git diff --check

TEST RESULTS:       npm run verify          exit 0
                      typecheck             exit 0
                      lint                  exit 0
                      format:check          exit 0   All matched files use Prettier code style
                      build                 exit 0   postbuild: PASS, 5 files, 8 imports,
                                                     0 violations
                      check:boundaries      exit 0   layer-direction PASS, kernel-purity PASS,
                                                     financial-zone-ai PASS,
                                                     provider-import PASS
                      test                  exit 0   tests 68, pass 68, fail 0, cancelled 0,
                                                     skipped 0, todo 0
                    node docs/tools/validate-doc-links.mjs   exit 0
                      files scanned  : 4
                      internal links : 115
                      broken         : 0
                    npm audit --audit-level=high   exit 0   found 0 vulnerabilities
                    git diff --check               exit 0   no whitespace errors

                    Negative test, recorded because a documentation check that cannot fail is
                    worthless: while this subtask was in progress the link validator reported
                    broken = 2 and exited 1 against the checklist forward references to this
                    very section, before the section existed. It caught the defect that was
                    actually present, unprompted, and passed only once the defect was fixed.

SECURITY:           No credentials, tokens or endpoints introduced. Section 9 of the new
                    document states the secrets rules the repository already relies on: nothing
                    committed, .env and .env.* ignored, .env.example carries names only,
                    rotate-then-remove for a leaked secret. No secret-management infrastructure
                    exists yet, and the document says so rather than implying one.

UI/UX REVIEW:       N/A — no user-facing surface.
MIGRATIONS:         None.
EVENTS:             None.

CONFIG / POLICY:    None. No business constants introduced. The document restates existing
                    architectural policy; it does not create any.

KNOWN LIMITATIONS:  1. The contract is textual. It proves a guarantee is still STATED, not that
                       it is still TRUE — a document could keep every required phrase while the
                       surrounding prose contradicts it. The boundary checks, not this contract,
                       are what make the architectural rules true.
                    2. Canonical phrasing. Several guarantees are keyed to a specific sentence
                       ("AI never decides money", "No secret is ever committed"). A faithful
                       paraphrase fails the contract and has to be applied in both places. That
                       is the deliberate trade for mutation-testability.
                    3. The default branch is stated in the test rather than derived, because
                       deriving it from the document under test would make the assertion
                       vacuous. A second case cross-checks it against origin/HEAD where that ref
                       is available, and returns early where it is not.
                    4. Setup instructions are only as current as the repository. They describe a
                       substrate with no database, no services and no environment variables;
                       FND-002 will require sections 1 and 2 to be revisited.
                    5. NOT VERIFIED BY CI. Like every other check here, this contract runs only
                       when somebody runs it. P0-09, blocked by BL-10.

DEFERRED:           P0-09 (CI) remains BLOCKED on BL-10 — not deferred. FND-001 stays IN
                    PROGRESS until it lands.

COMMITS:            Recorded at commit time for this branch.

FILES:              docs/CONTRIBUTING.md,
                    platform/checks/docs-contract.ts,
                    tests/docs-contract.test.ts,
                    modified: docs/CURRENT_IMPLEMENTATION_STATUS.md,
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md

FOLLOW-UP:          FND-001c is the only remaining FND-001 subtask and is blocked by BL-10.
                    Escalate the credential permission; nothing else in Phase 0 waits on it,
                    but FND-001 cannot be marked complete until it clears.
                    When CI does land, section 4 of the contributor document and the
                    verification-commands guarantee should be extended to name the CI workflow,
                    and X-44 and X-46 can move from IN PROGRESS to COMPLETE.
```

---

### 11.5 Evidence — FND-002a (database selection, migration contract, schema namespaces)

This subtask delivers the **contract** a migration must satisfy, not the ability to run one. That
distinction is load-bearing and is preserved everywhere below: no database was installed, no
connection was opened, and the migrations in `db/migrations/` have never been executed against a
live server. What is proved is that a structurally unsafe migration cannot enter the repository.

The validator is static by design. Parsing SQL as text means the checks run inside `npm run verify`
on any machine, on every change — rather than at deploy time, when the cost of being wrong is
highest and the feedback arrives last.

```text
ITEM ID:            P0-14, P0-15, P0-16 (FND-002a)
MODULE / PHASE:     Platform substrate — data foundation / Phase 0
STATUS:             P0-14 IN PROGRESS — selection decided, provisioning absent
                    P0-15 IN PROGRESS — file contract and validator delivered, runner absent
                    P0-16 IN PROGRESS — convention defined and enforced for migrations
                    P0-17 NOT STARTED — no seed or fixture strategy
                    Nothing is marked COMPLETE.

IMPLEMENTED:        Database selection: PostgreSQL 16 or later. Chosen for what this architecture
                    already assumes — schema namespaces as a first-class ownership boundary,
                    transactional DDL so a failed migration rolls itself back, and the constraint
                    vocabulary the deterministic financial zone will need.

                    db/migrations/ — two forward migrations with their rollbacks:
                      0001_create_platform_schema.up.sql / .down.sql
                        creates the `platform` schema; the rollback uses RESTRICT rather than
                        CASCADE so a non-empty schema fails loudly instead of being destroyed
                      0002_create_migration_ledger.up.sql / .down.sql
                        creates platform.schema_migrations — version, slug, checksum, applied_at,
                        applied_by, duration_ms, with format and non-negativity constraints
                    No kernel or business-module tables. A test asserts every delivered migration
                    is owned by the platform schema, so that bound is enforced rather than stated.

                    platform/db/schema-namespaces.ts — the ownership convention, DERIVED from
                    platform/architecture/manifest.ts rather than maintained as a second list:
                      platform substrate  -> platform
                      kernel component    -> kernel_<dir>   (K-01 Identity -> kernel_identity)
                      business module     -> module_<dir>   (M-11 Orders   -> module_orders)
                    63 schemas total (1 + 15 + 47). `public` resolves to no owner, deliberately.

                    platform/db/migrations.ts — ten checks:
                      malformed-name       P1   NNNN_snake_case_slug.(up|down).sql
                      malformed-header     P1   header names migration, direction and owner
                      duplicate-version    P0   one migration per version per direction
                      missing-rollback     P0   every .up.sql has its .down.sql
                      orphan-rollback      P1   no rollback without its forward migration
                      non-transactional    P0   wrapped in BEGIN; ... COMMIT;
                      public-schema        P0   no public., no unqualified object creation
                      cross-owner-schema   P0   touches only the schema it declares as owner
                      unregistered-schema  P0   every schema resolves to a manifest unit
                      unsafe-statement     P0   forward migrations are additive; TRUNCATE,
                                                DROP DATABASE and GRANT ... TO PUBLIC refused
                                                in either direction
                    Comment and string-literal content is blanked before analysis, preserving line
                    structure, so a statement quoted in a comment can neither trigger a check nor
                    satisfy one, and reported line numbers stay correct.

                    platform/db/cli.ts — `npm run check:migrations`, wired into `npm run verify`
                    between the boundary checks and the tests, and into `postbuild` so the emitted
                    dist/ output is exercised too.

                    docs/CONTRIBUTING.md section 6 — prerequisites, the validator commands, the
                    namespace table, how to write a migration, and an explicit table of what is
                    NOT delivered. Four new documentation-contract guarantees fail the build if
                    that honesty is later edited out.

TESTED:             97 tests (68 before this subtask, 29 added). tests/migrations.test.ts holds 25
                    of them; the rest extend the documentation contract.

                    The planted fixtures are the substance. tests/fixtures/migrations/ contains a
                    `valid/` control plus one `invalid-<check>/` directory per check, and each is
                    asserted to produce EXACTLY that check and no other — a fixture that drifted
                    into breaking two rules would stop proving anything precise about either. A
                    coverage test fails the build if a check is ever added without a fixture.

TEST COMMANDS:      npm run verify
                    npm run check:migrations
                    node platform/db/cli.ts --dir tests/fixtures/migrations/<each fixture>
                    node docs/tools/validate-doc-links.mjs
                    npm audit --audit-level=high
                    git diff --check

TEST RESULTS:       npm run verify          exit 0
                      typecheck             exit 0
                      lint                  exit 0
                      format:check          exit 0
                      build                 exit 0   postbuild: boundary PASS + migration PASS
                      check:boundaries      exit 0   4 checks PASS, 0 violations
                      check:migrations      exit 0   4 files, 10 checks PASS, 0 violations
                      test                  exit 0   tests 97, pass 97, fail 0

                    Migration validator against the real set          exit 0
                      files scanned 4, forward 2, rollback 2, owned schemas 63, 0 violations

                    Migration validator against every planted fixture:
                      valid                          exit 0   PASS, 2 files, 0 violations
                      invalid-malformed-name         exit 1   malformed-name
                      invalid-malformed-header       exit 1   malformed-header
                      invalid-duplicate-version      exit 1   duplicate-version
                      invalid-missing-rollback       exit 1   missing-rollback
                      invalid-orphan-rollback        exit 1   orphan-rollback
                      invalid-non-transactional      exit 1   non-transactional
                      invalid-public-schema          exit 1   public-schema
                      invalid-cross-owner-schema     exit 1   cross-owner-schema
                      invalid-unregistered-schema    exit 1   unregistered-schema
                      invalid-unsafe-statement       exit 1   unsafe-statement

                    node docs/tools/validate-doc-links.mjs   exit 0   4 files, 0 broken
                    npm audit --audit-level=high             exit 0   found 0 vulnerabilities
                    git diff --check                         exit 0   no whitespace errors

                    NOT RUN: no migration was applied to a database, because no PostgreSQL server
                    is available in this environment and none is provisioned by this repository.
                    The SQL is unexecuted. That is the single largest gap in this evidence and is
                    the reason P0-14 and P0-15 remain IN PROGRESS.

SECURITY:           No credentials, connection strings or endpoints introduced. The ledger records
                    current_user and a timestamp, no secrets. GRANT ... TO PUBLIC is refused by
                    the validator in either direction. `public` is rejected as an owner or as a
                    reference, which is a containment rule as much as an architectural one.

UI/UX REVIEW:       N/A — no user-facing surface.
MIGRATIONS:         Two forward, two rollback, none applied anywhere.
EVENTS:             None.

CONFIG / POLICY:    None. No business constants introduced. PostgreSQL 16+ is a technology
                    selection, recorded here and in docs/CONTRIBUTING.md section 6.

KNOWN LIMITATIONS:  1. NOTHING HAS RUN. The migrations are validated, not executed. A file can
                       satisfy every check here and still fail against a real server — a bad type,
                       a constraint that cannot be satisfied by existing rows, a lock that will not
                       be granted. Only a runner and a live database close this.
                    2. The validator is textual, not a SQL parser. It reads statements with
                       regular expressions after blanking comments and strings. Exotic syntax,
                       nested dollar-quoting inside dollar-quoted bodies, or a schema reached
                       through a variable would evade it.
                    3. Transaction wrapping is required unconditionally. CREATE INDEX CONCURRENTLY
                       and a few other statements cannot run inside a transaction; when the first
                       one is genuinely needed, this check needs an explicit, justified exception
                       mechanism rather than a quiet relaxation.
                    4. Cross-owner access is checked in migrations only. A module reading another
                       module's tables at RUNTIME is invisible here — that is the table-ownership
                       check in MODULE_MAP.md §13, still unbuilt, and it needs a real schema first.
                    5. No seed or fixture strategy (P0-17), no connection pooling, no migration
                       ledger writer, no local provisioning.
                    6. NOT VERIFIED BY CI. Like every other check, this runs only when somebody
                       runs it. P0-09, blocked by BL-10.

DEFERRED:           P0-17 (seed/fixture strategy) to a later FND-002 subtask. Local provisioning
                    and the migration runner to FND-002b. The table-ownership check to the point
                    where a real schema exists.

COMMITS:            Recorded at commit time for this branch.

FILES:              db/migrations/0001_create_platform_schema.up.sql,
                    db/migrations/0001_create_platform_schema.down.sql,
                    db/migrations/0002_create_migration_ledger.up.sql,
                    db/migrations/0002_create_migration_ledger.down.sql,
                    platform/db/schema-namespaces.ts, platform/db/migrations.ts,
                    platform/db/cli.ts, tests/migrations.test.ts,
                    tests/fixtures/migrations/** (11 directories),
                    modified: package.json (check:migrations, verify, postbuild),
                    docs/CONTRIBUTING.md (section 6 and renumbering),
                    platform/checks/docs-contract.ts, tests/docs-contract.test.ts,
                    docs/CURRENT_IMPLEMENTATION_STATUS.md,
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md

FOLLOW-UP:          FND-002b — local provisioning and a migration runner that writes the ledger
                    inside the migration's own transaction, at which point P0-14 and P0-15 can be
                    argued for COMPLETE against evidence of an actual applied migration.
                    FND-002c — seed and fixture strategy (P0-17).
                    P0-16 stays IN PROGRESS until the table-ownership check exists, since the
                    convention is currently enforced against migration files rather than against
                    running code.
```

---

### 11.6 Evidence — FND-002b (migration runner, PostgreSQL adapter, locking, checksums)

FND-002a proved a migration file cannot be structurally unsafe. This applies them. The properties
worth having are the ones that only matter on the worst day — atomicity with the ledger, exclusion
of a second runner, and refusing to guess when the evidence is inconsistent — so those are what the
tests assert.

**The runner has never been executed against a live PostgreSQL.** No server is available to this
repository. Its logic is proved against an injected fake, which is genuine evidence about control
flow and worthless as evidence about SQL validity. The opt-in integration test that would close
that gap **skipped**, and a skipped test is not evidence. That is why P0-14 and P0-15 remain
`IN PROGRESS`.

```text
ITEM ID:            P0-14, P0-15 (FND-002b)
MODULE / PHASE:     Platform substrate — data foundation / Phase 0
STATUS:             P0-14 IN PROGRESS — runner delivered, provisioning absent, nothing executed
                    P0-15 IN PROGRESS — runner delivered, never run against a live server
                    Nothing is marked COMPLETE.

IMPLEMENTED:        platform/db/client.ts — the injected Database interface (connect, query,
                    release) plus credential handling: redactConnectionString, redactText,
                    passwordOf. The runner is written against this interface and imports no
                    driver, which is what makes every failure path deterministically testable.

                    platform/db/postgres.ts — the adapter, and the only file that knows a driver
                    exists. Reads DATABASE_URL from the environment (never an argument, so it
                    cannot reach shell history or a process listing), holds only a redacted
                    description, and passes every driver message through redaction before it can
                    be printed. One session rather than a pool, because the advisory lock is
                    session-scoped. `pg` is imported dynamically and is NOT a declared dependency.

                    platform/db/runner.ts —
                      bootstrap        schema + ledger created IF NOT EXISTS in ONE transaction,
                                       before anything is applied, so a failure leaves neither
                      advisory lock    pg_try_advisory_lock on a frozen key (5573680152581085),
                                       taken once, released on every exit path including failure
                      discovery        refuses the whole set if the FND-002a contract fails
                      reconciliation   checksum drift, ledger rows with no file, and pending
                                       versions that sort before an applied one each abort
                      application      each migration's body and its ledger INSERT share one
                                       transaction; failure rolls both back
                      unwrapping       the file's own BEGIN/COMMIT is stripped and the body
                                       re-wrapped with the ledger write, located in comment- and
                                       string-blanked text so a quoted BEGIN cannot fool it
                      rollback         operator-invoked only, latest-version only, fail-closed

                    platform/db/migrate-cli.ts — `status`, `up`, `rollback`. Rollback requires
                    both --version NNNN and --yes. Exit 0 pass, 1 refusal, 2 misuse.

                    package.json — db:status, db:migrate, db:rollback, test:integration.

                    docs/CONTRIBUTING.md sections 6.6 and 6.7 — exact commands, the guarantee
                    table, the self-wrapped-SQL reconciliation, and how to run the integration
                    test.

RECONCILIATION:     The two things FND-002a left in tension are resolved here.
                    1. Self-wrapped SQL vs ledger atomicity. A file that commits itself would
                       commit before its ledger row. The runner strips exactly the outer
                       transaction and re-wraps the body with the INSERT, so the files stay
                       independently runnable via psql, the non-transactional check stays as it
                       is, and nothing commits unrecorded. A file not wrapped as the contract
                       requires is refused rather than executed.
                    2. Fresh-database bootstrap. The ledger cannot record migration 0001 because
                       0002 creates it. The runner creates schema and ledger itself in one
                       transaction first; 0001 and 0002 then apply as IF NOT EXISTS no-ops and
                       record their rows normally.

TESTED:             132 tests (97 before this subtask, 35 added), all against an injected fake.
                    Coverage of the behaviours named in the task:
                      clean bootstrap                  3 cases (incl. bootstrap failure leaving
                                                       neither schema nor ledger)
                      ordered incremental application  2
                      idempotent rerun                 1
                      lock release after success       1
                      lock release after failure       3 (bootstrap failure, SQL failure, refusal)
                      SQL failure rollback             2
                      checksum drift                   2 (forward run and rollback)
                      unknown ledger version           1
                      out-of-order version             1
                      concurrent-run exclusion         1
                      credential redaction             7
                      ledger atomicity / ordering      2
                      transaction unwrapping           2
                      rollback fail-closed             5
                    Plus 2 live-PostgreSQL cases that SKIPPED.

TEST COMMANDS:      npm run verify
                    npm run test:integration
                    node docs/tools/validate-doc-links.mjs
                    npm audit --audit-level=high
                    git diff --check

TEST RESULTS:       npm run verify          exit 0
                      typecheck             exit 0
                      lint                  exit 0
                      format:check          exit 0
                      build                 exit 0   postbuild: boundary PASS + migration PASS
                      check:boundaries      exit 0   4 checks PASS
                      check:migrations      exit 0   4 files, 10 checks PASS
                      test                  exit 0   tests 132, pass 132, fail 0, skipped 0

                    npm run test:integration   exit 0
                      tests 2, pass 0, fail 0, SKIPPED 2
                      reason printed for each: "DATABASE_URL is not set — no live database to
                      run against"
                      THIS IS NOT EVIDENCE THAT THE RUNNER WORKS. It is evidence that the suite
                      refuses to pretend.

                    node docs/tools/validate-doc-links.mjs   exit 0   4 files, 129 links, 0 broken
                    npm audit --audit-level=high             exit 0   found 0 vulnerabilities
                    git diff --check                         exit 0   no whitespace errors

                    CLI behaviour checked by hand:
                      node platform/db/migrate-cli.ts status          exit 1, refuses with the
                                                                     DATABASE_URL explanation
                      rollback --version 0002 (without --yes)         exit 2, refuses; the banner
                                                                     shows postgres://jaya:***@…
                                                                     with the password redacted

SECURITY:           The connection string is read from the environment only. It is never accepted
                    as an argument, never logged, and never attached as an error `cause` — a
                    driver error routinely quotes the connection string it failed on, and an error
                    chain is exactly what gets pasted into an issue. Two eslint-disable comments
                    in postgres.ts mark that deliberate departure from preserve-caught-error, with
                    the reason stated inline. Seven tests assert no password reaches a
                    description, a log line, or a rethrown message.

UI/UX REVIEW:       N/A — no user-facing surface.
MIGRATIONS:         Unchanged from FND-002a. Two forward, two rollback, none applied anywhere.
EVENTS:             None.

CONFIG / POLICY:    DATABASE_URL is the only configuration input. No defaults, no fallback: an
                    unset value is an explicit refusal.

KNOWN LIMITATIONS:  1. NOTHING HAS RUN AGAINST POSTGRESQL. The fake models the behaviours the
                       runner depends on; it does not parse SQL, enforce constraints, or
                       implement advisory locks. Everything about SQL validity and real locking
                       semantics remains unverified.
                    2. The `pg` driver is not a declared dependency, so the integration test
                       cannot run anywhere without an explicit `npm install --no-save pg`. That
                       keeps every ordinary install and audit free of an unused package; it also
                       means CI could not run the suite even if CI existed. Revisit when a real
                       environment exists.
                    3. No connection pooling, no retry, no statement timeout. A migration that
                       blocks on a lock will block until the server or the operator intervenes.
                    4. Rollback is one version at a time and latest-only by design. Multi-step
                       recovery is a sequence of deliberate operator commands, not a flag.
                    5. The runner assumes the migration set is append-only. It refuses an
                       out-of-order pending version rather than supporting branch-merge migration
                       histories, which is the right trade for one deployable but is a real
                       constraint on parallel work.
                    6. The missing-rollback-file branch is defence in depth: discovery already
                       refuses a set with an unpaired forward migration, so that specific error
                       is only reachable if the file disappears mid-run. The test asserts either
                       refusal, not that specific code.
                    7. NOT VERIFIED BY CI. P0-09, blocked by BL-10.

DEFERRED:           A verified live run to a later subtask, once a PostgreSQL runtime exists.
                    Local provisioning (container or service definition) to complete P0-14.
                    P0-17 seed/fixture strategy to FND-002c.

COMMITS:            Recorded at commit time for this branch.

FILES:              platform/db/client.ts, platform/db/postgres.ts, platform/db/runner.ts,
                    platform/db/migrate-cli.ts,
                    tests/migration-runner.test.ts, tests/helpers/fake-database.ts,
                    tests/integration/postgres-migration.integration.ts,
                    modified: package.json (db:* and test:integration scripts),
                    eslint.config.mjs (test override extended to integration files),
                    docs/CONTRIBUTING.md (sections 1, 4, 6.1, 6.6, 6.7),
                    docs/CURRENT_IMPLEMENTATION_STATUS.md,
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md

FOLLOW-UP:          Provision a PostgreSQL for development, run `npm run test:integration`
                    against it, and record the result. That single piece of evidence is what
                    P0-14 and P0-15 are waiting on; everything else for them is built.
                    Then FND-002c (seed and fixture strategy, P0-17).
```

---

### 11.7 Correction — FND-002b production readiness and transaction model

Three defects in the FND-002b delivery were found by review and corrected. Recorded here per v3
§58 rather than silently patched, because two of them were guarantees the previous evidence block
claimed and did not have.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **The runner could not run from a clean install.** `pg` was imported dynamically and deliberately left undeclared, so `npm ci` produced a migration tool that failed at the first connection with an instruction to install something. | A repository's declared install must produce working software. "Run this extra command first" is a defect, not a design. | `pg` 8.16.3 and `@types/pg` 8.15.5 declared and version-locked; the adapter now imports the driver statically. Verified by deleting `node_modules`, running `npm ci`, and reaching a real `ECONNREFUSED` from the driver — proof the driver loads and the connection is genuinely attempted. |
| 2 | **`status` and refused rollbacks created objects.** Both called the bootstrap, so asking an empty database what was applied created the schema and the ledger, and a rollback that was about to be refused did the same. | A command that reports on a database must not be the thing that changes it. | Both now ask `to_regclass` whether the ledger exists and treat absence as "nothing applied". Neither issues a mutating statement on an empty database, asserted deterministically and against a live server. |
| 3 | **An initial run could commit schema and ledger with no history, and the 0002 rollback was unexecutable.** The bootstrap committed in its own transaction, so a crash between it and the first migration left objects no history explained. Separately, `0002…down.sql` dropped `platform.schema_migrations` while the runner deleted that migration's row from the same table in the same transaction — the DELETE ran against a relation that no longer existed, and had it succeeded it would have erased the row for 0001 too. | Objects and the history that explains them commit together. Reversing one migration must not erase the record of the others. | The bootstrap DDL now joins the **first migration's** transaction, so schema, ledger and the first history row commit together or not at all; a run with nothing to apply creates nothing. The ledger is bootstrap-owned: `0002…down.sql` drops its index and comment and leaves the table, `0001…down.sql` resets the schema comment and leaves the schema. The runner deletes the history row **before** running the rollback body, removing the self-referential ordering hazard generally rather than only for this pair. |

**Tests added for the corrected guarantees** (deterministic, plus live equivalents that skip):

```text
status on an empty database creates nothing                            (asserts no CREATE/INSERT/DELETE/ALTER/DROP issued)
a refused rollback on an empty database creates nothing                (same assertion, refusal path)
a run that applies nothing creates neither schema nor ledger
on a fresh database the bootstrap shares the first migration transaction
a first-migration failure leaves neither schema, ledger nor history row
rolling back 0002 leaves the ledger intact, and the earlier history with it
the ledger row is deleted before the rollback body runs
```

The live suite gained two cases covering the same ground against a real server — an
empty-database probe of `information_schema.schemata` and `to_regclass` before and after
`status` and a refused rollback, and a 0002 rollback-then-reapply cycle. **Both skipped**, for
want of a PostgreSQL runtime.

```text
STATUS AFTER CORRECTION:
                    P0-14 IN PROGRESS — provisioning still absent, nothing executed
                    P0-15 IN PROGRESS — runner still never run against a live server
                    Nothing is marked COMPLETE.

TEST RESULTS:       npm run verify                 exit 0   tests 138, pass 138, fail 0
                    npm ci from a deleted node_modules
                                                   exit 0   0 vulnerabilities
                    node platform/db/migrate-cli.ts status (unreachable host)
                                                   exit 1   "could not connect to
                                                            postgres://jaya:***@127.0.0.1:1/jaya:
                                                            connect ECONNREFUSED 127.0.0.1:1"
                                                            — driver loaded from a clean install,
                                                            password redacted on a real driver error
                    npm run test:integration       exit 0   tests 4, pass 0, SKIPPED 4
                    node docs/tools/validate-doc-links.mjs
                                                   exit 0   4 files, 0 broken
                    npm audit --audit-level=high   exit 0   found 0 vulnerabilities
                    git diff --check               exit 0

STILL NOT VERIFIED: Every one of these corrections is proved against an injected fake and a
                    clean install. None has been proved against PostgreSQL, because no server is
                    available here. Transactional DDL semantics, advisory-lock behaviour and the
                    validity of the SQL itself remain unverified, which is why P0-14 and P0-15
                    are unchanged.
```

---

### 11.8 Evidence — FND-002c (local provisioning and isolated test-database lifecycle)

FND-002b left the runner able to apply migrations to a database that did not exist. This provides
one — reproducibly, on a developer's machine, and nowhere else.

**No Docker runtime is available to this repository, so the service has never been started.** Every
guarantee below is proved by inspecting the real artifacts and by planting weakened variants of
them; none is proved by running the thing. That distinction is why P0-14, P0-15, T-02, T-04, T-05,
T-20 and T-21 all remain incomplete.

```text
ITEM ID:            P0-14, T-21 (FND-002c)
MODULE / PHASE:     Platform substrate — data foundation / Phase 0
STATUS:             P0-14 IN PROGRESS — provisioning delivered, never started
                    T-21  IN PROGRESS — lifecycle delivered, never run against a server
                    P0-15, T-02, T-04, T-05, T-20 unchanged
                    Nothing is marked COMPLETE.

IMPLEMENTED:        compose.yaml — a DEVELOPMENT ONLY PostgreSQL service:
                      image     postgres:16.10-alpine3.22, an exact patch tag. A floating `16`
                                would let the database under the tests change without a line of
                                this repository changing
                      health    pg_isready against the real user and database, interval 2s,
                                retries 30. `db:ready` waits on this rather than on a sleep, so
                                "healthy" means "will accept our connection"
                      data      named volume jaya-postgres-data mounted at the data directory, so
                                `db:down` stops the service without discarding data
                      network   published on 127.0.0.1 only — a database whose example
                                credentials are committed must not be reachable from the network
                      secrets   POSTGRES_USER/PASSWORD/DB come from an untracked .env; compose
                                fails with a pointed message if they are unset

                    .env.example — every variable compose needs, with the password
                    `jaya_local_dev_only`: a placeholder that is safe to commit precisely because
                    it grants access to nothing but a loopback container holding disposable data.
                    .env and .env.* are git-ignored; .env.example is exempted.

                    platform/db/provision-cli.ts — up, ready, down, reset, destroy.
                    `reset` and `destroy` are the only commands that can lose data and both refuse
                    without --yes, naming what will be lost and what to run instead. `down` keeps
                    the volume, deliberately.

                    platform/db/test-database.ts — the isolated test-database lifecycle. The test
                    database is DERIVED from DATABASE_URL (jaya_dev -> jaya_dev_test) rather than
                    configured, because a separately-configured test URL is a URL somebody can
                    point somewhere else. assertSafeTestTarget refuses a non-loopback host, a name
                    not ending in _test, any name containing prod/production/live/staging/stage/
                    uat/preprod even on loopback, and anything it cannot parse. createTestDatabase
                    and dropTestDatabase each call the guard before acting.

                    platform/checks/provisioning-contract.ts — eleven guarantees over the real
                    artifacts: service-definition, pinned-version, health-check, persistent-data,
                    loopback-only, no-committed-secrets, env-example, commands,
                    destructive-confirmation, safe-target-guard, development-only.

                    tests/provisioning-contract.test.ts — in `npm run verify`.
                    tests/integration/test-database-lifecycle.integration.ts — opt-in, skips.

TESTED:             175 tests (138 before this subtask, 37 added), all passing.
                    Of the 37: 22 planted weakenings, 5 artifact/consistency assertions, 10
                    behavioural tests of the target guard.

                    The planted weakenings are the substance. Each mutates one real artifact and
                    requires the contract to catch it:
                      health check deleted / pg_isready removed / retries removed
                      image floated to `postgres:16`, to `latest`, downgraded to 14.11
                      password hardcoded into compose.yaml
                      real-looking credential put in .env.example
                      .env ignore rule removed; a .env reported as tracked by git
                      named volume removed; data directory unmounted
                      port published on every interface
                      postgres service renamed away
                      a required variable dropped from .env.example
                      a provisioning command dropped from package.json
                      --yes requirement removed; destructive command list emptied
                      target guard removed; a lifecycle function stops calling it; LOCAL_HOSTS
                        unexported
                      DEVELOPMENT ONLY statement deleted
                    A coverage test fails the build if a guarantee ever has no weakening.

                    The guard itself is tested behaviourally, not textually: non-loopback hosts,
                    names without the suffix, every forbidden marker on a loopback host,
                    unparseable strings, idempotent derivation, and that a refusal message never
                    echoes the password.

TEST COMMANDS:      npm run verify
                    node --test tests/provisioning-contract.test.ts
                    npm run test:integration
                    npm audit --audit-level=high
                    node docs/tools/validate-doc-links.mjs
                    git diff --check

TEST RESULTS:       npm run verify                     exit 0   tests 175, pass 175, fail 0
                    node --test tests/provisioning-contract.test.ts
                                                       exit 0   tests 37, pass 37, fail 0
                    npm run test:integration           exit 0   tests 7, pass 0, SKIPPED 7
                      reason: "DATABASE_URL is not set — no live database to run against" and
                      "…no local PostgreSQL to derive a test database from"
                      A SKIPPED SUITE IS NOT EVIDENCE THAT PROVISIONING WORKS.
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs
                                                       exit 0   4 files, 0 broken
                    git diff --check                   exit 0

                    NOT RUN: docker is not installed in this environment
                      $ command -v docker  ->  not found
                    so `npm run db:up`, `db:ready`, `db:reset`, `db:down` and `db:destroy` have
                    never been executed, and no PostgreSQL has ever been started from this
                    repository.

SECURITY:           No credential is committed. The only password in a tracked file is the known
                    placeholder, and the contract fails the build if .env.example ever carries
                    something secret-shaped, if compose.yaml hardcodes a password, if the ignore
                    rules for .env are weakened, or if git reports a .env as tracked. The service
                    binds to loopback only. The test-target guard refuses to act on anything that
                    is not demonstrably a local disposable database, and its refusal messages do
                    not echo connection strings.

UI/UX REVIEW:       N/A — no user-facing surface.
MIGRATIONS:         Unchanged. Two forward, two rollback, none applied anywhere.
EVENTS:             None.

CONFIG / POLICY:    DATABASE_URL plus POSTGRES_USER/PASSWORD/DB/PORT, all from an untracked .env
                    with a committed example. No defaults that could reach a real environment.

KNOWN LIMITATIONS:  1. NOTHING HAS BEEN STARTED. No Docker runtime here, so compose.yaml has never
                       been validated by Docker itself — only by the contract's own reading of it.
                       A syntax error Docker would reject could still be present.
                    2. Docker-specific. A contributor using Podman, Colima or a native install can
                       still use everything else by setting DATABASE_URL by hand, but `db:up` and
                       friends assume `docker compose`.
                    3. The image is pinned by tag, not by digest. A tag is immutable by convention
                       rather than by cryptography; a digest pin would be stronger and needs a
                       registry lookup this environment cannot make.
                    4. `db:reset` drops and recreates the application database but does not
                       re-apply migrations — that is `db:migrate`, deliberately kept separate so
                       the destructive step and the constructive one are distinct commands.
                    5. The forbidden-name list is a heuristic. A shared database called `scratch`
                       on a port-forward would pass the name check; the loopback rule and the
                       _test suffix are what carry the weight.
                    6. No seed or fixture data (P0-17), no backup, no restore, no upgrade path
                       between PostgreSQL majors.
                    7. NOT VERIFIED BY CI. P0-09, blocked by BL-10.

DEFERRED:           P0-17 seed/fixture strategy to FND-002d.
                    One verified live run — which is what P0-14, P0-15, T-02, T-04, T-05, T-20
                    and T-21 are all waiting on — to whenever a PostgreSQL runtime exists.

COMMITS:            Recorded at commit time for this branch.

FILES:              compose.yaml, .env.example,
                    platform/db/provision-cli.ts, platform/db/test-database.ts,
                    platform/checks/provisioning-contract.ts,
                    tests/provisioning-contract.test.ts,
                    tests/integration/test-database-lifecycle.integration.ts,
                    modified: package.json (db:up/db:ready/db:down/db:reset/db:destroy),
                    docs/CONTRIBUTING.md (sections 1, 4, 6.1, 6.8, 6.9),
                    docs/CURRENT_IMPLEMENTATION_STATUS.md,
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md

FOLLOW-UP:          On any machine with Docker: `npm run db:up && npm run db:ready &&
                    npm run test:integration`. Seven currently-skipped tests then become real
                    evidence, and P0-14, P0-15 and T-21 can be argued for COMPLETE against it.
                    Until then they stay IN PROGRESS. The next genuinely unblocked engineering
                    task is FND-003 (kernel build step B-1) — see §8.
```

---

### 11.9 Correction — FND-002c integration-test targeting, `.env` sufficiency, and a vacuous leftover proof

Three defects in the FND-002c delivery were found by review and corrected. Recorded here per v3 §58.
The first is the more serious kind: the delivery added a guarded, isolated test-database lifecycle
and then left the older suite migrating the development database beside it, so the repository
simultaneously proved that one suite was safe and shipped another that was not.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **The live migration suite ran against `DATABASE_URL` directly.** `postgres-migration.integration.ts` called `migrateUp`, `migrateDown` and a `DROP SCHEMA platform CASCADE` against whatever the contributor had configured — their development database. Running the tests destroyed local work, silently, with everything green. | A test suite may not destroy the data of the person running it. An isolated lifecycle that sits beside an unguarded suite protects nothing. | That file is deleted. Its coverage moved into `tests/integration/migrations.integration.ts`, where every case runs inside `withTestDatabase` — a derived `_test` database created for the test and dropped afterwards on success and failure alike. The configured database is now connection input only: the sole operation aimed at it is `migrationStatus`, which creates nothing, used to measure before and after that it was untouched. |
| 3 | **The leftover-database test proved nothing.** It created a marker inside `withTestDatabase` — which drops that database on the way out — then copied it to a *different* name, `${name}_kept`, and asserted a freshly-created database had no marker. Nothing ever occupied the guarded name when the run under test began, so the assertion held whether or not `withTestDatabase` replaced anything. | A test that cannot fail is not evidence. The claim was "a leftover at the guarded name is replaced, not reused"; the test never created that situation. | The suite now leaves a database at the **exact** derived `_test` name carrying a marker table, asserts both that the database exists and that the marker is present — so its later absence means something — then enters `withTestDatabase` and asserts the marker is gone and the name is the one it planted. Setup goes through the same guarded `createTestDatabase` path as everything else; cleanup is `removeTestDatabase()` in a `finally`, and a closing assertion confirms nothing survived. A new `seeded-cleanup` contract guarantee, with two planted mistakes, fails the build if any suite plants a leftover without removing it in a `finally`. |
| 2 | **`cp .env.example .env` was not sufficient.** Every `db:*` command and every live suite read `process.env` directly, so a contributor who followed the documented setup still got "DATABASE_URL is not set" — and, worse, the live suites reported that as an honest skip. The real cause was a missing, undocumented `export`. | Documented setup must be complete setup. A misconfiguration that presents as a legitimate skip is worse than one that fails. | `platform/db/env-file.ts` loads `.env` at the entry points — both CLIs and the integration harness — without overriding anything already set, so a shell export or CI secret still wins. The provisioning contract gained an `env-autoload` guarantee with planted weakenings, so a future entry point that forgets to load it fails the build. |

**The rule is now executable.** `platform/checks/integration-safety.ts` and
`tests/integration-safety.test.ts` run inside `npm run verify`, with no database in sight, and fail
the build if any file under `tests/integration`:

- constructs a `PostgresDatabase` outside the harness;
- reads `DATABASE_URL` outside the harness, by constant, literal or property access;
- calls `migrateUp`/`migrateDown` without entering `withTestDatabase`;
- plants a leftover database without removing it in a `finally`;
- or if the harness itself stops deriving, guarding, creating, dropping-in-`finally`, loading
  `.env`, or offering an honest skip.

Comments are blanked before analysis, so a file cannot satisfy a rule by mentioning it. Thirteen
planted mistakes cover the five guarantees, including the exact mistakes these corrections repair.

```text
STATUS AFTER CORRECTION:
                    P0-14 IN PROGRESS — provisioning delivered, never started
                    P0-15 IN PROGRESS — runner delivered, never run against a live server
                    T-21  IN PROGRESS — lifecycle delivered, never run against a server
                    T-02, T-04, T-05, T-20 unchanged and NOT STARTED
                    Nothing is marked COMPLETE.

TEST RESULTS:       npm run verify                 exit 0   tests 200, pass 200, fail 0
                                                            (175 before; +25 for integration
                                                            safety, .env loading, env-autoload and
                                                            seeded-cleanup)
                    node --test tests/provisioning-contract.test.ts
                                                   exit 0   tests 39, pass 39, fail 0
                    node --test tests/integration-safety.test.ts
                                                   exit 0   tests 23, pass 23, fail 0
                    npm run test:integration       exit 0   tests 12, pass 0, SKIPPED 12
                      reason: "DATABASE_URL is not set and no .env supplied it — run
                      `cp .env.example .env`, then `npm run db:up && npm run db:ready`"
                    npm audit --audit-level=high   exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs
                                                   exit 0   4 files, 0 broken
                    git diff --check               exit 0

STILL NOT VERIFIED: No Docker runtime and no PostgreSQL are available here, so the live suites
                    have never run — the twelve above are skipped, not passing.
                    Corrections 1 and 2 are proved statically, by the integration-safety contract
                    (which needs no database, by design) and by the .env loader's own tests.
                    Correction 3 is different in kind and worth stating plainly: the leftover test
                    is now written so that it CAN fail, but it has never been executed. Its
                    structure is enforced statically by the seeded-cleanup guarantee; whether
                    withTestDatabase actually replaces a leftover on a real server is exactly the
                    thing that remains unproven. Every live-database gate therefore stays
                    incomplete.
```

---

### 11.10 Evidence — FND-003a (K-05 Configuration foundation)

The first kernel component. Configuration comes first because almost everything else needs to ask
"what is the value of X, and what was it when that decision was made?" — and the second half of
that question is the reason versions here are immutable records rather than mutable rows.

**K-05 is not complete.** The core is delivered and tested; the administrative surface, enforced
authority, audit trail and events are deliberately absent, and the migration has never touched a
live server. See the status line below for exactly what that leaves unproven.

```text
ITEM ID:            K-05 Configuration (FND-003a); P0-38 partially
MODULE / PHASE:     Commerce kernel, build step B-1 / Phase 0
STATUS:             K-05 contract   COMPLETE  — kernel/configuration/CONTRACT.md
                    K-05 implementation IN PROGRESS
                    P0-38 IN PROGRESS (K-06 Policy Engine unbuilt at that time; it was
                    delivered later by FND-005b, §11.31)
                    Nothing else changed status.

IMPLEMENTED:        kernel/configuration/types.ts — scopes, value schemas, immutable version
                    records, publication origins, refusal codes. No clock is read and no
                    randomness generated anywhere in this component: `now`, `versionId` and
                    `idempotencyKey` come from the caller, which is what makes concurrency and
                    effective-time behaviour reproducible in a test rather than approximately
                    reproducible.

                    kernel/configuration/registry.ts — registered keys with explicit value
                    schemas (boolean, integer, string, enum, duration-seconds), permitted scope
                    levels, and two categories refused outright:
                      secrets          key names containing password/secret/token/api_key/… and
                                       values shaped like a credential (PEM, URL userinfo,
                                       bearer tokens, provider key prefixes, AWS access keys)
                      financial policy commission./fee./price./payout./settlement./tax./refund./
                                       interest. — these are K-06's, and a money decision behind
                                       a general-purpose settings table is the wrong shape

                    kernel/configuration/service.ts — publish and resolve:
                      immutable versions      publication never edits an existing record
                      draft to active         validated before it becomes resolvable
                      effective time          resolve(at) answers what was in force then
                      optimistic concurrency  expectedActiveVersionId, refused when stale
                      idempotent publication  a retry returns the first attempt's version
                      scoped overrides        tenant > region > global, most specific first
                      decision pinning        resolveForDecision returns the versionId to record;
                                              versionById replays it forever

                    kernel/configuration/repository.ts — the injected port, plus an in-memory
                    reference implementation. Every mutation runs inside one transaction, because
                    a publication both inserts the new version and supersedes the old one.

                    kernel/configuration/postgres-repository.ts — the SQL adapter. Real
                    BEGIN/COMMIT with ROLLBACK on failure; supersession is a conditional UPDATE
                    (`WHERE status = 'active'`) so a lost update is detected rather than applied
                    twice; every caller value is a bound parameter.

                    db/migrations/0003_create_kernel_configuration_schema.{up,down}.sql — the
                    kernel_configuration schema and config_version table, with CHECK constraints
                    mirroring the domain rules and a partial unique index on
                    (config_key, scope_level, scope_id) WHERE status = 'active', so "two active
                    versions" is impossible even if something writes around the service. The
                    origin CHECK permits only human and system-migration.

REFUSALS PROVED:    unknown-key, invalid-value (six shapes), scope-not-permitted, scope-escalation,
                    retroactive-change, ambiguous-active-version (same instant, and a second
                    active version), concurrent-modification (stale expectation, and claiming
                    none exists), secret-bearing-value (key names and four value shapes),
                    financial-policy-value, origin-not-permitted, malformed instants.

AI EXCLUSION:       `PublicationOrigin` includes 'ai-suggested' so that it can be refused
                    explicitly rather than being absent and un-refusable. publish() is the only
                    writer and rejects it; the database CHECK rejects it again; a test asserts a
                    refused AI publication writes nothing, and another asserts resolution has no
                    second source to answer from. AI may propose a change to a human, who
                    publishes it and owns it.

TESTED:             247 tests (200 before this subtask, 47 added).
                      tests/configuration.test.ts             27  lifecycle, effective time,
                                                                  concurrency, idempotency,
                                                                  scoped overrides, every refusal,
                                                                  AI exclusion, registry rules
                      tests/configuration-repository.test.ts  19  port conformance (7 cases),
                                                                  value round trip, adapter
                                                                  structure, module contract,
                                                                  planted contract weakenings
                      plus one widened ownership assertion in tests/migrations.test.ts

                    The pinning proof is the one that matters most: a decision records a version
                    id, a later version is published, and the recorded version is re-read and
                    found unchanged — same value, same effective instant, status superseded
                    rather than deleted.

TEST COMMANDS:      npm run verify
                    npm run check:migrations
                    node --test tests/configuration.test.ts
                    node --test tests/configuration-repository.test.ts
                    npm run test:integration
                    node docs/tools/validate-doc-links.mjs
                    npm audit --audit-level=high
                    git diff --check

TEST RESULTS:       npm run verify                     exit 0   tests 247, pass 247, fail 0
                    npm run check:migrations           exit 0   6 files, 10 checks PASS
                    node --test tests/configuration.test.ts
                                                       exit 0   tests 27, pass 27
                    node --test tests/configuration-repository.test.ts
                                                       exit 0   tests 19, pass 19
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

                    A defect was found by the tests during implementation and fixed: resolution
                    initially bounded a version's in-force window by `supersededAt`, which is
                    when a *successor was published* rather than when it *takes effect*. A
                    version published on the 15th to take effect on the 1st of the next month
                    would have left the predecessor unresolvable for the intervening fortnight.
                    The window is now bounded by effective time alone.

SECURITY:           No secret may be stored: refused by key name and by value shape, at
                    registration and at publication. No credential, endpoint or connection string
                    is introduced. Authority is checked (`authorityLevel`) but is caller-supplied
                    — see the limitation below.

UI/UX REVIEW:       N/A — no user-facing surface, deliberately.
MIGRATIONS:         One forward, one rollback, never applied anywhere.
EVENTS:             None. K-08 does not exist.

CONFIG / POLICY:    No business constants introduced. K-05 registers keys; it ships none.

KNOWN LIMITATIONS:  1. NOTHING HAS RUN AGAINST POSTGRESQL. Migration 0003 and the SQL adapter are
                       validated statically and exercised against an in-memory reference
                       implementation. The adapter's SQL has never executed.
                    2. NO ENFORCED AUTHORITY. `authorityLevel` is supplied by the caller because
                       K-04 Permissions does not exist. The escalation check is real and tested,
                       but the input it checks is not yet derived from an authenticated session.
                    3. NO AUDIT TRAIL. `origin` and `publishedAt` are recorded; *who* published is
                       not, because there is no identity to record and K-09 has nowhere to put it.
                    4. NO EVENTS. Nothing can subscribe to a configuration change yet (K-08).
                    5. NO API AND NO UI, deliberately. An endpoint that changes configuration
                       before there is anyone to authenticate or authorise is a hole, not a
                       feature.
                    6. No data migration path for a key whose schema narrows while older versions
                       violate it. Those versions stay readable; re-validating history is future
                       work.
                    7. The secret and financial-key detectors are heuristics on names and shapes.
                       They are blunt on purpose — a false positive costs a rename, a false
                       negative puts a live credential in a record that cannot be deleted.
                    8. NOT VERIFIED BY CI. P0-09, blocked by BL-10.

DEFERRED:           Administrative API and UI to after K-02 and K-04. Audit integration to K-09.
                    Change events to K-08. Financial policy values to K-06 — refused here on
                    purpose so they land there.

COMMITS:            Recorded at commit time for this branch.

FILES:              kernel/configuration/CONTRACT.md, types.ts, registry.ts, service.ts,
                    repository.ts, postgres-repository.ts, index.ts,
                    db/migrations/0003_create_kernel_configuration_schema.{up,down}.sql,
                    tests/configuration.test.ts, tests/configuration-repository.test.ts,
                    modified: kernel/README.md, tests/migrations.test.ts (ownership assertion
                    widened for the first kernel-owned migration), tests/migration-runner.test.ts
                    and tests/integration/migrations.integration.ts (expected versions now derived
                    from the migration set rather than hardcoded),
                    docs/CURRENT_IMPLEMENTATION_STATUS.md,
                    docs/MASTER_IMPLEMENTATION_CHECKLIST.md

FOLLOW-UP:          K-08 Event Infrastructure completes build step B-1 and is the next genuinely
                    unblocked task. K-05 cannot move to COMPLETE until a live PostgreSQL run
                    proves the adapter and migration, and until K-02/K-04/K-09 give it an
                    authenticated actor, enforced authority and an audit trail.
```

---

### 11.11 Correction — FND-003a lifecycle, replacement ordering, idempotency and scope inference

Four defects in the FND-003a delivery were found by review and corrected. Recorded here per v3 §58.
Two of them are the same kind of mistake the migration-runner corrections were: the code and the
constraint it was supposed to respect disagreed, and only one of them was tested.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **Replacement violated the partial unique index.** `publish` inserted the replacement already `active` and superseded the incumbent afterwards. The migration declares a unique index on `(config_key, scope_level, scope_id) WHERE status = 'active'`, checked per statement rather than deferred to COMMIT — so against a real PostgreSQL the insert would have failed every time a key already had a value. The in-memory repository did not model the index, so every test passed. | The reference implementation must enforce what the database enforces, at the same point the database enforces it. | The port now offers `insertDraft`, `supersedeActiveVersion` and `activateDraft`, used in that order: the draft sits outside the index, the incumbent leaves it, the replacement enters it. The in-memory repository enforces the index **after every mutation**, so the wrong order now fails there too — and a test plants exactly that wrong order and requires the refusal. |
| 2 | **No draft existed.** A version was constructed already active, so the documented draft→active lifecycle had no draft: nothing to be invisible to resolution, nothing to activate, and no failure mode where activation is refused with the proposal intact. | A documented lifecycle state that no operation produces is not a lifecycle. | `createDraft` writes an immutable draft; `publishDraft` activates that same record. `publish` composes the two so there is one activation path, not two. A refused activation now leaves the incumbent active *and* the draft still a draft, which is asserted directly. |
| 3 | **Idempotency answered the wrong question.** Any repeat of an idempotency key returned the original version, whatever the caller had actually asked for. A key reused with a different value reported success for a change that never happened — the worst available outcome, because the caller has no way to notice. | A retry must be a retry *of this request*. | The complete logical request is compared — key, scope, value, effective time, origin, version id. Identical content returns the original; anything else is refused as `idempotency-key-reuse`, with a message naming what differed. |
| 4 | **Tenant resolution could not reach a region.** `scopeChain` walked tenant → global, because the component has no tenant-to-region map and the previous revision tried to derive one and silently gave up. A regional default was therefore unreachable in practice. | Do not infer a relationship you do not hold; make the caller state it. | `resolve` takes an explicit optional `region`. With one, the chain is tenant → region → global; without, tenant → global. A region supplied for a non-tenant request, or a non-region passed as one, is refused as `region-mismatch` rather than ignored. |

**Tests added** (deterministic, no database):

```text
tests/configuration-lifecycle.test.ts        20 cases
  drafts            stored and immutable; invisible to resolution; activation reuses the record;
                    re-publishing is idempotent by state; unknown and superseded ids refused
  failure           a refused activation leaves incumbent active and draft still draft
  replacement       supersede-then-activate; exactly one active version survives
  concurrency       the loser is refused, keeps its draft, and changes nothing
  idempotency       identical retry returns the original; five kinds of mismatched reuse refused;
                    the refusal names what differed
  region            tenant → named region → global; no region named means no region consulted;
                    another region does not inherit; tenant still beats region; mismatches refused
  adapter queries   supersede precedes activate; each UPDATE is status-guarded; a zero-row
                    activation rolls back without committing; a zero-row supersession refuses
                    before activation is attempted; an active insert is refused before any write

tests/configuration-repository.test.ts       +4 conformance cases
  an already-active insert is refused; a draft activates once and only from draft;
  supersede-then-activate keeps one active version; activate-then-supersede is refused
```

The adapter-query cases run the **real** PostgreSQL adapter against a recording fake
(`tests/helpers/recording-database.ts`), because statement order is behaviour and cannot be
asserted by reading source.

```text
STATUS AFTER CORRECTION:
                    K-05 contract   COMPLETE (updated for the two-step lifecycle)
                    K-05 implementation IN PROGRESS — unchanged
                    P0-38 IN PROGRESS — unchanged
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 272, pass 272, fail 0
                                                                (247 before; +25)
                    npm run check:migrations           exit 0   6 files, 10 checks PASS
                    node --test tests/configuration.test.ts
                                                       exit 0   tests 28, pass 28
                    node --test tests/configuration-lifecycle.test.ts
                                                       exit 0   tests 20, pass 20
                    node --test tests/configuration-repository.test.ts
                                                       exit 0   tests 23, pass 23
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

                    Two further defects surfaced while writing the tests and were fixed:
                    the in-memory index check ran at commit rather than per statement, which made
                    the planted wrong-ordering case pass; and the recording fake matched an UPDATE
                    against a SELECT pattern, reporting one row changed where the test meant none —
                    silently turning a concurrency case into a happy path.

STILL NOT VERIFIED: No PostgreSQL runtime is available here. The ordering these corrections exist
                    to satisfy is proved against the reference implementation and against recorded
                    adapter statements; the index that motivates it has never rejected anything,
                    because no migration has ever been applied. Defect 1 in particular would have
                    been caught immediately by one live run, and was not caught by any number of
                    passing tests against a repository that did not model the constraint. Every
                    live-database gate stays incomplete.
```

---

### 11.12 Correction — FND-003a canonical instants, publication races and retries after supersession

Three further defects, each one a case where the component accepted something it documented itself
as refusing, or refused something it had already done. Recorded here per v3 §58.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **Instants were compared as text.** Every ordering decision — the retroactive check, the "a replacement must be effective strictly after the incumbent" check, resolution's filter and sort, and the idempotency comparison — used string comparison. `.` sorts before `Z`, so `2026-01-01T00:00:00.000Z` ranked *earlier* than the identical `2026-01-01T00:00:00Z`. An incumbent written with a fraction therefore accepted a replacement at its own instant, producing exactly the unorderable pair `ambiguous-active-version` exists to prevent; a genuinely retroactive change hid behind a coarser spelling; and the version that answered a resolution depended on how its effective time had been typed. Separately, validation was a pattern match, so `2026-02-30T00:00:00Z` was stored — `new Date` reads it as 2 March. | One moment is one moment, however it is written; and an instant must be a point in time the calendar contains. | `kernel/configuration/instant.ts` parses an instant, validates it against the real calendar by requiring it to survive a UTC round trip, and reduces it to microseconds since the epoch as a `bigint`. Every comparison in the component goes through that number. The caller's spelling is still what gets stored — a version records the instant as it was expressed — but nothing compares strings any more. |
| 2 | **A first-publication race leaked a driver error.** Two drafts at one key and scope, each correctly stating that it expected no active version, both reached activation: neither is wrong about what it read, so the service's own expectation check cannot separate them. Against PostgreSQL the loser got a raw unique-violation on `config_version_one_active_per_scope` — an error with no code, absent from the refusal table, naming an index rather than saying that someone else published first. Against the in-memory repository it was worse: transactions committed by swapping the whole working copy in, so the second commit overwrote the first and left **two active rows with no error raised at all**. | The reference implementation must not be able to reach a state the database forbids, and a race must be reported as a race. | The adapter translates SQLSTATE 23505 into the refusal the violated constraint actually means — `concurrent-modification`, `idempotency-key-reuse` or `immutable-version` — and rethrows anything else untouched, because an I/O failure dressed up as a race would be retried forever. The platform client now carries the SQLSTATE and constraint name across its redaction boundary, so this is never decided by matching English error text. The in-memory repository commits by applying only the rows the transaction wrote onto the current store, refusing if they moved underneath it or if the result would hold two active rows. |
| 3 | **A retry after supersession was told it had failed.** `publishDraft` on a version that had been published successfully and later replaced answered `not-a-draft`. A redelivery arriving after a third version took over reported failure for work that had demonstrably succeeded. | A retry of work that succeeded is answered with what it did. | A superseded version whose publication is retried — identified by the caller naming the predecessor *that* publication superseded — returns the original result, `deduplicated: true`, writing nothing. Naming the *current* incumbent instead is a request to reinstate a retired version and is still refused as `not-a-draft`. The expectation is the only thing that separates the two, and it separates them exactly. |

A fourth, smaller problem was fixed alongside defect 1: the adapter read instants back through
`new Date(…)`, which holds milliseconds where `timestamptz` holds microseconds. Two versions whose
effective times differed by less than a millisecond would have read back as the same instant —
reintroducing on the way out the ambiguity publication had just refused. A string result is now
rebuilt directly. The `Date` path cannot be recovered and is recorded as a limitation in
`kernel/configuration/CONTRACT.md` §5.

**Tests added** (deterministic, no database):

```text
tests/configuration-temporal.test.ts         24 cases
  calendar        30 February, 29 February 2025, 31 April, month 13, month 00, day 32, day 00,
                  hour 24, minute 60, leap second - each refused; 29 February 2024 accepted;
                  refused by the service, not merely by the parser
  equivalence     three spellings of one moment compare equal and canonicalise identically
  ordering        .5 after whole seconds; microseconds; .1 after .05; 00:01 after 00:00.999999
  bypasses        a same-instant replacement refused in *both* spelling directions; a retroactive
                  change refused when text comparison calls it later than now
  resolution      versions ordered by instant, not by typing: resolving at .400 and at .500 each
                  answer with the right version
  idempotency     a retry spelling one instant differently is a retry; a retry one millisecond
                  away is still refused as key reuse
  races           two competing first publications: one wins, one is refused as
                  concurrent-modification, one active row survives, the loser keeps its draft and
                  is unpublished, and may then retry successfully against the winner; two
                  replacements of one incumbent, same outcome
  retries         a retry after supersession returns the original result, writes nothing, and
                  leaves the current incumbent alone; reinstating a retired version refused;
                  the same retry through publish() answered from the idempotency key
  normalization   23505 on the active index becomes concurrent-modification and the transaction
                  rolls back without committing; idempotency and primary-key violations told
                  apart; an unrecognised SQLSTATE passed through untouched; a violation with no
                  constraint field recognised from the message; databaseErrorDetail extracts
                  SQLSTATE and constraint and nothing else
  precision       a microsecond instant read back intact and still ordering after the whole
                  second; one moment rendered one way from three stored forms

tests/configuration-lifecycle.test.ts        20 -> 21 cases
  the single "unknown or already-superseded version is refused" case became two, because half of
  what it asserted is now the wrong answer: a redelivery is answered, a reinstatement is refused
```

**Each defect was re-planted and the tests observed to fail**, since a regression test that cannot
fail is a placeholder:

```text
string comparison restored at all four sites + calendar check disabled
                                                   8 of 24 failed
wholesale-swap commit + adapter translation removed
                                                   6 of 24 failed
post-supersession retry branch disabled            1 of 24 failed
```

The eight include both spelling directions of the same-instant replacement, which matters: the
first version of this suite tested only the direction the *old* code already caught, and passed
against the very defect it was written for. It was rewritten after the plant exposed it.

```text
STATUS AFTER CORRECTION:
                    K-05 contract   COMPLETE (updated: canonical instants, constraint translation,
                                    retry-after-supersession, microsecond limitation)
                    K-05 implementation IN PROGRESS - unchanged
                    P0-38 IN PROGRESS - unchanged
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 297, pass 297, fail 0
                                                                (272 before; +25)
                    npm run check:migrations           exit 0   6 files, 10 checks PASS
                    node --test tests/configuration.test.ts
                                                       exit 0   tests 28, pass 28
                    node --test tests/configuration-lifecycle.test.ts
                                                       exit 0   tests 21, pass 21
                    node --test tests/configuration-repository.test.ts
                                                       exit 0   tests 23, pass 23
                    node --test tests/configuration-temporal.test.ts
                                                       exit 0   tests 24, pass 24
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here. Defect 2's translation is proved
                    against a recording fake raising an error shaped like the driver's; no real
                    23505 has ever been raised, because no migration has ever been applied and no
                    two transactions have ever raced for real. The in-memory races are real races
                    between overlapping transactions, but they are races in a model of the
                    database, not in the database. Every live-database gate stays incomplete.
```

---

### 11.13 Correction — K-05 PostgreSQL temporal fidelity

§11.12 closed the ambiguity that equivalent instant *spellings* created, and recorded one residue as
a limitation: microseconds survived only if the driver happened to hand back a string. That residue
is the defect this corrects. It was reachable on the ordinary path, not an exotic one — `pg` parses
`timestamptz` into a JavaScript `Date` by default, so the ordinary configuration was the losing one.

| Aspect | Before | After |
|---|---|---|
| Projection | `SELECT effective_from, …` — the driver parsed the column into a `Date`, which holds milliseconds where `timestamptz` holds microseconds | every timestamp column is projected as `to_char(<column> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, so the server produces the text and the driver's parser never runs |
| Coverage | — | all four: `effective_from`, `created_at`, `published_at`, `superseded_at`. Only `effective_from` decides resolution, but a truncated `published_at` misreports when a change took effect and a truncated `superseded_at` misreports when it stopped |
| Determinism | the session's `TimeZone` and the driver's locale were both in the path | `AT TIME ZONE 'UTC'` fixes the offset from any session; the pattern names no month or day, so `lc_time` cannot reach it; `DateStyle` does not apply to `to_char` |
| Ordering | `ORDER BY effective_from` — which, once the select list aliases a text expression to that name, binds to the **text** column and sorts lexically | `ORDER BY config_version.effective_from`, qualified so the sort is on the timestamp |
| Decoding | accepted several shapes and ended with `new Date(value)`, approximating anything it did not recognise | accepts exactly the projected form and refuses everything else as `invalid-value`, naming the column |
| Non-finite values | `new Date('infinity')` → `Invalid Date` → an `Invalid Date` ISO string, or a thrown `RangeError` from deep inside a decoder | refused explicitly, with the value quoted |

**Why truncation could not be caught downstream.** The digits are gone before any code here runs.
Two versions 300µs apart arrive as one instant, and two versions at one instant cannot be ordered —
which is precisely the ambiguity `publishDraft` refuses on the way in. Publication would have
allowed a distinction that resolution then could not see. Nothing in the service can detect that,
because from its side the two rows genuinely are identical.

**Tests added** — `tests/configuration-timestamp-projection.test.ts`, 15 cases:

```text
projection      the three SELECTs are issued; every one of the four timestamp columns is
                projected as UTC text in every one of them, and appears bare in none; the
                projection carries UTC, six fractional digits, and no locale-dependent field;
                the select list contains no unresolved interpolation; ORDER BY is qualified;
                the decoder contains no `new Date(`
decoding        200µs and 500µs stay distinct and orderable - with the driver's own truncation
                asserted alongside, showing both would have become the same millisecond;
                equivalent spellings decode to one spelling and compare equal; all four columns
                decode and the nullable two stay null; a Date in any of the four columns is
                refused; infinity, -infinity, session-formatted, three-digit, bare-date, empty,
                arbitrary, calendar-impossible and non-text values are all refused; a refusal
                names the column and quotes the value
round trips     the exact instant reaches the INSERT unreformatted; resolution at .000300 and
                .000400 answers with different versions; a pinned version keeps .00075
```

The projection assertions read the SQL **as issued**, by driving the three read paths through the
recording fake, rather than by scanning the adapter's source — the source says
`SELECT ${PROJECTION}`, so a source scan would prove nothing about what reaches the server.

**Both halves of the fix were planted and observed to fail:**

```text
effective_from selected bare (as before)            1 of 15 failed
Date fallback restored in the decoder               7 of 15 failed
```

The first plant failing only one test is the point of separating the two halves: a decoder test
suite alone would have passed while the adapter quietly went back to selecting a `Date`.

Two existing suites moved with it: the fixtures in `tests/helpers/recording-database.ts` now carry
six fractional digits, because that is what the projection returns and a fixture in another shape
would be testing a projection the adapter does not issue; and the two loose-form decoding cases in
`tests/configuration-temporal.test.ts` were replaced, since accepting session-formatted timestamps
is now the opposite of the contract.

```text
STATUS AFTER CORRECTION:
                    K-05 contract   COMPLETE (§3 gains "Timestamps are read as text, not as
                                    values"; §5's Date-truncation limitation narrowed to what is
                                    actually still unproven)
                    K-05 implementation IN PROGRESS - unchanged
                    P0-38 IN PROGRESS - unchanged
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 310, pass 310, fail 0
                                                                (297 before; +15 new, -2 replaced)
                    npm run check:migrations           exit 0   6 files, 0 violations
                    node --test tests/configuration.test.ts
                                                       exit 0   tests 28, pass 28
                    node --test tests/configuration-lifecycle.test.ts
                                                       exit 0   tests 21, pass 21
                    node --test tests/configuration-repository.test.ts
                                                       exit 0   tests 23, pass 23
                    node --test tests/configuration-temporal.test.ts
                                                       exit 0   tests 22, pass 22
                    node --test tests/configuration-timestamp-projection.test.ts
                                                       exit 0   tests 15, pass 15
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: `to_char` has never run. No PostgreSQL runtime is available here, so what is
                    demonstrated is that the adapter issues a projection the driver's parser cannot
                    touch and decodes only what that projection emits - both proved against a
                    recording fake. That the server renders exactly this text, and that a stored
                    microsecond survives a real INSERT and SELECT, remains unobserved. The
                    limitation in CONTRACT.md §5 was narrowed to that, and not removed. Every
                    live-database gate stays incomplete.
```

---

### 11.14 Evidence — FND-003b (K-08 Event Infrastructure foundation)

K-08 is how one unit tells the rest of the system that something happened without knowing who
cares, which is what makes MODULE_MAP.md §10.3 — no sibling calls between same-layer modules —
something other than a rule with no alternative. This slice delivers the foundation: the envelope,
the registry, the log, delivery, retry, dead-lettering and replay. It delivers **no business events
and no module integration**, and the contract says so in those words.

**What was built**

| File | Holds |
|---|---|
| `platform/time/instant.ts` | canonical UTC instants: calendar validation, microsecond comparison, `addSeconds` for retry scheduling. Error-agnostic, so each component refuses in its own vocabulary |
| `kernel/event-infrastructure/types.ts` | envelope, delivery, receipt, actor, 20 refusal codes |
| `kernel/event-infrastructure/registry.ts` | event types with immutable payload schema versions; subscriptions; credential detection at registration and at publication |
| `kernel/event-infrastructure/repository.ts` | the injected port and its in-memory reference implementation |
| `kernel/event-infrastructure/service.ts` | publish, deliver, replay; deterministic bounded backoff |
| `kernel/event-infrastructure/postgres-repository.ts` | the adapter: `FOR UPDATE SKIP LOCKED` claiming, guarded completions, UTC-text timestamps, constraint translation |
| `kernel/event-infrastructure/CONTRACT.md` | ownership, guarantees, refusals, the transactional-outbox rule, what is deferred |
| `db/migrations/0004_…up.sql` / `.down.sql` | `kernel_event_infrastructure`: `event`, `event_delivery`, `event_receipt` |

**The design decisions worth recording**

- **PostgreSQL is the transport, not merely the store.** A table with `SKIP LOCKED` gives durable
  at-least-once delivery, and it lets a producing module append its domain rows and its events in
  one transaction. No broker can offer that, and "we published the event but the write rolled back"
  is the incident that follows from pretending otherwise. A broker remains a later implementation
  of the same port; no broker SDK is in the repository.
- **A claim token identifies one claim, not one worker.** Every completion path — acknowledge,
  reschedule, dead-letter — is predicated on `claim_token = $2 AND status = 'in-flight'`. That
  single predicate is what stops two workers both declaring one delivery authoritatively finished.
  It is enforced in the service, in the reference implementation, and by a `UNIQUE (claim_token)`
  constraint in the migration.
- **Attempts are burned at claim, not at failure.** A worker that dies mid-handler must still
  consume an attempt, or a payload that reliably kills its consumer is retried for ever.
- **Replay appends a generation; it never reopens a terminal delivery.** A worker still holding the
  old row's lease is refused by the same guard as everything else, rather than by a special case
  that could be forgotten. And replay does not discard the consumer's receipt unless the operator
  explicitly says to, because "the notification was lost" and "the effect was lost" call for
  different actions and only a human knows which happened.
- **No jitter in the backoff.** A real trade-off, taken deliberately: jitter spreads retry load and
  makes retry timing unassertable. This component reads no clock and generates no randomness, so a
  caller that needs spread staggers its workers.

**Tests** (deterministic, no database) — 67 cases:

```text
tests/events.test.ts                     22 cases
  registry        unknown type and unknown version refused differently; versions coexist; a type
                  with a bad name, no owner, no description or version 0 cannot be registered; a
                  declared credential field refused; subscriptions must name registered types and
                  a real owner; fan-out is deterministic
  payload         an undeclared field is refused rather than dropped; missing required, wrong
                  type, fractional integer, null-required all refused; optional-null accepted;
                  five credential-shaped values refused under an innocent field name
  publication     event and deliveries share one transaction; a failed publication leaves neither;
                  identical retry returns the original; mismatched key reuse refused; payload
                  fingerprinted and key-order-independent; the stored payload is frozen; an event
                  may not be recorded before it happened; eight malformed envelopes fail closed;
                  a unit may not publish another unit's type
  AI              refused by origin and by actor, together and separately; a system actor may not
                  claim a human decided; every stored event carries a permitted origin

tests/events-delivery.test.ts            22 cases
  delivery        acknowledged once, one receipt, claim released; other subscriptions untouched;
                  work that is not yet due is not claimed
  retry/DLQ       a thrown handler never acknowledges and schedules a bounded retry; backoff
                  doubles, caps and is deterministic; attempts exhaust into a terminal dead-letter
                  that is never retried automatically; the event is untouched throughout
  concurrency     two simultaneous claims yield one winner and one empty batch; a stale worker is
                  refused after the winner finished AND while the winner is still working; a claim
                  token in use may not be reused
  crash window    a crash after the handler succeeded but before acknowledgement: the handler runs
                  twice, exactly one receipt and one acknowledgement result; a receipt suppresses
                  redelivery to the handler entirely
  replay          appends a generation and leaves the superseded row untouched; does not bypass
                  deduplication unless the operator discards the receipt; a dead-lettered delivery
                  can be replayed once its cause is fixed; refused while live, refused without an
                  operator or a reason, refused for AI, refused for unknown event/subscription;
                  the original event stays byte-identical, fingerprint included
  AI              an AI worker may neither claim nor acknowledge

tests/events-repository.test.ts          23 cases
  conformance     append-once; the port has no operation that changes an event; one delivery per
                  (event, subscription, generation); completion refused without the current claim
                  token; a terminal delivery refuses all three transitions; an expired lease
                  returns work to the pool and an already-burned attempt stays burned; a lease
                  must be in the future; one receipt per (subscription, event); a failed
                  transaction writes nothing
  adapter         claiming is a single UPDATE with FOR UPDATE SKIP LOCKED and RETURNING; all three
                  completions guarded on token and status; a zero-row completion is diagnosed
                  rather than reported as success; timestamps projected as UTC text; ordering on
                  the column; every value parameterised; non-scalar payloads refused on decode;
                  a Date or an infinite timestamp refused
  contract        the schema is the one the manifest derives; the adapter and the migration touch
                  no other schema; the migration enforces the claim-token, generation and receipt
                  constraints and the origin CHECK in the database; the rollback reverses exactly
                  what was created, children before parents; CONTRACT.md records what is deferred
```

**Each guarantee was planted and the tests observed to fail:**

```text
claim-token guard removed from every completion path   2 of 45 failed (delivery + conformance)
a thrown handler acknowledged anyway                   4 of 22 failed
receipt check skipped + replay always discards it      2 of 22 failed
```

The first plant is worth a note. It initially failed only **one** test, because the stale worker in
the lease-expiry case was caught by the "this delivery is already terminal" check before the token
check could matter. That made the token guard barely covered, so a sharper case was added — the
loser returning while the winner is still mid-handler, where the row is *not* terminal and the
token is the only thing refusing it. The plant then failed two.

**Deliberately not delivered**, and recorded as such in CONTRACT.md §4–§5 rather than implied:

- **No module publishes anything.** The event types in the tests are fixtures. There is no producer
  and no consumer.
- **No caller-supplied transaction.** `publish` opens its own transaction through the port, so a
  module *cannot yet* atomically couple a domain write to its event. The rule is written down in
  CONTRACT.md §4 with the mechanism it needs; the mechanism is future work. Claiming the guarantee
  exists would be worse than saying it does not.
- No broker SDK, no API, no UI, no runtime consumer registration, no retention policy.

**A known duplication was created and is recorded rather than hidden.** `platform/time/instant.ts`
duplicates logic K-05 already has in `kernel/configuration/instant.ts`. FND-003b is explicitly not
permitted to change K-05's behaviour, and the two differ in one real way — K-05's throws
`ConfigurationError` while the platform one is error-agnostic — so collapsing them is a bounded
follow-up rather than a free deletion.

Two existing test files moved with this change: `tests/migration-runner.test.ts` had ledger
fixtures listing migrations by hand, which went stale the moment 0004 existed and failed in tests
about something else entirely. They now derive from `discover(directory)`, so the next migration
cannot repeat it.

```text
STATUS AFTER THIS TASK:
                    K-08 contract         COMPLETE (kernel/event-infrastructure/CONTRACT.md)
                    K-08 implementation   IN PROGRESS - core only
                    P0-35 IN PROGRESS - not complete: no live PostgreSQL, no module integration
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 377, pass 377, fail 0
                                                                (310 before; +67)
                    npm run check:migrations           exit 0   8 files, 0 violations
                    npm run check:boundaries           exit 0   0 violations
                    node --test tests/events.test.ts   exit 0   tests 22, pass 22
                    node --test tests/events-delivery.test.ts
                                                       exit 0   tests 22, pass 22
                    node --test tests/events-repository.test.ts
                                                       exit 0   tests 23, pass 23
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here, so migration 0004 has never been
                    applied and the `FOR UPDATE SKIP LOCKED` claim statement — the single most
                    important statement in the component — has never executed. What is proved is
                    that the adapter issues it and that the reference implementation enforces the
                    same guarantees; that PostgreSQL enforces them under real concurrency is
                    unobserved. K-08 also has no producing module, no consuming module, no audit
                    trail and no authorisation, so P0-35 and every live-database gate stay
                    incomplete.
```

---

### 11.15 Correction — FND-003b concurrency parity and transaction composition

Two gaps in the FND-003b delivery, found by review. Neither was visible from the tests that shipped
with it, and the second was recorded in §11.14 as future work rather than a defect — it is corrected
here because the contract described a rule modules were expected to follow with no mechanism to
follow it.

| # | Gap | Failed invariant | Correction |
|---|---|---|---|
| 1 | **The reference implementation refused fewer conflicts than the database.** It detected a delivery whose row *moved* underneath a transaction, but not the three *uniqueness* conflicts PostgreSQL enforces with constraints: a second event under one `idempotency_key`, a second delivery at one `(event_id, subscription, generation)`, and two live claims holding one `claim_token`. Each is reachable by two overlapping transactions that both read a store where the row does not yet exist — so each passed in memory and would have failed against a server. That is the worst direction for a gap to run: every guarantee proved against the reference implementation was worth less than it looked. | A reference implementation must refuse what the database refuses, or the tests it backs are proving something narrower than they claim. | All three are checked at commit against the store as it stands *then*, not against the snapshot the transaction read. Events are checked before deliveries, because that is the order the statements run in — a losing publication now reports the idempotency-key conflict its `INSERT` would really have hit, rather than a delivery conflict the database would never have raised. |
| 2 | **Two overlapping retries of one publication both failed, or one did.** Retrying a publication is the normal response to a timeout, so two retries overlapping is ordinary rather than exotic. The loser got a raw conflict for work that had *succeeded* — the publication it was retrying was already in the log. | A retry of work that succeeded is answered with what it did. The sequential path already did this; the concurrent path did not. | The loser re-reads by idempotency key and converges on the winner's event and deliveries. Convergence runs the same content check as the sequential path, so a key reused for a genuinely different event still fails closed rather than being answered with somebody else's event. One re-read, not a loop: if the key is still absent the conflict was something else and is rethrown untouched. |
| 3 | **A module could not do what the contract told it to do.** CONTRACT.md §4 said a producer must write its domain rows and append its event in one transaction. `publish` always opened its own, so the instruction was unfollowable. | A documented rule with no mechanism is not a rule. | `PostgresEventRepository.enlist(client)` returns a repository that runs against a transaction the caller already opened. It issues no transaction control at all and never releases the connection, and both properties are enforced rather than assumed — the enlisted client *refuses* `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and `RELEASE SAVEPOINT` with a `nested-transaction` refusal. |

**Why the enlisted path refuses rather than trusts.** PostgreSQL has no nested transactions. A
`BEGIN` inside an open transaction warns and is ignored; a `COMMIT` ends the *caller's* transaction,
committing domain rows it had not finished writing and making its later `ROLLBACK` silently roll
back nothing. That failure is invisible where it happens and surfaces much later as inexplicable
partial writes. A guard turns a future refactor's stray `BEGIN` into a loud failure instead.

**Tests added** — `tests/events-concurrency.test.ts`, 15 cases:

```text
commit conflicts    two overlapping appends under one idempotency key; two overlapping replays
                    computing the same generation; two overlapping claims offering one token; and
                    a refused commit shown to write nothing at all - the loser's delivery rolls
                    back with its event rather than being left with nothing to deliver
convergence         two and three concurrent identical retries return one event, one fan-out, and
                    the same delivery list to every caller; concurrent reuse of one key for
                    different content still fails closed; a duplicate event id under a *different*
                    key stays a duplicate id rather than converging on an unrelated event; two
                    operators replaying at once produce one generation-2 delivery
enlistment          an enlisted append issues exactly the caller's BEGIN and COMMIT and none of its
                    own, opens no second connection and releases nothing; it writes the event and
                    both deliveries through the caller's client; a failure propagates so the
                    caller can roll back; nine forms of transaction control are refused and none
                    reaches the database; the repository-owned path still opens and closes its own
```

**Each correction was planted and the tests observed to fail:**

```text
the three commit-time uniqueness checks removed        6 of 15 failed
transaction control permitted, and a BEGIN/COMMIT
  issued by the enlisted repository                    3 of 15 failed
retry convergence removed                              3 of 15 failed
```

```text
STATUS AFTER CORRECTION:
                    K-08 contract         COMPLETE (§3 gains the three implementations and the
                                          conflict-parity rule; §4 now describes a mechanism that
                                          exists rather than one that does not)
                    K-08 implementation   IN PROGRESS - unchanged
                    P0-35 IN PROGRESS - unchanged
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 392, pass 392, fail 0
                                                                (377 before; +15)
                    npm run check:migrations           exit 0   8 files, 0 violations
                    npm run check:boundaries           exit 0   0 violations
                    node --test tests/events.test.ts   exit 0   tests 22, pass 22
                    node --test tests/events-delivery.test.ts
                                                       exit 0   tests 22, pass 22
                    node --test tests/events-repository.test.ts
                                                       exit 0   tests 23, pass 23
                    node --test tests/events-concurrency.test.ts
                                                       exit 0   tests 15, pass 15
                    npm run test:integration           exit 0   tests 12, pass 0, SKIPPED 12
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: **No business module uses any of this.** The enlisted path is a capability, not
                    an integration: nothing in the repository calls it, and K-08 still has no
                    producer and no consumer. Nor has any of it run against PostgreSQL - the
                    conflicts are refused by a model of the constraints rather than by the
                    constraints, and the enlisted path's central claim (that it composes correctly
                    inside a real transaction) is proved by recording the statements it sends, not
                    by watching a server honour them. P0-35 and every live-database gate stay
                    incomplete.
```

---

### 11.16 Evidence — FND-002d (seed and fixture foundation)

Seed data is the quietest way to make a test suite lie. A fixture carrying a real-looking email
address becomes a data-protection question the first time somebody dumps a development database;
one calling `now()` makes a test that passes in the morning and fails at midnight; one writing into
another unit's schema makes the boundary rules decorative. None of those fail loudly. All of them
are cheap to prevent at the point the data is declared, which is what this slice does.

**What was built**

| File | Holds |
|---|---|
| `platform/fixtures/manifest.ts` | the versioned manifest contract and its nine checks |
| `platform/fixtures/runner.ts` | the injected transactional seed runner, and the two target guards |
| `platform/fixtures/cli.ts` | `validate`, `list`, `load`, `reset` |
| `db/fixtures/*.fixture.json` | two datasets: K-05 configuration history, K-08 delivery states |
| `db/fixtures/README.md` | commands, safety, ownership, extension rules, retention, limitations |
| `tests/fixtures/seed/*` | ten planted-invalid fixtures, one per check, plus a README saying not to fix them |

**The design decisions worth recording**

- **A fixture is declared, not executed.** There is no place in a manifest to put code, so there is
  nothing to review for side effects. The runner reads, validates and inserts.
- **Ownership is derived, not remembered.** A dataset names a manifest unit and a schema, and the
  validator resolves the schema through the same `ownerOfSchema` the migration validator uses. A
  dataset claiming an owner that does not own its schema is refused; so is one writing into another
  unit's namespace.
- **Two target guards, not one.** `load` is additive and idempotent, so it may reach the local
  *development* database — that is the ordinary case, and that database does not end in `_test`. It
  refuses any remote host and any name containing a shared-environment marker. `reset` deletes rows,
  so it refuses everything but the guarded derived `_test` database *and* demands
  `--confirm=<database>` naming it. The development database is loadable and never replaceable.
- **`ON CONFLICT (identity) DO NOTHING`, never `DO UPDATE`.** A reload is a no-op, and a fixture
  cannot overwrite a row somebody changed by hand while debugging. During a debugging session the
  database is authoritative, not the file.
- **One transaction for the whole load**, across every dataset. A partial seed looks loaded, and
  whichever half is missing surfaces days later as an unrelated failure.
- **`reset` deletes by identity and never truncates.** The fixture set does not own the tables it
  writes into; a truncate would remove rows it never created.

**Tests** — 31 deterministic cases, plus one opt-in live suite:

```text
tests/seed-fixtures.test.ts              12 cases
  real datasets   every fixture passes; only implemented kernel foundations are seeded (K-05 and
                  K-08, checked against which components actually have a CONTRACT.md, so an
                  unimplemented component cannot acquire fixtures); no financial policy key; every
                  instant is a fixed UTC literal; every declared identity is present in every row
  ordering        dependency order respected, stable across input order and across repeated calls
  planted         each of the nine checks rejects its planted fixture; the planted directory has
                  one per check and nothing stale; a rejected manifest is not returned as loadable;
                  P0 is reserved for the checks that could leak data or corrupt a boundary

tests/seed-runner.test.ts                19 cases
  ordering        dependencies first whatever order the manifests arrive in, and the rows
                  themselves written in that order; tables within a dataset in declared order
                  (events before deliveries before receipts, or the foreign keys would refuse);
                  a cycle refused before a connection is opened
  atomicity       a row failing in the *second* dataset rolls back the first as well; a failure
                  after a successful earlier load restores exactly what was there; one BEGIN, one
                  COMMIT, one connection for the whole load
  idempotency     a second load inserts nothing and says so; every insert conflicts on the declared
                  identity including the composite one; a hand-edited row is not overwritten;
                  unseed removes exactly the declared rows, children first, and never truncates
  safety          remote hosts refused; every marker in the provisioning guard's own list refused
                  even on localhost; unparseable strings refused; the development database refused
                  for replacement; four wrong confirmations refused and the right one accepted

tests/integration/fixtures.integration.ts   2 cases, SKIPPED without a server
                  the two claims a fake cannot make: that the rows satisfy the real CHECK
                  constraints, foreign keys and unique indexes, and that ON CONFLICT really makes a
                  reload a no-op against the actual indexes. Runs inside the guarded derived _test
                  database and asserts the development database untouched.
```

**Each guarantee was planted and the tests observed to fail:**

```text
content rules and the cross-owner check disabled       1 of 12 failed (covering 4 checks)
per-dataset commits instead of one transaction         2 of 19 failed
ON CONFLICT removed, host and confirmation guards off  5 of 19 failed
```

**What is deliberately not seeded**, and why — recorded in `db/fixtures/README.md` as well:

- **No business-module data.** No module is implemented; seeding orders or listings would invent
  contracts that do not exist, and every test written against them would be rewritten when the real
  ones land.
- **No financial policy values.** K-06 owns those, and a test fails if a fixture declares one.
  (K-06 was unbuilt when this block was written; it was delivered by FND-005b, §11.31, and the
  fixture set still declares no policy value — loading one is a separate decision.)
- **No production defaults**, and no `production` purpose in the format at all.
- **No authoritative events.** The K-08 rows are delivery-state scenarios written by hand, not
  published through `EventService` and consumed by nothing.
- **No end-to-end commerce coverage.** Two kernel foundations' worth of rows is not a marketplace,
  and nothing here should be read as evidence that one works.

```text
STATUS AFTER THIS TASK:
                    P0-17 IN PROGRESS - the strategy, contract, runner and datasets exist; nothing
                          has been loaded into a live server, and "realistic-data testing" in the
                          v3 sense needs business modules that do not exist.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 430, pass 430, fail 0
                                                                (399 before; +31)
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/seed-fixtures.test.ts
                                                       exit 0   tests 12, pass 12
                    node --test tests/seed-runner.test.ts
                                                       exit 0   tests 19, pass 19
                    npm run check:migrations           exit 0   8 files, 0 violations
                    npm run test:integration           exit 0   tests 14, pass 0, SKIPPED 14
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here, so **no fixture has ever been loaded**.
                    The datasets are validated statically and the runner is proved against an
                    injected fake; that the rows satisfy the real constraints, and that ON CONFLICT
                    behaves against the actual indexes, is unobserved. The K-08 fixtures also carry
                    hand-computed payload fingerprints that nothing recomputes. P0-17 and every
                    live-database gate stay incomplete.
```

---

### 11.17 Correction — FND-002d validation bypass, split replacement, and trusted fingerprints

Three defects in the FND-002d delivery, found by review. The first is the one that mattered: the
fixture contract was enforced by the *route taken to the runner* rather than by the runner, so every
guarantee §11.16 recorded held only for callers who came in through the CLI.

| # | Defect | Failed invariant | Correction |
|---|---|---|---|
| 1 | **Validation was bypassable.** The CLI validated and then called `seed`. `seed`, `unseed` and `replace` are exported, and a caller passing hand-built manifests reached the database having skipped ownership, cross-owner, identity, determinism, credential, personal-data and dependency checks entirely. Every claim in §11.16 — "a fixture may not reach into another unit's namespace", "no credential", "no personal data" — was true of the CLI and not of the component. | A contract enforced by the polite path is not enforced. | Validation was split into `validateManifests` (in-memory, the complete check set) and file reading, and every public runner path now goes through one `plan()` gate that runs it. A violation is refused **before a connection is opened**, and the refusal lists every violation rather than the first, because fixing one at a time and guessing each round is how a validator gets worked around. |
| 2 | **Replacement could leave the database empty.** `reset` ran `unseed` and then `seed`. Each was atomic on its own, which sounds sufficient and is not: between the two commits the database held no fixture data at all, and a reload failing there — a constraint the edited fixtures now violate, a dropped connection — left the operator with an empty database and an error message. | An operation called "replace" must not be able to leave nothing behind. | One `replace(database, options)` deletes in reverse load order and reloads in load order inside **one transaction**, with a single commit. Any failure in either half rolls the whole thing back. The CLI calls it; `seed` and `unseed` remain for the additive and removal cases. |
| 3 | **Fingerprints were trusted.** K-08 treats a payload fingerprint as the evidence that the payload was never edited. The fixtures carried hand-computed values and nothing checked them, so editing a payload without recomputing would seed a row whose own evidence contradicts it — noticed by the first consumer that compared the two, and by nothing before that. | Evidence is recomputed or it is decoration. | The validator recomputes every `payload_fingerprint` from its `payload` with the same canonical SHA-256 `EventService` uses, and refuses a mismatch, a malformed hash, or a fingerprint with no payload to confirm. `fingerprint-mismatch` is the tenth check, at P0. |

**On the duplicated algorithm.** `platform/fixtures/fingerprint.ts` reimplements
`fingerprintPayload` rather than importing K-08's. `platform/` sits below `kernel/`, and importing
upward is exactly what the layer-direction rule forbids (MODULE_MAP.md §10.1) — inverting the
dependency the architecture is arranged around, to save nine lines, would be a poor trade. The
duplication is guarded instead: a test runs both implementations over a corpus that includes every
payload in the real fixtures and fails if they ever disagree. This is the second recorded
duplication of its kind, after K-05's private instant module (§11.14); both are follow-ups worth
collapsing when a natural home exists.

**Tests added** — `tests/seed-hardening.test.ts`, 14 cases:

```text
validation      fourteen invalid manifests a direct caller can build - unowned schema, cross-owner
                write, wrong owner, duplicate identity, missing identity column, now(), a seeded
                API key, a deliverable email address, a nested value, a bad manifest version, a
                non-kebab dataset name, a production purpose, two datasets with one name, a
                dependency on nothing - each refused by seed AND by unseed AND by replace, each
                with no connection opened; the refusal names every violation; a valid hand-built
                manifest still loads; validateManifests and validateFixtures agree
replacement     a successful replacement commits exactly once having deleted and reloaded; every
                delete precedes every insert with no commit between them; a failure while
                reloading leaves every original row byte-identical (asserted table by table, with
                the delete phase and the start of the reload both confirmed to have run); a
                failure while deleting does the same; a replacement restores a row an operator had
                deleted by hand, which is what distinguishes reset from a second load
fingerprints    the platform and kernel implementations agree over a corpus including unicode
                keys, quotes, backslashes, nulls, key-order permutations and every real fixture
                payload; every fingerprint in the real fixtures is the fingerprint of its own
                payload; an altered payload, an altered hash, a copied hash, a malformed hash and
                an orphan hash are each refused before any database access; tampering with the
                real fixture set is caught
```

**Each correction was planted and the tests observed to fail:**

```text
runner validation removed                          4 of 14 failed
replacement split back into two transactions       3 of 14 failed
fingerprint trusted rather than recomputed         3 of 26 failed (with the fixture suite)
```

The second plant is worth a note. It initially failed only two tests, because the reload-failure
case was matching on a *row value* that also appeared in the DELETE for the same row — so the
failure fired during the delete phase and the test was quietly proving something about deletes. It
was rewritten to fail only on an `INSERT`, and to assert that the delete phase and the start of the
reload had both actually run. The plant then failed three.

```text
STATUS AFTER CORRECTION:
                    P0-17 IN PROGRESS - unchanged. The strategy, contract, runner and datasets
                          exist; nothing has been loaded into a live server.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 444, pass 444, fail 0
                                                                (430 before; +14)
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/seed-fixtures.test.ts
                                                       exit 0   tests 12, pass 12
                    node --test tests/seed-runner.test.ts
                                                       exit 0   tests 19, pass 19
                    node --test tests/seed-hardening.test.ts
                                                       exit 0   tests 14, pass 14
                    npm run check:migrations           exit 0   8 files, 0 violations
                    npm run test:integration           exit 0   tests 14, pass 0, SKIPPED 14
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here. The single-transaction replacement is
                    proved against an injected fake that models transaction boundaries; that a real
                    server rolls back a failed replacement is unobserved, as is everything else
                    about these fixtures against real constraints. P0-17 and every live-database
                    gate stay incomplete.
```

---

### 11.18 Correction — FND-002d programmatic-manifest shape validation

§11.17 made validation *mandatory* on every runner path. It did not make it *complete* for input
that never came from a file. `describeShapeProblem` checked the fields a JSON parse would have
checked and trusted the rest because TypeScript said so — and TypeScript says nothing at runtime.
A caller in JavaScript, one that cast an `unknown`, or one deserialising a manifest off a wire had
been through neither the parser nor the type system.

| # | Gap | Failed invariant | Correction |
|---|---|---|---|
| 1 | **Column names were trusted.** `identity` was checked to be a non-empty array of strings; the strings themselves were not checked. `jsonColumns` was not checked at all outside the file parser. Both are interpolated into SQL — `ON CONFLICT (${identity.join(', ')})`, `WHERE ${column} = $1`, `$n::jsonb` — because identifiers cannot be parameterised, so a column name is the one place caller input reaches a statement as text. | Anything interpolated into SQL is validated, or it is an injection surface. | Every entry of `identity` and `jsonColumns` must match `COLUMN_NAME` (lower_snake_case, nothing else), must be distinct within its list, and a column may not be declared as both — a serialised document in `ON CONFLICT` would compare by key order, which is what a fingerprint exists to avoid. |
| 2 | **Runtime shapes were trusted.** A `dependsOn` entry that was a number or an object, a `rows` entry that was an array or `null`, a `tables` entry that was an array, a `jsonColumns` that was a string — each passed the shape check. A non-string dependency is the quietest of these: it matches no dataset in `loadOrder`, so the ordering it was meant to express silently disappears and the load runs in an order nobody asked for. | A validator that trusts its caller's types is a validator for one caller. | Each is checked and named: every `dependsOn` entry a non-empty string, every row an object with at least one column, every table an object with a schema-qualified name. |
| 3 | **Fingerprints were checked only when present.** The rule fired on rows that carried a `payload_fingerprint`, which let a row opt out by omitting the field — and the row that omits it is exactly the one nobody computed a fingerprint for. It could reach an append-only event log carrying no evidence at all. | For a table whose contract says every row carries evidence, absence is the violation. | Every row targeting `kernel_event_infrastructure.event` must carry an object `payload` and a correctly formatted matching `payload_fingerprint`. A null, array, string or numeric payload is refused, as is a fingerprint that is not 64 lower-case hex characters. |

**On naming K-08's table in `platform/`.** `FINGERPRINTED_TABLES` lists
`kernel_event_infrastructure.event` as a literal, because `platform/` sits below `kernel/` and may
not import upward to ask. The cost is that a K-08 rename must be mirrored; the cost of not naming it
is a fixture row reaching the event log with nothing to check it against. A test asserts the
constant still equals K-08's own `EVENT_TABLE`, so a rename fails the build rather than silently
disabling the rule.

**Tests added** — `tests/seed-adversarial.test.ts`, 12 cases:

```text
hostile input   30 manifests cast past the type system - SQL in an identity column, an identity
                closing the ON CONFLICT clause, quoted/spaced/upper-case/numeric/null column names,
                duplicate declarations, a column both identity and JSON, jsonColumns as a string,
                a JSON column carrying a cast, rows as an array/string/null/empty-object/object,
                tables as an array/null/object, an unqualified table name, a table name carrying a
                second statement, dependsOn as a string/object and entries that are
                numbers/objects/null/empty - each refused by seed AND unseed AND replace, each with
                zero connections opened and zero statements issued
containment     a hostile manifest alongside the real ones stops the whole load, so a bad dataset
                cannot ride in behind good ones
property        every identifier that actually reaches SQL in a real load is plain lower_snake_case
event rows      the fingerprinted-table constant still matches K-08's EVENT_TABLE; a row with no
                fingerprint is refused; missing, null, array, string and numeric payloads refused;
                six malformed fingerprints and four non-string ones refused; a correct row still
                loads; non-event tables are not asked for fingerprints; the rule holds through
                validateManifests as well as through the runner; the real fixtures satisfy it
```

**Both corrections were planted and the tests observed to fail:**

```text
shape checks reverted to "arrays checked, entries trusted"   2 of 12 failed (covering all 30 inputs)
fingerprint checked only when present                        2 of 12 failed
```

```text
STATUS AFTER CORRECTION:
                    P0-17 IN PROGRESS - unchanged.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 456, pass 456, fail 0
                                                                (444 before; +12)
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/seed-fixtures.test.ts
                                                       exit 0   tests 12, pass 12
                    node --test tests/seed-runner.test.ts
                                                       exit 0   tests 19, pass 19
                    node --test tests/seed-hardening.test.ts
                                                       exit 0   tests 14, pass 14
                    node --test tests/seed-adversarial.test.ts
                                                       exit 0   tests 12, pass 12
                    npm run check:migrations           exit 0   8 files, 0 violations
                    npm run test:integration           exit 0   tests 14, pass 0, SKIPPED 14
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: These are refusals, and a refusal proves that a bad manifest never reaches a
                    database — not that a good one behaves against a real server. Nothing here has
                    been loaded into PostgreSQL. In particular the injection surface is closed by
                    validation rather than by escaping, which is the right way round but means the
                    guarantee rests on the character class in `COLUMN_NAME` being correct rather
                    than on the server rejecting anything. P0-17 and every live-database gate stay
                    incomplete.
```

---

### 11.19 Evidence — FND-003c (K-09 Audit Foundation)

An audit record answers a question asked much later, by somebody who was not there and is not
inclined to take anybody's word for it. The whole value of the answer rests on the record being
impossible to change afterwards — so immutability is not a feature of this component, it is the
reason it exists, and everything below follows from it.

**What was built**

| File | Holds |
|---|---|
| `kernel/audit-foundation/types.ts` | the immutable record, actor, resource reference, outcome, evidence classification, 15 refusal codes |
| `kernel/audit-foundation/registry.ts` | registered actions with authority, owner, resource types and classified evidence fields; credential detection |
| `kernel/audit-foundation/repository.ts` | the injected port — append, read, query — and its in-memory reference implementation |
| `kernel/audit-foundation/service.ts` | record, retry convergence, filtered retrieval with stable pagination, content fingerprinting |
| `kernel/audit-foundation/postgres-repository.ts` | the adapter, the enlisted-client path, UTC-text projections, fail-closed decoding |
| `kernel/audit-foundation/CONTRACT.md` | ownership, guarantees, refusals, retention and access assumptions, deferred integrations |
| `db/migrations/0005_…up.sql` / `.down.sql` | `kernel_audit_foundation.audit_record` with an append-only trigger |

**The design decisions worth recording**

- **No update and no delete, at four layers.** Not in the service, not in the port, not in the
  adapter, and refused by a database trigger. Three tests attack this from different angles: the
  transaction object is inspected at runtime for any operation matching update/delete/redact/purge,
  the service's method list is asserted to be exactly `record, recordById, query, queryAll`, and the
  three source files are scanned for `UPDATE`, `DELETE` and `TRUNCATE`. A rule enforced only by a
  type is a rule a cast undoes.
- **The actor placeholder is refused into honesty.** `actor.authentication` must be
  `unauthenticated` and `actor.sessionId` must be `null` — anything else is refused, in the service
  and by a `CHECK`. A record written today that claimed a verified session would assert a
  verification that never happened, and a reader in two years could not tell which records had a
  real actor. Relaxing the constraint is a later migration's job when K-02 lands, rather than a
  silent change of meaning.
- **Ordering is `(recordedAt, recordId)`, never the instant alone.** Audit records arrive in bursts
  and two can share an instant to the microsecond. The SQL compares the cursor as a tuple
  (`(recorded_at, record_id) > ($n::timestamptz, $m)`) and the index matches. Ordering on time alone
  makes a paginated walk skip or repeat rows — the failure that turns "the log has 400 records" into
  "the log showed me 397 of them".
- **Evidence is classified at registration or refused.** An undeclared field is not stored and not
  dropped: dropping it means a recorder believes it captured something the log does not hold, which
  surfaces during an investigation. Classifications exist so the entitlement check K-04 will add has
  something to act on, decided by whoever understood the field.
- **A credential is refused under every classification, `restricted` included.** An audit log is the
  longest-lived store in the system. `REDACTED` is the documented alternative, and is accepted — that
  a field existed is worth recording, its value is not.
- **`denied` is a separate outcome from `failed`.** The single most interesting row in a security
  log; folding it into failure loses the difference between the system breaking and somebody trying
  something they may not do.

**Tests** — 64 deterministic cases, plus five opt-in live ones:

```text
tests/audit.test.ts                    22 cases
  registry     unregistered actions, bad names, absent owners, missing descriptions, unknown
               authorities and non-snake resource types refused; every field must carry a known
               classification; a declared credential field cannot be registered under any
               classification; classifications are reportable
  evidence     undeclared fields refused rather than dropped; missing required, wrong-typed,
               fractional-integer, non-boolean and null-required refused; optional-null accepted;
               five credential-shaped values refused; REDACTED accepted
  recording    stored as given with a fingerprint; the fingerprint ignores evidence key order;
               identical retry returns the original; mismatched reuse names what differed;
               duplicate id refused under a fresh key
  refusals     AI authorship; claimed session and claimed authentication; another unit's resource;
               an undeclared resource type; ten malformed identities and instants; empty reason;
               unknown outcome; denied recorded as itself

tests/audit-repository.test.ts         26 cases
  conformance  append-once; no mutation operation on the transaction; failed transaction writes
               nothing; equal-instant ordering stable and repeatable; a page walk over seven
               records sharing one instant returns each exactly once; filters combine with AND;
               from inclusive and before exclusive; four bad limits refused
  immutability no UPDATE/DELETE/TRUNCATE in any source; the migration's trigger and its rollback
  adapter      timestamps projected as UTC text and never bare; ORDER BY qualified on both columns;
               the cursor compared as a tuple with a timestamptz cast; every filter a bound
               parameter and no quoted literal in a WHERE; limit+1 rather than a second count(*);
               twelve undecodable rows refused; evidence decoding accepts flat scalars only
  transactions an enlisted append issues no transaction control and releases nothing; a failure
               propagates so the caller rolls back; nine forms of nested control refused; the
               repository-owned path still opens, commits and releases its own
  contract     the schema is the one the manifest derives; adapter and migration touch no other
               schema; the migration carries the pkey, the idempotency unique, the AI check, the
               session check, the outcome/reason/evidence checks and the chronological index; the
               rollback reverses everything and drops the trigger before its function

tests/audit-concurrency.test.ts        16 cases
  concurrency  two and three concurrent identical retries return one record; concurrent mismatched
               reuse fails closed; two recordings under one id, one wins; the loser writes nothing
  immutability the returned evidence is frozen; a mutated read cannot reach the store; five
               retries leave the record byte-identical; the service's method list is exactly four
  querying     a page walk over equal instants returns each record once; distinct instants are
               chronological; the last page reports no cursor; a query is repeatable; five bad
               limits, an unregistered action, an unknown outcome and two malformed instants
               refused; the four filters an investigation starts from; queryAll respects its bound

tests/integration/audit.integration.ts  5 cases, SKIPPED without a server
               the claims a fake cannot make: the trigger really refuses UPDATE and DELETE; the
               CHECK constraints refuse what the service refuses, through a connection that never
               went near the component; pagination is exact against the real index when every
               record shares an instant; an enlisted append commits with the caller and rolls back
               with it
```

**Each guarantee was planted and the tests observed to fail:**

```text
AI authorship and claimed sessions permitted           2 of 22 failed
unclassified fields ignored, secret values permitted   2 of 22 failed
instant-only ordering, no commit-time conflict check   6 of 42 failed
a mutation capability exposed, nested control allowed  2 of 26 failed
```

**Also caught by an earlier guard.** `tests/kernel-overview.test.ts`, added by the FND-003b
documentation correction, failed the moment K-09 landed because `kernel/README.md` still described
two implemented components. That is the test working: the README now names three, and the
remaining-unbuilt count follows from the same arithmetic.

**Deliberately not delivered**, and recorded as such in CONTRACT.md rather than implied:

- **No unit records an audit record.** Not K-05, not K-08, not any financial module. The actions in
  the tests are fixtures; registering one on a unit's behalf would claim it is audited when it
  records nothing.
- No API, no UI, no authentication implementation, no entitlement check on `query`.
- No retention, expiry, archival, partitioning or erasure. §5 of the contract records these as
  assumptions rather than mechanisms, including that a subject-erasure request currently has no
  answer in this component.
- No tamper-evident chaining. Records are fingerprinted individually; chaining would additionally
  detect deletion, and is worth doing once somebody has decided what the log is defended against.

```text
STATUS AFTER THIS TASK:
                    K-09 contract         COMPLETE (kernel/audit-foundation/CONTRACT.md)
                    K-09 implementation   IN PROGRESS - core only
                    P0-36 IN PROGRESS - not complete: no live PostgreSQL, no producer integration,
                          no RBAC, no authentication
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 520, pass 520, fail 0
                                                                (456 before; +64)
                    npm run check:migrations           exit 0   10 files, 0 violations
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/audit.test.ts    exit 0   tests 22, pass 22
                    node --test tests/audit-repository.test.ts
                                                       exit 0   tests 26, pass 26
                    node --test tests/audit-concurrency.test.ts
                                                       exit 0   tests 16, pass 16
                    npm run test:integration           exit 0   tests 19, pass 0, SKIPPED 19
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here, so migration 0005 has never been
                    applied and **the append-only trigger has never refused anything**. That is the
                    strongest claim this component makes, and today it is proved only in the sense
                    that the trigger is declared and the application has no operation that would
                    reach it. The `CHECK` constraints, the tuple cursor against the real index, and
                    the enlisted path inside a real transaction are all equally unobserved.
                    `tests/integration/audit.integration.ts` makes exactly these checks and skips,
                    with its reason stated, when there is no server. K-09 also has no producer, no
                    authentication and no entitlement check, so P0-36 and every live-database gate
                    stay incomplete.
```

---

### 11.20 Correction — FND-003c immutability boundary, persisted integrity, and the actor `CHECK`

§11.19 called immutability "not a feature of this component, it is the reason it exists". Three gaps
sat underneath that sentence. None was visible from the tests that shipped with the slice, because
each test asked the question the code was already answering.

| # | The gap | Why it mattered | The correction |
|---|---|---|---|
| 1 | **Only the evidence map was frozen.** `actor` and `resource` were plain objects on a frozen top level. A caller holding a returned record could write `record.actor.id` and change who the record says did it. | The one thing an audit trail must survive is being edited afterwards, and this was editable from any caller holding a result. | A single boundary, `sealRecord` in `kernel/audit-foundation/immutable.ts`, copies and freezes the record together with its `actor`, `resource` and `evidence`. Applied on service results, on all ten in-memory seed/read/write/query paths, and on PostgreSQL decoding. |
| 2 | **A shallow copy shares its children.** `{ ...record }` produces a new top level over the *same* nested objects, so a record the caller passed in — to `record`, to `seed`, to `insertRecord` — stayed reachable from the caller's own handle after it was stored. Editing that handle edited stored state, after the fact, with nothing to see. | This is the version of the same defect that leaves no trace at all: the log changes and no call was made. | The same boundary. `sealRecord` copies before freezing, so the store is unreachable from anything the caller kept, and the caller's own objects are left unfrozen rather than surprisingly immobilised. |
| 3 | **The stored fingerprint was trusted on read.** Decoding checked that `content_fingerprint` was *shaped* like a SHA-256 and returned it. Nothing compared it with the content it was supposed to fingerprint. | Every other decode check asks whether a field is well formed. None asked whether the record still said what it said when it was written — which is the only question the fingerprint exists to answer. A row altered by something that got past the append-only trigger, or restored from a doctored backup, decoded cleanly and was read as fact. | `fingerprintRecord` moved to its own module so the adapter can use it without depending on the service, and `toRecord` now recomputes it from the **fully decoded** record and refuses `malformed-record` on any mismatch. One bad row fails its whole page rather than being dropped from it. |

**And the constraint that was the wrong way round.** Migration 0005 carried
`CHECK (actor_session_id IS NULL OR actor_authentication <> 'unauthenticated')` — "a session id
requires an authentication method". It reads sensibly and it permitted `('session', 'sess-1')`: a
combination the service refuses outright, because at the time K-02 had not been built and nothing
had authenticated anybody. The constraint that matters is the one a write *around* the service hits,
so it now enforces the documented placeholder exactly:

```sql
CHECK (actor_authentication = 'unauthenticated')
CHECK (actor_session_id IS NULL)
```

Of the six combinations of three known authentication methods and a present-or-absent session id,
exactly one is writable. K-02 has since landed (§11.25), but it ships no verifier and has no
consumer, so nothing yet produces an authenticated actor for K-09 to record. Relaxing these stays a
later migration's job, to be done deliberately when there is a real session to write down.

**Each correction was planted and the tests observed to fail:**

```text
the seal made shallow again ({ ...record } only)        10 of 32 failed
the recomputation replaced by the stored value           4 of 16 failed
one field (reason) dropped from the canonical form       1 of 16 failed
the actor CHECKs weakened back to the implication form   2 of 27 failed
```

The third plant is the one worth keeping. "Every field is covered by the recomputation" builds a
consistent row, edits one column without recomputing — which is precisely what an alteration looks
like — and asserts the refusal, for all fifteen columns. Dropping `reason` from the canonical form
fails exactly that case and nothing else, which is how a fingerprint quietly stops covering a field.

**New tests.** `tests/audit-immutability.test.ts` (16) attacks the boundary from every direction a
record crosses one: service results, repository reads, transaction reads, query pages, `queryAll`,
seeded arrays and inserted objects, with twelve distinct nested writes each. Plus a deterministic
`(actor_authentication, actor_session_id)` matrix evaluated from the migration text in
`tests/audit-repository.test.ts`, and a live counterpart in `tests/integration/audit.integration.ts`
that enumerates all six combinations plus an unknown method against the real constraints.

The deterministic matrix exists because the live suite skips without a server: it parses the actor
`CHECK` predicates out of the migration and evaluates them, and it **throws rather than passing** if
a constraint is rewritten into a form it cannot evaluate. A check that cannot fail is a placeholder,
and a check that silently stops checking is worse.

```text
STATUS AFTER THIS TASK:
                    K-09 contract         COMPLETE (kernel/audit-foundation/CONTRACT.md)
                    K-09 implementation   IN PROGRESS - core only
                    P0-36 IN PROGRESS - not complete: no live PostgreSQL, no producer integration,
                          no RBAC, no authentication
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 537, pass 537, fail 0
                                                                (520 before; +17)
                    npm run check:migrations           exit 0   10 files, 0 violations
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/audit.test.ts    exit 0   tests 22, pass 22
                    node --test tests/audit-repository.test.ts
                                                       exit 0   tests 27, pass 27
                    node --test tests/audit-concurrency.test.ts
                                                       exit 0   tests 16, pass 16
                    node --test tests/audit-immutability.test.ts
                                                       exit 0   tests 16, pass 16
                    npm run test:integration           exit 0   tests 20, pass 0, SKIPPED 20
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: Unchanged from §11.19, and one item is now sharper. The corrected actor
                    constraints have never been applied to a server, so the six-combination matrix
                    is proved by evaluating the migration text rather than by PostgreSQL refusing
                    five inserts. The live test that would refuse them is written and skips. The
                    append-only trigger has still never refused anything, and the recomputed
                    fingerprint has never rejected a row that a real database returned — both are
                    proved against the adapter driven by a recording fake, which proves the adapter
                    and not the server.
```

---

### 11.21 Evidence — FND-004a (K-01 Identity foundation)

An identity layer is the easiest component in a commerce platform to get subtly wrong, because
almost everything that *feels* like it belongs there does not. A name, an email, a password, a
session, an account, a role, a verification level — every one of those is something a reader would
expect an "identity" to carry, and every one of them belongs to a different component. So this slice
is defined as much by its refusals as by what it stores, and the refusals are executable rather than
merely documented.

**What was built**

| File | Holds |
|---|---|
| `kernel/identity/types.ts` | the immutable subject, the origin, the closed kind list, 14 refusal codes |
| `kernel/identity/registry.ts` | the three-kind registry with a written rationale each, the opaque-identifier rules, the foreign-field table |
| `kernel/identity/immutable.ts` | the single seal boundary — clone and deep-freeze |
| `kernel/identity/repository.ts` | the injected port (insert, two lookups) and its in-memory reference implementation |
| `kernel/identity/service.ts` | create, retry convergence, deterministic lookup, every input refusal |
| `kernel/identity/postgres-repository.ts` | the adapter, the enlisted-client path, UTC-text projection, fail-closed decoding |
| `kernel/identity/CONTRACT.md` | ownership, guarantees, refusals, and the deferred K-02/K-03/K-04/K-09 integrations |
| `db/migrations/0006_…up.sql` / `.down.sql` | `kernel_identity.identity_subject` with a write-once trigger |

**The design decisions worth recording**

- **The kind registry is closed at three, and holds no role.** `person`, `organisation`, `system`.
  The guide's §4 is explicit — *do not create separate identities for buyers, sellers, hosts or
  service providers; create one JAYA Account with capabilities* — and a role as a *kind* is exactly
  how that gets violated: one person who both buys and sells becomes two parties who cannot see each
  other's history or share a payment method. Every open enumeration in an identity system eventually
  acquires a role, because somebody needs one and adding it is a one-line change. So the list is
  closed, and `tests/identity.test.ts` asserts that ten specific role names are refused.
- **Identifiers must be opaque, and the refusal explains the cost.** A subject id is copied into
  every account, order, ledger entry and audit record that ever references the party. If it is an
  email address, the platform has published personal data into places it cannot enumerate, and an
  erasure request has no answer short of rebuilding the database. Twelve natural-key shapes are
  refused — email, telephone, bare digit runs, IBAN, URL, domain, `first.last`, labelled document
  numbers — as are credential-shaped values and anything shorter than 8 characters, because an
  enumerable identity space lets anybody count the platform's parties. The checks are shape-based
  and therefore imperfect; §3 of the contract says so rather than implying completeness.
- **"An identity is not an account" is enforced, not documented.** Twenty-six field names are mapped
  to the component that owns them, and a create request carrying one is refused *by name* —
  `accountId` answers "K-03 Accounts owns the universal account and its link to a subject". Unknown
  fields are refused too. A caller passing `accountId` is not making a typo, it is modelling the
  thing wrongly, and a silent spread would store nothing while leaving it believing the link had
  been recorded.
- **Write-once at four layers.** No update, delete or merge in the service, the port or the adapter,
  and a `BEFORE UPDATE OR DELETE` trigger in migration 0006. Asserted by inspecting the transaction
  object at runtime — a rule enforced by a type is a rule a cast undoes — and by scanning the three
  source files with comments stripped.
- **Merge is deferred, not forgotten.** Two subjects that turn out to be one party is a real
  situation. The answer is a linkage record, a surviving id, an audited decision and a rule for the
  balances on both sides — not an `UPDATE` here. Implementing merge as a mutation is how an identity
  system becomes unable to explain its own history. `mergedInto` sits in the foreign-field table
  with that reason attached.
- **AI is refused three times over**: by the service, by the `CHECK`, and again on decode if a row
  somehow holds `origin_kind = 'ai'`. An identity is the root of attribution for everything
  downstream, so a fabricated one is indistinguishable from a real party — including to the
  financial modules, where AI is barred from authority outright. `ai` remains a representable value
  precisely so the refusal can be tested; an unrepresentable value would also be unexamined.
- **Two lessons from the previous three components were applied at the start rather than by
  correction.** The seal is one function that clones *and* freezes, because K-09 shipped a shallow
  one (§11.20); and the in-memory repository checks conflicts at commit against the store as it
  stands rather than the snapshot it read, because K-08 shipped without that parity (§11.15).

**Each guarantee was planted and the tests observed to fail:**

```text
the natural-identifier refusal removed                    3 of 67 failed
AI permitted as an origin                                 3 of 67 failed
foreign fields silently ignored instead of refused        2 of 67 failed
the seal made shallow ({ ...subject } only)               8 of 67 failed
no commit-time conflict check (in-memory/PG parity lost)  4 of 67 failed
the retry-convergence path removed                        1 of 67 failed
the enlisted transaction-control guard removed            1 of 67 failed
the migration's origin_not_ai CHECK removed               1 of 22 failed
the migration's opacity CHECK weakened to '^.+

1. **This document is updated at the end of every task**, before the task is reported complete (v3 §43 step 14, §66 step 6). A task that changes the repository without updating this document is not finished.
2. **Status changes require evidence.** Moving any item to `COMPLETE` requires the §11 evidence block, populated, with real commands and real results. "Tests pass" without the command and the counts is not evidence.
3. **Statuses may move backwards.** If review finds an item was marked complete prematurely, it returns to `IN PROGRESS` or `NEEDS REVIEW` and the reason is recorded. Correcting an over-claim is normal, not a failure.
4. **Defects are recorded when found, not when fixed.** A P0 stops all progression the moment it is identified.
5. **New requirements are classified before implementation** (v3 §67): new module, module extension, policy change, configuration change, UI/UX change, AI change, data change, or security/risk change — then impact-analysed against the owning module and its contracts.
6. **Nothing is deleted.** Superseded requirements move to `OUT OF SCOPE WITH REASON` and remain visible (v3 §53).
7. **Language discipline.** Use only accurate status words: phase complete, module complete, MVP candidate, release candidate, partially complete, blocked (v3 §64). Today the only accurate description is *"planning baseline established; toolchain and boundary enforcement delivered"* — not "FND-001 complete", not "Phase 0 complete", not "MVP candidate" (matching §10).
          1 of 22 failed
```

The last two are worth separating out. `origin_not_ai` and the opacity `CHECK` are the database's
copy of two service rules, and weakening either is invisible to every test that goes in through the
service — which is the whole reason those constraints exist. The opacity plant is caught by a test
that extracts the `CHECK` pattern *from the migration file* and runs the service's own accepted and
rejected identifiers through it, so the two enforcement points cannot drift apart quietly.

**Also caught by an earlier guard.** `tests/kernel-overview.test.ts` failed the moment K-01 landed,
because `kernel/README.md` still described three implemented components and twelve unbuilt ones.
That is the test working: the README now names four and eleven, from the same arithmetic.

**Deliberately not delivered**, and recorded in CONTRACT.md §7 rather than implied:

- **No unit creates an identity subject.** Not K-03, not any module. The enlisted path exists as a
  capability, not an integration — K-03 Accounts will be its first consumer.
- No login, password, OAuth, MFA or session (K-02). No account, capability, profile or verification
  (K-03 and the Capability & Verification module). No API and no UI.
- **No audit trail.** Creating an identity is precisely the sort of action K-09 exists to record.
  K-09 is built and K-01 does not use it, which makes this a deferred integration rather than a
  missing dependency.
- No merge, no deactivation, no listing and no search. `findSubject` takes an id and nothing else; a
  lookup that took personal data would be an identity layer that stores personal data.
- `identity_document`, which MODULE_MAP §3 lists among K-01's tables, holds verification evidence
  and is deferred with the verification work.

```text
STATUS AFTER THIS TASK:
                    K-01 contract         COMPLETE (kernel/identity/CONTRACT.md)
                    K-01 implementation   IN PROGRESS - core only
                    Checklist K-01 row (§B) moves to IN PROGRESS - not complete: no live
                          PostgreSQL, no consumer, no authentication, no permissions,
                          no audit integration.
                    Note: §A.5 Foundation capability lists P0 rows for authentication,
                          permissions, events, audit and feature flags but none for
                          identity. K-01 is therefore tracked only in §B, which is
                          recorded here rather than silently patched by inventing a P0 id.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 604, pass 604, fail 0
                                                                (537 before; +67)
                    npm run check:migrations           exit 0   12 files, 0 violations
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/identity.test.ts exit 0   tests 23, pass 23
                    node --test tests/identity-repository.test.ts
                                                       exit 0   tests 22, pass 22
                    node --test tests/identity-concurrency.test.ts
                                                       exit 0   tests 22, pass 22
                    npm run test:integration           exit 0   tests 25, pass 0, SKIPPED 25
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here, so migration 0006 has never been
                    applied and **the write-once trigger has never refused anything**. The same is
                    true of every CHECK in it — including the two that carry rules the service also
                    enforces, which are precisely the ones that matter for a write around the
                    adapter. tests/integration/identity.integration.ts makes exactly these checks,
                    plus a concurrent-retry convergence against the real unique index and an
                    enlisted create that commits and rolls back with its caller, and skips with its
                    reason stated when there is no server. K-01 also has no consumer, no
                    authentication behind its origin, no permission check on creation and no audit
                    record, so the K-01 checklist row and every live-database gate stay incomplete.
```

---

### 11.22 Correction — FND-004a persisted-identity validation and the migration's opacity claim

§11.21 recorded that K-01 refuses natural-key identifiers, and it did — on the way *in*. Two other
places claimed the same guarantee and did not keep it.

| # | The gap | Why it mattered | The correction |
|---|---|---|---|
| 1 | **Decoding asked far less than creation.** `toSubject` checked that each column was non-empty text and that two of them held a known enum value. It did not ask whether the subject id was opaque, whether the origin id or idempotency key looked like a credential, or whether the instant was a real one. | A row written around the adapter — by hand, by a restore, by a migration script — decoded cleanly and was handed back as a real party carrying exactly the natural key the creation path exists to keep out. Validation on the way in protects the store from a caller; validation on the way out protects every consumer from the store, and the store is the thing this component controls least. | One function, `validateSubject` in `kernel/identity/validate.ts`, called by the service on the subject it builds and by the decoder on the subject it decodes. There is no second list of rules to keep in step, because there is no second list. Its refusal on a stored row adds a clause saying the row was not written by this component, because that is a database problem rather than a caller's. |
| 2 | **Migration 0006 claimed more than it enforced.** Its comments said the constraints prohibited natural keys. The predicates checked `subject_id` for an `@` and for a run of twelve or more digits, and checked `origin_id` for neither. | Four whole classes of natural key satisfied every constraint the table declared while the service refused them: a **domain** (`example.com`), a **`first.last` personal name** (`alice.smith`), a **compact IBAN or labelled document number** (`GB29NWBK6016133192`, `nic:912345678V`), and a **10- or 11-digit telephone number** (`0771234567`) — the last slipping under the twelve-digit rule. Credentials were not checked at all, on any column. A constraint that claims more than it enforces is worse than none, because the next reader trusts the comment rather than the predicate. | `kernel_identity.is_opaque_identifier(text)` carries the whole rule set once, and the `CHECK` on all three identifier columns calls it. It mirrors `assertOpaqueIdentifier` clause for clause. |
| 3 | **`origin_id` and `idempotency_key` were second-class.** The service applied the full identifier rules to all three; the database applied a fragment to one. | An origin id is copied into logs and diagnostics exactly as a subject id is, and `origin_id = 'alice@example.com'` was accepted by the table. | All three columns go through the one function, and a test fails if any column reacquires an ad-hoc regex `CHECK` of its own alongside it. |

**One corpus, three enforcement points.** `tests/identity-persisted.test.ts` holds twenty-eight
identifiers — ten that must be accepted and eighteen natural or credential-shaped ones that must
not — and drives every one of them through the service, through `validateSubject`, and through the
SQL rules **extracted from migration 0006 and evaluated in JavaScript**. The SQL evaluator
understands only the clause forms the function actually uses and **throws** on anything else, so
rewriting a clause into a shape it cannot read is a failing test rather than a silent pass. That
matters more here than usual: no PostgreSQL runtime is available, so an unevaluated `CHECK` would be
a constraint nobody had ever tested in any form.

The corpus also guards the other direction. "Without weakening the accepted opaque-ID domain" is
half of this correction, and a rule tightened until only one generator's output survives would pass
every refusal test while breaking every caller that chose a different id format. Ten accepted shapes
— ULID, UUID, prefixed key, colon-namespaced, base64url, hyphenated service name — are asserted to
survive all three points.

**Each protection was planted and the tests observed to fail:**

```text
the decoder stops calling the shared validator             8 of 80 failed
the SQL domain-suffix clause removed                       2 of 14 failed
the SQL bare-digit-run clause removed                      2 of 14 failed
the SQL shape clause weakened to accept short ids          3 of 14 failed
the SQL shape clause narrowed so a valid UUID is refused   3 of 14 failed
a SQL clause rewritten into a form the evaluator cannot read
                                                           3 of 14 failed
the domain rule removed from the service instead           3 of 37 failed
```

The last two are the ones worth keeping. The sixth replaces `position('@' in value) = 0` with the
equivalent `strpos(value, '@') = 0` — a change that is *correct SQL and correct behaviour*, and the
test still fails, because a rule set the guard cannot read is a rule set the guard is not checking.
The seventh weakens the **service** rather than the SQL and is caught by the same corpus, so drift
is detected whichever side moves.

**Also changed:** two decoder tests in `tests/identity-repository.test.ts` now expect the shared
vocabulary — a stored `kind` of `seller` is `unknown-subject-kind` rather than `malformed-record`,
because the kind is not malformed, it is unregistered, exactly as at creation. The migration-contract
test asserts that all three columns call the shared function. `tests/integration/identity.integration.ts`
gained fifteen bypass-insert probes covering the newly-refused classes on all three columns.

```text
STATUS AFTER THIS TASK:
                    K-01 contract         COMPLETE (kernel/identity/CONTRACT.md)
                    K-01 implementation   IN PROGRESS - core only
                    Checklist K-01 row (§B) stays IN PROGRESS - no live PostgreSQL, no consumer,
                          no authentication, no permissions, no audit integration.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 617, pass 617, fail 0
                                                                (604 before; +13 net, +14 new
                                                                 less one relocated)
                    npm run check:migrations           exit 0   12 files, 0 violations
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/identity.test.ts exit 0   tests 23, pass 23
                    node --test tests/identity-repository.test.ts
                                                       exit 0   tests 21, pass 21
                    node --test tests/identity-concurrency.test.ts
                                                       exit 0   tests 22, pass 22
                    node --test tests/identity-persisted.test.ts
                                                       exit 0   tests 14, pass 14
                    npm run test:integration           exit 0   tests 25, pass 0, SKIPPED 25
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: The strengthened constraints have never been applied to a server, so
                    `is_opaque_identifier` has never refused an INSERT. It is proved by extracting
                    its clauses and evaluating them, which tests the *rules* and not PostgreSQL's
                    execution of them — a regex that means something different under POSIX ARE than
                    under JavaScript would pass here and behave otherwise in the database. The two
                    known differences are handled (`\y` is translated to `\b`; case-insensitive
                    matching uses `~*`), and the residue is stated rather than implied.
                    `tests/integration/identity.integration.ts` inserts every refused class
                    directly and skips, with its reason, when there is no server. Everything else in
                    §11.21's "still not verified" is unchanged: no consumer, no authentication
                    behind `origin`, no permission check, no audit record.
```

---

### 11.23 Evidence — FND-004b (K-03 Universal Account foundation, and the first real K-01 consumer)

Two things landed here, and the second matters more than its size suggests. K-03 is a small
component — one table, five fields, five operations. It is also **the first time one kernel
component has depended on another and been proved to**. Every cross-component path built so far
(K-08's enlisted append, K-09's enlisted record, K-01's enlisted create) was a capability nothing
used. This one is used.

**What was built**

| File | Holds |
|---|---|
| `kernel/accounts/types.ts` | the immutable account, the origin, 13 refusal codes |
| `kernel/accounts/registry.ts` | the foreign-field table (57 entries with owners), and K-01's identifier rules re-raised in K-03's vocabulary |
| `kernel/accounts/subject-lookup.ts` | the injected K-01 contract — one method — and why it is a port rather than a foreign key |
| `kernel/accounts/immutable.ts` | the single seal boundary — clone and deep-freeze |
| `kernel/accounts/validate.ts` | one validator, called at creation and on every decoded row |
| `kernel/accounts/repository.ts` | the injected port and its in-memory reference implementation |
| `kernel/accounts/service.ts` | open, retry convergence, deterministic lookup, every refusal |
| `kernel/accounts/postgres-repository.ts` | the adapter, the enlisted path, UTC-text projection, fail-closed decoding |
| `kernel/accounts/CONTRACT.md` | ownership, guarantees, refusals, and the deferred K-02/K-04/profile/capability/K-08/K-09 integrations |
| `db/migrations/0007_…up.sql` / `.down.sql` | `kernel_accounts.universal_account` with a write-once trigger |

**The design decisions worth recording**

- **The account carries nothing, and that is enforced.** No capability, role, verification level,
  profile field, credential, persona or balance. `FOREIGN_FIELDS` maps 57 field names to the
  component that owns each, and a request carrying one is refused **by name** — `capabilities`
  answers "the Capability & Verification module owns capability activation". The reason is written
  into the refusal rather than left implicit: an account that carries `isSeller` makes "what about a
  party that sells under two businesses" answerable with a second account, and from then on one
  person has two histories, two reputations and no single counterparty. Guide §4 forbids exactly
  that, and this is what makes it structural rather than aspirational.
- **One party, one account, enforced three times.** Read-then-refuse in the service (which gives the
  good message, naming the account the party already holds), a uniqueness check at commit in the
  reference repository, and `UNIQUE (subject_id)` in the migration. The last two exist because the
  first is a race: two callers both read "no account for this party" before either writes.
- **The K-01 dependency is a port, and the foreign key was refused deliberately.** `SubjectLookup`
  is one method — `exists(subjectId)` — which `IdentityService` satisfies structurally, with no
  adapter and no translation layer. A cross-schema foreign key would have made the two components
  one object: `kernel_identity` could not be migrated, rolled back or moved without
  `kernel_accounts`' permission, and K-01's rollback uses `RESTRICT` precisely so it fails loudly
  rather than taking something else with it. It would also put the refusal in the wrong layer — the
  useful one is "this subject does not exist", raised before the account transaction opens, naming
  the subject, rather than SQLSTATE 23503 arriving after the write.
- **What that costs is stated, not glossed.** There is **no database-level guarantee** that
  `subject_id` names a real subject. A row inserted around this component can name anything the
  opacity rules accept. The cost is small today because K-01 subjects are write-once — nothing
  deletes one, so a link checked at creation stays valid — and it would grow if K-01 ever acquired
  deletion. That is the moment to revisit it, and CONTRACT.md §5 says so.
- **One consequence, converted into a guarded duplication.**
  `kernel_accounts.is_opaque_identifier` is a character-for-character copy of
  `kernel_identity.is_opaque_identifier`, because a `CHECK` calling the other schema's function
  would be exactly the coupling refused above. Unavoidable, so guarded: a test extracts both bodies
  and fails if they differ by a character.
- **Convergence is deliberately asymmetric.** An identical retry converges on the winner. A
  *different* account id for the same party does not — that is a caller error, not a retry, and
  converging would hand back an account the caller never asked for while leaving it believing its
  own id was in use.
- **Every lesson from the previous four components was applied at the start.** The seal clones and
  freezes (K-09 shipped shallow, §11.20). The in-memory repository checks conflicts at commit
  against the current store (K-08 shipped without that parity, §11.15). The decoder runs the same
  validator the service does (K-01 needed a correction to reach that, §11.22).

**Each guarantee was planted and the tests observed to fail:**

```text
the unknown-subject check removed                          7 of 74 failed
the one-account-per-subject check removed from the service 1 of 74 failed
the commit-time subject uniqueness check removed           3 of 74 failed
the foreign-concern check removed                          3 of 74 failed
the seal made shallow ({ ...account } only)                8 of 74 failed
the decoder stops calling the shared validator             3 of 74 failed
UNIQUE (subject_id) removed from the migration             1 of 25 failed
origin_not_ai removed from the migration                   1 of 25 failed
K-03's opacity rules drifted from K-01's                    1 of 25 failed
a cross-schema FOREIGN KEY into kernel_identity            1 of 25 failed
                                              …and npm run check:migrations reported a P0
```

Three of these are worth separating out.

The **cross-schema foreign key** is caught twice — by the new test and, independently, by the
existing `cross-owner-schema` check in `npm run check:migrations`, which reports it as a P0. The
FND-002a migration contract was written before any of these components existed and it caught this
without being told about K-03. That is what a boundary check is for.

The **one-account-per-subject plant against the service** fails only one test, and correctly so: the
port's own check still refuses the second account, so the invariant holds. What breaks is the
*message* — the caller is no longer told which account the party already has. Defence in depth
working as intended, with the loss being quality of refusal rather than correctness.

The **opacity drift** plant removes one clause from K-03's copy of the rule set. Nothing about
account behaviour changes; the identical-bodies test is the only thing that notices, which is the
whole reason it exists.

**Deliberately not delivered**, recorded in CONTRACT.md §7 rather than implied:

- **No unit opens an account.** The registration path this makes possible — a K-01 subject and a
  K-03 account created in one transaction through both enlisted paths — is undelivered.
- No authentication (K-02), no permissions (K-04): nothing verifies the `origin` and nothing decides
  who may open an account.
- No profile core. Name, email, phone and preferences have no home, which is precisely what lets
  this table say it holds no personal data.
- No capability or verification model. No events (K-08). No audit trail (K-09) — opening an account
  is exactly the sort of action K-09 was built to record, and nothing is recorded.
- No closure, relink, merge or erasure. No listing or search.

```text
STATUS AFTER THIS TASK:
                    K-03 contract         COMPLETE (kernel/accounts/CONTRACT.md)
                    K-03 implementation   IN PROGRESS - core only
                    Checklist K-03 row (§B) moves to IN PROGRESS - not complete: no live
                          PostgreSQL, no caller, no authentication, no permissions, no profile,
                          no capability model, no events, no audit integration.
                    Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 691, pass 691, fail 0
                                                                (617 before; +74)
                    npm run check:migrations           exit 0   14 files, 0 violations
                    npm run check:fixtures             exit 0   2 files, 2 datasets, 0 violations
                    node --test tests/accounts.test.ts exit 0   tests 24, pass 24
                    node --test tests/accounts-repository.test.ts
                                                       exit 0   tests 25, pass 25
                    node --test tests/accounts-concurrency.test.ts
                                                       exit 0   tests 25, pass 25
                    npm run test:integration           exit 0   tests 32, pass 0, SKIPPED 32
                    npm audit --audit-level=high       exit 0   found 0 vulnerabilities
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: No PostgreSQL runtime is available here, so migration 0007 has never been
                    applied. In particular **`UNIQUE (subject_id)` has never refused an insert** —
                    the constraint the component's central invariant rests on under concurrency,
                    and the one a reference implementation can only model. Nor has the write-once
                    trigger refused a relink, nor any `CHECK` refused a natural key.
                    `tests/integration/accounts.integration.ts` makes exactly these checks, plus a
                    live one-account-per-party race and a rollback of `kernel_accounts` asserted to
                    leave `kernel_identity` untouched — the benefit the refused foreign key was
                    traded for, and the only place it is observable. All 32 live tests skip with
                    their reason stated. K-03 also has no caller, so the K-01 dependency is
                    exercised by tests rather than by the platform.
```

---

### 11.24 Correction — FND-004b convergence under whichever constraint PostgreSQL picks

§11.23 recorded that K-03 converges on identical concurrent retries. Against the reference
repository it did. Against PostgreSQL it would have converged *sometimes*, and which times was the
server's choice rather than the component's.

**The defect.** An identical concurrent opening violates all three uniqueness constraints at once —
same account id, same subject, same idempotency key. PostgreSQL reports whichever unique index it
checked first, and nothing in K-03 can predict or pin that. The convergence path listed only
`duplicate-account-id` and `idempotency-key-reuse`, deliberately excluding
`subject-already-has-account` on the reasoning that a second account for one party is a caller error
rather than a retry. That reasoning is true of the *situation* and false as a way to *recognise* it:
a genuine retry that the server happened to report through the subject index was refused.

**Why nothing caught it.** The in-memory repository checks its three uniqueness rules in a fixed
order and always reported the account id first. Every concurrency test therefore exercised one
branch of three and passed. That is the shape of an in-memory/PostgreSQL parity gap the repository
has now seen twice: the reference implementation is deterministic exactly where the real one is not,
so a suite built only on the reference never reaches the other paths. K-08's version of this was
§11.15; this one is subtler, because the reference implementation was not *wrong* — it was merely
more predictable than the thing it stands in for.

**The fix.** All three normalized uniqueness conflicts now enter the convergence path, and
convergence is decided by **content**: re-read by idempotency key, and return the winner only when
the complete logical account matches — account id, subject, instant and origin. Anything else
re-raises the **original** refusal rather than a synthesised one, so a caller opening a genuinely
different account for a party that already has one still hears `subject-already-has-account`, which
is what happened, instead of a complaint about an idempotency key it never reused. Which constraint
fired is not evidence of anything; the content is.

`assertSameAccount` was split into a non-throwing `differencesFrom` plus the throwing wrapper the
sequential path still uses, so both paths compare the same four fields with one implementation.

**New tests.** `tests/accounts-convergence.test.ts` (8) drives the **real adapter and real service**
against a stateful fake that reproduces the losing side of a race — read before the winner commits,
insert, be refused on a chosen index, re-read and find the winner — once for each of the three
constraints. The same matrix is then run for every way an opening can fail to match, and again
against the port directly so the guarantee does not depend on the PostgreSQL adapter existing.

```text
subject conflict excluded from convergence (the original defect)  3 of 8 failed
converge on any conflict without checking content                5 of 33 failed
mismatch re-raises a synthesised key error, not the original     2 of 8 failed
```

**Also corrected: stale K-01 commentary.** `kernel/identity/index.ts` still said "K-03 will be its
first consumer" — a future that FND-004b had already made past, in the first thing a consumer of
K-01 reads. It now records K-03 as implemented and consuming K-01 through the `SubjectLookup` port,
while keeping the two things that really are still missing: nothing *writes* a subject, and
transactional registration (subject and account in one transaction through both enlisted paths) is
undelivered. Three assertions in `tests/kernel-overview.test.ts` fail on the obsolete sentence, on
dropping the deferred half, and on either component claiming its enlisted path has a user.

```text
STATUS AFTER THIS TASK:
                    K-03 implementation stays IN PROGRESS. Nothing moved to COMPLETE.

TEST RESULTS:       npm run verify                     exit 0   tests 702, pass 702, fail 0
                                                                (691 before; +11)
                    npm run check:migrations           exit 0   14 files, 0 violations
                    node --test tests/accounts.test.ts exit 0   tests 24, pass 24
                    node --test tests/accounts-repository.test.ts
                                                       exit 0   tests 25, pass 25
                    node --test tests/accounts-concurrency.test.ts
                                                       exit 0   tests 25, pass 25
                    node --test tests/accounts-convergence.test.ts
                                                       exit 0   tests 8, pass 8
                    node --test tests/kernel-overview.test.ts   exit 0   tests 10, pass 10
                    node --test tests/status-docs.test.ts       exit 0   tests 10, pass 10
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                   exit 0

STILL NOT VERIFIED: The fix is proved against a fake that *simulates* each constraint being
                    selected, not against a server that selects one. Which index PostgreSQL
                    actually reports for a given collision is still unobserved here — and it does
                    not need to be, because the component no longer depends on the answer. That is
                    the point of the fix: the behaviour is now independent of the thing that cannot
                    be verified. Everything else in §11.23's "still not verified" is unchanged.
```

---

### 11.25 Evidence — FND-004c (K-02 Authentication foundation)

**Task:** FND-004c — K-02 Authentication foundation.
**Selected in:** §8, as the next dependency-ordered slice of build step B-2.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-02 contract row moves to
`COMPLETE`; the K-02 implementation row moves to `IN PROGRESS`.

**What K-02 is, in one sentence:** the component that answers *is the party making this request the
K-01 subject it claims to be, and how strongly do we know that* — by **asking an injected verifier
and checking its answer**, never by believing a caller.

**Delivered:**

| Area | What landed |
|---|---|
| Records | Append-only **bindings** (a K-01 subject ↔ an opaque `(provider, providerReference)` pair, carrying no secret) and append-only **evidence** (one successful authentication: verifier, factor categories, assurance, when). **Sessions** are the only record with a lifecycle, and it is two operations wide: rotate the secret, or revoke |
| Trust boundary | A `Verifier` port. K-02 hands opaque `proof` over untouched and never stores, logs or echoes it; a verifier that throws is normalised to `invalid-assertion` without its message being read. Provider, reference and expiry on the answer are checked against what was asked, by this platform's clock |
| Caller cannot decide | `authenticated`, `verified`, `factors`, `assurance`, `assertion`, `skipVerification` and eleven more are refused **by name** (`caller-asserted-authentication`), as are raw credentials and any attempt to choose a session secret |
| Replay | `UNIQUE (provider, assertion_id)`: an assertion authenticates exactly once, enforced by a constraint rather than a read, because two replays can both pass a read |
| Factors and MFA | Factor **categories** (`knowledge`, `possession`, `inherence`) counted as a set, ordered assurance, and a per-provider MFA floor that may be **raised and never lowered** — refused at registry construction, not at authentication time |
| Session secrets | 32 bytes of injected entropy, shape-checked; presented **once** through a `SessionToken` whose `reveal()` throws on a second call and whose `toString`/`toJSON`/inspector all redact; stored only as a SHA-256, with the `CHECK` to match |
| Expiry | Absolute and idle. Rotation moves the idle expiry only — there is no field for the absolute one in the port, and the database trigger refuses to move it |
| Races | Rotation and revocation are guarded updates carrying the state they expect. The reference repository preflights every queued guard against a copy of current state and refuses the **whole transaction** with `stale-session-state` if one loses; PostgreSQL carries the same guard in the `WHERE` clause |
| Idempotency | An exact-idempotency retry converges on the original session and receives a **spent** token. Convergence requires a complete match — every non-secret request field, the provider reference read from the binding, the three records naming each other, the duplicated assurance and canonical factor set, and the issuance chronology — and anything short of it preserves the original refusal |
| Persistence | Migration 0008 (`kernel_authentication`): three tables, opacity `CHECK`s calling one SQL rule set, write-once triggers on bindings and evidence, and a session trigger permitting exactly two changes. In-memory reference repository, PostgreSQL adapter, and an enlisted repository refusing transaction control (`nested-transaction`) |
| Contract | [`kernel/authentication/CONTRACT.md`](../kernel/authentication/CONTRACT.md) — ten sections including the verifier trust boundary, the threat assumptions stated **as assumptions**, and the full deferred list |

**Commands and results** (all run in this working tree, exit codes recorded):

```text
ITEM ID:            K-02 (FND-004c)
MODULE / PHASE:     K-02 Authentication / Phase 0, build step B-2
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/authentication/{types,ports,registry,tokens,immutable,validate,
                    repository,postgres-repository,service,index}.ts, CONTRACT.md, and
                    db/migrations/0008_create_kernel_authentication_schema.{up,down}.sql

COMMANDS:           npm run verify                              exit 0   tests 819, pass 819
                    node --test tests/authentication.test.ts    exit 0   tests 27, pass 27
                    node --test tests/authentication-sessions.test.ts
                                                                exit 0   tests 26, pass 26
                    node --test tests/authentication-repository.test.ts
                                                                exit 0   tests 28, pass 28
                    node --test tests/authentication-concurrency.test.ts
                                                                exit 0   tests 8, pass 8
                    node --test tests/authentication-convergence.test.ts
                                                                exit 0   tests 18, pass 18
                    node --test tests/kernel-overview.test.ts   exit 0   tests 10, pass 10
                    npm run test:integration                    exit 0   tests 41, skipped 41
                    node docs/tools/validate-doc-links.mjs      exit 0   0 broken
                    git diff --check                            exit 0

PLANTED REGRESSIONS: Each guard was proved to bite by reverting it and re-running the suite,
                    then restoring it: the commit-time guard preflight (5 of 8 concurrency
                    cases fail without it), the post-conflict recovery (2 convergence cases),
                    the complete comparison including the provider reference read from the
                    binding (5 cases), and the assurance/factor/chronology comparison (3 cases,
                    one of them a deliberately planted privilege escalation whose two rows are
                    each individually well formed).

UI/UX:              N/A — no user-facing surface exists in this repository.

SECURITY:           No secret is ever a SQL parameter — every parameter of every statement the
                    adapter issues is inspected by tests/authentication-repository.test.ts and
                    any value shaped like a secret rather than a hash fails the suite. No
                    credential, proof or session secret is stored, logged or echoed in a refusal.

STILL NOT VERIFIED: **No verifier ships**, so nothing here can authenticate a real person: no
                    password checking, no OAuth or OIDC, no passkey or WebAuthn, no TOTP, no
                    email or SMS delivery. No API, no UI, no cookie or CSRF handling, no rate
                    limiting or lockout. No permissions (K-04), no audit record (K-09) and no
                    event (K-08) for any sign-in, rotation or revocation. No registration path
                    creates a subject or an account. No recovery flow. No unit consumes a
                    session, and the enlisted path has no caller. **Nothing has been applied to
                    a live PostgreSQL server:** migration 0008, every CHECK, both write-once
                    triggers and the session-rewrite guard are declared and unproven, and the
                    opt-in suite that would prove them (tests/integration/authentication.
                    integration.ts, 9 cases) skips with its reason stated.
```

---

### 11.26 Evidence — FND-004d (K-04 Permissions foundation)

**Task:** FND-004d — K-04 Permissions foundation.
**Selected in:** §8, as the last unbuilt component of the kernel's internal chain.
**Corrected three times after review:** §11.27 (idempotency as a bearer token), §11.28 (unauthenticated,
self-asserted authority administration) and §11.29 (an unauthenticated read surface, and a migration
corrupted by its own edit). This block records the delivery; the surface, the migration and the
verification aggregate it quotes were all superseded by those three, and §11.29 carries the final
numbers.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-04 contract row moves to
`COMPLETE`; the K-04 implementation row moves to `IN PROGRESS`.

**What K-04 is, in one sentence:** the component that answers *may this authenticated subject take
this action on this resource, in this account, right now* — by evaluating grants it stored itself
against a policy version it published, and **never by asking the caller**.

**Delivered:**

| Area | What landed |
|---|---|
| Trust model | Three injected ports: a **provider-neutral** `SessionValidator` (K-02's `AuthenticationService.validate` satisfies it structurally), an `AccountLookup` (K-03's `findAccountForSubject`), and a `Clock`. What a port asserts is **re-checked**: a revoked session, one past either expiry, or one carrying an unrecognised assurance is refused. `NO_SESSIONS` and `NO_ACCOUNTS` fail closed |
| Caller cannot decide | `allowed`, `effect`, `decision`, `subjectId`, `role`, `roles`, `permissions`, `grants`, `purposeSatisfied`, `isStaff`, `bypass`, `superAdmin`, `override`, `aiAuthority` and `policyVersionId` are refused **by name** (`caller-asserted-authorization`), before the session is even validated |
| Deny by default | The answer is `deny` before anything is examined; only an explicit, in-force, policy-permitted grant moves it |
| Deny precedence | Any applicable deny wins over any allow, whatever the specificity and whatever the write order. No scoring, no most-recent-wins |
| Least privilege | A grant with a `resourceId` covers one resource; without, the type **inside one account**. There is no grant shape covering every account |
| Roles | The v1.0 guide §52 vocabulary, in order, with **no role-to-authority mapping in the code**: what a role may do is a published, numbered policy version. `SUPER_ADMIN` confers nothing and has no code path |
| Staff purpose | v3 §5.3's role-based, purpose-based, audited access: a closed purpose vocabulary, mandatory for the seven staff roles, refused for the others, enforced in the service, the validator and a database `CHECK` |
| ABAC | Six typed predicate kinds over an **allowlisted** context. A predicate over an undeclared attribute is refused at write time, because it would otherwise never match and the grant would silently never apply. Context values pass the K-01 identifier rules, so an email cannot be a region |
| Temporal validity | `notBefore` / `expiresAt` honoured against the injected clock, plus append-only revocation with one revocation per grant |
| Decision records | Effect, machine-readable reason, deterministic explanation, deciding grant, policy version, session and purpose. An `allow` always names a grant — the database refuses one that does not |
| AI authority | Three separate checks: AI may not author policy, a grant or a revocation; may never hold `grant-permission`, `approve`, `impersonate`, `delete`, `export`, or anything on `permission`, `ledger-entry` or `payment`; and may hold **only** `invoke-tool` on `tool`. Enforced in the shared validator (so a stored row cannot walk past it) and by two database constraints |
| Idempotency | An identical retry converges; a key reused for a *different* question is refused, which is the confused-deputy shape |
| Persistence | Migration 0009 (`kernel_permissions`): four tables, opacity `CHECK`s calling one SQL rule set, and **four append-only triggers** refusing every `UPDATE` and `DELETE`. In-memory reference repository checking uniqueness at commit, PostgreSQL adapter, and an enlisted repository refusing transaction control |
| Contract | [`kernel/permissions/CONTRACT.md`](../kernel/permissions/CONTRACT.md) — ten sections including the trust model stated as assumptions, decision-record semantics, and the full deferred list |

**Commands and results** (all run in this working tree, exit codes recorded):

```text
ITEM ID:            K-04 (FND-004d)
MODULE / PHASE:     K-04 Permissions / Phase 0, build step B-2
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/permissions/{types,registry,ports,immutable,validate,decide,
                    repository,postgres-repository,service,index}.ts, CONTRACT.md, and
                    db/migrations/0009_create_kernel_permissions_schema.{up,down}.sql

COMMANDS:           npm run verify                                exit 0   tests 901, pass 901
                    node --test tests/permissions.test.ts         exit 0   tests 18, pass 18
                    node --test tests/permissions-decisions.test.ts
                                                                  exit 0   tests 21, pass 21
                    node --test tests/permissions-concurrency.test.ts
                                                                  exit 0   tests 12, pass 12
                    node --test tests/permissions-repository.test.ts
                                                                  exit 0   tests 18, pass 18
                    npm run check:migrations                      exit 0   18 files, 0 violations
                    npm run check:boundaries                      exit 0   81 files, 278 imports
                    npm run test:integration                      exit 0   tests 47, skipped 47
                    node docs/tools/validate-doc-links.mjs        exit 0   0 broken
                    npm audit --audit-level=high                  exit 0   0 vulnerabilities
                    git diff --check                              exit 0

ADVERSARIAL COVER:  Permission-escalation attempts (a caller supplying its own subject, role,
                    permissions, effect or policy version — nineteen field names, each refused
                    before the session is validated); forged authentication context (a validator
                    asserting a revoked, expired or unknown-assurance session, each refused);
                    cross-account reads (a request naming another account, refused before any
                    grant is read; a grant in another account invisible to this one); concurrent
                    grant/revoke races (two identical grants produce one grant; two revocations
                    produce one revocation and one stale-revocation); stale decisions (a retry
                    returns the decision that was taken, not a re-decision, and a key reused for
                    a different question is refused); and malformed state (a grant row with an
                    unreadable effect authorises nothing).

PLANTED REGRESSION: The shared AI rule was found by test rather than by review: validateGrant did
                    not apply it, so an AI grant row written around the service decoded cleanly.
                    The rule moved into registry.ts, where the validator and the service both call
                    it, and the decode case now fails without it.

UI/UX:              N/A — no user-facing surface exists in this repository.

SECURITY:           No credential, session secret or proof material is stored, logged or echoed.
                    The presented token is handed to the session port unread; a validator's
                    refusal is normalised without its message being inspected, because a session
                    error can carry a fragment of the secret.

STILL NOT VERIFIED: **Nothing calls K-04**, so no path in this repository is actually guarded and
                    every decision so far is about a subject a test created. K-02 ships no
                    verifier, so no real session has ever reached it. No API, no UI, no policy
                    studio, no operational role matrix (v3 §47 Level 4), no business-module action
                    registration, no delegation, no groups, no role hierarchy, no retention of
                    decision records. No audit record (K-09) and no event (K-08) follows a grant,
                    a revocation or a decision — the two integrations v3 §53 most obviously wants.
                    **Nothing has been applied to a live PostgreSQL server:** migration 0009,
                    every CHECK, all four append-only triggers and every constraint are declared
                    and unproven, and the opt-in suite that would prove them
                    (tests/integration/permissions.integration.ts, 6 cases) skips with its reason
                    stated.
```

---

### 11.27 Correction — FND-004d idempotency was a bearer token for somebody else's answer

**Task:** FND-004d, corrected after review.
**Severity:** the highest of any correction recorded here. The other blocks in this register are
about records that could be rewritten, races that could be lost, or claims that were unproven. This
one is about **an authorisation obtainable without authenticating**.

**What was wrong.** `authorize` treated the idempotency key as though it identified the request. It
does not; it identifies the *caller's intent to retry*, and on its own it is a bearer token for
whatever answer was stored under it. Two defects followed, and they compounded:

| # | Defect | Why it mattered |
|---|---|---|
| 1 | **The stored decision was looked up before the presented session was validated.** | Presenting somebody else's idempotency key with any garbage token — or no working session at all — returned their decision. If it was an `allow`, the caller had just been authorised without authenticating. Every other control in the component ran *after* this point and so never ran at all. |
| 2 | **The retry comparison covered six of the nine facts the decision depended on.** It compared `decisionId`, `accountId`, `action`, `resourceType`, `resourceId` and `purpose`. It did not compare the **subject**, the **session**, or the **ABAC context**. | A caller with a valid session of its own could present a captured key and change the context — the thing an ABAC condition is evaluated against. A grant conditioned on `region = north`, satisfied once, was replayable from anywhere. Nothing recorded what context had satisfied it, so nothing could have caught this. |

Neither was reachable by a caller in this repository, because nothing calls K-04. That is luck, not
mitigation, and it is exactly the window in which a defect of this shape should be fixed.

**What changed.**

1. **The session is resolved before anything is read from storage.** `authorize` now validates the
   presented secret through K-02's port, re-checks the assertion itself, resolves the account
   through K-03 and refuses cross-account access — *then* looks up the idempotency key. A retry
   with a bad session is `invalid-session`; one aimed at another party's account is
   `cross-account-access`; neither reaches storage.
2. **Every decision stores a fingerprint of its own inputs.** `kernel/permissions/fingerprint.ts`
   canonicalises decision id, subject, session, account, action, resource type and id, purpose and
   the allowlisted ABAC context, and SHA-256s it. The canonical form quotes every field so a value
   containing a separator cannot impersonate a field boundary, and sorts context keys so key order
   is not part of the question. Migration 0009 gains `request_fingerprint text NOT NULL` with a
   `CHECK` that it is a SHA-256; the validator refuses any decision record without one.
3. **A stored decision is returned only on an exact fingerprint match**, on the pre-insert retry
   path *and* on the post-conflict convergence path — a convergence that checked less than a retry
   checks would be the same hole reached by another route. A mismatch is `idempotency-key-reuse`
   naming the input that moved: the authenticated subject, the session, or the ABAC context.
4. **Author origin joined the equality checks** for policy versions, grants and revocations
   (`publishedBy`, `grantedBy`, `revokedBy`). A retry under one key that changes who authorised the
   change is a different authority statement. The service-generated instants (`publishedAt`,
   `grantedAt`, `revokedAt`) stay excluded — including them would make every retry a mismatch and
   idempotency impossible.

**A consequence worth stating:** idempotency keys are now **scoped to the session that earned the
answer**. The same person on a rotated session is asking a new question and gets a new decision.
That is a deliberate tightening, recorded in CONTRACT.md §8 rather than left for somebody to
discover.

**Migration 0009 was edited rather than superseded.** It has never been applied to any database —
no PostgreSQL runtime exists in this repository — and it belongs to the same undelivered slice, so
there is no ledger row whose checksum could drift and no environment holding the old shape. The
immutability rule protects *applied* migrations; adding a 0010 to correct a migration nobody has
ever run would leave a permanent record of an intra-branch iteration and nothing else.

```text
ITEM ID:            K-04 (FND-004d, correction)
MODULE / PHASE:     K-04 Permissions / Phase 0, build step B-2
STATUS:             CORRECTED — implementation stays IN PROGRESS

COMMANDS:           npm run verify                                  exit 0   tests 901, pass 901
                    node --test tests/permissions.test.ts           exit 0   tests 18, pass 18
                    node --test tests/permissions-decisions.test.ts exit 0   tests 21, pass 21
                    node --test tests/permissions-concurrency.test.ts
                                                                    exit 0   tests 12, pass 12
                    node --test tests/permissions-repository.test.ts
                                                                    exit 0   tests 18, pass 18
                    node --test tests/permissions-idempotency.test.ts
                                                                    exit 0   tests 13, pass 13
                    npm run check:migrations                        exit 0   18 files, 0 violations
                    npm run test:integration                        exit 0   tests 47, skipped 47

PLANTED REGRESSION: The old ordering was restored — the idempotency lookup moved back above the
                    session validation — and tests/permissions-idempotency.test.ts observed to
                    fail 5 of its 13 cases: the stolen key with no session, the stolen key from
                    another session, the stolen key aimed at the owner's account, the retry from a
                    rotated session, and the retry with a changed ABAC context. The ordering was
                    then restored and all 13 pass.

STILL NOT VERIFIED: The fingerprint is proved against the reference repository and against the
                    adapter's decode path, not against a server: `request_fingerprint` and its
                    CHECK have never been created, and the live probe that would exercise them
                    skips with its reason stated. Everything in §11.26's "still not verified" is
                    unchanged — nothing calls K-04, K-02 ships no verifier, and no audit record or
                    event follows a decision.
```

---

### 11.28 Correction — FND-004d authority administration was unauthenticated and self-asserted

**Task:** FND-004d, corrected after review.
**Severity:** equal to §11.27, and arguably worse in reach. §11.27 was a way to obtain one stored
answer. This was a way to **write the rules that produce every future answer**.

**What was wrong.** `publishPolicy`, `grant` and `revoke` took no session, resolved no account, and
accepted the author of the change as a field in the request:

```ts
service.grant({ ..., grantedBy: { kind: 'human', id: 'ops-alice-console' } })
```

Three defects in one signature:

| # | Defect | Why it mattered |
|---|---|---|
| 1 | **No authentication.** No session was presented, so nothing established who was administering. | Anybody who could reach the service could grant themselves anything. Every guarantee in the contract — deny by default, deny precedence, least privilege, purpose limitation — sat downstream of a table the caller could write. |
| 2 | **Authorship was caller-supplied.** `publishedBy`, `grantedBy` and `revokedBy` were request fields. | The audit trail named whoever the caller typed. A grant could be signed in the name of a person who had no idea, which is worse than an unsigned one: it is evidence pointing at the wrong party. |
| 3 | **No authorisation.** Even a caller who *was* somebody held no requirement to be permitted to administer. | Authentication is not authorisation. K-04's entire subject matter is that distinction, and its own administration did not observe it. |

**What changed.**

1. **Every administration operation authenticates.** `publishPolicy`, `grant` and `revoke` present a
   session secret to the same injected K-02 port `authorize` uses, and the assertion is re-checked
   here: revoked, past absolute expiry, past idle expiry, or an unrecognised assurance are all
   `invalid-session`. The presented secret is never echoed into an error.
2. **The account is resolved through K-03**, so an administrator with no account administers nothing
   (`unknown-account`) and administration is scoped to the account the session's subject holds.
3. **Authorship is derived, never declared.** `publishedBy` / `grantedBy` / `revokedBy` are computed
   as `{ kind: 'human', id: <the session's subject> }`. Supplying any of them — or `actor`, or
   `bootstrap` — is `caller-asserted-authorization`, refused by name alongside the nineteen
   decision-asserting fields already refused.
4. **Administration requires an explicit grant, like everything else here.** The administrator must
   hold `grant-permission` on `permission`, evaluated through the same deny-by-default `evaluate()`
   that answers every other question. A refusal is `administration-denied`. There is **no
   super-admin path**: a `SUPER_ADMIN` role grant that is not an administration grant confers no
   administration, and `AI_AGENT` can never hold the capability at all (three independent checks,
   §11.26).

**The bootstrap problem, and the one bypass.** Administering permissions requires permission, and
until a policy exists no role permits anything, so the **first** policy can never be authorised.
Something must break that circle, and every way of breaking it is a bypass. A bypass nobody has
enumerated is the most dangerous thing a security component can contain, so this one is enumerated,
and every property is asserted by test:

| Property | How it is enforced |
|---|---|
| It is **injected, not requested** | A `BootstrapAuthority` is supplied at construction. No request field can ask for one, and `bootstrap: true` in a request is refused by name |
| It **defaults to refusal** | The default port is `NO_BOOTSTRAP`, which refuses. A service constructed without thinking about this cannot bootstrap |
| It **cannot mint authority** | It applies to `publishPolicy` and to nothing else. There is no bootstrap path through `grant` or `revoke`, so it can install rules but can never hand anybody authority under them |
| It applies **only to an empty store** | It is available only when no policy version exists at all, so it can never install a wider policy over a real one. The single exception writes nothing: a *retry* under the same idempotency key of the bootstrap that installed the policy already there, so an operator's install script is re-runnable. A re-bootstrap under a **new** key is `administration-denied` |
| It leaves **permanent evidence** | The row carries `bootstrap: true` with a `system` author in an append-only table, under a `CHECK` that a bootstrap row must have a system author and a partial unique index permitting **at most one** bootstrap row for all time |

**A consequence stated rather than hidden:** because bootstrap cannot mint a grant, the **first
administration grant is written out of band through the repository port** — which is what an
operator with database access would do, and why it is visible in the fixtures
(`installFirstAdministrator`) rather than behind a service method anybody could call.

**Administration idempotency now includes the actor.** `fingerprintAdministrationRequest` covers the
operation, the record id, the authenticated subject, session and account, the bootstrap flag, the
purpose and the content, and the fingerprint is stored on all three administration tables
(`request_fingerprint text NOT NULL` with a SHA-256 `CHECK`). Equality checks compare it first, so a
retry under one key by a **different administrator, from a different session, or claiming a
different bootstrap status** is `administration-denied` rather than a convergence — on the
pre-insert path and on the post-conflict convergence path alike.

```text
ITEM ID:            K-04 (FND-004d, correction 2 of 3)
MODULE / PHASE:     K-04 Permissions / Phase 0, build step B-2
STATUS:             CORRECTED — implementation stays IN PROGRESS

IMPLEMENTED:        kernel/permissions/{service,ports,types,validate,registry,fingerprint}.ts,
                    db/migrations/0009_create_kernel_permissions_schema.up.sql,
                    tests/permissions-administration.test.ts (new, 20 cases),
                    tests/helpers/permission-fixtures.ts

ADVERSARIAL COVER:  Unauthenticated administration (all three operations, each refused without a
                    session, and the presented secret never echoed); expired, idle-expired and
                    revoked administrator sessions; an administrator holding no account; forged
                    authorship in five shapes (another human, a system authority, an agent, a named
                    actor, a requested bootstrap); an authenticated subject holding no
                    administration grant; a SUPER_ADMIN grant that is not an administration grant;
                    an AI author; bootstrap reuse (a second bootstrap under a new key, and a
                    bootstrap attempted over an existing policy); a changed actor on an idempotent
                    retry; and — the other half — authorised identical concurrent mutations, which
                    converge.

STILL NOT VERIFIED: The administration authorisation is **evaluated but not recorded** as a
                    decision record, so who administered what is reconstructable from the
                    append-only rows and their authors, not from K-04's own decision log. Recorded
                    in CONTRACT.md rather than left to be discovered. Nothing has run against a
                    live server: the bootstrap CHECK and the single-bootstrap-row partial unique
                    index have never refused anything.
```

---

### 11.29 Correction — FND-004d the read surface, and a migration corrupted by its own edit

**Task:** FND-004d, corrected after review. Two findings: one a security defect, the other a lesson
about what this repository's gates can and cannot see.

#### The read surface

**What was wrong.** Alongside its four write operations the service exposed three reads:

```ts
findGrant(grantId)  /  findDecision(decisionId)  /  activePolicy()
```

Each took an identifier and **nothing else**: no session, no account, no scope, no authorisation, no
record. Possession of an id was sufficient — and an idempotency key, which a client keeps in a retry
buffer and a proxy may log, is an id. What came back was authority data: whose grant it was, who
granted it, under what condition, what somebody else had been allowed to do and why. That is the
same shape of hole as §11.28's unauthenticated write, one direction over, and cross-party visibility
of who may do what is not a lesser exposure than cross-party visibility of money.

**What changed.** The three methods are **deleted**, and nothing replaced them:

- The service's public surface is now exactly `publishPolicy`, `grant`, `revoke`, `authorize` and its
  constructor — four operations and **no reads**.
- No guarded read API was added in their place. A read API this component does not need is one
  nobody has to keep safe, and half of an authorised read — a validated session, a matching account,
  an explicit scope, a deny-by-default authorisation and a decision record of its own — would be
  worse than none.
- Setup and inspection moved to the **repository port**, which is persistence and a test seam rather
  than a caller-facing API. Two fixtures (`storedActivePolicy`, `storedGrant`) go through
  `withTransaction`, and every unit, helper and integration caller was migrated to them.
- `tests/permissions.test.ts` gained a public-surface regression: the three names are absent from the
  prototype chain and `undefined` at runtime, nothing matching `find|get|read|list|lookup|query|
  fetch|load|show|inspect` has replaced them under another name, and the whole surface is asserted to
  be exactly those five members.

**What this costs, stated plainly:** there is now **no supported way to read authority back at all** —
not for an operator, not for an audit view, not for a policy console. Inspection means database
access, which is an operator's privilege and leaves the database's own trail. CONTRACT.md §9 records
it as a deferred capability, with the five things an authorised read would have to do.

#### Migration 0009 was committed syntactically invalid

**What was wrong.** The file on the branch was **2389 lines** containing **sixteen `COMMIT;`
statements**, four unterminated string literals, and text resuming mid-`CREATE TABLE` after the first
`COMMIT;`. It would have failed on any PostgreSQL server, and the migration runner refused it
outright as a nested transaction — six `tests/migration-runner.test.ts` cases were failing, so
`npm run verify` was **red on the branch** before this session began.

**The cause is worth recording, because it will recur.** The four fingerprint constraints were
written by an automated edit whose replacement string contained the SQL literal `'^[0-9a-f]{64}$'`.
In JavaScript, a dollar-quote sequence inside a `String.prototype.replace` replacement is a
**substitution pattern meaning "everything after the match"** — so each of the four edits dropped the
closing characters and spliced the entire remainder of the file back in at that point, compounding.

**What changed.** The intact prefix — lines 1 to 374, a complete migration carrying the current
`bootstrap` column, all four `request_fingerprint` columns, the bootstrap `CHECK` and the
single-bootstrap-row partial unique index — was kept, the duplicated tail removed, and the four
regexes closed. The file is now **374 lines** with one `BEGIN;` and one `COMMIT;`, ending exactly as
migration 0008 does. Quote, parenthesis and dollar-quote balance were checked programmatically over
the whole file, and no other migration carries the signature.

**Why no 0010.** Migration 0009 has never been applied to any database — no PostgreSQL runtime exists
here — so there is no ledger row whose checksum could drift and no environment holding the broken
shape. The immutability rule protects *applied* migrations; a 0010 correcting a migration nobody has
ever run would record an intra-branch accident and nothing else. The same reasoning is in §11.27.

**The lesson, which is about the gates rather than the file.** `npm run check:migrations` passed over
2389 corrupt lines, because it enforces the FND-002a contract — naming, direction, headers, pairing —
and **does not parse SQL**. No gate in this repository does. Every claim about migration 0009's
`CHECK`s, triggers and constraints therefore rests on reading, and will until a live server runs one.
A gate that cannot fail on a class of defect is not evidence about that class.

```text
ITEM ID:            K-04 (FND-004d, correction 3 of 3)
MODULE / PHASE:     K-04 Permissions / Phase 0, build step B-2
STATUS:             CORRECTED — implementation stays IN PROGRESS

IMPLEMENTED:        kernel/permissions/service.ts (three methods removed), CONTRACT.md §2 and §9,
                    db/migrations/0009_create_kernel_permissions_schema.up.sql (2389 to 374 lines),
                    tests/permissions.test.ts (public-surface regression),
                    tests/helpers/permission-fixtures.ts (repository seams), and the five other
                    K-04 suites migrated off the removed methods

COMMANDS:           npm run verify                                  exit 0   tests 931, pass 931
                    node --test tests/permissions.test.ts           exit 0   tests 19, pass 19
                    node --test tests/permissions-decisions.test.ts exit 0   tests 21, pass 21
                    node --test tests/permissions-administration.test.ts
                                                                    exit 0   tests 20, pass 20
                    node --test tests/permissions-repository.test.ts
                                                                    exit 0   tests 18, pass 18
                    node --test tests/permissions-idempotency.test.ts
                                                                    exit 0   tests 14, pass 14
                    node --test tests/permissions-concurrency.test.ts
                                                                    exit 0   tests 12, pass 12
                    npm run check:migrations                        exit 0   18 files, 0 violations
                    npm run check:boundaries                        exit 0   82 files, 284 imports
                    npm run check:fixtures                          exit 0   2 files, 2 datasets
                    npm run test:integration                        exit 0   tests 47, skipped 47
                    node docs/tools/validate-doc-links.mjs          exit 0   0 broken
                    npm audit --audit-level=high                    exit 0   0 vulnerabilities
                    git diff --check                                exit 0

PLANTED REGRESSION: `activePolicy` was reinstated on the service and the public-surface regression
                    observed to fail (18 of 19 passing in tests/permissions.test.ts); it was then
                    removed again and all 19 pass.

STILL NOT VERIFIED: Everything in §11.26's "still not verified" is unchanged — nothing calls K-04,
                    K-02 ships no verifier, no audit record or event follows a decision, and
                    **nothing has been applied to a live PostgreSQL server**. The repaired
                    migration is the sharpest case of that: it is now syntactically valid by
                    inspection and by a balance check, and it has still never been executed. The
                    47 live cases across all components skip with their reason stated, and a
                    skipped run is not evidence.
```

---

### 11.30 Evidence — FND-004e (K-07 Feature Flags foundation)

**Task:** FND-004e — K-07 Feature Flags foundation.
**Selected in:** §8, as the last unstarted component of build step B-2.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-07 contract row moves to
`COMPLETE`; the K-07 implementation row and P0-37 move to `IN PROGRESS`. **Build step B-2 is now
covered** — the first build step boundary this repository has crossed since B-1.

**What K-07 is, in one sentence:** the component that answers *is this deployment currently running
this piece of code, for this subject, right now* — and answers **off** whenever it is not certain.

**What it is not, which is most of the design.** A feature flag is one `if` statement away from
being an authorisation system: the code is identical, the storage is identical, and the only thing
separating "is this feature running" from "may this party do this" is whether somebody can publish a
key called `permissions.admin.enabled`. So the five separations are enforced rather than documented:

| A flag is not | Refused because it belongs to |
|---|---|
| a permission | **K-04**, from an explicit grant against a published policy version |
| an entitlement | the **Capability & Verification** module |
| an experiment | **Analytics** (v3 §48), where a variant is stable, recorded and analysable |
| financial policy | **K-06 / K-10**, where amounts are versioned so a historic transaction keeps the policy applied to it (v3 §35) |
| AI authority | **K-04** plus v3 §38 — never a deployment control |

A flag key matching any of them is refused at publication with the owning component named — in the
service *and* by a database `CHECK` (`is_flag_key`), because the statement that matters is the one
written around the service.

**Delivered:**

| Area | What landed |
|---|---|
| Rollout stages | v3 §36's progression as one model: `off`, `internal-only`, `targeted`, `percentage`, `on`. `killed` is deliberately **not** a state — an emergency stop is an appended event, so stopping a feature is one insert rather than a publication plus an activation |
| Kill switch | Checked **first**, before the active version is read, so it outranks every definition including `on`. Not reversible through this component: restoring a killed feature means a new flag key, because a kill switch somebody can quietly lift is not one. Republishing over it is `flag-terminated` |
| Immutable versions | Numbered per flag key, never edited. Which version is *current* is a separate appended fact, so "what was this flag doing at 14:05" is answerable from rows that still exist |
| Guarded activation | An activation names the version it supersedes. Two operators reacting to one incident cannot both win — the second is `stale-activation`. Enforced in the service, in the reference repository **at commit**, and by two partial unique indexes (the `NULL` case needs its own, because NULLs do not conflict) |
| Temporal bounds | `notBefore` / `notAfter`, both inclusive, against the injected clock. A window containing no instant is refused at publication rather than published as a permanently-off flag that reads as scheduled |
| Hierarchical scopes | `global` → `country` → `category` → `account`. A version declares the levels it may be evaluated at; any other level is off, because a flag written per account and evaluated globally is a full rollout nobody chose |
| Percentage rollout | `sha256(flagKey : rolloutSalt : subjectKey)` over 10 000 buckets. No clock, no randomness, no process state. Monotonic (raising a percentage never removes anybody), exact at the boundaries (0% includes nobody — including bucket zero; 100% includes everybody), and separated per flag so one cohort does not carry every rollout |
| Targeting | Four registered attributes (`country`, `category`, `channel`, `cohort`), four predicate kinds, **no negation** — a negated rollout rule is the shape most likely to be read backwards at three in the morning. A rule over an unregistered attribute is refused at publication, because it would otherwise never match and a flag that never matches looks exactly like a rollout that has not started |
| Fail closed | Unknown flag, retired flag, unsupported scope, missing context, missing subject key, unresolvable deployment stage — all **off**. A flag exists to stop code running, so the uncertain answer must be the stopped one |
| K-05, through its public contract only | One registered key, `platform.deployment.stage`, read **only** when the active version is `internal-only`, through a port shaped like `ConfigurationService.resolve`. No import of K-05 anywhere in the component. An absent, unrecognised, wrongly-typed or refused value is `null`, never "probably internal" |
| Caller states nothing | `enabled`, `disabled`, `on`, `off`, `bucket`, `variant`, `allowed`, `role`, `price` and 20 more refused **by name**. No mutation request carries an author: the identity comes from an injected authority that **defaults to refusing**, so K-04's §11.28 defect is not repeated |
| Explanations | Name the flag, the version and what decided it — and never an attribute **value**, a subject key, a scope id or a configuration value. An explanation is the thing most likely to be logged |
| Idempotency and convergence | Every mutation stores a SHA-256 fingerprint of its inputs. An identical retry converges; a reused key naming a different request is refused, and the refusal names the field that moved. Two overlapping copies of one call converge on the row that landed, compared exactly as a retry is |
| Persistence | Migration 0010 (`kernel_feature_flags`): three tables, opacity and flag-key `CHECK`s calling two SQL rule sets, **three append-only triggers** refusing every `UPDATE` and `DELETE`, and two partial unique indexes. In-memory reference repository checking uniqueness at commit, PostgreSQL adapter whose current-version query is an **anti-join** rather than `ORDER BY activated_at` (two activations can share an instant; a clock is not a history), and an enlisted repository refusing transaction control |
| Contract | [`kernel/feature-flags/CONTRACT.md`](../kernel/feature-flags/CONTRACT.md) — nine sections including the five separations, the trust model stated as assumptions, the precedence order, and the full deferred list |

**One deviation from MODULE_MAP, recorded rather than absorbed.** The map declared K-07 as depending
on **K-03 and K-05**, on the assumption that "selected accounts" meant resolving an account record.
As built it does not: a flag is evaluated at an **opaque scope handle it never resolves**, so K-07
reads no account and imports nothing from K-03. That is strictly less coupling than planned, and
MODULE_MAP §3 and §12 now say so.

**No evaluation table, deliberately.** K-04 records a decision per authorisation because a permission
decision is rare and consequential. A flag is evaluated on every request through every guarded path,
and a row per evaluation would be a write-amplification defect wearing a compliance costume. What
makes an evaluation accountable instead is that it is **pure**: `decide.ts` reads no clock, opens no
connection and generates no randomness, so an incident is *replayed* from the active version, the
lifecycle rows and the request rather than looked up.

```text
ITEM ID:            K-07 (FND-004e)
MODULE / PHASE:     K-07 Feature Flags / Phase 0, build step B-2 — which this completes
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/feature-flags/{types,registry,immutable,validate,rollout,fingerprint,
                    decide,ports,repository,postgres-repository,service,index}.ts, CONTRACT.md,
                    and db/migrations/0010_create_kernel_feature_flags_schema.{up,down}.sql

COMMANDS:           npm run verify                                  exit 0   tests 1029, pass 1029
                    node --test tests/feature-flags.test.ts         exit 0   tests 17, pass 17
                    node --test tests/feature-flags-evaluation.test.ts
                                                                    exit 0   tests 20, pass 20
                    node --test tests/feature-flags-rollout.test.ts exit 0   tests 12, pass 12
                    node --test tests/feature-flags-concurrency.test.ts
                                                                    exit 0   tests 18, pass 18
                    node --test tests/feature-flags-repository.test.ts
                                                                    exit 0   tests 21, pass 21
                    npm run check:migrations                        exit 0   20 files, 0 violations
                    npm run check:boundaries                        exit 0   94 files, 329 imports
                    npm run check:fixtures                          exit 0   2 files, 2 datasets
                    npm run test:integration                        exit 0   tests 48, skipped 48
                    node docs/tools/validate-doc-links.mjs          exit 0   0 broken
                    npm audit --audit-level=high                    exit 0   0 vulnerabilities
                    git diff --check                                exit 0

ADVERSARIAL COVER:  Flag keys naming another component's decision (authority, money, entitlement,
                    experiment, AI autonomy — seven cases, each refused with the owner named);
                    requests asserting the outcome (enabled, bucket, variant, allowed, role,
                    price); administration with no injected authority (all four write operations);
                    malformed definitions that would otherwise "work" (a percentage on an off flag,
                    rules on a fully-on one, a targeted flag with no rules, a window containing no
                    instant, equal window bounds); natural, personal and credential-shaped values in
                    the salt, a rule value, a subject key and a context value; unregistered
                    attributes and scope levels; a kill switch racing a fully-on version and a
                    republication; rollout boundaries at 0% and 100% including bucket zero;
                    stale activations, two first activations, and an activation losing the race
                    **at commit** while held open by a latch; reused idempotency keys across six
                    changed fields; and twelve malformed persisted rows, each refused rather than
                    evaluated.

PLANTED REGRESSION: Two design defects were found by test rather than by review, and both were
                    corrected before delivery. (1) Two *truly concurrent* identical publications —
                    both transactions open at once, neither able to see the other's row — failed at
                    commit instead of converging; a post-conflict recovery path was added to all
                    four write operations, comparing exactly what a retry compares. (2) The terminal
                    check ran before the idempotency lookup, so an honest retry of a kill was
                    refused as "already killed" and the caller would conclude its first attempt had
                    failed; a retry is now answered before a refusal is raised.

UI/UX:              N/A — no user-facing surface exists in this repository.

SECURITY:           No credential, session secret or personal identifier is stored, logged or
                    echoed. The subject key is hashed rather than stored, and is refused before
                    hashing if it looks natural or credential-shaped — "hashed" is not "anonymous"
                    when the input space is small. Explanations name attributes and never values.

STILL NOT VERIFIED: **Nothing evaluates a flag**, so no code path in this repository is actually
                    gated, and every rollout so far is over subjects a test invented. There is no
                    API, no UI, no flag console, no control plane, no propagation or caching (every
                    evaluation reads the store, which is correct and will not be fast enough for a
                    hot path), no per-scope overrides, no flag dependencies and no retention.
                    **Administration is not authenticated**: the injected authority is injected
                    rather than asserted and refuses by default, but it identifies a deployment
                    capability rather than a person, so *who* killed a flag is not recorded — K-02
                    and K-04 wiring is deferred and is a change to one method. **No audit record
                    (K-09) and no event (K-08) follows a publication, an activation or a kill**,
                    which for a control whose entire purpose is to be used during an incident is
                    the most conspicuous absence in the component. **Nothing has been applied to a
                    live PostgreSQL server:** migration 0010, every CHECK, all three append-only
                    triggers, both partial unique indexes and every constraint are declared and
                    unproven, and the opt-in suite that would prove them
                    (tests/integration/feature-flags.integration.ts, 8 cases inside one guarded
                    top-level test) skips with its reason stated. Across the whole repository
                    `npm run test:integration` reports **48 tests, 0 passing, 48 skipped** — the
                    honest shape of a live gate nothing has ever run. A skipped run is not
                    evidence of anything, and none of the live claims above may be read as made.
```

---

### 11.31 Evidence — FND-005b (K-06 Policy Engine foundation)

**Task:** FND-005b — K-06 Policy Engine foundation.
**Selected in:** §8, as the first component of build step B-3 and the mitigation §5 names for R-04.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-06 contract row moves to
`COMPLETE`; the K-06 implementation row moves to `IN PROGRESS`. **Build step B-3 is opened.**

**What K-06 is, in one sentence:** the component that answers *what does business policy say about
this situation, and which version said it* — and returns the version id with every answer, because
that is the only way the promise below can be kept by anybody.

**The requirement this component exists for**, quoted rather than paraphrased:

| Source | Requirement |
|---|---|
| v3 §35 | "Policies must be versioned. **Historic transactions retain the policy version originally applied.**" |
| v3 §24 | "Every transaction stores the exact commission policy version applied at purchase time. **Changing future policy must not rewrite historical economics.**" |
| v3 §20 | Payout logic is "a standalone policy-driven module" that determines, among other things, the **policy version** |
| v3 §38 | "**AI must never be the financial authority.**" Deterministic services for commissions, refunds, settlements, reserves, payouts |
| v3 §50 | Acceptance: "policy version retained" |

Those are promises a *caller* keeps by storing something. So `PolicyDecision.policyVersionId` is not
optional, not nullable and not derivable later — and when an output reads K-05, the configuration
version id is pinned beside it in `configurationVersions`, for the same reason.

**Delivered:**

| Area | What landed |
|---|---|
| Version pinning | Every successful evaluation returns `policyVersionId`, `version` and a deterministic explanation naming the version and the rule. Superseding a version leaves the old one readable and unchanged, so replaying a historic decision reproduces the number it was priced at |
| Explicit lifecycle | **draft → publish → activate → retire**, each a separate append. A draft can never be evaluated; the publish request carries **no rules, no schema and no outputs**, so what goes live is verbatim what was reviewed; publication does not put anything in force; retirement stops new evaluations without erasing the versions historic decisions are pinned to |
| No floating point, anywhere | Rates, thresholds and amounts are exact `{ units, scale }` decimals compared through `BigInt` and carried as text end to end. `1234.56 * 0.175` is not `216.048` in a double, and a commission computed from an inexact rate is a penny nobody can trace. A `number` where a decimal belongs is refused as **`lossy-numeric-value`** rather than as malformed, because it is not a typo — it is a value that keeps working until it is one a double cannot hold |
| Precedence, ties refused | The matching rule binding the most scope dimensions wins. Two matching rules of equal specificity are **`ambiguous-precedence`** — refused, not resolved by row order. First-match-wins would make a commission depend on a query plan, which is a difference nobody would ever find. Two rules that could never be told apart are refused earlier still, at authoring |
| Fail closed | A fact a matching rule needs but the request omitted is `missing-fact`, never a fall-through to a less specific rule — omitting `sellerTier` must not quietly buy the global rate. No match and no declared defaults is `no-matching-rule`: **there is no implicit zero** |
| Bounded windows | `effectiveFrom` / `effectiveUntil`, both inclusive, against the injected clock, with `evaluate({ at })` for replaying a historic instant. A window containing no instant is refused at publication |
| No executable policy | Six literal predicate shapes. No arithmetic, no regular expressions, no interpolation, no functions — `assertPredicate` refuses a function and a `RegExp` by name. Depth ≤ 4, breadth ≤ 8, rules ≤ 64, because a condition nobody can hold in their head is one nobody can confirm, and what this returns is pinned into a financial record |
| Allowlisted facts | Five, all from v3 §24's list (country, category, sellerTier, seller, amount). **None describes a person** — no name, no address, no payment instrument, no purchase history |
| No AI author | There is no `ai` origin kind in the component **at all** — absent from the type, not refused at the boundary — in the service and by a database `CHECK`. v3 §38 |
| K-05, only where the specification needs it | One `configured` output kind, read through K-05's public `resolve` and only when the version in force declares one. The configuration version is pinned into the decision; a key K-05 cannot resolve **refuses the evaluation** rather than defaulting. No import of K-05 anywhere in the component |
| Caller states nothing | `outputs`, `rate`, `commission`, `ruleId`, `total`, `allowed`, `enabled` and more refused **by name**; on `evaluate` only, so are `policyVersionId`, `version` and `draftId`, because naming the version you want is choosing the economics of your own transaction. No mutation request carries an author: the identity comes from an injected authority that **defaults to refusing** |
| Idempotency and convergence | Every mutation stores a SHA-256 fingerprint of its **validated** content, so a retry differing only in key order or decimal spelling converges while one differing in a rate is refused. Two overlapping copies of one call converge on the row that landed, compared exactly as a retry is |
| Persistence | Migration 0011 (`kernel_policy_engine`): four tables, opacity and policy-key `CHECK`s calling two SQL rule sets, **four append-only triggers**, two partial unique indexes, and **no floating-point column of any type**. In-memory reference repository checking uniqueness at commit, PostgreSQL adapter whose version-in-force query is an **anti-join**, and an enlisted repository refusing transaction control |
| Contract | [`kernel/policy-engine/CONTRACT.md`](../kernel/policy-engine/CONTRACT.md) — nine sections including the ownership boundaries, the trust model, the evaluation order and the full deferred list |

**One boundary worth stating twice: K-06 does not compute money.** It returns `1.7500` and the
version that said so; K-10 Ledger foundation multiplies. `tests/policy-engine.test.ts` scans the
service surface for any method that sounds like it calculates an amount, and
`tests/policy-engine-decimal.test.ts` scans the source for `parseFloat`, `toFixed` and `Math.round`.
A policy engine that did the arithmetic would be a second place money is calculated, and v3 §38
wants exactly one.

```text
ITEM ID:            K-06 (FND-005b)
MODULE / PHASE:     K-06 Policy Engine / Phase 0, build step B-3 — which this opens
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/policy-engine/{types,decimal,registry,immutable,validate,fingerprint,
                    decide,ports,repository,postgres-repository,service,index}.ts, CONTRACT.md,
                    and db/migrations/0011_create_kernel_policy_engine_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1125, pass 1125
                    node --test tests/policy-engine.test.ts           exit 0   tests 13, pass 13
                    node --test tests/policy-engine-evaluation.test.ts
                                                                      exit 0   tests 18, pass 18
                    node --test tests/policy-engine-decimal.test.ts   exit 0   tests 13, pass 13
                    node --test tests/policy-engine-lifecycle.test.ts exit 0   tests 15, pass 15
                    node --test tests/policy-engine-repository.test.ts
                                                                      exit 0   tests 22, pass 22
                    npm run check:migrations                          exit 0   22 files, 0 violations
                    npm run test:integration                          exit 0   tests 49, skipped 49
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

ADVERSARIAL COVER:  Policy keys naming another component's decision (authority, deployment state,
                    credentials — five cases, each refused with the owner named); requests asserting
                    the answer, and requests naming the version they want to be decided by; a
                    service with no injected authority (all four write operations); a rate supplied
                    as a `number`, at a wrong scale, outside its declared range, with a leading
                    zero, in scientific notation, as Infinity and as NaN; an amount threshold
                    probed a ten-thousandth either side of its boundary and at three different
                    scales; two equally specific matching rules; two rules that can never be told
                    apart; a fact a matching rule needs but the request omitted; no match with and
                    without declared defaults; a version outside its window by one microsecond; a
                    window containing no instant, including equal bounds; a policy retired and
                    then written to; stale activations, two first activations, and an activation
                    losing the race **at commit** while held open by a latch; idempotency keys
                    reused across six changed inputs; and fourteen malformed persisted rows, each
                    refused rather than evaluated.

PLANTED REGRESSION: Two design defects were found by test and corrected before delivery. (1) The
                    blanket asserted-outcome table refused `policyVersionId` on every operation,
                    including `publish`, where supplying the id of the record being created is the
                    convention every other component follows; the refusal moved to `evaluate`,
                    where naming a version is choosing your own economics, and is raised *before*
                    the generic unknown-field check so the caller is told what is actually wrong.
                    (2) `reason` was refused the same way, which blocked `retire` from recording
                    why a policy stopped applying.

UI/UX:              N/A — no user-facing surface exists in this repository.

SECURITY:           No credential and no personal identifier is stored, logged or echoed. Seller,
                    category, country and tier handles pass K-01's opacity rules, and an
                    explanation names facts and rules but never a fact value.

STILL NOT VERIFIED: **Nothing evaluates a policy**, so no amount anywhere has been priced by one and
                    **no record has yet pinned a version id** — the guarantee the component exists
                    for is implemented and unexercised. There is no API, no UI, **no policy studio**
                    (M-43 does not exist), no approval workflow — v3 §32's "approval as required" is
                    not modelled, so a draft can be published by whoever can draft it — and no
                    simulation or diff, which is the single most useful thing a studio offers.
                    **Authoring is not authenticated**: the injected authority refuses by default
                    but identifies a deployment capability rather than a person, so *who* changed a
                    commission rate is not recorded; K-02 and K-04 wiring is deferred and is a
                    change to one method. **No audit record (K-09) and no event (K-08) follows a
                    draft, a publication, an activation or a retirement**, which for the component
                    holding the commission rate is the most conspicuous absence in it. **Nothing has
                    been applied to a live PostgreSQL server:** migration 0011, every CHECK, all
                    four append-only triggers, both partial unique indexes and every constraint are
                    declared and unproven, and the opt-in suite that would prove them
                    (tests/integration/policy-engine.integration.ts, 8 cases) skips with its reason
                    stated. **Rolling back 0011 is data loss rather than a reversal** once anything
                    pins a version — the down migration says so in its header.
```

---

### 11.32 Extension — K-05 Configuration transactional outbox

K-05, K-06, K-07 and K-11 now write domain-event and audit-record outbox rows inside the same
transaction that performs a visible lifecycle mutation. This is the first use of the outbox pattern
required by MODULE_MAP.md §10.3 and the foundation for wiring K-08 events and K-09 audit to other
kernel components without letting any module directly touch another's tables.

**What was built**

| File | Holds |
|---|---|
| `platform/outbox/types.ts` | `OutboxEntry`, `OutboxKind`, `OutboxTransaction` — the shared contract every module uses |
| `platform/outbox/repository.ts` | `InMemoryOutboxStore`, the in-memory reference implementation |
| `platform/outbox/builder.ts` | helpers to build event and audit outbox payloads |
| `platform/outbox/relay.ts` | `runOutboxRelay`, which dispatches unprocessed rows to injected `EventService` and `AuditService` |
| `db/migrations/0013_create_kernel_configuration_outbox.{up,down}.sql` | `kernel_configuration.outbox` table, owned by K-05 |
| `db/migrations/0014_create_kernel_policy_engine_outbox.{up,down}.sql` | `kernel_policy_engine.outbox` table, owned by K-06 |
| `db/migrations/0015_create_kernel_feature_flags_outbox.{up,down}.sql` | `kernel_feature_flags.outbox` table, owned by K-07 |
| `db/migrations/0016_create_kernel_commerce_unit_registry_outbox.{up,down}.sql` | `kernel_commerce_unit_registry.outbox` table, owned by K-11 |
| `kernel/configuration/outbox.ts` | `CONFIGURATION_VERSION_PUBLISHED_EVENT` / `ACTION` helpers |
| `kernel/configuration/repository.ts` | `ConfigurationTransaction` extends `OutboxTransaction`; in-memory repository stores outbox rows |
| `kernel/configuration/postgres-repository.ts` | `insertOutbox` writes to `kernel_configuration.outbox` |
| `kernel/configuration/service.ts` | `publishDraft` appends event + audit outbox rows |
| `kernel/policy-engine/outbox.ts` | `POLICY_VERSION_PUBLISHED`, `POLICY_ACTIVATED`, `POLICY_RETIRED` event/audit helpers |
| `kernel/policy-engine/repository.ts` | `PolicyTransaction` extends `OutboxTransaction` |
| `kernel/policy-engine/postgres-repository.ts` | `insertOutbox` writes to `kernel_policy_engine.outbox` |
| `kernel/policy-engine/service.ts` | `publish`, `activate`, `retire` append event + audit rows |
| `kernel/feature-flags/outbox.ts` | `FEATURE_FLAG_VERSION_PUBLISHED`, `FEATURE_FLAG_ACTIVATED`, `FEATURE_FLAG_RETIRED` helpers |
| `kernel/feature-flags/repository.ts` | `FeatureFlagTransaction` extends `OutboxTransaction` |
| `kernel/feature-flags/postgres-repository.ts` | `insertOutbox` writes to `kernel_feature_flags.outbox` |
| `kernel/feature-flags/service.ts` | `publish`, `activate`, `retire` append event + audit rows |
| `kernel/commerce-unit-registry/outbox.ts` | `COMMERCE_UNIT_VERSION_PUBLISHED`, `COMMERCE_UNIT_ACTIVATED`, `COMMERCE_UNIT_RETIRED` helpers |
| `kernel/commerce-unit-registry/repository.ts` | `CommerceUnitRegistryTransaction` extends `OutboxTransaction` |
| `kernel/commerce-unit-registry/postgres-repository.ts` | `insertOutbox` writes to `kernel_commerce_unit_registry.outbox` |
| `kernel/commerce-unit-registry/service.ts` | `publish`, `activate`, `retire` append event + audit rows |
| `tests/*-outbox.test.ts` | 15 new cases across K-05, K-06, K-07 and K-11 |

**Design decisions worth recording**

- **Module-owned outbox tables, not a shared outbox database.** Every producing module owns its own
  `outbox` table in its own schema. The business mutation and the outbox rows share one transaction,
  so a rolled-back publication leaves no event and no audit ghost. The platform relay later reads those
  module-owned rows and dispatches them to K-08 and K-09.
- **The relay is injected, not imported.** `runOutboxRelay` accepts `EventService` and `AuditService`
  as arguments, so `platform/outbox` does not statically depend on any kernel component. That keeps the
  relay usable from any module and keeps K-08/K-09 replaceable.
- **Only visible lifecycle mutations write outbox rows.** Draft creation is invisible by design;
  evaluation/lookup is read-only. Each module emits on publish, activate and retire (where applicable).
- **Fixed schema constants are the only SQL interpolation.** The PostgreSQL adapters use `OUTBOX_TABLE`
  and `OUTBOX_COLUMNS` string constants; the repository contract tests were widened to treat them as
  permitted fixed constants, preserving the invariant that no caller value reaches SQL as text.

```text
ITEM ID:            K-05/K-06/K-07/K-11 transactional outbox extension
MODULE / PHASE:     Phase 0, build steps B-1 and B-3 extension
STATUS:             DELIVERED. All four contracts and implementations stay IN PROGRESS.

IMPLEMENTED:        platform/outbox/{types,repository,builder,relay}.ts,
                    db/migrations/0013_*_configuration_outbox.{up,down}.sql,
                    db/migrations/0014_*_policy_engine_outbox.{up,down}.sql,
                    db/migrations/0015_*_feature_flags_outbox.{up,down}.sql,
                    db/migrations/0016_*_commerce_unit_registry_outbox.{up,down}.sql,
                    kernel/{configuration,policy-engine,feature-flags,commerce-unit-registry}/outbox.ts,
                    kernel/{configuration,policy-engine,feature-flags,commerce-unit-registry}/repository.ts,
                    kernel/{configuration,policy-engine,feature-flags,commerce-unit-registry}/postgres-repository.ts,
                    kernel/{configuration,policy-engine,feature-flags,commerce-unit-registry}/service.ts,
                    kernel/{configuration,policy-engine,feature-flags,commerce-unit-registry}/index.ts,
                    tests/configuration-outbox.test.ts,
                    tests/policy-engine-outbox.test.ts,
                    tests/feature-flags-outbox.test.ts,
                    tests/commerce-unit-registry-outbox.test.ts,
                    modified: tests/*-repository.test.ts (permitted SQL constants)

TESTED:             15 new deterministic unit tests across the four outbox suites; every existing
                    suite still passes; relay behaviour is exercised against in-memory services.

TEST COMMANDS:      npm run verify
                    node --test tests/configuration-outbox.test.ts
                    node --test tests/policy-engine-outbox.test.ts
                    node --test tests/feature-flags-outbox.test.ts
                    node --test tests/commerce-unit-registry-outbox.test.ts
                    npm run check:migrations
                    npm run test:integration

TEST RESULTS:       npm run verify                                    exit 0   tests 1295, pass 1295
                    node --test tests/configuration-outbox.test.ts    exit 0   tests 2, pass 2
                    node --test tests/policy-engine-outbox.test.ts  exit 0   tests 4, pass 4
                    node --test tests/feature-flags-outbox.test.ts    exit 0   tests 4, pass 4
                    node --test tests/commerce-unit-registry-outbox.test.ts
                                                                       exit 0   tests 5, pass 5
                    npm run check:migrations                          exit 0   32 files, 0 violations
                    npm run test:integration                          exit 0   tests 49, skipped 49

SECURITY:           No new secret-bearing columns; payload is JSON, with the same classification
                    rules that apply to events and audit records. Idempotency key and correlation
                    id are non-secret identifiers.

UI/UX:              N/A — no user-facing surface.

MIGRATIONS:         0013–0016 module-owned outbox tables, one forward and one rollback each.
                    Each owned by its module's schema; no cross-schema references.

EVENTS:             K-05 emits `ConfigurationVersionPublished`; K-06 emits `PolicyVersionPublished`,
                    `PolicyActivated`, `PolicyRetired`; K-07 emits `FeatureFlagVersionPublished`,
                    `FeatureFlagActivated`, `FeatureFlagRetired`; K-11 emits
                    `CommerceUnitVersionPublished`, `CommerceUnitActivated`, `CommerceUnitRetired`.
                    No live relay runs yet; the relay contract is tested in-memory.

CONFIG / POLICY:    No business constants introduced.

KNOWN LIMITATIONS:  1. The relay has not run against a live PostgreSQL server; it is proved against
                       the in-memory reference store.
                    2. No module consumes these events yet.
                    3. Draft creation does not emit outbox rows; only visible lifecycle mutations do.

DEFERRED:           Live relay scheduling and consumer wiring.

FOLLOW-UP:          Build a relay scheduler/CLI that polls module outbox tables and dispatches to
                    K-08/K-09 against a real PostgreSQL server.
```

---

### 11.33 Evidence — FND-005c (K-10 Ledger Foundation)

**Task:** FND-005c — K-10 Ledger Foundation.
**Selected in:** §8, as the first component of build step B-3 after K-06 opened it.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-10 contract row moves to
`COMPLETE`; the K-10 implementation row moves to `IN PROGRESS`.

**What K-10 is, in one sentence:** the component that records how much of what moved where — every
amount as an exact integer in minor units, with debits equal to credits and history nobody can edit.

**Delivered:**

| Area | What landed |
|---|---|
| Asset types | A registry of asset classes (`fiat`, `reward`, `digital_asset`, `community`), symbols, precision and valuation source. Asset type ids are lower_snake_case vocabulary, not opaque handles |
| Ledger accounts | Opaque account ids, an owner handle, a single asset type and a `debit`/`credit` normal balance. No floating-point value exists anywhere |
| Balanced transactions | Caller-supplied transaction id, idempotency key and posted instant; entries must balance; unknown accounts, mixed asset types and negative amounts are refused |
| Derived balances | `getBalance` sums every entry for an account; no balance column can disagree |
| Outbox wiring | Every posted transaction appends a K-08 domain event and a K-09 audit record inside the same transaction |
| Persistence | In-memory reference repository and PostgreSQL adapter, migration 0017 with append-only triggers on `asset_type`, `ledger_account`, `ledger_transaction` and `ledger_entry`, a deferred constraint trigger that refuses unbalanced or mixed-asset-type journals at commit, and the `is_opaque_identifier` rule copied character-for-character into the schema |
| Contract | [`kernel/ledger-foundation/CONTRACT.md`](../kernel/ledger-foundation/CONTRACT.md) — ownership, public surface, refusals, persistence, outbox and deferred work |

```text
ITEM ID:            K-10 (FND-005c)
MODULE / PHASE:     K-10 Ledger Foundation / Phase 0, build step B-3
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/ledger-foundation/{types,registry,immutable,validate,repository,
                    postgres-repository,service,outbox,index}.ts, CONTRACT.md, and
                    db/migrations/0017_create_kernel_ledger_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1320, pass 1320
                    node --test tests/ledger-foundation.test.ts       exit 0   tests 15, pass 15
                    node --test tests/ledger-foundation-repository.test.ts
                                                                      exit 0   tests 10, pass 10
                    npm run check:migrations                          exit 0   34 files, 0 violations
                    npm run test:integration                          exit 0   tests 56, skipped 56
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

STILL NOT VERIFIED: **Nothing calls K-10**, so no value has moved and no consumer reads the outbox.
                    There is no API, no UI, no enforced authority (K-02/K-04 deferred), no audit
                    record or event consumer is wired, and nothing has been applied to a live PostgreSQL
                    server — the opt-in live suite (`tests/integration/ledger-foundation.integration.ts`,
                    5 cases) skips with its reason stated. Rolling back 0017 is data loss once any
                    transaction is posted.
```

---

### 11.34 Evidence — FND-005d (K-12 Conversation Foundation)

**Task:** FND-005d — K-12 Conversation Foundation.
**Selected in:** §8, as the next component of build step B-3 after K-10 opened it.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-12 contract row moves to
`COMPLETE`; the K-12 implementation row moves to `IN PROGRESS`.

**What K-12 is, in one sentence:** the component that owns the conversation container, the
participants inside it, and the messages they send — a primitive any business module, AI gateway or
support surface can depend on without inheriting their concerns.

**Delivered:**

| Area | What landed |
|---|---|
| Conversation | Opaque ids, a context (`direct`, `transaction`, `support`, `ai`), an optional title, a canonical creation instant and an idempotency key. Refused fields that belong to K-01, K-02, K-03, K-04, K-10 or business modules |
| Participant | One account in one conversation, with a role (`owner`, `member`, `ai`, `system`) and a joined instant. Duplicate account per conversation is refused |
| Message | One line in a conversation with content, type (`text`, `system`) and sent-at instant. Empty content and unknown conversations or participants are refused |
| Immutability | No UPDATE or DELETE path exists at the service, port, adapter or migration level; migration 0018 adds `BEFORE UPDATE OR DELETE` triggers on `conversation`, `participant` and `message` |
| Determinism | The caller supplies every identifier and instant; K-12 reads no clock and generates no randomness |
| Outbox wiring | `createConversation` and `sendMessage` each append one K-08 event and one K-09 audit record inside the same transaction |
| Persistence | In-memory reference repository and PostgreSQL adapter, migration 0018 with append-only triggers on the three business tables, and the `is_opaque_identifier` rule copied character-for-character into the schema |
| Contract | [`kernel/conversation-foundation/CONTRACT.md`](../kernel/conversation-foundation/CONTRACT.md) — ownership, public surface, refusals, persistence, outbox and deferred work |

```text
ITEM ID:            K-12 (FND-005d)
MODULE / PHASE:     K-12 Conversation Foundation / Phase 0, build step B-3
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/conversation-foundation/{types,registry,immutable,validate,
                    repository,postgres-repository,service,outbox,index}.ts, CONTRACT.md, and
                    db/migrations/0018_create_kernel_conversation_foundation_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1391, pass 1391
                    node --test tests/conversation-foundation.test.ts
                                                                      exit 0   tests 43, pass 43
                    node --test tests/conversation-foundation-repository.test.ts
                                                                      exit 0   tests 28, pass 28
                    npm run check:migrations                          exit 0   36 files, 0 violations
                    npm run test:integration                          exit 0   tests 76, skipped 76
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

STILL NOT VERIFIED: **Nothing calls K-12**, so no conversation, participant or message is created
                    by any unit. There is no API, no UI, no enforced authority (K-02/K-04 deferred),
                    no audit record or event consumer is wired, and nothing has been applied to a
                    live PostgreSQL server — the opt-in live suite
                    (`tests/integration/conversation-foundation.integration.ts`, 3 cases) skips
                    with its reason stated. Rolling back 0018 is data loss once any conversation
                    record is created.
```

---

### 11.35 Evidence — FND-005e (K-13 AI Gateway)

**Task:** FND-005e — K-13 AI Gateway.
**Selected in:** §8, as the next component of build step B-3 after K-10 opened it.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-13 contract row moves to
`COMPLETE`; the K-13 implementation row moves to `IN PROGRESS`.

**What K-13 is, in one sentence:** the single runtime boundary to model providers, owning task
registrations, model bindings, routing, AI runs, AI decisions and their costs, so no business
module embeds a provider SDK or a model secret.

**Delivered:**

| Area | What landed |
|---|---|
| Tasks | Dotted-lowercase task ids, input/output JSON schemas, a capability, a canonical creation instant and an idempotency key. Refused fields that belong to other components |
| Model bindings | Opaque binding ids, provider name, model id, capabilities, cost per 1K tokens in a named asset type, priority, enabled flag and idempotency key. Natural keys and credentials are refused |
| Routing | Lowest-priority enabled binding that matches the task's capability; disabled bindings skipped |
| Execution | Deterministic mock provider that returns stable output and token counts from the input; real cost computed from binding rates and ceiling-bucketed per 1K tokens |
| Decisions | Policy level 0–4, approval status, explanation, optional run reference and idempotency key. A decision may only reference a run that executed the same task |
| Immutability | No UPDATE or DELETE path exists at the service, port, adapter or migration level; migration 0019 adds `BEFORE UPDATE OR DELETE` triggers on `task_definition`, `model_binding`, `ai_run` and `ai_decision` |
| Determinism | The caller supplies every identifier and instant; K-13 reads no clock and generates no randomness |
| Outbox wiring | `executeTask` and `recordDecision` each append one K-08 event and one K-09 audit record inside the same transaction |
| Persistence | In-memory reference repository and PostgreSQL adapter, migration 0019 with append-only triggers on the four business tables, and the `is_opaque_identifier` rule copied character-for-character into the schema |
| Contract | [`kernel/ai-gateway/CONTRACT.md`](../kernel/ai-gateway/CONTRACT.md) — ownership, public surface, refusals, persistence, outbox and deferred work |

```text
ITEM ID:            K-13 (FND-005e)
MODULE / PHASE:     K-13 AI Gateway / Phase 0, build step B-3
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/ai-gateway/{types,registry,immutable,validate,service,
                    repository,postgres-repository,outbox,index}.ts,
                    kernel/ai-gateway/adapters/{ai-provider,mock-ai-provider}.ts,
                    CONTRACT.md, and
                    db/migrations/0019_create_kernel_ai_gateway_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1471, pass 1471
                    node --test tests/ai-gateway.test.ts
                                                                      exit 0   tests 47, pass 47
                    node --test tests/ai-gateway-repository.test.ts
                                                                      exit 0   tests 30, pass 30
                    node --test tests/ai-gateway-mock-provider.test.ts
                                                                      exit 0   tests 3, pass 3
                    npm run check:migrations                          exit 0   38 files, 0 violations
                    npm run test:integration                          exit 0   tests 76, skipped 76
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

STILL NOT VERIFIED: **Nothing calls K-13**, so no task is executed by a real provider adapter and
                    no business module consumes its outbox. There is no API, no UI, no enforced
                    authority (K-02/K-04 deferred), no audit record or event consumer is wired,
                    and nothing has been applied to a live PostgreSQL server — the opt-in live suite
                    (`tests/integration/ai-gateway.integration.ts`, 4 cases) skips with its reason
                    stated. Rolling back 0019 is data loss once any gateway record is created.
```

---

### 11.36 Evidence — FND-005g (K-14 Notifications)

**Task:** FND-005g — K-14 Notifications.
**Selected in:** §8, as the next component of build step B-3 after K-13 opened it.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-14 contract row moves to
`COMPLETE`; the K-14 implementation row moves to `IN PROGRESS`.

**What K-14 is, in one sentence:** channel-neutral delivery of templated notifications, owning
channel configurations, notifications, delivery attempts and the module's own transactional outbox,
so no business module embeds a provider SDK or a notification secret.

**Delivered:**

| Area | What landed |
|---|---|
| Channels | Caller-supplied opaque channel id, channel vocabulary, provider name, enabled flag, configuration object, creation instant and idempotency key. A channel/provider combination is unique |
| Notifications | Caller-supplied opaque notification and account ids, channel, template id, rendered subject/body, payload object, priority, lifecycle status, scheduled and sent instants, creation instant and idempotency key |
| Delivery attempts | Caller-supplied opaque attempt id, notification id, channel, provider, success/failure status, optional error code, attempted-at instant and idempotency key |
| Lifecycle | `send` creates a `pending` notification, delivers it through the channel's provider and moves it to `sent` or `failed`. `schedule` creates a `scheduled` notification. `recordDeliveryAttempt` records an external attempt and updates the notification status |
| Immutability | No UPDATE or DELETE path exists at the service, port or adapter level for channels and delivery attempts; the database refuses mutation with append-only triggers on both tables. Notifications are created once; only `status` and `sent_at` may change |
| Determinism | The caller supplies every identifier and instant; K-14 reads no clock and generates no randomness |
| Outbox wiring | `send` and `recordDeliveryAttempt` each append one K-08 event and one K-09 audit record inside the same transaction |
| Persistence | In-memory reference repository and PostgreSQL adapter, migration 0020 under `kernel_notifications` with append-only triggers on the channel and delivery-attempt tables and the character-for-character `is_opaque_identifier` rule copied into the schema |
| Contract | [`kernel/notifications/CONTRACT.md`](../kernel/notifications/CONTRACT.md) — ownership, public surface, refusals, persistence, outbox and deferred work |

```text
ITEM ID:            K-14 (FND-005g)
MODULE / PHASE:     K-14 Notifications / Phase 0, build step B-3
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/notifications/{types,registry,immutable,validate,service,
                    repository,postgres-repository,outbox,index}.ts,
                    kernel/notifications/providers/{notification-provider,in-app-provider}.ts,
                    CONTRACT.md, and
                    db/migrations/0020_create_kernel_notification_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1534, pass 1534
                    node --test tests/notifications.test.ts
                                                                      exit 0   tests 36, pass 36
                    node --test tests/notifications-repository.test.ts
                                                                      exit 0   tests 27, pass 27
                    npm run check:migrations                          exit 0   40 files, 0 violations
                    npm run test:integration                          exit 0   tests 86, skipped 86
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

STILL NOT VERIFIED: **Nothing calls K-14**, so no business module sends a notification and no live
                    provider adapter delivers one. There is no API, no UI, no enforced authority
                    (K-02/K-04 deferred), no scheduling worker, no attachment handling, no template
                    service integration, and nothing has been applied to a live PostgreSQL server —
                    the opt-in live suite (`tests/integration/notifications.integration.ts`, 5 cases)
                    skips with its reason stated. Rolling back 0020 is data loss once any notification
                    record is created.
```

---

### 11.37 Evidence — FND-005h (K-15 Search Foundation)

**Task:** FND-005h — K-15 Search Foundation.
**Selected in:** §8, as a remaining component of build step B-3 after K-14 opened it.
**Status:** DELIVERED. **Nothing marked COMPLETE.** The checklist K-15 contract row moves to
`COMPLETE`; the K-15 implementation row moves to `IN PROGRESS`.

**What K-15 is, in one sentence:** search document and query-log primitives for a future search
consumer, owning the index, the query log and the module's own transactional outbox, so no business
module embeds search logic or a provider SDK.

**Delivered:**

| Area | What landed |
|---|---|
| Document | Caller-supplied opaque document id, owner type/id, scope, language, title, description, keywords, attributes, vectors, ranking, creation and update instants, and idempotency key. Replaced whole by `documentId` on re-index |
| Query log | Caller-supplied opaque query id, query text, filters, result count, executed-at instant, correlation id and idempotency key. Append-only |
| Full-text search | Generated `tsv` tsvector column combining title, description and keywords, backed by a GIN index; `plainto_tsquery` for keyword search |
| Determinism | The caller supplies every identifier and instant; K-15 reads no clock and generates no randomness |
| Immutability | No UPDATE or DELETE path exists at the service, port or adapter level for the query log; the database refuses mutation with an append-only trigger. Documents are upserted by `documentId` |
| Outbox wiring | `index`, `query` and `remove` each append one K-08 event and one K-09 audit record inside the same transaction |
| Persistence | In-memory reference repository and PostgreSQL adapter, migration 0021 under `kernel_search_foundation` with the generated `tsv` column and append-only trigger on `query_log` |

```text
ITEM ID:            K-15 (FND-005h)
MODULE / PHASE:     K-15 Search Foundation / Phase 0, build step B-3
STATUS:             DELIVERED — implementation IN PROGRESS, contract COMPLETE
IMPLEMENTED:        kernel/search-foundation/{types,registry,immutable,validate,service,
                    repository,postgres-repository,outbox,index}.ts,
                    CONTRACT.md, and
                    db/migrations/0021_create_kernel_search_foundation_schema.{up,down}.sql

COMMANDS:           npm run verify                                    exit 0   tests 1591, pass 1591
                    node --test tests/search-foundation.test.ts
                                                                      exit 0   tests 30, pass 30
                    node --test tests/search-foundation-repository.test.ts
                                                                      exit 0   tests 27, pass 27
                    npm run check:migrations                          exit 0   42 files, 0 violations
                    npm run test:integration                          exit 0   tests 91, pass 91
                    node docs/tools/validate-doc-links.mjs            exit 0   0 broken
                    npm audit --audit-level=high                      exit 0   0 vulnerabilities
                    git diff --check                                  exit 0

ADVERSARIAL COVER:  Foreign-field attempts (business-module identifiers, profile data, financial
                    amounts, AI provider fields and notification fields smuggled into a document or
                    query log — refused by name with the owning component); malformed documents
                    (missing or empty title/description, invalid language, non-object attributes/
                    vectors/ranking, non-text keywords); malformed queries (missing query text,
                    non-object filters); idempotency-key reuse for a different document; duplicate
                    document ids; duplicate idempotency keys; out-of-order removal; and append-only
                    query-log refusal.

PLANTED REGRESSION: The PostgreSQL-generated `tsv` column initially used `array_to_string` directly in
                    the generation expression. PostgreSQL rejects that because `array_to_string` is
                    marked STABLE, not IMMUTABLE. An immutable wrapper function
                    `kernel_search_foundation.keywords_to_text(text[])` was added so the generated
                    column is accepted. The `total` returned by `count(*) OVER()` is decoded as a
                    string bigint and converted to a number by `nonNegativeInteger`.

STILL NOT VERIFIED: **No caller indexes or searches anything**, so no live consumer reads the query
                    log. There is no API, no UI, no semantic/vector search, no ranking model, and
                    nothing has been applied to a live server beyond the integration suite's isolated
                    `_test` database.
```

---

## 12. Update protocol

1. **This document is updated at the end of every task**, before the task is reported complete (v3 §43 step 14, §66 step 6). A task that changes the repository without updating this document is not finished.
2. **Status changes require evidence.** Moving any item to `COMPLETE` requires the §11 evidence block, populated, with real commands and real results. "Tests pass" without the command and the counts is not evidence.
3. **Statuses may move backwards.** If review finds an item was marked complete prematurely, it returns to `IN PROGRESS` or `NEEDS REVIEW` and the reason is recorded. Correcting an over-claim is normal, not a failure.
4. **Defects are recorded when found, not when fixed.** A P0 stops all progression the moment it is identified.
5. **New requirements are classified before implementation** (v3 §67): new module, module extension, policy change, configuration change, UI/UX change, AI change, data change, or security/risk change — then impact-analysed against the owning module and its contracts.
6. **Nothing is deleted.** Superseded requirements move to `OUT OF SCOPE WITH REASON` and remain visible (v3 §53).
7. **Language discipline.** Use only accurate status words: phase complete, module complete, MVP candidate, release candidate, partially complete, blocked (v3 §64). Today the only accurate description is *"planning baseline established; toolchain and boundary enforcement delivered"* — not "FND-001 complete", not "Phase 0 complete", not "MVP candidate" (matching §10).
