# JAYA — MASTER IMPLEMENTATION CHECKLIST

**Document status:** BASELINE
**Created by task:** DOC-001
**Authority rank:** 3 per `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` §1 (below the master guide and `CURRENT_IMPLEMENTATION_STATUS.md`)
**Governing sources:** v3 §53 (no silent requirement loss), §54 (no placeholder completion), §55 (definition of done), §56 (completion evidence), §59 (phased build order), §64 (production completion rule). Compatible detail from v1.0 §6 (status system), §64–§77 (phase checklists), §88 (evidence format), §93 (deployment gates), §102 (master checklist).

**Related baseline documents:**
- [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md)
- [MODULE_MAP.md](./MODULE_MAP.md)

> **Baseline truth: no business capability in this checklist is complete.** The repository contains the specifications, the documentation baseline, the pinned toolchain (FND-001a), four executable architectural boundary checks (FND-001b), a validated migration set and runner with local provisioning (FND-002a–c), a deterministic seed-and-fixture foundation (FND-002d), and the cores of fourteen kernel components — K-05 Configuration (FND-003a), K-08 Event Infrastructure (FND-003b), K-09 Audit Foundation (FND-003c), K-01 Identity (FND-004a), K-03 Accounts (FND-004b), K-02 Authentication (FND-004c), K-04 Permissions (FND-004d), K-07 Feature Flags (FND-004e), K-06 Policy Engine (FND-005b), K-10 Ledger Foundation (FND-005c), K-12 Conversation Foundation (FND-005d), K-13 AI Gateway (FND-005e), K-14 Notifications (FND-005g) and K-15 Search Foundation (FND-005h). There is still no CI, no live database, no business module and no UI. **None of the fourteen kernel components is complete**, and each carries the same gaps: no API, no UI, no enforced authority, no caller, and no schema ever applied to a running server. K-02 and K-03 each depend on K-01 and are proved to, which makes them the repository's real cross-component dependencies — but both are still exercised only by tests. **K-02 ships no verifier**, so the component that would authenticate a real person cannot yet do so; **nothing calls K-04**, so no path in this repository is actually guarded; **K-15 ships no live consumer**, so no caller indexes or searches anything.
>
> `COMPLETE` items are confined to §A.1: P0-01 (documentation), P0-03 (source structure) and P0-11 (financial-zone and provider-import checks). P0-04 through P0-08 remain `IN PROGRESS` — satisfied by FND-001a but held there while FND-001 is unfinished — and P0-10 is `IN PROGRESS` because it references MODULE_MAP §13, which lists eight checks of which four are built. Every business capability — all 15 kernel components, all 47 modules, all 19 phases — remains `NOT STARTED`, `BLOCKED`, `DEFERRED WITH REASON`, or `OUT OF SCOPE WITH REASON`.

---

## Table of contents

