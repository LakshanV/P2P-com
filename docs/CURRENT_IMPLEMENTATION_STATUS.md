# JAYA — CURRENT IMPLEMENTATION STATUS

**Overall status:** `TOOLCHAIN SUBSTRATE ONLY — NO BUSINESS CAPABILITY`
**Baseline established:** 2026-08-19 by task DOC-001
**Last updated:** 2026-08-19 by task FND-001b (source roots, architecture manifest, four executable boundary checks)
**Authority rank:** 2 per `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` §1 — second only to the master guide
**Branch:** `conductor/jaya-p2p-com-47859d`

**Related baseline documents:**
- [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md)
- [MODULE_MAP.md](./MODULE_MAP.md)

> **Read this first.** The repository now installs, builds, type-checks, lints, format-checks and tests from a clean dependency state. That is the whole of what exists in code.
>
> Four of the eight architectural checks in [MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification) are now executable and run inside `npm run verify`, each proven by a committed planted-violation fixture.
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
| Phase | Phase 0 — Foundation. **In progress.** Toolchain and boundary enforcement; no data layer, no kernel. |
| Application code | None. Substrate only: `platform/runtime/` (2 modules) and `platform/architecture/` + `platform/checks/` (3 modules) — version pins and boundary enforcement. |
| Database | None |
| Migrations | None |
| Tests | 68 passing (`npm test`, exit 0) — substrate, boundary enforcement and the documentation contract only; no business logic exists to test |
| CI | None — FND-001c, blocked by BL-10. Every check runs locally via `npm run verify`; nothing runs automatically on a change. |
| Environments | None (local only; no staging, no production) |
| Deployment | None |
| Monitoring | None |
| Modules implemented | 0 of 62 (15 kernel components + 47 business modules), all 62 registered in the architecture manifest |
| Boundary rules enforced | 4 of 8 (`layer-direction`, `kernel-purity`, `financial-zone-ai`, `provider-import`); the other 4 need a schema, policy values or module contracts to exist |
| Module contracts written | 0 of 62 |
| Tracked requirements | 474, each with an explicit status; **2 of 472 implementation items complete** (P0-03, P0-11). 9 are `IN PROGRESS`. |
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
| Git workflow conventions | **Present** — [docs/CONTRIBUTING.md §10–§12](./CONTRIBUTING.md#10-atomic-changes) (FND-001d) | P0-13 |

### 4.2 Data infrastructure

| Item | State | Checklist ID |
|---|---|---|
| Database | Absent | P0-14 |
| Migration system | Absent | P0-15 |
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
| R-01 | **Unverifiable baseline.** ~~Nothing is executable.~~ **Largely mitigated by FND-001a and FND-001b.** | Was High, now Low | A test can now run, so a completion claim can be checked rather than asserted. Two residues remain: the harness proves only substrate behaviour, because no business behaviour exists yet; and with no CI, it runs only when somebody chooses to run it. | Toolchain and harness delivered — `npm run verify` chains six gates and 68 tests, all green from a clean install. The residues close as CI lands (FND-001c, blocked by BL-10) and as modules arrive with their own tests. | Closed for substrate; CI residue owned by FND-001c, now blocked by BL-10 |
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

**Zero open defects still means almost no code.** FND-001a and FND-001b added five substrate modules and 32 passing tests; FND-001d added a sixth and 36 more, for 68 today. No defect was found in any of them during implementation or review. The register will carry little information about system health until business capability exists to defect — a green suite over a toolchain is a much weaker signal than a green suite over a commerce platform.

**Recording protocol.** Each defect, when found, records: id, severity, description, owning module, reproduction steps, detection source, the regression test that reproduces it, the fix commit, and — per v3 §58 — whether the defect was introduced by a previous correction, in which case the failed invariant and the adjacent flows inspected are recorded too.

Register: [MASTER_IMPLEMENTATION_CHECKLIST.md §H](./MASTER_IMPLEMENTATION_CHECKLIST.md#h-p0--p1-defect-register).

---

## 8. Next highest-priority unblocked task

### TASK FND-001 — Platform substrate, boundary enforcement, and test harness

**Status:** IN PROGRESS. Subtasks FND-001a, FND-001b and FND-001d delivered. **FND-001c is BLOCKED by BL-10** — it is the only remaining subtask, and it cannot be delivered by any local means.

**Next subtask: FND-001c — GitHub Actions CI.** It is the only remaining item on the critical path to a boundary rule that holds without somebody remembering to run a command, and it is stalled on a credential permission rather than on any technical question. The workflow has been authored and validated locally on several occasions; every attempt to land it is rejected by the remote because the token lacks the Workflows permission (BL-10, §6). Until that is granted, FND-001 stays IN PROGRESS and no CI-dependent gate may be marked complete.

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
| 2 | FND-002 | Database, migration system, schema-namespace convention, seed strategy (P0-14…P0-17) | No |
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

Per v3 §56, completion requires evidence. Below is every evidence claim currently made in this repository. There are seven: four documentation artefacts from DOC-001, and the three delivered FND-001 subtasks, each backed by named commands with recorded exit codes (§11.1, §11.2, §11.4).

| Item | Status | Evidence type | Evidence |
|---|---|---|---|
| P0-01a — status baseline | COMPLETE | File | `docs/CURRENT_IMPLEMENTATION_STATUS.md` (this document) |
| P0-01b — checklist baseline | COMPLETE | File | [`docs/MASTER_IMPLEMENTATION_CHECKLIST.md`](./MASTER_IMPLEMENTATION_CHECKLIST.md) |
| P0-01c — module map baseline | COMPLETE | File | [`docs/MODULE_MAP.md`](./MODULE_MAP.md) |
| P0-01d — link validator | COMPLETE | File + reproducible command | `docs/tools/validate-doc-links.mjs`, run as `node docs/tools/validate-doc-links.mjs` |
| FND-001a — pinned toolchain and test harness | DELIVERED | Commands + exit codes | See §11.1. P0-04 satisfied; P0-05…P0-08 satisfied but held `IN PROGRESS` while FND-001 is unfinished. |
| FND-001b — source roots, architecture manifest, boundary enforcement | DELIVERED | Commands + exit codes + planted fixtures | See §11.2. **P0-03 and P0-11 COMPLETE**; P0-10 `IN PROGRESS` (four of the eight MODULE_MAP §13 checks are built). |
| FND-001d — contributor documentation and git conventions | DELIVERED | Commands + exit codes + planted erosions | See §11.4. **P0-12 and P0-13 COMPLETE**, each guarantee covered by a planted-erosion test. |

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

## 12. Update protocol

1. **This document is updated at the end of every task**, before the task is reported complete (v3 §43 step 14, §66 step 6). A task that changes the repository without updating this document is not finished.
2. **Status changes require evidence.** Moving any item to `COMPLETE` requires the §11 evidence block, populated, with real commands and real results. "Tests pass" without the command and the counts is not evidence.
3. **Statuses may move backwards.** If review finds an item was marked complete prematurely, it returns to `IN PROGRESS` or `NEEDS REVIEW` and the reason is recorded. Correcting an over-claim is normal, not a failure.
4. **Defects are recorded when found, not when fixed.** A P0 stops all progression the moment it is identified.
5. **New requirements are classified before implementation** (v3 §67): new module, module extension, policy change, configuration change, UI/UX change, AI change, data change, or security/risk change — then impact-analysed against the owning module and its contracts.
6. **Nothing is deleted.** Superseded requirements move to `OUT OF SCOPE WITH REASON` and remain visible (v3 §53).
7. **Language discipline.** Use only accurate status words: phase complete, module complete, MVP candidate, release candidate, partially complete, blocked (v3 §64). Today the only accurate description is *"planning baseline established; toolchain and boundary enforcement delivered"* — not "FND-001 complete", not "Phase 0 complete", not "MVP candidate" (matching §10).
