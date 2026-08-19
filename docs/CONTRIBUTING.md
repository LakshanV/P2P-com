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
6. [Module ownership and dependency rules](#6-module-ownership-and-dependency-rules)
7. [AI authority is excluded from financial code](#7-ai-authority-is-excluded-from-financial-code)
8. [Provider SDK imports are confined to K-13](#8-provider-sdk-imports-are-confined-to-k-13)
9. [Secrets handling](#9-secrets-handling)
10. [Atomic changes](#10-atomic-changes)
11. [Review](#11-review)
12. [Branch and Git conventions](#12-branch-and-git-conventions)
13. [Documentation duties that come with a change](#13-documentation-duties-that-come-with-a-change)

---

## 1. Prerequisites

| Requirement | Exact version | Where it is declared |
|---|---|---|
| Node.js | **26.7.0** | `.nvmrc` |
| npm | **11.19.0** | `packageManager` in `package.json` |
| Git | any recent version | — |

Nothing else. No database, no Docker, no cloud account, no environment variables: the repository
currently contains a platform substrate and its tests, and none of them touch a network or a
data store. That will change at FND-002; this section changes with it.

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

It chains six gates in order and stops at the first failure:

| Command | What it proves |
|---|---|
| `npm run typecheck` | `tsc --noEmit` under strict mode, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. |
| `npm run lint` | ESLint with type-aware rules across all TypeScript. |
| `npm run format:check` | Prettier formatting, repository-wide. |
| `npm run build` | `tsc -p tsconfig.build.json` compiles and emits `dist/`; `postbuild` re-runs the boundary checks against the emitted output. |
| `npm run check:boundaries` | The four architectural checks below, over the real source tree. |
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

**These files are not broken code awaiting repair.** They are the evidence that each check can
fail. A check that has never rejected anything is indistinguishable from a check that returns
success unconditionally, and "fixing" a fixture silently converts an enforced rule into a
decorative one.

They are excluded from TypeScript (`tsconfig.json` → `exclude`), ESLint
(`eslint.config.mjs` → `ignores`) and Prettier (`.prettierignore`) on purpose — linting a
deliberate violation would report the very problem it exists to demonstrate. The exclusions are
load-bearing, not tidiness.

When you add a boundary check, add its fixture in the same change.
`tests/boundaries.test.ts` asserts that every declared check id has one, so a check without a
fixture fails the build.

---

## 6. Module ownership and dependency rules

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

## 7. AI authority is excluded from financial code

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

## 8. Provider SDK imports are confined to K-13

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

## 9. Secrets handling

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

## 10. Atomic changes

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

## 11. Review

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

## 12. Branch and Git conventions

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

## 13. Documentation duties that come with a change

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