- [0. How to use this checklist](#0-how-to-use-this-checklist)
- [A. Phase 0 — Foundation](#a-phase-0--foundation)
- [B. Commerce kernel components](#b-commerce-kernel-components)
- [C. Business modules](#c-business-modules)
- [D. Phases 1–18 — major requirements](#d-phases-118--major-requirements)
- [E. Cross-cutting mandatory requirements](#e-cross-cutting-mandatory-requirements)
- [F. Test suites](#f-test-suites)
- [G. Release gates](#g-release-gates)
- [H. P0 / P1 defect register](#h-p0--p1-defect-register)
- [I. Blocker register](#i-blocker-register)
- [J. Guide reconciliation — deferred and out-of-scope items](#j-guide-reconciliation--deferred-and-out-of-scope-items)
- [K. Baseline counts](#k-baseline-counts)

---

## 0. How to use this checklist

### 0.1 Status legend

Every requirement carries exactly one status at all times (v3 §53). Nothing may be absent, and nothing may be blank.

| Marker | Status | Meaning |
|---|---|---|
| `[ ]` | **NOT STARTED** | No work has begun. |
| `[~]` | **IN PROGRESS** | Work has begun. Temporary scaffolding is permitted only while an item is in this state (v3 §54). |
| `[?]` | **NEEDS REVIEW** | Implementation claims completion; independent review and gates not yet passed. |
| `[x]` | **COMPLETE** | Definition of Done met **and** an evidence block recorded (§0.3). |
| `[!]` | **BLOCKED** | Cannot proceed. Must name a blocker ID from [§I](#i-blocker-register). |
| `[-]` | **DEFERRED WITH REASON** | Consciously postponed. Must state the reason and the revisit point. |
| `[o]` | **OUT OF SCOPE WITH REASON** | Consciously excluded. Must state the reason. |

### 0.2 Completion rules

1. An item may move to `[x]` only with an evidence block. A claim without evidence is rejected (v3 §56).
2. An item containing a TODO, a fake success, hardcoded mock data, a stub API, a non-functional control, a "coming soon", a temporary bypass, a skipped authorisation, or a skipped test is **not** complete (v3 §54).
3. A module reaches `[x]` only when every applicable layer of the v3 §55 Definition of Done is done: business requirement, architecture, database, migration, API, events, permissions, backend logic, AI/tool integration where needed, frontend, mobile UX, desktop UX, loading/error/empty states, audit, observability, configuration, tests, security review, documentation, feature flags, rollback consideration.
4. A page that merely renders is not UI completion (v3 §33, §51).
5. No item may be deleted from this checklist. Superseded items move to `[o]` with a reason and stay visible (v3 §53).

### 0.3 Evidence block format

Required on every item moved to `[x]`, per v3 §56 and v1 §88:

```text
ITEM ID:
MODULE / PHASE:
STATUS:
IMPLEMENTED:            (what was actually built)
TESTED:                 (which test types ran)
TEST COMMANDS:          (exact commands)
TEST RESULTS:           (pass/fail counts, and the failures)
SECURITY:               (review outcome, or N/A with reason)
UI/UX REVIEW:           (outcome against the v3 §51 gate, or N/A with reason)
MIGRATIONS:             (migration ids, reversibility)
EVENTS:                 (events emitted/consumed, idempotency verified)
CONFIG / POLICY:        (policy keys and versions used; confirm no source constants)
KNOWN LIMITATIONS:
DEFERRED:
COMMITS:                (commit sha list)
FILES:                  (paths that constitute the evidence)
FOLLOW-UP:
```

**Evidence links.** Where an item's evidence lives in the repository, the item records the path — and, where the evidence is a command, the command and its exit code. An item with nothing built against it still reads `NONE — no implementation`, which is the honest value, not an omission.

---

## A. Phase 0 — Foundation

Source: v3 §59 Phase 0 and v1 §64. **Phase 0 exit gate: all foundation tests pass before Phase 1 begins.** Phase 0 has begun (toolchain only) and is far from complete.

### A.1 Repository, toolchain and CI

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0-01 | `/docs` planning baseline created, with reproducible link validation | `[x]` COMPLETE | `docs/CURRENT_IMPLEMENTATION_STATUS.md`, `docs/MASTER_IMPLEMENTATION_CHECKLIST.md`, `docs/MODULE_MAP.md`, `docs/tools/validate-doc-links.mjs` — created by DOC-001. Validated by `node docs/tools/validate-doc-links.mjs` → 126 internal links across 4 files, 0 broken, exit 0 (count as of the FND-002a reconciliation; re-run the command for the current figure). Full evidence block: [CURRENT_IMPLEMENTATION_STATUS.md §11](./CURRENT_IMPLEMENTATION_STATUS.md#11-evidence-register). Documentation artefact, not an implementation capability. |
| P0-02 | Remaining `/docs` set from v3 §42 (ARCHITECTURE, DATABASE_SCHEMA, API_CONTRACTS, EVENT_CATALOG, AI_ARCHITECTURE, AI_MODEL_REGISTRY, SECURITY_MODEL, PERMISSIONS_MATRIX, POLICY_CATALOG, TEST_STRATEGY, UX_SYSTEM, DEPLOYMENT_GUIDE, OPERATIONS_RUNBOOK, DECISIONS_LEDGER, KNOWN_LIMITATIONS, CHANGELOG, MASTER_PRODUCT_SPEC) | `[ ]` NOT STARTED | NONE — files do not exist |
| P0-03 | Repository source structure (`/platform`, `/kernel`, `/modules`, `/design-system`, `/apps`, `/tests`) | `[x]` COMPLETE | All six roots exist, are tracked and carry an ownership README (FND-001b). `modules/`, `design-system/` and `apps/` remain empty of implementation; `kernel/` now holds the K-05 and K-08 foundations. This item is about structure, not content. Evidence [§11.2](./CURRENT_IMPLEMENTATION_STATUS.md#112-evidence--fnd-001b-source-roots-architecture-manifest-boundary-enforcement). |
| P0-04 | Runtime and package manifest chosen and committed | `[~]` IN PROGRESS | Satisfied by FND-001a. **Pinned toolchain:** Node 26.7.0 (`.nvmrc`), npm 11.19.0 (`packageManager`). **Supported ranges:** `engines.node >=22.18.0`, `engines.npm >=10.0.0`. Exact devDependency pins, committed lockfile, `npm ci` exit 0. Automated assertions bind each pin to its range. Held at IN PROGRESS until FND-001 completes. Evidence [§11.1](./CURRENT_IMPLEMENTATION_STATUS.md#111-evidence--fnd-001a-pinned-toolchain-and-test-harness). |
| P0-05 | Build pipeline (compile/bundle) | `[~]` IN PROGRESS | `npm run build` exit 0, emits `dist/`. Compilation check only — no runnable entry point exists yet. Evidence [§11.1](./CURRENT_IMPLEMENTATION_STATUS.md#111-evidence--fnd-001a-pinned-toolchain-and-test-harness). |
| P0-06 | Type checking | `[~]` IN PROGRESS | `npm run typecheck` exit 0, strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Evidence [§11.1](./CURRENT_IMPLEMENTATION_STATUS.md#111-evidence--fnd-001a-pinned-toolchain-and-test-harness). |
| P0-07 | Lint and format configuration | `[~]` IN PROGRESS | `npm run lint` and `npm run format:check` both exit 0. Evidence [§11.1](./CURRENT_IMPLEMENTATION_STATUS.md#111-evidence--fnd-001a-pinned-toolchain-and-test-harness). |
| P0-08 | Test framework and runner | `[~]` IN PROGRESS | `npm test` exit 0 — tests 702, pass 702, fail 0 (32 at FND-001b, 36 by the FND-001d documentation contract, 29 by the FND-002a migration contract, 41 by the FND-002b runner and its corrections, 62 by the FND-002c provisioning and integration-safety contracts, 109 by the FND-003a K-05 Configuration suites and their three correction passes, 82 by the FND-003b K-08 Event Infrastructure suites and its correction, 57 by the FND-002d fixture contract and seed runner and its two corrections, 81 by the FND-003c K-09 Audit Foundation suites and its immutability correction, 80 by the FND-004a K-01 Identity suites and its persisted-validation correction, 85 by the FND-004b K-03 Accounts suites and its convergence correction, plus one widened ownership assertion). A further 32 live-PostgreSQL tests exist and are skipped, not passing. Runner proven to report failure (exit 1) on a deliberately failing assertion. Evidence [§11.1](./CURRENT_IMPLEMENTATION_STATUS.md#111-evidence--fnd-001a-pinned-toolchain-and-test-harness), [§11.2](./CURRENT_IMPLEMENTATION_STATUS.md#112-evidence--fnd-001b-source-roots-architecture-manifest-boundary-enforcement). |
| P0-09 | CI pipeline running build + typecheck + lint + tests + `node docs/tools/validate-doc-links.mjs` on every change | `[!]` BLOCKED | NONE — no CI configuration exists in the repository. FND-001c is blocked by **BL-10**: the repository credential is a fine-grained token without the **Workflows** permission, so any change touching `.github/workflows/` is rejected by the remote and never lands. The item stays incomplete until BL-10 clears; it is not deferred, and no CI-dependent gate may be marked complete meanwhile. |
| P0-10 | Import-boundary / layering enforcement checks ([MODULE_MAP.md](./MODULE_MAP.md) §13) | `[~]` IN PROGRESS | `layer-direction` and `kernel-purity` delivered (FND-001b), wired into `npm run verify`, each proven by a committed planted-violation fixture. **Held at IN PROGRESS: §13 lists eight checks and four are built** — table ownership, policy-literal scan, contract presence and cycle detection need a schema, policy values and module contracts to exist. Evidence [§11.2](./CURRENT_IMPLEMENTATION_STATUS.md#112-evidence--fnd-001b-source-roots-architecture-manifest-boundary-enforcement). |
| P0-11 | Financial-zone and AI-provider-import enforcement checks | `[x]` COMPLETE | `financial-zone-ai` (severity P0) and `provider-import` in `platform/checks/boundaries.ts`, wired into `npm run verify`, exit 1 on violation. Planted fixtures rejected, including the control proving the zone matches on path boundaries — `modules/rewards/ledger` restricted, `modules/rewards/ui` not. Evidence [§11.2](./CURRENT_IMPLEMENTATION_STATUS.md#112-evidence--fnd-001b-source-roots-architecture-manifest-boundary-enforcement). |
| P0-12 | Contributor and development documentation | `[x]` COMPLETE | [`docs/CONTRIBUTING.md`](./CONTRIBUTING.md) (FND-001d) — exact prerequisites (Node 26.7.0, npm 11.19.0), clean-clone setup, the pinned-vs-supported toolchain distinction, every verification command, the planted-violation fixtures, module ownership and dependency rules, the financial-zone AI prohibition, provider confinement to K-13, and secrets handling. Enforced, not merely written: `platform/checks/docs-contract.ts` + `tests/docs-contract.test.ts` run under `npm test` and fail the build if any guarantee is deleted or softened — 36 cases, 30 of them planted erosions. Evidence [§11.4](./CURRENT_IMPLEMENTATION_STATUS.md#114-evidence--fnd-001d-contributor-documentation-and-git-conventions). |
| P0-13 | Git workflow conventions (atomic commits, branch policy) | `[x]` COMPLETE | [`docs/CONTRIBUTING.md` §11–§13](./CONTRIBUTING.md#11-atomic-changes) (FND-001d) — atomic-change definition, no-completion-without-evidence rule, the six review questions, branch roles (default `conductor/p2p-com-03af26`, per-session `conductor/<session>` working branches), commit-message convention, and the Conductor-managed Git operations contributors must not run. The `branch-conventions`, `atomic-changes` and `review` guarantees are each covered by planted-erosion tests. Evidence [§11.4](./CURRENT_IMPLEMENTATION_STATUS.md#114-evidence--fnd-001d-contributor-documentation-and-git-conventions). |

### A.2 Data layer

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0-14 | Database selection and local provisioning | `[~]` IN PROGRESS | **Selection decided: PostgreSQL 16+** (FND-002a), recorded in [`docs/CONTRIBUTING.md` §6](./CONTRIBUTING.md#6-the-database-and-the-migration-contract). **Provisioning delivered and exercised** (FND-002c): `compose.yaml` pins PostgreSQL 16.10-alpine3.22 with a pg_isready health check, a named data volume, loopback-only binding and credentials from an untracked `.env`; `db:up`/`db:ready`/`db:down`/`db:reset`/`db:destroy` drive it, the two destructive commands refusing without `--yes`. Eleven guarantees are enforced by `tests/provisioning-contract.test.ts` with 22 planted weakenings. A Docker runtime is available in this environment, so the service has been started, `npm run test:integration` passes, and a connection has succeeded. Held at IN PROGRESS until CI runs the same checks automatically. Evidence [§11.8](./CURRENT_IMPLEMENTATION_STATUS.md#118-evidence--fnd-002c-local-provisioning-and-isolated-test-database-lifecycle). Runner evidence [§11.6](./CURRENT_IMPLEMENTATION_STATUS.md#116-evidence--fnd-002b-migration-runner-postgresql-adapter-locking-checksums). Evidence [§11.5](./CURRENT_IMPLEMENTATION_STATUS.md#115-evidence--fnd-002a-database-selection-migration-contract-schema-namespaces). |
| P0-15 | Migration system, forward and reversible where reasonable (v1 §92) | `[~]` IN PROGRESS | **File contract and validator delivered** (FND-002a): `db/migrations/` holds 2 forward migrations each with its rollback; `npm run check:migrations` enforces ten rules and is wired into `npm run verify`; each rule has a planted-invalid fixture asserted to produce exactly that violation. **Runner delivered and exercised** (FND-002b): `npm run db:migrate` applies pending migrations under a session advisory lock, records a SHA-256 checksum per migration in the same transaction as the migration itself, and fails closed on checksum drift, unknown ledger versions or out-of-order versions. Rollback is operator-invoked only. 35 deterministic tests against an injected fake. Corrected after review: the `pg` driver is now declared and locked so a clean `npm ci` yields a runnable runner; `status` and refused rollbacks no longer create objects; the bootstrap commits inside the first migration's transaction so schema and ledger cannot exist without history; and the 0002 rollback, which was unexecutable, now leaves the bootstrap-owned ledger intact. The migration files are executed against a live server by `npm run test:integration`, which passes. Held at IN PROGRESS until CI runs the same checks automatically. Correction record [§11.7](./CURRENT_IMPLEMENTATION_STATUS.md#117-correction--fnd-002b-production-readiness-and-transaction-model). Evidence [§11.5](./CURRENT_IMPLEMENTATION_STATUS.md#115-evidence--fnd-002a-database-selection-migration-contract-schema-namespaces), [§11.6](./CURRENT_IMPLEMENTATION_STATUS.md#116-evidence--fnd-002b-migration-runner-postgresql-adapter-locking-checksums). |
| P0-16 | Schema-namespace-per-module convention enforced | `[~]` IN PROGRESS | **Defined and enforced for migrations** (FND-002a): `platform/db/schema-namespaces.ts` derives 63 namespaces (`platform`, `kernel_<dir>`, `module_<dir>`) from the architecture manifest, so the manifest stays the single source of truth. `public`, unregistered schemas and cross-owner access are rejected, each proven by a fixture. **Held at IN PROGRESS:** the convention is enforced against migration *files*, not against running code — the table-ownership check in [MODULE_MAP.md §13](./MODULE_MAP.md#13-enforcement-and-verification) is still unbuilt and needs a real schema first. Evidence [§11.5](./CURRENT_IMPLEMENTATION_STATUS.md#115-evidence--fnd-002a-database-selection-migration-contract-schema-namespaces). |
| P0-17 | Seed/fixture strategy for realistic-data testing (v3 §33) | `[~]` IN PROGRESS | A versioned deterministic fixture-manifest contract with nine executable checks (`npm run check:fixtures`, in the verify chain), an injected transactional seed runner that is atomic and idempotent and refuses non-local, shared-looking and non-`_test` targets, a CLI (`db:fixtures`, `db:seed`, `db:seed:reset`), and development datasets for the K-05 and K-08 foundations. 57 deterministic tests including thirteen planted-invalid fixtures and thirty type-cast hostile manifests. Corrected after review twice: the complete validation now runs inside every runner path rather than only in the CLI, replacement deletes and reloads in one transaction, and payload fingerprints are recomputed rather than trusted ([§11.17](./CURRENT_IMPLEMENTATION_STATUS.md#1117-correction--fnd-002d-validation-bypass-split-replacement-and-trusted-fingerprints)); then every runtime shape a programmatic caller can supply is checked — column names that reach SQL, dependency entries, row and table types — and every event row must carry an object payload and a matching fingerprint ([§11.18](./CURRENT_IMPLEMENTATION_STATUS.md#1118-correction--fnd-002d-programmatic-manifest-shape-validation)). **Not complete:** nothing has been loaded into a live PostgreSQL server, and "realistic-data testing" in the v3 sense needs business modules that do not exist — no business, financial-policy or production data is seeded. Evidence [§11.16](./CURRENT_IMPLEMENTATION_STATUS.md#1116-evidence--fnd-002d-seed-and-fixture-foundation) |
| P0-18 | Object/file storage abstraction | `[ ]` NOT STARTED | NONE |
| P0-19 | Object storage provider credentials | `[!]` BLOCKED | Blocker BL-06 |

### A.3 Environments and operations

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0-20 | Environment configuration and validation (local) | `[ ]` NOT STARTED | NONE |
| P0-21 | Secrets management approach | `[ ]` NOT STARTED | NONE |
| P0-22 | Staging environment | `[!]` BLOCKED | Blocker BL-01 |
| P0-23 | Production environment design | `[ ]` NOT STARTED | NONE — design work is unblocked; provisioning is BL-02 |
| P0-24 | Production environment provisioning | `[!]` BLOCKED | Blocker BL-02 |
| P0-25 | Structured logging | `[ ]` NOT STARTED | NONE |
| P0-26 | Error monitoring service | `[!]` BLOCKED | Blocker BL-03 |
| P0-27 | Metrics and health endpoints | `[ ]` NOT STARTED | NONE |
| P0-28 | Deployment pipeline and rollback path | `[!]` BLOCKED | Blocker BL-09 |

### A.4 Platform conventions

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0-29 | API conventions (versioning, errors, pagination, idempotency headers) | `[ ]` NOT STARTED | NONE |
| P0-30 | Event conventions (naming, envelope, idempotency key, versioning) | `[ ]` NOT STARTED | NONE |
| P0-31 | Error taxonomy and user-facing error experience (v1 §82) | `[ ]` NOT STARTED | NONE |
| P0-32 | Observability conventions (correlation ids, tracing) | `[ ]` NOT STARTED | NONE |

### A.5 Foundation capability

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| P0-33 | Authentication (see K-02) | `[~]` IN PROGRESS | K-02's core is delivered (FND-004c): append-only bindings and evidence, an assertion consumed exactly once by constraint, factor categories with a per-provider MFA floor that may be raised and never lowered, and sessions whose secret is presented once and stored only as a SHA-256, with absolute and idle expiry, guarded rotation and revocation that refuse a stale caller, and exact-idempotency convergence that hands a retry a spent token. Authentication is performed by **asking an injected verifier and checking its answer**; a request that states an outcome is refused by name. **Not complete: no verifier ships**, so nothing here can authenticate a real person — no password checking, no OAuth or OIDC, no passkey, no TOTP, no email or SMS delivery. No API, no UI, no cookie or CSRF handling, no rate limiting or lockout, no recovery flow, no registration path, no permissions (K-04), no audit record (K-09), no event (K-08), no unit consuming a session, and nothing applied to a live server. Evidence [§11.25](./CURRENT_IMPLEMENTATION_STATUS.md#1125-evidence--fnd-004c-k-02-authentication-foundation) |
| P0-34 | Permissions framework (see K-04) | `[~]` IN PROGRESS | K-04's core is delivered (FND-004d): a deny-by-default authorisation core that resolves the subject through an injected K-02 session port it re-checks itself and the account through K-03, with immutable numbered policy versions, explicit allow and deny grants scoped to account/resource/action, deny precedence, least privilege, temporal validity, append-only revocation, typed ABAC predicates over an allowlisted context, mandatory declared purpose for staff roles (v3 §5.3), account isolation, deterministic decision explanations, exact idempotency and concurrency-safe grant/revoke. The role vocabulary is the guide's with **no role-to-authority mapping in code**; `SUPER_ADMIN` confers nothing and there is no bypass; `AI_AGENT` may hold only explicitly granted tool capabilities and can never grant permissions or be authoritative for financial or permission decisions (v3 §38). Corrected three times after review ([§11.27](./CURRENT_IMPLEMENTATION_STATUS.md#1127-correction--fnd-004d-idempotency-was-a-bearer-token-for-somebody-elses-answer), [§11.28](./CURRENT_IMPLEMENTATION_STATUS.md#1128-correction--fnd-004d-authority-administration-was-unauthenticated-and-self-asserted), [§11.29](./CURRENT_IMPLEMENTATION_STATUS.md#1129-correction--fnd-004d-the-read-surface-and-a-migration-corrupted-by-its-own-edit)): administering permissions now requires an authenticated, account-resolved, explicitly authorised administrator whose identity is derived from the session rather than supplied, and the three unauthenticated read methods are removed, leaving a surface of exactly four operations. **Not complete: nothing calls it**, so no path is guarded — no API, no UI, no policy studio, no operational role matrix, no business-module action registration, no delegation or groups, no audit record (K-09), no event (K-08), no way to read authority back, and nothing applied to a live server. Evidence [§11.26](./CURRENT_IMPLEMENTATION_STATUS.md#1126-evidence--fnd-004d-k-04-permissions-foundation) |
| P0-35 | Event infrastructure (see K-08) | `[~]` IN PROGRESS | Envelope and versioned type registry, append-only log, per-subscription delivery with at-least-once semantics, consumer receipts, deterministic bounded retry, terminal dead-lettering and operator-explicit replay, plus migration 0004 under `kernel_event_infrastructure`. 82 deterministic tests including concurrency, crash-window, commit-conflict and replay cases. Corrected after review ([§11.15](./CURRENT_IMPLEMENTATION_STATUS.md#1115-correction--fnd-003b-concurrency-parity-and-transaction-composition)): the reference implementation now refuses every uniqueness conflict PostgreSQL does, concurrent identical retries converge on the original event, and `PostgresEventRepository.enlist(client)` lets a producer append inside its own transaction. **Not complete:** no producing or consuming module actually uses any of it, no broker binding, and nothing applied to a live server. Evidence [§11.14](./CURRENT_IMPLEMENTATION_STATUS.md#1114-evidence--fnd-003b-k-08-event-infrastructure-foundation) |
| P0-36 | Audit framework (see K-09) | `[~]` IN PROGRESS | An immutable audit-record contract with a registered action set, classified structured evidence, content fingerprinting, idempotent recording with convergent concurrent retries, and deterministic filtered retrieval with stable `(recordedAt, recordId)` pagination. No update or delete exists in the service, the port or the adapter, and migration 0005 refuses both by trigger. 81 deterministic tests plus six opt-in live ones. Corrected after review ([§11.20](./CURRENT_IMPLEMENTATION_STATUS.md#1120-correction--fnd-003c-immutability-boundary-persisted-integrity-and-the-actor-check)) for a record whose actor and resource were writable through any returned reference, a stored fingerprint trusted rather than recomputed on decode, and an actor `CHECK` that permitted a claimed authenticated session the service refuses. **Not complete:** no unit records an audit record, no authentication, no entitlement check on retrieval, no retention or erasure mechanism, and nothing applied to a live server — the append-only trigger has never refused anything. Evidence [§11.19](./CURRENT_IMPLEMENTATION_STATUS.md#1119-evidence--fnd-003c-k-09-audit-foundation) |
| P0-37 | Feature flags (see K-07) | `[~]` IN PROGRESS | K-07's core is delivered (FND-004e): immutable versioned definitions, the v3 §36 rollout stages, a guarded activation chain, an emergency kill switch that outranks every version, bounded windows, hierarchical scopes, deterministic percentage rollout and allowlisted typed targeting, all failing closed to off. **Not complete: no unit evaluates a flag**, so nothing is gated; no API, no UI, no control plane, no K-02 authentication or K-04 authorisation behind administration, no audit (K-09), no events (K-08), and nothing applied to a live server — the opt-in live suite skips, and a skipped run is not evidence of anything. Evidence [§11.30](./CURRENT_IMPLEMENTATION_STATUS.md#1130-evidence--fnd-004e-k-07-feature-flags-foundation) |
| P0-38 | Configuration and policy engine (see K-05, K-06) | `[~]` IN PROGRESS | Both cores are delivered: K-05 Configuration (FND-003a) and K-06 Policy Engine (FND-005b). The financial policy values K-05 refuses now have somewhere to land — K-06 holds them as versioned rule sets with exact decimals, and every evaluation returns the version id a transaction pins. **Not complete: nothing evaluates a policy**, no API, no studio, no approval workflow, no audit (K-09), no events (K-08), and nothing applied to a live server. Evidence [§11.10](./CURRENT_IMPLEMENTATION_STATUS.md#1110-evidence--fnd-003a-k-05-configuration-foundation) and [§11.31](./CURRENT_IMPLEMENTATION_STATUS.md#1131-evidence--fnd-005b-k-06-policy-engine-foundation) |
| P0-39 | AI provider abstraction / AI Gateway (see K-13) | `[~]` IN PROGRESS | K-13 core is delivered (FND-005e): task registry, model bindings, deterministic routing, mock provider execution, cost capture, AI decision recording, idempotency, append-only records, foreign-field refusal, in-memory and PostgreSQL adapters, migration 0019 under `kernel_ai_gateway` with append-only triggers on the four business tables and the character-for-character `is_opaque_identifier` rule copied into the schema. **Not complete: no live provider adapter ships** (blocked by BL-04), no unit evaluates a task, no API, no UI, no audit (K-09) consumer wired, no events (K-08) consumer wired, and nothing applied to a live server. Evidence [§11.35](./CURRENT_IMPLEMENTATION_STATUS.md#1135-evidence--fnd-005e-k-13-ai-gateway) |
| P0-40 | Live AI provider credentials for at least one adapter | `[!]` BLOCKED | Blocker BL-04 |
| P0-41 | Design system foundation (v3 §34) | `[ ]` NOT STARTED | NONE |
| P0-42 | Test infrastructure for integration, E2E and adversarial suites | `[ ]` NOT STARTED | NONE |

### A.6 Phase 0 exit gate

| ID | Gate | Status |
|---|---|---|
| P0-G1 | All Phase 0 items `[x]` or explicitly `[-]`/`[o]` with reason | `[ ]` NOT STARTED |
| P0-G2 | All foundation tests pass | `[ ]` NOT STARTED |
| P0-G3 | Boundary enforcement checks green in CI | `[ ]` NOT STARTED |
| P0-G4 | No P0 or P1 defects open | `[ ]` NOT STARTED |
| P0-G5 | `CURRENT_IMPLEMENTATION_STATUS.md` accurate as of gate | `[ ]` NOT STARTED |

---

## B. Commerce kernel components

Each kernel component needs a contract document (v3 §10) and an implementation meeting the v3 §55 Definition of Done. Both are tracked. **No item here may reach `[x]` on the strength of a live-database suite that skipped: a skipped run is not evidence**, and every one of them skips today because no PostgreSQL runtime is available to this repository. **Fourteen** components — K-01, K-02, K-03, K-04, K-05, K-06, K-07, K-08, K-09, K-10, K-12, K-13, K-14 and K-15 — have a `COMPLETE` contract and an `IN PROGRESS` implementation; **none is complete**, and the remaining one is `NOT STARTED`. Build steps B-1 and B-2 are both covered, and K-06, K-10, K-12, K-13, K-14 and K-15 open B-3.

| ID | Component | Contract | Implementation | Build step |
|---|---|---|---|---|
| K-01 | Identity | `[x]` COMPLETE — [`kernel/identity/CONTRACT.md`](../kernel/identity/CONTRACT.md) | `[~]` IN PROGRESS — stable opaque internal handles for parties: a closed three-kind registry (`person`, `organisation`, `system`, and no role, per guide §4), caller-supplied ids and canonical UTC instants, immutable write-once creation records, exact idempotent retry with concurrent convergence, deterministic lookup by id, injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0006 with a write-once trigger. Natural- and PII-shaped identifiers, credential-shaped values, AI-authored identities and every field belonging to K-02/K-03/K-04 or a profile are refused **by name** rather than ignored. Corrected after review ([§11.22](./CURRENT_IMPLEMENTATION_STATUS.md#1122-correction--fnd-004a-persisted-identity-validation-and-the-migrations-opacity-claim)): one shared validator now judges stored rows by exactly the creation rules, and the migration's constraints call one SQL rule set on all three identifier columns instead of admitting domains, personal names, compact document numbers and 10–11 digit telephone numbers that its comments claimed to prohibit. **No unit creates an identity subject** — K-03 will be the first consumer — and there is no API, no UI, no authentication behind `origin`, no permission check, no audit record, no merge or deactivation, and nothing applied to a live server: the write-once trigger has never refused anything. Evidence [§11.21](./CURRENT_IMPLEMENTATION_STATUS.md#1121-evidence--fnd-004a-k-01-identity-foundation) | B-2 |
| K-02 | Authentication (incl. MFA support, secure sessions) | `[x]` COMPLETE — [`kernel/authentication/CONTRACT.md`](../kernel/authentication/CONTRACT.md) | `[~]` IN PROGRESS — authentication by **asking an injected verifier and checking its answer**, never by believing a caller: `authenticated`, `verified`, `factors`, `assurance`, `assertion` and eleven more are refused **by name**, as are raw credentials and any attempt to choose a session secret. Append-only bindings and evidence; an assertion consumed exactly once by `UNIQUE (provider, assertion_id)` rather than by a read; factor **categories** counted as a set with a per-provider MFA floor that may be raised and never lowered; sessions whose secret is presented once through a token that redacts itself and stored only as a SHA-256, with absolute and idle expiry where rotation moves the idle one and never the absolute one. Rotation and revocation are guarded updates: a stale caller loses rather than clobbering, and a transaction whose guard loses at commit is refused whole. Exact-idempotency convergence requires a complete match — every non-secret request field, the provider reference read from the binding, the three records naming each other, the duplicated assurance and canonical factor set, and the issuance chronology — and anything short of it preserves the original refusal. Injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0008 whose write-once triggers and session-rewrite guard refuse what the port has no operation for. **The second real consumer of K-01**, through the same one-method lookup K-03 uses. **Not complete: no verifier ships** — no password checking, no OAuth or OIDC, no passkey, no TOTP, no email or SMS delivery — so nothing here can authenticate a real person; and there is no API, no UI, no cookie or CSRF handling, no rate limiting or lockout, no recovery, no registration, no permissions (K-04), no audit (K-09), no events (K-08), no caller for the enlisted path, and nothing applied to a live server: the opt-in K-02 live suite skips. Evidence [§11.25](./CURRENT_IMPLEMENTATION_STATUS.md#1125-evidence--fnd-004c-k-02-authentication-foundation) | B-2 |
| K-03 | Accounts (one universal JAYA Account) | `[x]` COMPLETE — [`kernel/accounts/CONTRACT.md`](../kernel/accounts/CONTRACT.md) | `[~]` IN PROGRESS — one universal account per K-01 subject and nothing else: no capability, role, verification level, profile field, credential, persona or balance, each refused **by name** with the component that owns it (57 mapped field names). Immutable subject linkage, caller-supplied opaque ids and canonical UTC instants, exact idempotent retry with concurrent convergence, deterministic lookup by account and by subject, and a one-account-per-subject invariant enforced in the service, in the reference repository at commit, and by `UNIQUE (subject_id)` in migration 0007. **The first real consumer of another kernel component:** K-01 is consulted through an injected one-method lookup, with no foreign key and no SQL reaching `kernel_identity` — a decision recorded with its cost (no database-level referential guarantee) rather than glossed. **No unit opens an account**, and there is no API, no UI, no authentication behind `origin`, no permission check, no profile core, no capability model, no events, no audit record, no closure/relink/merge, and nothing applied to a live server: `UNIQUE (subject_id)` has never refused an insert. Corrected after review ([§11.24](./CURRENT_IMPLEMENTATION_STATUS.md#1124-correction--fnd-004b-convergence-under-whichever-constraint-postgresql-picks)): retry convergence now depends on the content of the account rather than on which unique index PostgreSQL happened to report, and a non-identical opening preserves its original domain refusal. Evidence [§11.23](./CURRENT_IMPLEMENTATION_STATUS.md#1123-evidence--fnd-004b-k-03-universal-account-foundation-and-the-first-real-k-01-consumer) | B-2 |
| K-04 | Permissions (RBAC/ABAC, purpose-based staff access) | `[x]` COMPLETE — [`kernel/permissions/CONTRACT.md`](../kernel/permissions/CONTRACT.md) | `[~]` IN PROGRESS — a deny-by-default authorisation core that **never asks the caller**: `allowed`, `effect`, `subjectId`, `role`, `permissions`, `purposeSatisfied`, `bypass`, `superAdmin` and eleven more are refused **by name** before the session is even validated. The subject comes from an injected K-02 session port whose assertion is **re-checked here** (revoked, either expiry, unknown assurance — all refused), and the account from K-03's public contract, with the request's account required to be the one the subject holds before any grant is read. Immutable numbered policy versions; explicit allow and deny grants scoped to account, resource and action; deny precedence over every allow; least privilege by omission; temporal validity; append-only revocation with one revocation per grant; six typed ABAC predicate kinds over an allowlisted context; mandatory declared purpose for the seven staff roles and refused for the others (v3 §5.3); deterministic decision records carrying the reason, the deciding grant and the policy version. The role vocabulary is the v1.0 guide §52 list with **no role-to-authority mapping in code** — what a role may do is a published, numbered policy version — so `SUPER_ADMIN` confers nothing and has no code path, and `AI_AGENT` may hold only `invoke-tool` on `tool`, never authority over authority or anything financial (v3 §38). Injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0009 whose four append-only triggers refuse every `UPDATE` and `DELETE`. Corrected **three times** after review, all three security corrections: an idempotency key was a bearer token for somebody else's stored decision ([§11.27](./CURRENT_IMPLEMENTATION_STATUS.md#1127-correction--fnd-004d-idempotency-was-a-bearer-token-for-somebody-elses-answer)); `publishPolicy`, `grant` and `revoke` were **unauthenticated and self-asserting their own author**, so any caller could grant itself anything and sign it in somebody else's name ([§11.28](./CURRENT_IMPLEMENTATION_STATUS.md#1128-correction--fnd-004d-authority-administration-was-unauthenticated-and-self-asserted)); and `findGrant`, `findDecision` and `activePolicy` returned authority data to anybody holding an identifier ([§11.29](./CURRENT_IMPLEMENTATION_STATUS.md#1129-correction--fnd-004d-the-read-surface-and-a-migration-corrupted-by-its-own-edit)). Administration now authenticates through the K-02 port, resolves the K-03 account, **derives authorship from that binding** and requires an explicit administration grant, with one enumerated bootstrap authority that is injected rather than requested, refuses by default, applies to `publishPolicy` alone, works only on an empty store and leaves permanent evidence. The read methods are **removed rather than guarded**: the public surface is exactly four operations — `publishPolicy`, `grant`, `revoke`, `authorize` — and **no way to read authority back**, asserted by a public-surface regression that also refuses any replacement named like a read. **Not complete: nothing calls it**, so no path in this repository is guarded and every decision so far is about a subject a test created; K-02 ships no verifier, so no real session has reached it. There is **no way for a caller to read a grant, a decision or a policy version**, and no authorised read to replace it. No API, no UI, no policy studio, no operational role matrix, no business-module actions, no delegation or groups, no retention of decision records, no audit (K-09), no events (K-08). **Nothing applied to a live server:** migration 0009 — repaired to 374 lines after being committed syntactically invalid, which every static gate passed over because none parses SQL (§11.29) — its four append-only triggers, its bootstrap `CHECK`, its single-bootstrap-row index and every other constraint are declared and unproven, and the opt-in live suite skips. Evidence [§11.26](./CURRENT_IMPLEMENTATION_STATUS.md#1126-evidence--fnd-004d-k-04-permissions-foundation) | B-2 |
| K-05 | Configuration | `[x]` COMPLETE — [`kernel/configuration/CONTRACT.md`](../kernel/configuration/CONTRACT.md) | `[~]` IN PROGRESS — registry, immutable versions, an explicit draft→active lifecycle (`createDraft` then `publishDraft`), effective-time resolution, optimistic concurrency, content-matched idempotent publication, scoped overrides with an explicitly supplied region, decision pinning, injected repository port with in-memory and PostgreSQL adapters, and migration 0003 under `kernel_configuration`. Corrected after review in two passes — four lifecycle and idempotency defects ([§11.11](./CURRENT_IMPLEMENTATION_STATUS.md#1111-correction--fnd-003a-lifecycle-replacement-ordering-idempotency-and-scope-inference)), including a replacement order that would have violated the partial unique index on every live run, then three more covering text-compared instants, a publication race that leaked a raw driver error, and a retry after supersession reported as a failure ([§11.12](./CURRENT_IMPLEMENTATION_STATUS.md#1112-correction--fnd-003a-canonical-instants-publication-races-and-retries-after-supersession)), then timestamps projected as deterministic UTC text so the driver's `Date` parser cannot discard microseconds ([§11.13](./CURRENT_IMPLEMENTATION_STATUS.md#1113-correction--k-05-postgresql-temporal-fidelity)). **No API, no UI, no events, no enforced RBAC, no audit trail** (K-02/K-04/K-08/K-09), and the migration has never been applied to a live server. Evidence [§11.10](./CURRENT_IMPLEMENTATION_STATUS.md#1110-evidence--fnd-003a-k-05-configuration-foundation) | B-1 |
| K-06 | Policy Engine (versioned, history-preserving) | `[x]` COMPLETE — [`kernel/policy-engine/CONTRACT.md`](../kernel/policy-engine/CONTRACT.md) | `[~]` IN PROGRESS — versioned business policy where **every successful evaluation returns the policy version id that produced it**, which is what makes v3 §35's "historic transactions retain the policy version originally applied" and v3 §24's "every transaction stores the exact commission policy version applied at purchase time" keepable by a caller. An explicit **draft → publish → activate → retire** lifecycle, each step a separate append: a draft can never be evaluated, the publish request carries no rules so what goes live is what was reviewed, activation is guarded so two operators cannot both win, and retirement stops new evaluations without erasing the versions historic decisions are pinned to. Immutable numbered versions, bounded effective windows refused when they contain no instant, a scope hierarchy (country → category → sellerTier → seller) whose precedence is **specificity with ties refused** rather than resolved by row order, six literal predicate shapes with no arithmetic and no way to express executable code, bounded depth/breadth/rule count, and five allowlisted facts none of which describes a person. **No floating point exists anywhere in the component:** rates, thresholds and amounts are exact `{ units, scale }` decimals compared through `BigInt` and carried as text end to end, and the migration is asserted to declare no `double precision`, `real` or `money` column. Explicit defaults apply only where a version declares them — there is no implicit zero. K-05 is read **only** for a declared `configured` output, through its public contract, with the configuration version pinned beside the policy version and an unresolvable key refusing the evaluation. Injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0011 whose four append-only triggers and two partial unique indexes refuse what the port has no operation for. **Not complete: nothing evaluates a policy**, so no amount has been priced by one and no record has yet pinned a version id. No API, no UI, **no policy studio** (M-43), no approval workflow, no simulation or diff, **no K-02 authentication and no K-04 authorisation behind authoring** (the injected authority is the honest placeholder, so who changed a commission rate is recorded as a deployment capability rather than a person), no audit (K-09), no events (K-08), and nothing applied to a live server: the opt-in K-06 live suite skips. Evidence [§11.31](./CURRENT_IMPLEMENTATION_STATUS.md#1131-evidence--fnd-005b-k-06-policy-engine-foundation) | B-3 |
| K-07 | Feature Flags (OFF → internal → selected → percentage → full, kill switches) | `[x]` COMPLETE — [`kernel/feature-flags/CONTRACT.md`](../kernel/feature-flags/CONTRACT.md) | `[~]` IN PROGRESS — a deployment control that is **nothing else**: a flag key naming authority, money, an entitlement, an experiment or AI autonomy is refused at publication with the owning component named, in the service **and** by a database `CHECK`, and `enabled`, `bucket`, `variant`, `allowed`, `role` and `price` are refused by name so a caller cannot state the answer. v3 §36's stages as one model: `off`, `internal-only` (resolved through K-05's public contract, one registered key, and **off** when the stage cannot be resolved), `targeted` over four allowlisted typed attributes, `percentage` bucketed by SHA-256 over an opaque non-PII subject key, and `on`. Immutable numbered definitions, a **guarded append-only activation chain** where a second operator loses rather than clobbering, an **emergency kill switch checked before any version is read** and reversible only by a new flag key, bounded activation windows, and hierarchical supported scopes. **Every uncertainty fails closed to off** — unknown flag, retired flag, unsupported scope, missing context, missing subject key, unresolvable stage. Evaluation is pure and **records nothing**, which is deliberate; administration takes no author from the caller and is gated by an injected authority that **defaults to refusing**. The surface is five operations — `publish`, `activate`, `kill`, `retire`, `evaluate` — with no update, no delete and no override anywhere. Injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0010 whose three append-only triggers and two partial unique indexes refuse what the port has no operation for. **Not complete: nothing evaluates a flag**, so no code path in this repository is actually gated. No API, no UI, no flag console, no control plane or propagation, no per-scope overrides, no flag dependencies, **no K-02 authentication and no K-04 authorisation behind administration** (the injected authority is the honest placeholder, so who killed a flag is recorded as a deployment capability rather than a person), no audit (K-09), no events (K-08) — so killing a flag alerts nobody — and nothing applied to a live server: the opt-in K-07 live suite **skips**, and a skipped run is not evidence of anything. Evidence [§11.30](./CURRENT_IMPLEMENTATION_STATUS.md#1130-evidence--fnd-004e-k-07-feature-flags-foundation) | B-2 |
| K-08 | Event Infrastructure (idempotency, retries, DLQ, replay) | `[x]` COMPLETE — [`kernel/event-infrastructure/CONTRACT.md`](../kernel/event-infrastructure/CONTRACT.md) | `[~]` IN PROGRESS — provider-neutral envelope with correlation/causation, versioned event-type and subscription registries, durable append fanned out in one transaction, `FOR UPDATE SKIP LOCKED` claiming with per-claim lease tokens, consumer receipts for idempotency, deterministic bounded backoff, terminal dead-lettering, generation-appending replay, injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0004. Corrected after review ([§11.15](./CURRENT_IMPLEMENTATION_STATUS.md#1115-correction--fnd-003b-concurrency-parity-and-transaction-composition)) for commit-time conflict parity, convergent concurrent retries and a transaction-scoped append path that refuses nested transaction control. **No broker SDK, no API, no UI, no business events, no module integration, no audit** (K-02/K-04/K-09), and the migration has never been applied to a live server — the `SKIP LOCKED` claim statement has never executed. Evidence [§11.14](./CURRENT_IMPLEMENTATION_STATUS.md#1114-evidence--fnd-003b-k-08-event-infrastructure-foundation) | B-1 |
| K-09 | Audit Foundation (append-only) | `[x]` COMPLETE — [`kernel/audit-foundation/CONTRACT.md`](../kernel/audit-foundation/CONTRACT.md) | `[~]` IN PROGRESS — provider-neutral immutable record with caller-supplied id and canonical UTC instant, an authenticated-actor placeholder refused into honesty (`unauthenticated` and a null session are the only permitted values until K-02), registered actions with owner, authority and classified evidence fields, content fingerprinting, idempotent recording, deterministic filtered retrieval with stable pagination, injected port with in-memory, PostgreSQL and transaction-enlisted implementations, and migration 0005 whose append-only trigger and exact actor `CHECK`s refuse what the service refuses. Every record crossing a boundary is deep-frozen and severed from the caller's objects, and every row decoded from PostgreSQL has its fingerprint recomputed and is refused on mismatch ([§11.20](./CURRENT_IMPLEMENTATION_STATUS.md#1120-correction--fnd-003c-immutability-boundary-persisted-integrity-and-the-actor-check)). **No producer records anything** — not K-05, not K-08, not any financial module — and there is no API, no UI, no authentication, no entitlement check, no retention mechanism, and nothing applied to a live server. Evidence [§11.19](./CURRENT_IMPLEMENTATION_STATUS.md#1119-evidence--fnd-003c-k-09-audit-foundation) | B-2 |
| K-10 | Ledger Foundation (double-entry primitives) | `[x]` COMPLETE — [`kernel/ledger-foundation/CONTRACT.md`](../kernel/ledger-foundation/CONTRACT.md) | `[~]` IN PROGRESS — asset-type registry, ledger accounts, balanced double-entry transactions and derived balances; every amount is an exact integer in minor units, no floating point exists anywhere, and a deferred trigger refuses unbalanced, negative, mixed-asset-type or unknown-account transactions at commit. In-memory reference repository and PostgreSQL adapter, migration 0017 with append-only triggers on all four history tables and the character-for-character `is_opaque_identifier` rule copied into the schema. **Nothing calls it**, so no value has moved; no API, no UI, no caller, no audit record (K-09), no event consumer (K-08), and nothing applied to a live server. Evidence [§11.33](./CURRENT_IMPLEMENTATION_STATUS.md#1133-evidence--fnd-005c-k-10-ledger-foundation) | B-3 |
| K-11 | Commerce Unit Registry (`CommerceUnit`, units of measure, category adapters) | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-3 |
| K-12 | Conversation Foundation (`conversation`, `participant`, `message`, outbox) | `[x]` COMPLETE — [`kernel/conversation-foundation/CONTRACT.md`](../kernel/conversation-foundation/CONTRACT.md) | `[~]` IN PROGRESS — conversation, participant and message primitives for a Telegram-like UX, with idempotent creation, one account per conversation, unknown-conversation and unknown-participant refusal, append-only records, deterministic caller-supplied identifiers and instants, an injected repository port with in-memory and PostgreSQL adapters, and migration 0018 under `kernel_conversation_foundation` with append-only triggers on the three history tables and the character-for-character `is_opaque_identifier` rule copied into the schema. Foreign fields are refused by name, so AI providers, business modules, profile data and financial amounts cannot be smuggled into a conversation record. `createConversation` and `sendMessage` each emit one K-08 event and one K-09 audit record through the module-owned outbox. **No unit creates a conversation**, and nothing calls it; no API, no UI, no profile core, no attachments, no read receipts, no search, no moderation, and nothing applied to a live server. | B-3 |
| K-13 | AI Gateway (sole provider boundary, task router, fallbacks, cost/latency capture) | `[x]` COMPLETE — [`kernel/ai-gateway/CONTRACT.md`](../kernel/ai-gateway/CONTRACT.md) | `[~]` IN PROGRESS — task registry, model bindings, AI runs and AI decisions with deterministic mock-provider execution, cost capture, idempotent creation, append-only records, deterministic caller-supplied identifiers and instants, an injected repository port with in-memory and PostgreSQL adapters, and migration 0019 under `kernel_ai_gateway` with append-only triggers on the four business tables and the character-for-character `is_opaque_identifier` rule copied into the schema. Foreign fields are refused by name, so business modules, profile data and financial amounts cannot be smuggled into a gateway record. `executeTask` and `recordDecision` each emit one K-08 event and one K-09 audit record through the module-owned outbox. **No live provider adapter ships** (blocked by BL-04), **no unit executes a task**, and nothing calls it; no API, no UI, no fallbacks, no latency tracking, no model registry integration, and nothing applied to a live server. | B-3 |
| K-14 | Notifications (channel-neutral templated delivery) | `[x]` COMPLETE — [`kernel/notifications/CONTRACT.md`](../kernel/notifications/CONTRACT.md) | `[~]` IN PROGRESS — FND-005g. Channel-neutral delivery of templated notifications with an in-app provider, idempotent channel creation, send, schedule and delivery-attempt recording, append-only channel and delivery-attempt tables, notification lifecycle (`pending`/`sent`/`failed`/`scheduled`), deterministic caller-supplied identifiers and instants, an injected repository port with in-memory and PostgreSQL adapters, and migration 0020 under `kernel_notifications` with append-only triggers on the channel and delivery-attempt tables and the character-for-character `is_opaque_identifier` rule copied into the schema. Foreign fields are refused by name, so business-module identifiers, profile data, lifecycle state and financial amounts cannot be smuggled into a notification record. `send` and `recordDeliveryAttempt` each emit one K-08 event and one K-09 audit record through the module-owned outbox. **No live email/SMS/push/WhatsApp provider adapter ships** (blocked by BL-07), **no business module sends a notification**, and nothing calls it; no API, no UI, no attachment handling, no scheduling worker, no template service integration, and nothing applied to a live server. | B-3 |
| K-15 | Search Foundation | `[x]` COMPLETE — [`kernel/search-foundation/CONTRACT.md`](../kernel/search-foundation/CONTRACT.md) | `[~]` IN PROGRESS — search document and query-log primitives, keyword full-text search with a generated `tsv` tsvector, idempotent indexing and query logging, foreign-field refusal, append-only query log, deterministic caller-supplied identifiers and instants, an injected repository port with in-memory and PostgreSQL adapters, and migration 0021 under `kernel_search_foundation` with the character-for-character `is_opaque_identifier` rule copied into the schema. `index`, `query` and `remove` each emit one K-08 event and one K-09 audit record through the module-owned outbox. **No caller indexes or searches anything**, and nothing calls it; no API, no UI, no live consumer, no semantic/vector search, and nothing applied to a live server. | B-3 |

---

## C. Business modules

47 independently owned modules from [MODULE_MAP.md](./MODULE_MAP.md) §4. Each needs a contract and an implementation. **Four of the 47 have a foundation** — M-01 Universal Account, the first module to own a schema, M-02 Capability & Verification, M-04 Universal Listing (listing and inventory halves), and M-11 Orders (including split supplier fulfilment). The other 43 are `NOT STARTED`.

| ID | Module | Layer | Contract | Implementation | Build step |
|---|---|---|---|---|---|
| M-01 | Universal Account | L1 | `[x]` COMPLETE — [`modules/universal-account/CONTRACT.md`](../modules/universal-account/CONTRACT.md) | `[~]` IN PROGRESS — **the first business module, and the first module-owned schema.** Which capabilities an account holds, over a closed vocabulary (`buyer`, `seller`, `host`, `provider`, `introducer`, `driver`, `business-purchaser`): `account_capability` carries the current status of one role with `UNIQUE (account_id, capability)` making "one active role per account" a database fact, and `capability_state` carries the append-only log of how it got there, enforced by a trigger. Activation is idempotent by key and reactivates a deactivated capability **in place**, so a consumer that stored a `capabilityId` keeps a valid handle for the whole life of the role; each fact writes the row, the transition, one K-08 event and one K-09 audit record in a single transaction. Caller-supplied opaque ids and canonical UTC instants, sealed records, an injected port with in-memory and PostgreSQL adapters, and migration 0024 with the character-for-character `is_opaque_identifier` rule copied into the schema. `accountId` is an opaque K-03 id with **no foreign key and no SQL reaching `kernel_accounts`** — the same trade K-03 made against K-01, recorded in the contract with its cost. Verification levels are refused **by name** as belonging to M-02. Two defects were found by writing the suites rather than by reading the code and are fixed: an outbox id derived from the capability id collided with itself on a second activation, and a whitespace-only reason passed the TypeScript validator and would have been refused by the migration's `btrim` CHECK. **Not complete: nothing calls it** — no API, no UI, no consumer of either event, no `suspend` operation, no K-02 authentication and no K-04 authorisation behind activation, and no account-existence check. 32 unit tests and 6 live-PostgreSQL integration tests, in which the trigger, the unique constraint, the status/timestamp CHECK and the opacity rule each actually refused a statement. | B-5 |
| M-02 | Capability & Verification | L1 | `[x]` COMPLETE — [`modules/capability-verification/CONTRACT.md`](../modules/capability-verification/CONTRACT.md) | `[~]` IN PROGRESS — how far the platform has checked a claim, and the evidence behind it. Ordered levels (`none` → `basic` → `standard` → `enhanced` → `full`) compared **by rank rather than as strings**; `verification_case` carrying the level requested and the level reached, with an append-only `level_record` log behind it and an append-only `evidence` table beside it. One *open* case per `(account, purpose)`, enforced in the service, in the reference repository at commit, and by a **partial** unique index — partial precisely so a decided or withdrawn case cannot block the next attempt. `evaluateLevel` refuses `level-regression`: standing is removed by a new case with its own evidence, never by editing the record that granted it. `seller.verified` — the event MODULE_MAP names as M-02's — is emitted from the level decision itself, so it cannot be raised without a case behind it. **Evidence holds an opaque reference to an artefact another system stores, never the artefact**: the reference runs through the same `is_opaque_identifier` rule set as every id, in the service and again as a database `CHECK`, which is what refuses an email, a passport-shaped digit run, an IBAN, a document URL and anything credential-shaped. A verification record outlives the thing it verifies. Migration 0025, an injected port with in-memory and PostgreSQL adapters, and refusal by name for M-01's `capability` — the two are the same layer and communicate by event. Two defects were found while writing the suites and are fixed: rejection emitted nothing at all, so a refusal was visible only in a status column nobody subscribes to (it now carries `verification.rejected`); and a purpose beginning with a digit passed the TypeScript validator and would have been refused by the migration's CHECK. **Not complete: nothing calls it**, and **no verifier exists** — M-02 records the level a caller says was reached and checks nothing itself: no document verification, no sanctions or PEP screening, no liveness check, no identity bureau. No API, no UI, no `withdraw` operation, no evidence expiry or re-verification schedule, no K-02 authentication and no K-04 authorisation behind approval. 42 unit tests and 7 live-PostgreSQL integration tests, in which the partial index, both append-only triggers, the status/decision CHECK and the reference opacity rule each actually refused a statement. | B-5 |
| M-03 | Item / Commerce Request | L2 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-6 |
| M-04 | Universal Listing | L2 | `[x]` COMPLETE — [`modules/universal-listing/CONTRACT.md`](../modules/universal-listing/CONTRACT.md) | `[~]` IN PROGRESS — **the listing and inventory halves.** A listing is the stable identity of an offer to supply one K-11 CommerceUnit type, and **its terms change by version, never by edit**: `UNIQUE (listing_id, version_number)` makes that pair the permanent address an order pins, and an append-only trigger stops version 3 being rewritten after an order was placed against it. The same reasoning covers `listing_declaration` — what the supplier asserted is what a dispute is judged against, and a claim that can be edited after a dispute begins is not evidence. Republishing appends a new version; **no operation edits one**, asserted by a public-surface regression. Money is `bigint` minor units, with the same three accepted forms as K-10 and **no `double precision`, `real`, `float` or `money` column** anywhere in migration 0026, asserted over the stripped statements; events carry amounts as strings because a bigint does not survive JSON. `listing_media.reference` is an opaque handle obeying the same rule set M-02 applies to evidence — a listing outlives its media. Withdrawal is terminal. One defect was found by writing the suites: `addMedia` and `addDeclaration` did not guard against withdrawal, so a supplier could append claims to an offer that no longer existed; both now refuse. The inventory interface derives availability from an append-only `inventory_movement` log rather than a mutable counter — K-10's discipline applied to stock — with `inventory_snapshot` a cache written in the same transaction and `CHECK (reserved <= on_hand)` making the invariant a database rule. `tests/contracts/inventory.contract.test.ts` is parameterised over an implementation and reads refusal codes structurally rather than by error class, so a replacement module passes or fails it without editing the file. **Not complete: nothing calls the module** — no reservation is made by a real buyer, no stock received from a real supplier, and no consumer reads any of the nine events. No API, no UI, no verification gate against M-02, no K-11 type check, no K-02 authentication, no K-04 authorisation, no search indexing into K-15. 52 unit tests (40 listing, 12 contract) and two live-PostgreSQL integration suites. | B-7 |
| M-05 | Product Catalog | L2 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-7 |
| M-06 | Search & Discovery | L3 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-8 |
| M-07 | Matching | L3 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-8 |
| M-08 | Offers | L4 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-9 |
| M-09 | RFQ / Reverse Marketplace | L4 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-9 |
| M-10 | Quotes | L4 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-9 |
| M-11 | Orders | L5 | `[x]` COMPLETE — [`modules/orders/CONTRACT.md`](../modules/orders/CONTRACT.md) | `[~]` IN PROGRESS — the order state machine, the immutable commercial snapshot, and split supplier fulfilment. An order is an agreement, so an item pins `(listingId, versionId)` — the permanent address M-04 exists to provide — and the `OrderSnapshot` captures the agreed terms at placement; both tables are append-only by trigger, because an agreement that changes after the fact is not a record of what was agreed. The state machine is a declared table, not scattered conditionals, and cancellation is reachable from every non-terminal state since an order you cannot abandon is a trap. **Split fulfilment**: a 20-tonne order becomes a parent with one child order per supplier, `allocation-mismatch` refuses any allocation that does not sum to the ordered quantity for every pinned version, and **partial fulfilment is a derived quantity, not a status** — `getFulfilmentSummary` sums child rows, so nothing stores a ratio that drifts when a child moves. A parent completes only when every child is terminal, refuses `nothing-fulfilled` when all cancelled, and cascades cancellation to non-terminal children only. Money is `bigint` minor units with the arithmetic checked by the database as well as the service (`order_item_line_total_is_product`); no floating-point column exists. M-12/M-13/M-14 are the same layer and are refused **by name**, reaching Orders by event only; a regression asserts no source file mentions them or the AI gateway. Three defects were found by running the suites: concurrent splits both succeeded (neither repository had optimistic locking, so the same 20 tonnes could be promised twice — fixed with a conditional `UPDATE` and a commit-time guard); `order.cancelled` published only free text where a consumer needs a vocabulary word; and a split parent reaching `fulfilling` without ever being `confirmed` violated a CHECK the in-memory repository does not enforce, so **all 42 unit tests passed while every split failed against a real database**. **Not complete: nothing calls it** — no API, no UI, no consumer of any of the seven events, no M-04 inventory reservation actually taken, no K-02 authentication, no K-04 authorisation, no payment linkage (M-12 is unbuilt). 42 unit tests, 14 live-PostgreSQL integration tests, migrations 0028 and 0029. | B-10 |
| M-12 | Payments | L5 | `[x]` COMPLETE — [`modules/payments/CONTRACT.md`](../modules/payments/CONTRACT.md) | `[~]` IN PROGRESS — provider-neutral payment orchestration: request, authorise, capture, cancel, refund, and webhook receipts. The module is built around one distinction: **a decline is an answer and a timeout is not**. A declined card fails the payment; a timeout says nothing about whether the money moved, so the payment stays where it was and the caller retries under the same idempotency key — which the provider recognises as the same operation rather than a second one. Treating a timeout as a decline is how a platform charges somebody twice. Provider calls happen **outside** the transaction (a silent gateway would otherwise hold locks on payment rows for ever), and the attempt row is committed **even when the payment cannot then be moved**, because rolling back would leave money moved with nothing written down. `updatePaymentIfUnchanged` guards the status **and both running totals**: two concurrent partial refunds both leave the status unchanged, so a status-only guard would let both commit. **No instrument is ever stored** — no PAN, CVV, expiry, IBAN or cardholder name; `instrument_token` is held to K-03’s opacity rule in TypeScript and by `payment_instrument_token_opaque` in SQL, and an instrument field on a request is refused by name. `assetCode` is open to any externally settled asset (LKR, USD, BTC, USDC — never assumed to be ISO-4217) and **closed by name to the six values JAYA issues itself**, in the validator, the provider contract suite and a CHECK constraint: no rail carries a reward, and M-13 allocates those legs. `UNIQUE (provider, provider_event_id)` makes the redelivery every provider eventually sends take effect once; an out-of-order delivery is recorded as **stale, not an error**. Three defects were found by running the suites: the internal-value guardrail could never fire (the shape check ran first and every JAYA code carries an underscore, so the specific refusal was unreachable); the in-memory repository was **less safe than PostgreSQL**, losing the loser’s attempt row in a rollback where the database would have kept it; and the mock provider could not express a payment that authorises cleanly and then fails at capture, which is the sequence that matters most. **Not complete: nothing calls it** — no API, no UI, no live gateway adapter (BL-05), no M-13 consumer of `payment.captured`, no relay dispatching the outbox, no reconciliation job. 59 unit tests, 12 provider-contract tests, 11 live-PostgreSQL integration tests, migration 0030. | B-10 |
| M-13 | Financial Ledger | L5 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-10 |
| M-14 | Commission Rules | L5 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-10 |
| M-15 | Settlements | L6 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-11 |
| M-16 | Seller Payouts | L6 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-11 |
| M-17 | Seller Risk | L6 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-11 |
| M-18 | Listing Risk / Trust & Safety | L6 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-7 |
| M-19 | Logistics | L7 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-12 |
| M-20 | Returns | L7 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-12 |
| M-21 | Disputes | L7 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-12 |
| M-22 | Warranty / Buyer Protection | L7 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-12 |
| M-23 | Accommodation | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-15 |
| M-24 | Services | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-16 |
| M-25 | Used Goods Risk Pack | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-14 |
| M-26 | Vehicle Risk Pack | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-14 |
| M-27 | Fashion / Luxury Risk Pack | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-14 |
| M-28 | Rewards (points ledger) | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-13 |
| M-29 | Referrals | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-13 |
| M-30 | Attribution | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-13 |
| M-31 | Budgeting | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-17 |
| M-32 | User Intelligence | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-17 |
| M-33 | Seller Market Intelligence | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-18 |
| M-34 | Finance Provider Marketplace | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-19 |
| M-35 | Conversation Supervision | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-5 shell, B-21 full |
| M-36 | User Cockpit | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-5 shell |
| M-37 | Seller Cockpit | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-5 shell |
| M-38 | Operations Cockpit | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-5 shell |
| M-39 | AI Model Registry | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-20 |
| M-40 | AI Routing / Control Plane | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-20 |
| M-41 | AI Decision Audit | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-20 |
| M-42 | AI Monitoring | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-20 |
| M-43 | Policy / Configuration Studio | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-21 |
| M-44 | Feature Flags / Rollouts UI | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-21 |
| M-45 | Analytics / Platform Intelligence | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-22 |
| M-46 | Admin Audit | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-22 |
| M-47 | Module Registry / Health | L8 | `[ ]` NOT STARTED | `[ ]` NOT STARTED | B-22 |

---

## D. Phases 1–18 — major requirements

Phase structure from v3 §59. Every phase and every major requirement below is `NOT STARTED` unless marked otherwise. Phase exit requires the v3 §47 Level 3 checks: cross-module E2E, regression, security review, adversarial review, and data/migration checks.

### Phase 1 — Universal Account + Cockpit Foundations

| ID | Requirement | Status |
|---|---|---|
| P1-01 | One universal JAYA Account (v3 §4) | `[ ]` NOT STARTED |
| P1-02 | Capability model (buyer, seller, supplier, host, guest, service provider, business purchaser, introducer, delivery provider) | `[ ]` NOT STARTED |
| P1-03 | Capability activation with per-capability verification requirements | `[ ]` NOT STARTED |
| P1-04 | Shared identity, auth, profile, conversations, payment history, rewards, reputation, preferences, disputes, AI memory, settings, permissions across capabilities | `[ ]` NOT STARTED |
| P1-05 | User cockpit shell (adaptive, not everything-at-once) | `[ ]` NOT STARTED |
| P1-06 | Seller cockpit shell | `[ ]` NOT STARTED |
| P1-07 | Operations cockpit shell with role-based, purpose-based, audited access | `[ ]` NOT STARTED |
| P1-08 | Shared navigation | `[ ]` NOT STARTED |
| P1-09 | Conversation foundation surfaced in UI | `[ ]` NOT STARTED |
| P1-G | Phase 1 exit gate | `[ ]` NOT STARTED |

### Phase 2 — Request / Need

| ID | Requirement | Status |
|---|---|---|
| P2-01 | Multimodal request capture: text, voice, photo, multi-photo, screenshot, video, URL, barcode/QR, document | `[ ]` NOT STARTED |
| P2-02 | AI interpretation into a structured Request | `[ ]` NOT STARTED |
| P2-03 | Request object fields (v3 §13): original input, interpretation, item/service/stay, quantity, unit, budget, max price, location, required date/time, quality, preferences, substitutes, fulfilment requirements, media, AI confidence, clarification status, matching status, RFQ status, resulting order, lifecycle state | `[ ]` NOT STARTED |
| P2-04 | Clarification loop with confidence thresholds | `[ ]` NOT STARTED |
| P2-05 | Human correction of AI interpretation | `[ ]` NOT STARTED |
| P2-06 | Request lifecycle state machine | `[ ]` NOT STARTED |
| P2-07 | Staff monitoring of requests | `[ ]` NOT STARTED |
| P2-G | Phase 2 exit gate | `[ ]` NOT STARTED |

### Phase 3 — Listing + CommerceUnit

| ID | Requirement | Status |
|---|---|---|
| P3-01 | Seller onboarding, progressive, minutes-to-first-listing (v3 §18) | `[ ]` NOT STARTED |
| P3-02 | Jurisdiction-configurable tax identifiers — never hardcoded to one country | `[ ]` NOT STARTED |
| P3-03 | Seller verification levels 0–5, configurable (v3 §19) | `[ ]` NOT STARTED |
| P3-04 | `CommerceUnit` abstraction covering new, used, bulk, vehicle, accommodation, service, rental, wholesale lot, custom | `[ ]` NOT STARTED |
| P3-05 | Definable commercial units (each, kg, tonne, litre, metre, box, pallet, lot, container, night, week, month, room, property, hour, job, visit, km, quotation, fixed package) | `[ ]` NOT STARTED |
| P3-06 | AI-assisted listing creation: camera → identify → title → description → attributes → condition → category → price suggestion → seller review | `[ ]` NOT STARTED |
| P3-07 | Seller representations and declarations with version, identity, item, timestamp, evidence | `[ ]` NOT STARTED |
| P3-08 | Listing lifecycle DRAFT → AI_REVIEW → NEEDS_SELLER_INFO / HUMAN_REVIEW / APPROVED → PUBLISHED → LIMITED / SUSPENDED / REMOVED / SOLD | `[ ]` NOT STARTED |
| P3-09 | Listing review pipeline stage 1: AI reviews 100%, humans review exceptions plus random samples | `[ ]` NOT STARTED |
| P3-10 | Random human sampling retained at every automation stage (drift detection) | `[ ]` NOT STARTED |
| P3-G | Phase 3 exit gate | `[ ]` NOT STARTED |

### Phase 4 — Catalog / Search / Matching

| ID | Requirement | Status |
|---|---|---|
| P4-01 | Search pipeline | `[ ]` NOT STARTED |
| P4-02 | Discovery surfaces | `[ ]` NOT STARTED |
| P4-03 | Supplier and supply matching | `[ ]` NOT STARTED |
| P4-04 | Match explanations | `[ ]` NOT STARTED |
| P4-05 | Ranking weights kept server-side and private (v3 §41) | `[ ]` NOT STARTED |
| P4-G | Phase 4 exit gate | `[ ]` NOT STARTED |

### Phase 5 — Offers / RFQ / Quotes

| ID | Requirement | Status |
|---|---|---|
| P5-01 | Direct offers | `[ ]` NOT STARTED |
| P5-02 | Reverse marketplace / RFQ | `[ ]` NOT STARTED |
| P5-03 | RFQ privacy modes | `[ ]` NOT STARTED |
| P5-04 | Private supplier outreach | `[ ]` NOT STARTED |
| P5-05 | Quote capture and ranking | `[ ]` NOT STARTED |
| P5-06 | Split-fulfilment foundations | `[ ]` NOT STARTED |
| P5-G | Phase 5 exit gate | `[ ]` NOT STARTED |

### Phase 6 — Orders / Payments / Ledger

| ID | Requirement | Status |
|---|---|---|
| P6-01 | Order state machine | `[ ]` NOT STARTED |
| P6-02 | Immutable commercial snapshot: listing snapshot, title, description, media refs, price, quantity, condition, seller representations, policy version, buyer acceptance (v3 §39) | `[ ]` NOT STARTED |
| P6-03 | Provider-neutral payment abstraction | `[ ]` NOT STARTED |
| P6-04 | Payment provider sandbox integration | `[!]` BLOCKED — BL-05 |
| P6-05 | Idempotency keys on every external payment operation | `[ ]` NOT STARTED |
| P6-06 | Crash-window safety: capture-then-crash never yields an invisible or unrecoverable order | `[ ]` NOT STARTED |
| P6-07 | Webhook signature verification and replay handling | `[ ]` NOT STARTED |
| P6-08 | Append-only financial ledger | `[ ]` NOT STARTED |
| P6-09 | Refund foundation including partial refunds | `[ ]` NOT STARTED |
| P6-10 | Deterministic totals — no AI in the authority path (v3 §38) | `[ ]` NOT STARTED |
| P6-G | Phase 6 exit gate including the financial adversarial suite (§F.3) | `[ ]` NOT STARTED |

### Phase 7 — Seller Payouts / Settlements / Risk

| ID | Requirement | Status |
|---|---|---|
| P7-01 | Standard holds driven by policy, not constants (initial concept ~45 days) | `[ ]` NOT STARTED |
| P7-02 | Policy milestones: delivery confirmation, buyer acceptance, service completion, accommodation checkout | `[ ]` NOT STARTED |
| P7-03 | Accelerated payout (~24h) for eligible sellers with approved security | `[ ]` NOT STARTED |
| P7-04 | Security instruments: bank guarantee, rolling reserve, cash security, approved insurance, third-party guarantee, extensible | `[ ]` NOT STARTED |
| P7-05 | Guarantee exposure and coverage tracking (initial target 50%, configurable) | `[ ]` NOT STARTED |
| P7-06 | Eligible / held / reserved / permitted-payout computation | `[ ]` NOT STARTED |
| P7-07 | Risk-based settlement inputs (v3 §21) | `[ ]` NOT STARTED |
| P7-08 | Settlement dashboard | `[ ]` NOT STARTED |
| P7-09 | Payout policy version recorded on every settlement record | `[ ]` NOT STARTED |
| P7-G | Phase 7 exit gate including settlement adversarial scenarios | `[ ]` NOT STARTED |

### Phase 8 — Logistics / Fulfilment

| ID | Requirement | Status |
|---|---|---|
| P8-01 | Pickup | `[ ]` NOT STARTED |
| P8-02 | Delivery | `[ ]` NOT STARTED |
| P8-03 | Proof of delivery | `[ ]` NOT STARTED |
| P8-04 | Delivery failure handling | `[ ]` NOT STARTED |
| P8-05 | Multi-stop / route consolidation foundations | `[ ]` NOT STARTED |
| P8-G | Phase 8 exit gate | `[ ]` NOT STARTED |

### Phase 9 — Rewards / Referrals / Commissions

| ID | Requirement | Status |
|---|---|---|
| P9-01 | Points ledger: earn, redeem, expire, reverse, adjust — never a mutable balance only | `[ ]` NOT STARTED |
| P9-02 | Reward sources and funding types (JAYA, seller, shared, campaign) | `[ ]` NOT STARTED |
| P9-03 | Reward redemption rules | `[ ]` NOT STARTED |
| P9-04 | Referral / introducer model | `[ ]` NOT STARTED |
| P9-05 | Deterministic attribution | `[ ]` NOT STARTED |
| P9-06 | Configurable commission rules by seller, tier, category, geography, amount, segment, campaign, accommodation, service type, payment type, promotional period | `[ ]` NOT STARTED |
| P9-07 | Commission policy version stored per transaction; history never rewritten | `[ ]` NOT STARTED |
| P9-G | Phase 9 exit gate | `[ ]` NOT STARTED |

### Phase 10 — Used Goods / Category Risk Packs

| ID | Requirement | Status |
|---|---|---|
| P10-01 | Pluggable risk-pack framework | `[ ]` NOT STARTED |
| P10-02 | Phones/electronics pack (IMEI/serial, model/storage, lock declaration, battery, repairs, ownership, photos, proof of purchase) | `[ ]` NOT STARTED |
| P10-03 | Vehicles pack (VIN/chassis, registration, title evidence, mileage, condition evidence, security-interest checks, inspections, media) | `[ ]` NOT STARTED |
| P10-04 | Fashion/luxury pack (brand, model, size, serial/date codes, authenticity evidence, AI indicators, proof of purchase) | `[ ]` NOT STARTED |
| P10-05 | Generic high-risk used goods pack | `[ ]` NOT STARTED |
| P10-06 | Combined controls: AI checks, evidence, seller history, risk scoring, payment/settlement controls, buyer acceptance, dispute protection, optional inspection, human review | `[ ]` NOT STARTED |
| P10-G | Phase 10 exit gate including the listing/trust adversarial suite (§F.4) | `[ ]` NOT STARTED |

### Phase 11 — Accommodation (and Services)

| ID | Requirement | Status |
|---|---|---|
| P11-01 | Host capability | `[ ]` NOT STARTED |
| P11-02 | Property, room type, capacity, beds/bathrooms, amenities, media, map/location | `[ ]` NOT STARTED |
| P11-03 | Availability calendar | `[ ]` NOT STARTED |
| P11-04 | Nightly/weekly/monthly pricing, fees | `[ ]` NOT STARTED |
| P11-05 | House rules, cancellation policies, min/max stay | `[ ]` NOT STARTED |
| P11-06 | Reservation, payment, check-in/check-out | `[ ]` NOT STARTED |
| P11-07 | Accommodation settlement via shared settlement module | `[ ]` NOT STARTED |
| P11-08 | Reviews, disputes, host/guest conversations reusing shared infrastructure | `[ ]` NOT STARTED |
| P11-09 | Accommodation fraud/risk review (host verification, property/location verification, image consistency) | `[ ]` NOT STARTED |
| P11-10 | Services module: offering, scheduling, completion evidence, service settlement | `[ ]` NOT STARTED |
| P11-11 | No separate platform codebase — shared identity, conversations, payment, ledger, rewards, reputation, disputes, AI, settlement | `[ ]` NOT STARTED |
| P11-G | Phase 11 exit gate | `[ ]` NOT STARTED |

### Phase 12 — Budget / User Intelligence

| ID | Requirement | Status |
|---|---|---|
| P12-01 | User-defined budget categories | `[ ]` NOT STARTED |
| P12-02 | Allocated / spent / committed / remaining views | `[ ]` NOT STARTED |
| P12-03 | Committed spend includes confirmed pending obligations | `[ ]` NOT STARTED |
| P12-04 | Recommendations distinguish essential, reserve, planned and discretionary spend | `[ ]` NOT STARTED |
| P12-05 | Remaining budget is not treated as spendable advertising inventory; no exploitative personalisation | `[ ]` NOT STARTED |
| P12-06 | Permissioned personalisation with user inspection and deletion controls | `[ ]` NOT STARTED |
| P12-G | Phase 12 exit gate | `[ ]` NOT STARTED |

### Phase 13 — Seller Intelligence / Opportunities

| ID | Requirement | Status |
|---|---|---|
| P13-01 | Demand growth and geographic demand insights | `[ ]` NOT STARTED |
| P13-02 | Price competitiveness | `[ ]` NOT STARTED |
| P13-03 | Lost and unanswered demand | `[ ]` NOT STARTED |
| P13-04 | Inventory and reorder suggestions | `[ ]` NOT STARTED |
| P13-05 | Performance analytics (response time, fulfilment issues) | `[ ]` NOT STARTED |
| P13-06 | Deterministic analytics first, prediction later | `[ ]` NOT STARTED |
| P13-G | Phase 13 exit gate | `[ ]` NOT STARTED |

### Phase 14 — Finance Provider Marketplace

| ID | Requirement | Status |
|---|---|---|
| P14-01 | Pluggable finance provider abstraction | `[ ]` NOT STARTED |
| P14-02 | Eligibility presentation (working capital, inventory, PO, invoice, equipment/vehicle, trade finance) | `[ ]` NOT STARTED |
| P14-03 | JAYA acts as connector/technology layer where regulated | `[ ]` NOT STARTED |
| P14-04 | Licensing and jurisdiction decisions | `[!]` BLOCKED — BL-08 |
| P14-G | Phase 14 exit gate | `[ ]` NOT STARTED |

### Phase 15 — AI Control Plane Advanced

| ID | Requirement | Status |
|---|---|---|
| P15-01 | Model registry UI | `[ ]` NOT STARTED |
| P15-02 | Routing controls by task | `[ ]` NOT STARTED |
| P15-03 | Shadow mode | `[ ]` NOT STARTED |
| P15-04 | Model evaluation | `[ ]` NOT STARTED |
| P15-05 | Multi-model comparison with policy-threshold escalation to humans | `[ ]` NOT STARTED |
| P15-06 | Cost optimisation | `[ ]` NOT STARTED |
| P15-07 | Controlled improvement proposals — AI never silently rewrites business policy | `[ ]` NOT STARTED |
| P15-G | Phase 15 exit gate | `[ ]` NOT STARTED |

### Phase 16 — Advanced Operations / Autonomy

| ID | Requirement | Status |
|---|---|---|
| P16-01 | Conversation Monitoring Centre with the v3 §6 filter set | `[ ]` NOT STARTED |
| P16-02 | Human takeover and return of control | `[ ]` NOT STARTED |
| P16-03 | Staff conversation access logging and redaction | `[ ]` NOT STARTED |
| P16-04 | Exception routing | `[ ]` NOT STARTED |
| P16-05 | Risk automation | `[ ]` NOT STARTED |
| P16-06 | Sampling regime | `[ ]` NOT STARTED |
| P16-07 | AI-first moderation with human governance | `[ ]` NOT STARTED |
| P16-08 | Opportunity engine | `[ ]` NOT STARTED |
| P16-G | Phase 16 exit gate | `[ ]` NOT STARTED |

### Phase 17 — Omnichannel / Future Inputs

| ID | Requirement | Status |
|---|---|---|
| P17-01 | WhatsApp channel | `[ ]` NOT STARTED |
| P17-02 | Voice channel | `[ ]` NOT STARTED |
| P17-03 | Browser context | `[ ]` NOT STARTED |
| P17-04 | AI glasses interface contracts | `[ ]` NOT STARTED |
| P17-05 | Partner APIs | `[ ]` NOT STARTED |
| P17-G | Phase 17 exit gate | `[ ]` NOT STARTED |

### Phase 18 — Final Hardening

| ID | Requirement | Status |
|---|---|---|
| P18-01 | Full regression | `[ ]` NOT STARTED |
| P18-02 | Security review | `[ ]` NOT STARTED |
| P18-03 | Financial adversarial suite | `[ ]` NOT STARTED |
| P18-04 | Performance and scale sanity | `[ ]` NOT STARTED |
| P18-05 | UX review | `[ ]` NOT STARTED |
| P18-06 | Recovery and failure-injection tests | `[ ]` NOT STARTED |
| P18-07 | Production readiness | `[ ]` NOT STARTED |
| P18-G | Release gate set (§G) fully green | `[ ]` NOT STARTED |

### Master journeys (v3 §60–§63)

| ID | Journey | Status |
|---|---|---|
| J-01 | Master MVP user journey, end to end, no manual DB edits | `[ ]` NOT STARTED |
| J-02 | Master seller journey | `[ ]` NOT STARTED |
| J-03 | Master accommodation journey | `[ ]` NOT STARTED |
| J-04 | Operations acceptance (v3 §63, all thirteen staff capabilities) | `[ ]` NOT STARTED |

---

## E. Cross-cutting mandatory requirements

These are not owned by one phase. Each is verified per module and again at release.

### E.1 Security and privacy (v3 §40)

| ID | Requirement | Status |
|---|---|---|
| X-01 | Secure authentication | `[~]` IN PROGRESS — FND-004c delivered the mechanism: verifier-decided outcomes, an assertion consumed exactly once, session secrets presented once and stored only as a SHA-256, absolute and idle expiry, guarded rotation and revocation. **Held at IN PROGRESS because no verifier ships** — nothing checks a password, a passkey or a code, so no real person can authenticate — and because there is no API, no rate limiting and no lockout in front of it. Evidence [§11.25](./CURRENT_IMPLEMENTATION_STATUS.md#1125-evidence--fnd-004c-k-02-authentication-foundation) |
| X-02 | MFA support | `[~]` IN PROGRESS — the *model* exists (FND-004c): factor **categories** counted as a set so two passwords are still one factor, ordered assurance, and a per-provider policy that may raise the platform floor and may never lower it, refused at registry construction. **No second factor can actually be presented**: no TOTP, no passkey, no hardware token, no delivery channel, and no verifier of any kind. Evidence [§11.25](./CURRENT_IMPLEMENTATION_STATUS.md#1125-evidence--fnd-004c-k-02-authentication-foundation) |
| X-03 | Least privilege | `[~]` IN PROGRESS — K-04 (FND-004d) expresses it structurally: a grant covers one resource or one type **inside one account**, and there is no grant shape covering every account; deny beats allow; `SUPER_ADMIN` confers nothing. **Held at IN PROGRESS because nothing calls it**, so no path is actually narrowed. Evidence [§11.26](./CURRENT_IMPLEMENTATION_STATUS.md#1126-evidence--fnd-004d-k-04-permissions-foundation) |
| X-04 | RBAC/ABAC | `[~]` IN PROGRESS — both halves delivered by FND-004d: roles and capabilities in immutable numbered policy versions (RBAC), and six typed predicate kinds over an allowlisted context (ABAC). **No caller, no API, no policy studio and no operational role matrix.** Evidence [§11.26](./CURRENT_IMPLEMENTATION_STATUS.md#1126-evidence--fnd-004d-k-04-permissions-foundation) |
| X-05 | Server-side authorisation on every path | `[ ]` NOT STARTED — K-04 can decide (FND-004d), but **no path calls it** and there are no paths: no API and no UI exist. This stays NOT STARTED until something is actually guarded |
| X-06 | Data isolation between accounts | `[ ]` NOT STARTED |
| X-07 | Input validation | `[ ]` NOT STARTED |
| X-08 | Webhook signing | `[ ]` NOT STARTED |
| X-09 | Secret management | `[ ]` NOT STARTED |
| X-10 | Encryption in transit and at rest | `[ ]` NOT STARTED |
| X-11 | Rate limits | `[ ]` NOT STARTED |
| X-12 | Abuse detection | `[ ]` NOT STARTED |
| X-13 | Audit logs | `[ ]` NOT STARTED |
| X-14 | Secure session and cookie handling | `[~]` IN PROGRESS — the session half is delivered (FND-004c): a secret revealed exactly once and never stored, a SHA-256 in the only column that could hold one, constant-time hash comparison, absolute and idle expiry, rotation that never extends the absolute stop, and explicit revocation with a reason. **The cookie half does not exist at all** — no HTTP surface, so no `Secure`, `HttpOnly`, `SameSite`, no CSRF defence and no cookie is ever set. Evidence [§11.25](./CURRENT_IMPLEMENTATION_STATUS.md#1125-evidence--fnd-004c-k-02-authentication-foundation) |
| X-15 | Dependency scanning | `[ ]` NOT STARTED |
| X-16 | Security testing | `[ ]` NOT STARTED |
| X-17 | Privacy controls and consent | `[ ]` NOT STARTED |
| X-18 | Retention policies | `[ ]` NOT STARTED |
| X-19 | Data minimisation | `[ ]` NOT STARTED |
| X-20 | Staff access to conversations and sensitive records logged and restricted | `[~]` IN PROGRESS — the *restricted* half is delivered by FND-004d: a staff role must declare a purpose from a closed vocabulary and it must be the purpose the grant names, enforced in the service, the record validator and a database `CHECK`. **The logged half does not exist**: no K-09 audit record follows a decision, and nothing calls K-04 anyway. Evidence [§11.26](./CURRENT_IMPLEMENTATION_STATUS.md#1126-evidence--fnd-004d-k-04-permissions-foundation) |

### E.2 Anti-clone / IP protection (v3 §41)

| ID | Requirement | Status |
|---|---|---|
| X-21 | Ranking weights, prompts, fraud rules, intelligence algorithms, seller risk logic and internal decision policy never exposed client-side | `[ ]` NOT STARTED |
| X-22 | API gateway, scoped tokens, rate limiting, logging, abuse detection in place | `[ ]` NOT STARTED |

### E.3 UI/UX (v3 §33, §34, §51)

| ID | Requirement | Status |
|---|---|---|
| X-23 | Shared design system covering the v3 §34 element list | `[ ]` NOT STARTED |
| X-24 | Every module provides mobile and desktop layouts | `[ ]` NOT STARTED |
| X-25 | Empty, loading, error and success states on every surface | `[ ]` NOT STARTED |
| X-26 | First-time and returning-user experiences | `[ ]` NOT STARTED |
| X-27 | Accessibility review | `[ ]` NOT STARTED |
| X-28 | Responsive testing | `[ ]` NOT STARTED |
| X-29 | Realistic-data testing | `[ ]` NOT STARTED |
| X-30 | No dead controls, no placeholder actions | `[ ]` NOT STARTED |
| X-31 | Independent UI/UX quality gate sign-off per user-facing module | `[ ]` NOT STARTED |

### E.4 Configuration, policy and rollout (v3 §35, §36)

| ID | Requirement | Status |
|---|---|---|
| X-32 | Frequently changing business rules live in versioned policy, not source | `[ ]` NOT STARTED |
| X-33 | Historic transactions retain the policy version originally applied | `[ ]` NOT STARTED |
| X-34 | Rollout stages OFF / internal / selected accounts / selected sellers / selected categories / selected countries / percentage / full | `[ ]` NOT STARTED |
| X-35 | Kill switches on high-risk functions | `[ ]` NOT STARTED |

### E.5 Events and reliability (v3 §37)

| ID | Requirement | Status |
|---|---|---|
| X-36 | Event catalogue published and versioned | `[ ]` NOT STARTED |
| X-37 | Idempotency on critical events | `[ ]` NOT STARTED |
| X-38 | Retries with backoff | `[ ]` NOT STARTED |
| X-39 | Dead-letter handling | `[ ]` NOT STARTED |
| X-40 | Consumer-side deduplication | `[ ]` NOT STARTED |
| X-41 | Safe replay | `[ ]` NOT STARTED |
| X-42 | Transaction and crash-window handling | `[ ]` NOT STARTED |

### E.6 Financial architecture (v3 §38, [MODULE_MAP.md](./MODULE_MAP.md) §11)

| ID | Requirement | Status |
|---|---|---|
| X-43 | Deterministic services own totals, payments, refunds, ledger, commissions, rewards, settlements, reserves, guarantee exposure, payouts | `[ ]` NOT STARTED |
| X-44 | AI is never the financial authority; enforced by a CI check | `[~]` IN PROGRESS — the `financial-zone-ai` check exists and fails `npm run verify` at P0 severity; it is not yet a **CI** check, because there is no CI (P0-09) |
| X-45 | Append-only/immutable financial records where appropriate | `[ ]` NOT STARTED |

### E.7 AI control plane (v3 §29–§32)

| ID | Requirement | Status |
|---|---|---|
| X-46 | No business module hardcodes a provider; enforced by a CI check | `[~]` IN PROGRESS — the `provider-import` check exists and fails `npm run verify`; it is not yet a **CI** check, because there is no CI (P0-09) |
| X-47 | Task-based model routing | `[ ]` NOT STARTED |
| X-48 | Shadow mode for new models | `[ ]` NOT STARTED |
| X-49 | Full AI decision metadata recorded (v3 §31) | `[ ]` NOT STARTED |
| X-50 | Cost and latency monitoring with fallbacks | `[ ]` NOT STARTED |
| X-51 | Controlled self-improvement pipeline with approval and rollback | `[ ]` NOT STARTED |

### E.8 Development process

| ID | Requirement | Status |
|---|---|---|
| X-52 | `CURRENT_IMPLEMENTATION_STATUS.md` updated at the end of every task | `[~]` IN PROGRESS — established by DOC-001; ongoing obligation |
| X-53 | Decisions ledger maintained | `[ ]` NOT STARTED |
| X-54 | Known limitations maintained | `[ ]` NOT STARTED |
| X-55 | Changelog maintained | `[ ]` NOT STARTED |
| X-56 | Development AI usage tracking (model, task, effort, duration, cost, retries, outcome) where the harness permits (v3 §46) | `[ ]` NOT STARTED |

---

## F. Test suites

Testing is continuous across four levels (v3 §47): task, module, phase, release. **A test runner exists and 702 tests pass** (`npm test`, exit 0 — FND-001a, FND-001b, FND-001d, FND-002a…d, FND-003a…c, FND-004a and FND-004b). Thirty-two live-PostgreSQL tests are skipped for want of a server, so T-02, T-04, T-05, T-20 and T-21 stay incomplete. None of the mandatory test types below is satisfied for a business capability, because no business capability exists yet; the statuses in §F.1 and §F.3–§F.4 are unchanged.

### F.1 Mandatory test types (v3 §48)

| ID | Test type | Status |
|---|---|---|
| T-01 | Unit | `[ ]` NOT STARTED |
| T-02 | Integration | `[ ]` NOT STARTED |
| T-03 | API contract | `[ ]` NOT STARTED |
| T-04 | Database | `[ ]` NOT STARTED |
| T-05 | Migration | `[ ]` NOT STARTED |
| T-06 | Permission | `[ ]` NOT STARTED |
| T-07 | Negative / invalid input | `[ ]` NOT STARTED |
| T-08 | Idempotency | `[ ]` NOT STARTED |
| T-09 | Concurrency | `[ ]` NOT STARTED |
| T-10 | Crash-window recovery | `[ ]` NOT STARTED |
| T-11 | Webhook replay | `[ ]` NOT STARTED |
| T-12 | Queue retry | `[ ]` NOT STARTED |
| T-13 | Dead-letter handling | `[ ]` NOT STARTED |
| T-14 | End-to-end | `[ ]` NOT STARTED |
| T-15 | Mobile / responsive | `[ ]` NOT STARTED |
| T-16 | Accessibility | `[ ]` NOT STARTED |
| T-17 | AI evaluation | `[ ]` NOT STARTED |
| T-18 | Security | `[ ]` NOT STARTED |
| T-19 | Regression | `[ ]` NOT STARTED |

### F.2 Test infrastructure

| ID | Requirement | Status |
|---|---|---|
| T-20 | Test runner and CI integration | `[ ]` NOT STARTED |
| T-21 | Test database lifecycle and isolation | `[~]` IN PROGRESS — delivered by FND-002c: the test database is derived from `DATABASE_URL`, guarded against non-loopback hosts, names without the `_test` suffix and shared-environment names, then created and dropped around the live suite. Corrected after review: the live migration suite no longer runs against the database `DATABASE_URL` names — all live coverage now runs inside the derived `_test` database, and `tests/integration-safety.test.ts` fails the build if any suite reaches around it or plants a leftover it does not remove in a `finally`. The leftover-replacement test, which previously could not fail, now seeds a database at the exact guarded name and proves the marker is gone. **Held at IN PROGRESS: never run against a server.** FND-004c added a sixth live suite (`tests/integration/authentication.integration.ts`, 9 cases) under the same harness, covering K-02 migration-backed writes, hashed-token-only persistence, rotation and revocation races, transaction rollback and enlisted composition; it skips with the same stated reason, so it adds coverage that has never executed rather than evidence. Correction record [§11.9](./CURRENT_IMPLEMENTATION_STATUS.md#119-correction--fnd-002c-integration-test-targeting-env-sufficiency-and-a-vacuous-leftover-proof). Evidence [§11.8](./CURRENT_IMPLEMENTATION_STATUS.md#118-evidence--fnd-002c-local-provisioning-and-isolated-test-database-lifecycle) |
| T-22 | Fixtures and realistic data | `[ ]` NOT STARTED |
| T-23 | Failure-injection harness | `[ ]` NOT STARTED |
| T-24 | Coverage reporting for critical paths | `[ ]` NOT STARTED |

### F.3 Critical financial / settlement adversarial suite (v3 §49)

**Every scenario below is a release gate. No P0 or P1 failure may remain before release.** All are `NOT STARTED`.

| ID | Scenario | Status |
|---|---|---|
| FA-01 | Duplicate payment webhook | `[ ]` NOT STARTED |
| FA-02 | Payment provider retry | `[ ]` NOT STARTED |
| FA-03 | Payment capture succeeds, process crashes immediately afterward | `[ ]` NOT STARTED |
| FA-04 | Order confirmation fails after payment | `[ ]` NOT STARTED |
| FA-05 | Duplicate refund | `[ ]` NOT STARTED |
| FA-06 | Partial refund then retry | `[ ]` NOT STARTED |
| FA-07 | Duplicate payout | `[ ]` NOT STARTED |
| FA-08 | Settlement worker crash | `[ ]` NOT STARTED |
| FA-09 | Duplicate settlement event | `[ ]` NOT STARTED |
| FA-10 | Seller payout and dispute race | `[ ]` NOT STARTED |
| FA-11 | Guarantee/security expires before payout | `[ ]` NOT STARTED |
| FA-12 | Accelerated payout exceeds permitted security exposure | `[ ]` NOT STARTED |
| FA-13 | Return after accelerated payout | `[ ]` NOT STARTED |
| FA-14 | Chargeback after seller payout | `[ ]` NOT STARTED |
| FA-15 | Commission event duplicated | `[ ]` NOT STARTED |
| FA-16 | Reward earn event duplicated | `[ ]` NOT STARTED |
| FA-17 | Reward reversal | `[ ]` NOT STARTED |
| FA-18 | Order cancellation during payment | `[ ]` NOT STARTED |
| FA-19 | Concurrent updates to the same order | `[ ]` NOT STARTED |
| FA-20 | Delivery completion emitted twice | `[ ]` NOT STARTED |
| FA-21 | Accommodation checkout emitted twice | `[ ]` NOT STARTED |
| FA-22 | Queue consumer retry | `[ ]` NOT STARTED |
| FA-23 | Stale worker acting after newer state | `[ ]` NOT STARTED |
| FA-24 | Permission escalation attempt | `[ ]` NOT STARTED |

### F.4 Listing / trust adversarial suite (v3 §50)

| ID | Scenario | Status |
|---|---|---|
| LA-01 | AI misidentifies a used item | `[ ]` NOT STARTED |
| LA-02 | Seller corrects AI identification | `[ ]` NOT STARTED |
| LA-03 | Seller omits required title/ownership evidence | `[ ]` NOT STARTED |
| LA-04 | Duplicate image or listing | `[ ]` NOT STARTED |
| LA-05 | Suspicious price | `[ ]` NOT STARTED |
| LA-06 | Serial mismatch | `[ ]` NOT STARTED |
| LA-07 | Counterfeit risk | `[ ]` NOT STARTED |
| LA-08 | Prohibited category | `[ ]` NOT STARTED |
| LA-09 | High-risk seller | `[ ]` NOT STARTED |
| LA-10 | Listing changed after purchase; immutable order snapshot remains correct | `[ ]` NOT STARTED |
| LA-11 | AI low confidence escalates | `[ ]` NOT STARTED |
| LA-12 | Human override is audited | `[ ]` NOT STARTED |
| LA-13 | Policy version retained | `[ ]` NOT STARTED |
| LA-14 | False-positive moderation appeal | `[ ]` NOT STARTED |
| LA-15 | Staff attempts unauthorised conversation access | `[ ]` NOT STARTED |

---

## G. Release gates

Sources: v3 §64 (production completion rule), v1 §93 (deployment gates). **No gate is met.**

### G.1 Build and quality gates

| ID | Gate | Status |
|---|---|---|
| G-01 | Build passes | `[ ]` NOT STARTED |
| G-02 | Type checks pass | `[ ]` NOT STARTED |
| G-03 | Lint passes | `[ ]` NOT STARTED |
| G-04 | Unit tests pass | `[ ]` NOT STARTED |
| G-05 | Integration tests pass | `[ ]` NOT STARTED |
| G-06 | Critical E2E journeys pass | `[ ]` NOT STARTED |
| G-07 | Full regression passes | `[ ]` NOT STARTED |

### G.2 Safety gates

| ID | Gate | Status |
|---|---|---|
| G-08 | Financial adversarial suite (§F.3) passes | `[ ]` NOT STARTED |
| G-09 | Listing/trust adversarial suite (§F.4) passes | `[ ]` NOT STARTED |
| G-10 | Permission matrix passes | `[ ]` NOT STARTED |
| G-11 | Security checks pass | `[ ]` NOT STARTED |
| G-12 | Migrations validated | `[ ]` NOT STARTED |
| G-13 | Environment validation passes | `[ ]` NOT STARTED |
| G-14 | Rollback path available | `[ ]` NOT STARTED |
| G-15 | Monitoring active | `[ ]` NOT STARTED |

### G.3 Experience gates

| ID | Gate | Status |
|---|---|---|
| G-16 | UI/UX quality gate passes (v3 §51) | `[ ]` NOT STARTED |
| G-17 | Mobile critical flows pass | `[ ]` NOT STARTED |
| G-18 | Desktop critical flows pass | `[ ]` NOT STARTED |
| G-19 | Accessibility review passes | `[ ]` NOT STARTED |
| G-20 | Performance and scale sanity passes | `[ ]` NOT STARTED |

### G.4 Governance gates

| ID | Gate | Status |
|---|---|---|
| G-21 | No open P0 defects | `[ ]` NOT STARTED |
| G-22 | No open P1 defects | `[ ]` NOT STARTED |
| G-23 | `CURRENT_IMPLEMENTATION_STATUS.md` accurate | `[ ]` NOT STARTED |
| G-24 | Known limitations documented | `[ ]` NOT STARTED |
| G-25 | No required placeholder or stub remains | `[ ]` NOT STARTED |
| G-26 | Production deployment healthy | `[ ]` NOT STARTED |

---

## H. P0 / P1 defect register

Severity definitions from v3 §52.

- **P0 — catastrophic:** money lost or corrupted, unrecoverable paid transaction, cross-user data exposure, severe auth/security flaw, destructive migration or data loss, settlement corruption. **All progression stops until fixed.**
- **P1 — major:** primary workflow broken, significant security flaw, major financial inconsistency, core module unavailable. **Must be fixed before phase completion.**
- **P2 — important:** may proceed only if documented and non-blocking.
- **P3 — minor:** backlog permitted.

### H.1 Open P0 defects

| ID | Description | Module | Detected | Status |
|---|---|---|---|---|
| — | None | — | — | **0 open** |

### H.2 Open P1 defects

| ID | Description | Module | Detected | Status |
|---|---|---|---|---|
| — | None | — | — | **0 open** |

### H.3 Open P2 / P3 defects

| ID | Description | Severity | Module | Status |
|---|---|---|---|---|
| — | None | — | — | **0 open** |

**Interpretation:** zero open defects reflects almost no implementation, not verified quality. The substrate delivered by FND-001a, FND-001b, FND-001d, FND-002a and FND-002b, and the K-01, K-03, K-05, K-08 and K-09 foundations on top of it, carries 702 passing tests and no known defect (three FND-002c defects were found by review and corrected — [§11.9](./CURRENT_IMPLEMENTATION_STATUS.md#119-correction--fnd-002c-integration-test-targeting-env-sufficiency-and-a-vacuous-leftover-proof)) (three FND-002b defects were found by review and corrected — [§11.7](./CURRENT_IMPLEMENTATION_STATUS.md#117-correction--fnd-002b-production-readiness-and-transaction-model)); this register stays close to meaningless until business capability exists to defect. Each entry, when added, must carry: id, severity, description, owning module, reproduction, detection source, and the regression test that reproduces it (v3 §58).

---

## I. Blocker register

A blocker prevents work that cannot proceed by any local means. Per v3 §65, escalate only for these categories. **None of these blockers prevent Phase 0 local foundation work.**

| ID | Blocker | Blocks | Category | Escalation |
|---|---|---|---|---|
| BL-01 | No staging environment or cloud account | P0-22 | Credentials / access | Human owner |
| BL-02 | No production environment or cloud account | P0-24 | Credentials / access | Human owner |
| BL-03 | No error-monitoring/APM service account | P0-26 | Credentials / access | Human owner |
| BL-04 | No AI provider credentials for any live adapter | P0-40 | Credentials / access | Human owner |
| BL-05 | No payment provider sandbox or merchant account | P6-04 | Credentials / access | Human owner (needed by Phase 6, not before) |
| BL-06 | No object-storage credentials | P0-19 | Credentials / access | Human owner |
| BL-07 | No email/SMS delivery provider credentials | K-14 live delivery | Credentials / access | Human owner (abstraction is unblocked) |
| BL-08 | Jurisdiction and legal decisions: tax identifier schemes, legality of guarantee instruments, finance licensing, permitted hold periods | P3-02 detail, P7-04, P14-04 | Legal / regulatory | Human owner |
| BL-09 | No deployment target or domain | P0-28 | Credentials / access | Human owner |
| BL-10 | **Repository credential lacks the Workflows permission.** The token is a fine-grained PAT with repository write (`push`, `admin`), but pushes whose diff touches `.github/workflows/` are refused by the remote — `refusing to allow a Personal Access Token to create or update workflow ... without 'workflow' scope`. The Contents API rejects the identical file with `403 Resource not accessible by personal access token`, so this is the permission and not the transport. | P0-09, FND-001c, and every CI-dependent gate (G-*, X-44, X-46 promotion to CI checks) | Credentials / access | Human owner — grant **Workflows: Read and write** on the fine-grained token for `LakshanV/P2P-com`, or add the workflow through the GitHub web editor |

**T-02, T-04, T-05 and T-20 remain `NOT STARTED`** — integration, database, migration and test-runner/CI suites all need either a live PostgreSQL run or CI, and neither has happened.

**Work that continues regardless of every blocker above:** all of §A.1 except P0-09, §A.2 except P0-19, §A.4 conventions, the entire kernel except live provider adapters, the design system, and all test infrastructure. **BL-10 is the first blocker to sit on the critical path** — it stops P0-09 and therefore stops FND-001 from completing. Every other blocker remains off the critical path.

---

## J. Guide reconciliation — deferred and out-of-scope items

The v1.0 guide is subordinate to v3 (see the hierarchy decision in [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md) §3). Where v1 contains material that v3 supersedes or omits, the item is recorded here with an explicit status rather than dropped, per v3 §53.

| ID | v1 item | Status | Reason |
|---|---|---|---|
| RC-01 | Separate Supplier identity/account distinct from Customer (v1 §17, §18) | `[o]` OUT OF SCOPE WITH REASON | Superseded by v3 §4: one universal JAYA Account with capabilities. Supplier behaviour is delivered as the seller/supplier capability on M-01/M-02. |
| RC-02 | v1 14-phase programme (v1 §64–§77) | `[o]` OUT OF SCOPE WITH REASON | Superseded by the v3 §59 19-phase programme, which is authoritative. v1 phase *content* is retained as detail inside §D above. |
| RC-03 | v1 §76 Quality / Certification Adapters as a standalone phase | `[-]` DEFERRED WITH REASON | v3 has no equivalent phase. The requirement is carried by the category risk packs (M-25/M-26/M-27) and M-22 Warranty. Revisit at Phase 10 to confirm coverage; if a gap remains, promote to a module. |
| RC-04 | v1 §73 Demand Aggregation | `[-]` DEFERRED WITH REASON | No v3 phase. Candidate extension of M-33 Seller Market Intelligence. Revisit after Phase 13. |
| RC-05 | v1 §74 Autonomous Procurement (agent purchases without per-order confirmation) | `[-]` DEFERRED WITH REASON | v3 §32 constrains AI self-improvement and v3 §38 forbids AI financial authority. Revisit at Phase 15/16 behind a feature flag with explicit human authority envelope. |
| RC-06 | v1 §92 database migration rules | `[~]` IN PROGRESS | Compatible with v3; adopted as the migration standard under P0-15 and made executable by FND-002a — forward/rollback pairing, transactional DDL and additive-forward rules are enforced by `npm run check:migrations`. Remains IN PROGRESS while no runner applies them. |
| RC-07 | v1 §56 event catalogue names | `[ ]` NOT STARTED | Compatible with v3 §37; the union of both lists forms the initial event catalogue under X-36. |
| RC-08 | v1 §9 core domain object list | `[ ]` NOT STARTED | Compatible; used as the starting data model under P0-02 `DATABASE_SCHEMA.md`, mapped onto module-owned tables per [MODULE_MAP.md](./MODULE_MAP.md) §4. |

---

## K. Baseline counts

**474 tracked items** carry an explicit status. Counts verified mechanically over this file after FND-005h, which moved the K-15 contract to COMPLETE and the K-15 implementation to IN PROGRESS — two rows out of NOT STARTED, and **the fifth component of build step B-3 is now in progress**. FND-005e before it moved the K-13 contract to COMPLETE and the K-13 implementation to IN PROGRESS — two rows out of NOT STARTED, and **the fourth component of build step B-3 is now in progress**. FND-005d before it moved the K-12 contract to COMPLETE and the K-12 implementation to IN PROGRESS; FND-005c before it moved the K-10 contract to COMPLETE and the K-10 implementation to IN PROGRESS; FND-005b before it moved the K-06 contract to COMPLETE and the K-06 implementation to IN PROGRESS, opening B-3. FND-004e before it moved the K-07 contract to COMPLETE and the K-07 implementation and P0-37 to IN PROGRESS, covering B-2. FND-004d before it moved the K-04 contract to COMPLETE and the K-04 implementation, P0-34, X-03, X-04 and X-20 to IN PROGRESS; its three corrections (§11.27–§11.29) changed no status and added no row. The method is reproducible and is asserted by `tests/status-docs.test.ts`: count one status marker per status-bearing cell of every row in sections A–G and J whose first cell is an item id. §H and §I are registers rather than tracked requirements and are excluded, which is what makes the section table below sum to the same 474.

| Status | Count | Notes |
|---|---:|---|
| `[ ]` NOT STARTED | 389 | |
| `[~]` IN PROGRESS | 47 | X-52 (standing documentation obligation); P0-04…P0-08 (satisfied by FND-001a, held while FND-001 is unfinished); P0-10 (four of eight MODULE_MAP §13 checks built); X-44 and X-46 (the checks exist but are not yet **CI** checks); P0-14, P0-15, P0-16 and RC-06 (FND-002a delivered the migration contract, FND-002b the runner, FND-002c local provisioning); P0-17 (seed and fixture foundation, never loaded); T-21 (test-database lifecycle delivered, never run); P0-35 and P0-36 (K-08 and K-09 cores); P0-38 (K-05's core; K-06 not started); **P0-33, X-01, X-02 and X-14 (K-02's core, with no verifier behind it and no HTTP surface in front of it)**; **P0-39 (K-13's core, with no live provider adapter behind it)**; **K-14's core, with no live email/SMS/push/WhatsApp provider adapter behind it**; **K-15's core, with no live search consumer behind it**; **M-01 Universal Account's core, the first business module, with nothing calling it**; **M-02 Capability & Verification's core, with no verifier behind it and nothing calling it**; **M-04 Universal Listing's listing half, with its inventory interface unbuilt**; **M-11 Orders' core, including split supplier fulfilment, with nothing calling it**; **M-12 Payments' core, with no live gateway adapter behind it and nothing calling it**; and the K-01, K-02, K-03, K-05, K-08, K-09, K-10, K-12, K-13, K-14, K-15, M-01, M-02, M-04, M-11 and M-12 implementation rows. The kernel has not been executed against a live PostgreSQL beyond its integration suites. |
| `[?]` NEEDS REVIEW | 0 | Nothing has been submitted for review. |
| `[x]` COMPLETE | 24 | P0-01 (DOC-001 documentation artefacts), P0-03 (all six source roots tracked and documented), P0-11 (financial-zone and provider-import checks, proven by planted fixtures), P0-12 and P0-13 (contributor documentation and git conventions), fourteen kernel module contracts — K-01, K-02, K-03, K-04, K-05, K-06, K-07, K-08, K-09, K-10, K-12, K-13, K-14 and K-15 — and the first five business-module contracts — M-01 Universal Account, M-02 Capability & Verification, M-04 Universal Listing, M-11 Orders and M-12 Payments. A contract is a fixed public surface, not a delivered capability. |
| `[!]` BLOCKED | 9 | P0-09 (CI — BL-10, the credential lacks the Workflows permission), P0-19, P0-22, P0-24, P0-26, P0-28, P0-40, P6-04, P14-04. All external credentials or legal decisions (§I). |
| `[-]` DEFERRED WITH REASON | 3 | RC-03, RC-04, RC-05. |
| `[o]` OUT OF SCOPE WITH REASON | 2 | RC-01, RC-02. |
| **Total** | **474** | |

| Section | Tracked items |
|---|---:|
| A. Phase 0 — Foundation | 47 |
| B. Commerce kernel components (15 components × contract + implementation) | 30 |
| C. Business modules (47 modules × contract + implementation) | 94 |
| D. Phases 1–18 — major requirements | 150 |
| E. Cross-cutting mandatory requirements | 56 |
| F. Test suites | 63 |
| G. Release gates | 26 |
| J. Guide reconciliation | 8 |
| **Total** | **474** |

**Implementation items complete: 4 of 472** — P0-03 (source structure), P0-11 (financial-zone and provider-import checks), P0-12 (contributor documentation) and P0-13 (git workflow conventions). The 474 tracked items less P0-01 and X-52, neither of which is an implementation capability.

**Business capabilities complete: 0.** No kernel component, no business module, no phase, no release gate. Fourteen kernel components have *contracts* marked COMPLETE and *implementations* marked IN PROGRESS; a contract is a fixed public surface, not a delivered capability, and §B distinguishes the two columns for exactly this reason. Phase 0 itself is not complete: the data layer (§A.2) has never run against a live server, environments (§A.3) do not exist, platform conventions (§A.4) are partial, and of the foundation capabilities (§A.5) only authentication, permissions, events, audit, configuration, policy, feature flags, ledger, commerce units, conversation, AI gateway, notifications and search have moved off NOT STARTED — identity and accounts are delivered but have no rows there at all, and are tracked in §B instead.

**Statuses in use:** NOT STARTED, IN PROGRESS, COMPLETE, BLOCKED, DEFERRED WITH REASON, OUT OF SCOPE WITH REASON. `NEEDS REVIEW` is unused because nothing has been submitted for review.

The next task is stated in [CURRENT_IMPLEMENTATION_STATUS.md §8](./CURRENT_IMPLEMENTATION_STATUS.md#8-next-highest-priority-unblocked-task).
