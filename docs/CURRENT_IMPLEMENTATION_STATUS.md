# JAYA — CURRENT IMPLEMENTATION STATUS

**Overall status:** `TOOLCHAIN SUBSTRATE ONLY — NO BUSINESS CAPABILITY`
**Baseline established:** 2026-08-19 by task DOC-001
**Last updated:** 2026-08-19 by task FND-003a, as corrected three times (explicit draft lifecycle, replacement ordering that respects the partial unique index, content-matched idempotency, explicit region in resolution; then canonical instant comparison, deterministic refusal of competing publications, and retries answered after supersession; then timestamps projected as UTC text so the driver cannot truncate them). Preceding updates: FND-002a (PostgreSQL selection, migration contract, schema namespaces), FND-001d (contributor documentation), FND-001b (source roots, architecture manifest, four executable boundary checks).
**Authority rank:** 2 per `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` §1 — second only to the master guide
**Branch:** `conductor/jaya-p2p-com-47859d`

**Related baseline documents:**
- [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md)
- [MODULE_MAP.md](./MODULE_MAP.md)

> **Read this first.** The repository now installs, builds, type-checks, lints, format-checks and tests from a clean dependency state. That is the whole of what exists in code.
>
> Four of the eight architectural checks in [MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification) are now executable and run inside `npm run verify`, each proven by a committed planted-violation fixture.
>
> Local provisioning is delivered (FND-002c): `compose.yaml` pins PostgreSQL 16.10 with a health check, a named data volume and loopback-only binding; `db:up`/`db:ready`/`db:migrate`/`db:status`/`db:reset`/`db:down`/`db:destroy` drive it; and the integration suites derive a guarded, isolated test database rather than touching the development one. **No Docker runtime is available to this repository, so the service has never been started and no live suite has ever run.**
>
> The data foundation has begun. FND-002a selected PostgreSQL 16+, delivered the migration file contract enforced by `npm run check:migrations` with a planted-invalid fixture per rule, and derived the schema-namespace ownership convention from the architecture manifest. FND-002b added the runner: a PostgreSQL adapter, advisory locking, SHA-256 checksum reconciliation, and atomic application of each migration with its ledger row, all written against an injected database interface and covered by 35 deterministic tests.
>
> **No database is provisioned and no migration has been executed against a live server.** No PostgreSQL runtime is available to this repository; the runner is proved against a fake, and the opt-in integration test skips with its reason stated. A skipped test is not evidence, so P0-14 and P0-15 stay incomplete.
>
> Contributor documentation and git conventions are delivered (FND-001d) and are themselves under an executable contract: [docs/CONTRIBUTING.md](./CONTRIBUTING.md) is read by `tests/docs-contract.test.ts`, which fails the build if a documented guarantee is deleted or softened.
>
> There is still **no CI, no database, no kernel component, no business module and no UI**. FND-001 is **not complete** — subtask FND-001c (CI) is **blocked by BL-10**: the repository credential lacks the Workflows permission, so no change touching `.github/workflows/` can reach the remote. `kernel/`, `modules/`, `design-system/` and `apps/` exist as tracked, documented roots and are **empty of implementation**.
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
| Phase | Phase 0 — Foundation. **In progress.** Toolchain, boundary enforcement and the migration contract; no database server, no kernel. |
| Application code | None. Substrate only: `platform/runtime/` (2 modules), `platform/architecture/` + `platform/checks/` (4 modules) and `platform/db/` (7 modules) — version pins, boundary enforcement, documentation and migration contracts, and the migration runner. One runtime dependency: `pg`, used only by the runner. |
| Database | **Selected and provisionable, never started here.** PostgreSQL 16.10 pinned in `compose.yaml` (FND-002c), started with `npm run db:up`. A runner exists (FND-002b) and the `pg` driver is declared, so code in this repository *does* open connections when invoked — but no Docker runtime is available to this repository, so no server has ever been started and no connection has ever succeeded. |
| Migrations | 3 forward + 3 rollback, validated statically by `npm run check:migrations`, applied by `npm run db:migrate` (FND-002b). **Never executed against a live server.** They create the `platform` schema, the migration ledger and the `kernel_configuration` schema with K-05's version table. No business-module tables exist. |
| Tests | 310 passing (`npm test`, exit 0) — substrate, boundary enforcement, documentation contract, migration contract, migration runner and K-05 Configuration. A further 12 live-PostgreSQL tests exist and are **skipped**, not passing |
| CI | None — FND-001c, blocked by BL-10. Every check runs locally via `npm run verify`; nothing runs automatically on a change. |
| Environments | None (local only; no staging, no production) |
| Deployment | None |
| Monitoring | None |
| Modules implemented | 1 of 62 partially — **K-05 Configuration** core only (FND-003a); 0 business modules. All 62 registered in the architecture manifest |
| Boundary rules enforced | 4 of 8 (`layer-direction`, `kernel-purity`, `financial-zone-ai`, `provider-import`); the other 4 need a schema, policy values or module contracts to exist |
| Module contracts written | 1 of 62 — [`kernel/configuration/CONTRACT.md`](../kernel/configuration/CONTRACT.md) |
| Tracked requirements | 474, each with an explicit status; **4 of 472 implementation items complete** (P0-03, P0-11, P0-12, P0-13). 13 are `IN PROGRESS`, 9 are `BLOCKED`. |
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
| `kernel/`, `modules/`, `design-system/`, `apps/` | Source roots | Tracked, each with a README recording its ownership rules. **Empty of implementation.** |
| `platform/architecture/manifest.ts` | Substrate | Machine-readable encoding of MODULE_MAP: 15 kernel components, 47 modules, layer depths, the financial authority zone as path prefixes, the provider SDK list. |
| `platform/checks/boundaries.ts` | Substrate | The four boundary checks, extracting imports through the TypeScript compiler API. |
| `platform/checks/cli.ts` | Substrate | `npm run check:boundaries`; exits 1 on any violation. |
| `tests/manifest.test.ts` | Tests | 7 tests guarding the manifest's structural invariants. |
| `tests/boundaries.test.ts` | Tests | 10 tests: positive cases plus a planted-violation proof per check. |
| `tests/fixtures/**` (22 files) | Fixtures | Committed non-conforming trees, one per rule, plus a clean control. Excluded from TypeScript, ESLint and Prettier. |
| `tests/README.md` | Tests | Ownership note, including why fixtures must not be "fixed". |

