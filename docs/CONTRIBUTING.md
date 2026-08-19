# Contributing to JAYA

**Document authority rank 4** — below [MODULE_MAP.md](./MODULE_MAP.md) for architectural
questions and below [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md) for
what is and is not built. Where this document and one of those disagree, they win and this
document is wrong and must be corrected.

This is the working manual for the repository: how to get a clean clone running, which commands
decide whether a change is acceptable, which architectural rules are machine-enforced, and how
changes are shaped and reviewed. It describes what the repository actually does today. Anything
aspirational belongs in the status document, not here.

Delivered by task **FND-001d** (checklist items P0-12 and P0-13).

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Clean-clone setup](#2-clean-clone-setup)
3. [The pinned toolchain, and why it is pinned](#3-the-pinned-toolchain-and-why-it-is-pinned)
4. [Verification commands](#4-verification-commands)
5. [The planted-violation fixtures](#5-the-planted-violation-fixtures)
6. [The database and the migration contract](#6-the-database-and-the-migration-contract)
7. [Module ownership and dependency rules](#7-module-ownership-and-dependency-rules)
8. [AI authority is excluded from financial code](#8-ai-authority-is-excluded-from-financial-code)
9. [Provider SDK imports are confined to K-13](#9-provider-sdk-imports-are-confined-to-k-13)
10. [Secrets handling](#10-secrets-handling)
11. [Atomic changes](#11-atomic-changes)
12. [Review](#12-review)
13. [Branch and Git conventions](#13-branch-and-git-conventions)
14. [Documentation duties that come with a change](#14-documentation-duties-that-come-with-a-change)

---

## 1. Prerequisites

| Requirement | Exact version | Where it is declared |
|---|---|---|
| Node.js | **26.7.0** | `.nvmrc` |
| npm | **11.19.0** | `packageManager` in `package.json` |
| Git | any recent version | — |

Nothing else is needed to run `npm run verify`. The repository contains a platform substrate,
its tests and the database migration contract, and none of them opens a connection: the migration
validator reads SQL as text, so every gate passes on a machine with no PostgreSQL installed.

**PostgreSQL 16 or later** is the selected database (FND-002a). It is a prerequisite only for
actually applying a migration, which nothing in this repository does yet — no runner, no
connection string, no provisioning script. See
[section 6](#6-the-database-and-the-migration-contract) for what exists and what does not.

The **supported ranges** are wider than the pins — `engines.node >= 22.18.0` and
`engines.npm >= 10.0.0` — and the two are not interchangeable. The range says what the project
will run on. The pin says what it is developed and verified against. `tests/toolchain.test.ts`
asserts each pin lies inside its own range, so the two cannot drift into contradiction.

If you use `nvm`, `fnm` or `asdf`, `.nvmrc` is read automatically:

```bash
nvm use            # or: fnm use
```

If you do not, install Node 26.7.0 directly. Verify before going further:

```bash
node --version     # must print v26.7.0
npm --version      # must print 11.19.0
```

A mismatched npm is not cosmetic. `tests/toolchain.test.ts` compares the npm actually running the
scripts against the `packageManager` pin and fails the build on a mismatch, so a wrong version
surfaces as a test failure rather than as a subtly different lockfile resolution.

To get the pinned npm:

```bash
npm install --global "npm@11.19.0"
```

---

## 2. Clean-clone setup

```bash
git clone https://github.com/LakshanV/P2P-com.git
cd P2P-com
npm ci
npm run verify
```

`npm ci` — never `npm install` for setup. `npm ci` installs exactly what the committed
`package-lock.json` specifies and fails if `package.json` and the lockfile disagree. `npm install`
will quietly resolve something newer and rewrite the lockfile, which is how two developers end up
with two different dependency trees and one unreproducible bug.

`npm run verify` is the gate. It must exit 0 on a clean clone before you have a working
environment; if it does not, that is a defect in the repository, not in your machine, and should
be reported as one.

There is no build artefact to run. `npm run build` emits `dist/` for compilation checking only —
the repository has no runnable entry point yet, because no kernel component, module or UI exists.

---

## 3. The pinned toolchain, and why it is pinned

Four facts about the toolchain live in the repository, and each is load-bearing:

| File | Declares | Kind |
|---|---|---|
| `.nvmrc` | Node 26.7.0 | exact pin |
| `package.json` → `packageManager` | npm 11.19.0 | exact pin |
| `package.json` → `engines.node` | `>=22.18.0` | supported range |
| `package.json` → `engines.npm` | `>=10.0.0` | supported range |
| `package-lock.json` | every transitive dependency, by integrity hash | exact pin |

devDependencies are pinned to exact versions with no range prefix — `"typescript": "5.9.3"`, not
`"^5.9.3"`. A caret in a devDependency means the linter, compiler or formatter can change
underneath a passing build, which turns "it passed yesterday" into an unanswerable question.

Node 26 is required rather than merely preferred: the test runner executes TypeScript directly
via native type stripping (`node --test "tests/**/*.test.ts"`), with no build step and no loader.
That is why `tsconfig.json` sets `erasableSyntaxOnly`, `allowImportingTsExtensions` and
`rewriteRelativeImportExtensions`, and why test imports carry the `.ts` extension.

**Changing a pin is a deliberate act.** Update `.nvmrc` or `packageManager`, re-run
`npm run verify`, and expect the toolchain tests to tell you if you have created a contradiction.

---

## 4. Verification commands

One command decides whether a change is acceptable:

```bash
npm run verify
```

It chains seven gates in order and stops at the first failure:

| Command | What it proves |
|---|---|
| `npm run typecheck` | `tsc --noEmit` under strict mode, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. |
| `npm run lint` | ESLint with type-aware rules across all TypeScript. |
| `npm run format:check` | Prettier formatting, repository-wide. |
| `npm run build` | `tsc -p tsconfig.build.json` compiles and emits `dist/`; `postbuild` re-runs the boundary and migration checks against the emitted output. |
| `npm run check:boundaries` | The four architectural checks below, over the real source tree. |
| `npm run check:migrations` | The ten migration-contract checks in [section 6](#6-the-database-and-the-migration-contract), over `db/migrations`. |
| `npm test` | `node --test "tests/**/*.test.ts"` — the whole test suite. |

Supporting commands:

| Command | Purpose |
|---|---|
| `npm run lint:fix` | Apply the mechanically fixable lint results. |
| `npm run format` | Rewrite files to Prettier style. Run this rather than arguing with `format:check`. |
| `node docs/tools/validate-doc-links.mjs` | Validate every relative file link and Markdown anchor under `/docs`. Exit 1 on any broken link. |
| `npm audit --audit-level=high` | Fail on any high or critical dependency advisory. |

`npm run check:boundaries` runs four checks, each of which fails the build on violation:

| Check | Rule |
|---|---|
| `layer-direction` | A unit may import only units of strictly lower depth, plus the universally importable zones. No upward imports, no same-layer sibling imports. |
| `kernel-purity` | A kernel component may not import a business module. The kernel knows nothing about what is built on it. |
| `financial-zone-ai` | Code in the deterministic financial authority zone may not import the AI Gateway. Severity **P0**. |
| `provider-import` | Only `kernel/ai-gateway` (K-13) may import a model-provider SDK. |

Run them alone while iterating:

```bash
npm run check:boundaries
```

The architecture they enforce is encoded in `platform/architecture/manifest.ts`, which is the
machine-readable form of [MODULE_MAP.md](./MODULE_MAP.md). The two change together; edit one
without the other and `tests/manifest.test.ts` fails.

---

## 5. The planted-violation fixtures

`tests/fixtures/` contains deliberately non-conforming source trees:

| Fixture | Proves |
|---|---|
| `clean/` | A conforming tree exercising every allowed edge produces zero violations. |
| `violation-layer-direction/` | An upward import and a same-layer sibling import are both rejected. |
| `violation-kernel-purity/` | A kernel component importing a business module is rejected. |
| `violation-financial-zone-ai/` | Financial-zone code importing K-13 is rejected, at P0. |
| `violation-provider-import/` | A provider SDK imported outside K-13 is rejected. |
| `violation-unregistered-unit/` | A directory that is in no register is rejected rather than silently skipped. |
| `migrations/` | One directory per migration-contract check — `valid/` plus `invalid-<check>/` — each breaking exactly one rule from [section 6](#6-the-database-and-the-migration-contract). |

**These files are not broken code awaiting repair.** They are the evidence that each check can
fail. A check that has never rejected anything is indistinguishable from a check that returns
success unconditionally, and "fixing" a fixture silently converts an enforced rule into a
decorative one.

They are excluded from TypeScript (`tsconfig.json` → `exclude`), ESLint
(`eslint.config.mjs` → `ignores`) and Prettier (`.prettierignore`) on purpose — linting a
deliberate violation would report the very problem it exists to demonstrate. The exclusions are
load-bearing, not tidiness.

When you add a boundary check or a migration check, add its fixture in the same change.
`tests/boundaries.test.ts` and `tests/migrations.test.ts` each assert that every declared check id
has one, so a check without a fixture fails the build. The migration fixtures go further: each is
asserted to produce exactly one kind of violation, so a fixture that drifts into breaking two
rules stops proving anything precise about either.

---

## 6. The database and the migration contract

**Selected database: PostgreSQL 16 or later** (FND-002a). Chosen for the features this
architecture already assumes: schema namespaces as a first-class ownership boundary, transactional
DDL so a failed migration rolls itself back, and the constraint vocabulary the deterministic
financial zone will need.

### 6.1 What exists, and what does not

| Capability | State |
|---|---|
| Database selection | **Decided** — PostgreSQL 16+ |
| Migration file format, versioning and pairing | **Delivered and enforced** — `db/migrations/`, `npm run check:migrations` |
| Schema-namespace ownership convention | **Delivered and enforced** — `platform/db/schema-namespaces.ts` |
| Local provisioning (container, service, init script) | **Not delivered.** Nothing here starts a database |
| Migration runner (applying files to a live server) | **Not delivered.** No connection is opened by any code in this repository |
| Connection configuration, pooling, credentials | **Not delivered** |
| Seed and fixture data | **Not delivered** |
| Business-module or kernel tables | **None.** FND-002a establishes the contract only |

The migrations in `db/migrations/` have therefore **never been executed against a live server**
from this repository. They are validated statically. Treat "the migration contract passes" as
exactly that claim and no more.

### 6.2 Running the validator

```bash
npm run check:migrations                                  # the repository's own migrations
node platform/db/cli.ts --dir tests/fixtures/migrations/valid
node platform/db/cli.ts --json                            # machine-readable
```

Exit 0 means no violations; exit 1 means at least one. It opens no connection and needs no
PostgreSQL installed, which is why it can sit inside `npm run verify` and run on every change
rather than at deploy time, when the cost of being wrong is highest.

### 6.3 Schema-namespace ownership

Every unit owns exactly one PostgreSQL schema, and the name is **derived from the architecture
manifest** rather than maintained as a second list:

| Owner | Schema | Example |
|---|---|---|
| Platform substrate | `platform` | the migration ledger |
| Kernel component (K-01…K-15) | `kernel_<dir>` | K-01 Identity → `kernel_identity` |
| Business module (M-01…M-47) | `module_<dir>` | M-11 Orders → `module_orders` |

Kebab-case directory slugs become snake_case schema names. Add a unit to
`platform/architecture/manifest.ts` and its namespace exists; misspell a schema in a migration and
the validator rejects it, because the name resolves to no owner.

**`public` is forbidden for unit data.** It sits on the default `search_path`, so anything in it
is reachable by every unit and owned by none — precisely the coupling
[MODULE_MAP.md §2](./MODULE_MAP.md#2-architectural-shape--modular-monolith) exists to prevent. An
unqualified `CREATE TABLE` lands there implicitly, so that is rejected too.

### 6.4 Writing a migration

Files live in `db/migrations/` and come in pairs:

```
NNNN_snake_case_slug.up.sql      forward
NNNN_snake_case_slug.down.sql    rollback
```

Every file starts with a header naming itself, its direction and its owning schema:

```sql
-- migration: 0003_create_orders_schema
-- direction: up
-- owner: module_orders

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_orders;

COMMIT;
```

Rules, all enforced by `npm run check:migrations`:

| Check | Rule | Severity |
|---|---|---|
| `malformed-name` | `NNNN_snake_case_slug.(up\|down).sql`. A version that cannot be ordered cannot be applied deterministically. | P1 |
| `malformed-header` | Header names the migration, its direction and its owner, and matches the file name. | P1 |
| `duplicate-version` | One migration per version per direction. Two claimants apply in an undefined order. | P0 |
| `missing-rollback` | Every `.up.sql` has a matching `.down.sql`. A forward migration that cannot be reversed turns a bad deploy into an outage. | P0 |
| `orphan-rollback` | No rollback without its forward migration. | P1 |
| `non-transactional` | Wrapped in `BEGIN; … COMMIT;`. DDL that fails partway otherwise leaves a schema no rollback file describes. | P0 |
| `public-schema` | No `public.`, and no unqualified object creation. | P0 |
| `cross-owner-schema` | A migration touches only the schema it declares as owner. Go through the other unit's contract. | P0 |
| `unregistered-schema` | Every schema referenced resolves to a unit in the architecture manifest. | P0 |
| `unsafe-statement` | Forward migrations are additive: no `DROP TABLE`, `DROP SCHEMA`, `DROP COLUMN`, or `DELETE` without `WHERE`. `TRUNCATE`, `DROP DATABASE` and `GRANT … TO PUBLIC` are refused in either direction. Put removals in the rollback. | P0 |

Rollbacks are exempt from the additive rule — undoing the forward migration is their entire
purpose — but not from the transaction, namespace or always-unsafe rules.

**A migration is versioned once and never edited afterwards.** The ledger
(`platform.schema_migrations`) records a checksum of the file as applied; editing a file that has
run somewhere is the most common cause of two environments disagreeing about their own schema.
Correct a mistake with a new migration, not by rewriting history.

### 6.5 Local development, when a database is needed

No provisioning is delivered, so these are prerequisites for a contributor who wants to apply a
migration by hand, not a supported workflow:

```bash
psql --version                                            # PostgreSQL 16 or later
createdb jaya_dev
psql -d jaya_dev -v ON_ERROR_STOP=1 -f db/migrations/0001_create_platform_schema.up.sql
psql -d jaya_dev -v ON_ERROR_STOP=1 -f db/migrations/0002_create_migration_ledger.up.sql
```

`ON_ERROR_STOP=1` matters: without it `psql` continues after a failed statement and reports
success. Rolling back means applying the `.down.sql` files in reverse version order.

Nothing in `npm run verify` does any of the above, and nothing in this repository writes a
connection string. When a runner and provisioning arrive, this section is where they get
documented.

---

## 7. Module ownership and dependency rules

The architecture is a **modular monolith**: one deployable, hard internal boundaries. It is
defined in [MODULE_MAP.md](./MODULE_MAP.md) and encoded in `platform/architecture/manifest.ts` —
15 kernel components (K-01…K-15) and 47 business modules (M-01…M-47) arranged in layers L1–L8.

Binding rules, all mechanically checked where a checker exists:

1. **Every file has exactly one owner.** A kernel component or a business module. Code that
   belongs to no registered unit is a violation, not an oversight — see the
   `violation-unregistered-unit` fixture.
2. **One module owns its data.** A module reads and writes its own tables. It does not read
   another module's tables, in code or in SQL; it goes through that module's contract.
3. **Dependencies point downward only.** `platform` → `kernel` → `design-system` → L1 → … → L8 →
   `apps`. See [MODULE_MAP.md §8](./MODULE_MAP.md#8-dependency-graph).
4. **No cycles.** Two modules that need each other have a missing third module or a misplaced
   responsibility. See [MODULE_MAP.md §10](./MODULE_MAP.md#10-anti-cycle-rules).
5. **No sibling imports within a layer.** Same-layer coordination goes through a lower layer or
   through events.
6. **Build order follows the dependency graph.** A unit is not built before the units it declares
   as dependencies — [MODULE_MAP.md §9](./MODULE_MAP.md#9-build-order).

Changing an ownership or dependency rule means changing [MODULE_MAP.md](./MODULE_MAP.md) **and**
`platform/architecture/manifest.ts` in the same change. Neither is the source of truth alone;
they are two representations of one decision, and the manifest tests exist to keep them honest.

---

## 8. AI authority is excluded from financial code

**AI never decides money.** Prices, fees, commissions, ledger entries, settlements and payouts are
produced by deterministic code with an auditable input-to-output path. AI may summarise, explain,
suggest, rank or draft — it may not compute or approve a financial outcome.

The deterministic financial authority zone is defined in
[MODULE_MAP.md §11](./MODULE_MAP.md#11-deterministic-financial-authority-zone) and encoded as
`FINANCIAL_ZONE_PREFIXES` in `platform/architecture/manifest.ts`:

```
kernel/ledger-foundation      modules/orders           modules/payments
modules/financial-ledger      modules/commission-rules modules/settlements
modules/seller-payouts        modules/rewards/ledger
```

The `financial-zone-ai` check rejects any import of `kernel/ai-gateway` from inside that zone, at
**P0 severity** — the highest, meaning it stops progression rather than being logged and deferred.
The zone matches on path boundaries, not string prefixes: `modules/rewards/ledger` is inside it
and `modules/rewards/ui` is not, and there is a test asserting exactly that distinction.

If you find yourself wanting an AI call inside the zone, the design is wrong. Move the
non-deterministic part outside the boundary and pass its output in as reviewed, validated data —
never as an authority.

---

## 9. Provider SDK imports are confined to K-13

**Only `kernel/ai-gateway` (K-13) may import a model-provider SDK.** Every other unit talks to the
gateway through its interface. See
[MODULE_MAP.md §12](./MODULE_MAP.md#12-ai-provider-neutrality).

This keeps provider choice a runtime configuration decision rather than a code-level commitment,
so a provider can be swapped, A/B-tested or dropped without touching 47 modules. The
`provider-import` check enforces it against the `PROVIDER_PACKAGES` allowlist in
`platform/architecture/manifest.ts`, matching exact names, subpaths and whole scopes while
rejecting lookalikes — `openai` and `openai/resources` are providers, `openai-schema-validator` is
not.

**An unlisted provider is an unenforced provider.** When a new provider is adopted, add it to
`PROVIDER_PACKAGES` in the same change that introduces it, or the check will wave it through.

---

## 10. Secrets handling

**No secret is ever committed.** Not a key, not a token, not a connection string, not a
"temporary" test credential.

- `.env` and `.env.*` are git-ignored; `.env.example` is deliberately exempted and holds **names
  only, never values**.
- Configuration arrives from the environment at runtime. Provider credentials belong to the
  deployment environment, not the repository.
- Never log a secret, and never include one in an error message, a test fixture or a document.
- A secret that reaches a commit is compromised, whatever the repository's visibility. Rotate it
  first, then remove it. Removing it from the working tree is not sufficient — it stays in history.
- CI runs with least privilege: the workflow declares `permissions: contents: read` and passes
  `persist-credentials: false` to checkout, so no token is left on disk for a later step to use.
- Dependencies are audited on every CI run with `npm audit --audit-level=high`; high and critical
  advisories fail the build rather than being recorded and ignored.

No secret-management infrastructure exists in this repository yet — see
[CURRENT_IMPLEMENTATION_STATUS.md §4](./CURRENT_IMPLEMENTATION_STATUS.md#4-absent-infrastructure).
Until it does, the rule is simply that there is nothing to manage, because nothing is stored here.

---

## 11. Atomic changes

**One bounded task per change.** A change delivers one coherent thing and leaves the repository
verifiable at every point.

A change is atomic when:

- it delivers a single task, and the reason for every file in it is the same reason;
- `npm run verify` exits 0 with the change applied;
- documentation is updated in the same change as the code it describes, not afterwards;
- an evidence block is recorded for any status that moved, per
  [CURRENT_IMPLEMENTATION_STATUS.md §11](./CURRENT_IMPLEMENTATION_STATUS.md#11-evidence-register);
- unrelated cleanups, reformatting and drive-by refactors are left out. They are their own change.

**Nothing is marked complete without evidence.** A status moves to `COMPLETE` only with the
command that was run, its exit code and its output. "Tests pass" is not evidence. A status may
also move backwards: finding that something was marked complete prematurely is normal
housekeeping, and the correction is recorded rather than quietly applied.

Status vocabulary is fixed — `[ ]` NOT STARTED, `[~]` IN PROGRESS, `[?]` NEEDS REVIEW, `[x]`
COMPLETE, `[!]` BLOCKED, `[-]` DEFERRED, `[o]` OUT OF SCOPE — and is defined in
[MASTER_IMPLEMENTATION_CHECKLIST.md §0](./MASTER_IMPLEMENTATION_CHECKLIST.md#0-how-to-use-this-checklist).

---

## 12. Review

Every change is reviewed against the same questions, in this order:

1. **Does `npm run verify` pass?** If not, the review stops here.
2. **Does it respect the boundaries?** Layer direction, kernel purity, financial-zone AI
   exclusion, provider confinement. The checks answer this mechanically; the reviewer confirms no
   check was weakened to make the change fit.
3. **Was any check, fixture or exclusion weakened?** Unpinning a dependency, deleting a fixture,
   lowering an audit threshold, adding `continue-on-error` or `|| true`, or broadening an ignore
   list is a change to the repository's guarantees and needs to be justified explicitly, not
   noticed in a diff.
4. **Does every claim match reality?** Documented status against recorded evidence. An
   unsupported completion claim is a defect in its own right.
5. **Is the scope atomic?** Unrelated changes are split out.
6. **Are new rules enforced or merely described?** A new architectural rule needs a check and a
   planted fixture, or an explicit note saying it is unenforced and why.

Defects found in review are recorded when found, not when fixed. A P0 — anything touching
financial correctness, security, or a boundary that guards them — stops progression immediately.

---

## 13. Branch and Git conventions

This repository's Git operations are performed by **Conductor**, an automation layer that owns
commits, pushes and branch management. Contributors — human or agent — express changes as **file
changes on disk**, and Conductor commits and pushes them.

**Inside a Conductor-managed session, do not run:**

```
git commit    git push    git checkout    git branch    git merge    git rebase
```

Doing so corrupts Conductor's record of what a session changed. Read-only Git commands
(`git status`, `git diff`, `git log`, `git show`) are fine and encouraged.

Branch conventions:

| Branch | Role |
|---|---|
| `conductor/p2p-com-03af26` | Default branch. CI builds pull requests and pushes targeting it. |
| `conductor/<session>` | Working branches created and owned by Conductor, one per session. |

Commit conventions, applied by Conductor from the session's work:

- One task per commit, subject line prefixed with the task id — `FND-001d: add contributor
  documentation`.
- The body explains **why**, not what; the diff already says what.
- No commit is amended after it is pushed; a correction is a new commit with its own reason.
- Force-pushing a shared branch is not done.

Where a task instruction asks for a commit, a push, or verification that something is tracked in
Git, that part is satisfied by Conductor. Write the files; leave the Git operations alone.

---

## 14. Documentation duties that come with a change

Three documents are updated as part of the change that affects them, never afterwards:

| Document | Update when |
|---|---|
| [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md) | Any task finishes. Record the evidence block in §11 and move statuses in §7. |
| [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md) | Any tracked item changes status. The evidence column carries the command and result, not a claim. |
| [MODULE_MAP.md](./MODULE_MAP.md) | Ownership, dependencies, layering, the financial zone or provider neutrality change — together with `platform/architecture/manifest.ts`. |

Then validate:

```bash
node docs/tools/validate-doc-links.mjs
```

Every relative link and every Markdown anchor under `/docs` must resolve. The validator exits 1
on the first broken reference, so a stale cross-reference fails rather than rotting quietly.

This document is itself under contract: `platform/checks/docs-contract.ts` reads it and
`tests/docs-contract.test.ts` — run by `npm test`, and so by `npm run verify` — fails the build if
any of the guarantees above is deleted or weakened. If you remove a section, you are removing a
rule, and the build will say so.