**That is the entire repository.** There is no CI configuration, no database, no migration directory, no environment configuration, no kernel component, no business module and no UI.

DOC-001 created no source file. FND-001a was scoped to the toolchain. FND-001b was scoped to the source roots and boundary enforcement and created **no CI, database, kernel, business-module or UI functionality** — `kernel/` and `modules/` contain one README each and nothing else.

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
| Local database provisioning | **Present, never exercised** — `compose.yaml` pins PostgreSQL 16.10 with a health check and a named data volume; `db:up`/`db:ready`/`db:down`/`db:reset`/`db:destroy` drive it (FND-002c). **No Docker runtime is available here, so it has never been started** | P0-14 |
| Migration file contract and validator | **Present** — `db/migrations/`, `npm run check:migrations`, ten checks with planted-invalid fixtures | P0-15 |
| Migration runner | **Present** — `npm run db:migrate`/`db:status`/`db:rollback` (FND-002b), with advisory locking, checksum reconciliation and ledger-atomic application. Driver `pg` declared and locked, so `npm ci` yields a runnable runner. **Never run against a live server** | P0-15 |
| Connection configuration | `DATABASE_URL` only, read from the environment and never logged. **No pooling, no secret storage, no provisioning** | P0-14 |
| Schema-namespace ownership convention | **Present and enforced for migrations** — `platform/db/schema-namespaces.ts`, derived from the architecture manifest | P0-16 |
| Isolated test-database lifecycle | **Present, never exercised** — derived from `DATABASE_URL`, guarded against non-loopback hosts, non-test names and shared-environment names, and the **only** path any live suite has to a database (FND-002c) | T-21 |
| Seed and fixture data | Absent | P0-17 |
| Object / file storage | Absent | P0-18 |
| Search index | Absent | K-15 |
| Event bus / queue | Absent | K-08 |

### 4.3 Platform capability

| Item | State | Checklist ID |
|---|---|---|
| Authentication | Absent | K-02 |
| Permissions framework | Absent | K-04 |
| Audit framework | Absent | K-09 |
| Configuration and policy engine | Absent | K-05, K-06 |
| Feature flags | Absent | K-07 |
| Ledger foundation | Absent | K-10 |
| AI gateway / provider abstraction | Absent | K-13 |
| Notifications | Absent | K-14 |
| Conversation foundation | Absent | K-12 |
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
| R-01 | **Unverifiable baseline.** ~~Nothing is executable.~~ **Largely mitigated by FND-001a and FND-001b.** | Was High, now Low | A test can now run, so a completion claim can be checked rather than asserted. Two residues remain: the harness proves only substrate behaviour, because no business behaviour exists yet; and with no CI, it runs only when somebody chooses to run it. | Toolchain and harness delivered — `npm run verify` chains seven gates and 310 tests, all green from a clean install. The residues close as CI lands (FND-001c, blocked by BL-10) and as modules arrive with their own tests. | Closed for substrate; CI residue owned by FND-001c, now blocked by BL-10 |
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

**Zero open defects still means almost no code.** FND-001a and FND-001b added five substrate modules and 32 passing tests; FND-001d added a sixth and 36 more; FND-002a added three more and 29 more; FND-002b added four more and 41 more; FND-002c added five more and 62 more; FND-003a added the first kernel component and 110 more tests, for 310 today. Eight defects were found in FND-003a by review after delivery and corrected in three passes (§11.11, §11.12, §11.13); no defect was found in the earlier tasks. The register will carry little information about system health until business capability exists to defect — a green suite over a toolchain is a much weaker signal than a green suite over a commerce platform.

**Recording protocol.** Each defect, when found, records: id, severity, description, owning module, reproduction steps, detection source, the regression test that reproduces it, the fix commit, and — per v3 §58 — whether the defect was introduced by a previous correction, in which case the failed invariant and the adjacent flows inspected are recorded too.

Register: [MASTER_IMPLEMENTATION_CHECKLIST.md §H](./MASTER_IMPLEMENTATION_CHECKLIST.md#h-p0--p1-defect-register).

---

## 8. Next highest-priority unblocked task

### TASK FND-001 — Platform substrate, boundary enforcement, and test harness

**Status:** IN PROGRESS. Subtasks FND-001a, FND-001b and FND-001d delivered. **FND-001c is BLOCKED by BL-10** — it is the only remaining subtask, and it cannot be delivered by any local means.

**Next genuinely unblocked task: FND-003b — K-08 Event Infrastructure**, which completes build step B-1. **FND-003a delivered K-05 Configuration's core** (§11.10): registered keys, immutable versions, effective-time resolution, scoped overrides, an injected repository port and migration 0003. K-05 is not complete — no API, no enforced authority, no audit, no events, and nothing applied to a live server.

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
| 4 | FND-004 | K-01 Identity, K-02 Authentication, K-03 Accounts, K-04 Permissions, then K-09 Audit and K-07 Feature Flags (build step B-2) | No |
| 5 | FND-005 | K-06 Policy, K-10 Ledger foundation, K-11 Commerce Unit Registry, K-12 Conversation, K-14 Notifications, K-15 Search, K-13 AI Gateway (build step B-3) | K-13 live adapter needs BL-04; the abstraction and a test double for the test suite do not |
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
| Safety (G-08…G-15) | 8 | 0 | No adversarial suites, no permissions, no migrations, no monitoring |
| Experience (G-16…G-20) | 5 | 0 | No UI, no design system |
| Governance (G-21…G-26) | 6 | 0 | Registers exist and are empty; no deployment |

**Phase 0 exit gate:** not met (P0-G1…P0-G5, all `NOT STARTED`).

**Production completion rule (v3 §64):** the project may not be described as complete until every gate above is met, no P0 or P1 defect is open, the critical journeys and adversarial suites pass, and this document is accurate. None of those conditions holds. Permitted description today: **"planning baseline established; toolchain and boundary enforcement delivered."** Not "FND-001 complete", not "Phase 0 complete", not "MVP candidate".

---

## 11. Evidence register

Per v3 §56, completion requires evidence. Below is every evidence claim currently made in this repository. There are nine: four documentation artefacts from DOC-001, the three delivered FND-001 subtasks, and two FND-002 subtasks, each backed by named commands with recorded exit codes (§11.1, §11.2, §11.4, §11.5, §11.6).

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
| FND-002b — migration runner, PostgreSQL adapter, locking, checksums | DELIVERED | Commands + exit codes + 35 deterministic tests against an injected fake | See §11.6. **Nothing marked COMPLETE.** P0-14 and P0-15 stay `IN PROGRESS`: the runner exists and is proved against a fake, but has never been executed against a live PostgreSQL, and the integration test that would prove it **skipped**. |

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
                    P0-38 IN PROGRESS (K-06 Policy Engine not started)
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

## 12. Update protocol

1. **This document is updated at the end of every task**, before the task is reported complete (v3 §43 step 14, §66 step 6). A task that changes the repository without updating this document is not finished.
2. **Status changes require evidence.** Moving any item to `COMPLETE` requires the §11 evidence block, populated, with real commands and real results. "Tests pass" without the command and the counts is not evidence.
3. **Statuses may move backwards.** If review finds an item was marked complete prematurely, it returns to `IN PROGRESS` or `NEEDS REVIEW` and the reason is recorded. Correcting an over-claim is normal, not a failure.
4. **Defects are recorded when found, not when fixed.** A P0 stops all progression the moment it is identified.
5. **New requirements are classified before implementation** (v3 §67): new module, module extension, policy change, configuration change, UI/UX change, AI change, data change, or security/risk change — then impact-analysed against the owning module and its contracts.
6. **Nothing is deleted.** Superseded requirements move to `OUT OF SCOPE WITH REASON` and remain visible (v3 §53).
7. **Language discipline.** Use only accurate status words: phase complete, module complete, MVP candidate, release candidate, partially complete, blocked (v3 §64). Today the only accurate description is *"planning baseline established; toolchain and boundary enforcement delivered"* — not "FND-001 complete", not "Phase 0 complete", not "MVP candidate" (matching §10).
