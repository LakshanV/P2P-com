# /platform — substrate

Runtime foundations shared by everything above, containing **no business rules**.

| Path | Purpose |
|---|---|
| `runtime/node-version.ts` | Version parsing, comparison and minimum-range checking, so `engines.node` is verifiable from code rather than only declared in a manifest. |
| `runtime/package-manager.ts` | Parses the `packageManager` pin. Accepts only an exact `name@major.minor.patch`; rejects range syntax, because a pin that admits a span of versions is not a pin. |
| `architecture/manifest.ts` | Machine-readable encoding of `docs/MODULE_MAP.md`: 15 kernel components, 47 business modules, layer depths, the financial authority zone as path prefixes, and the model-provider SDK list. |
| `checks/boundaries.ts` | The four executable boundary checks. Imports are extracted with the TypeScript compiler API, so multi-line, dynamic, re-export and require forms are handled exactly. |
| `checks/cli.ts` | `npm run check:boundaries`. Exits 1 on any violation; `--root`, `--json`, `--quiet`. |

## Pinned toolchain vs supported range

These answer different questions and are deliberately kept apart:

| | Node | npm |
|---|---|---|
| **Pinned** — what this repository is developed and verified against | `26.7.0` (`.nvmrc`) | `11.19.0` (`packageManager`) |
| **Supported** — what the project will run on | `>=22.18.0` (`engines.node`) | `>=10.0.0` (`engines.npm`) |

`tests/toolchain.test.ts` binds them together: each pin must be exact, each range must stay a
minimum, and every pin must lie inside its own range. A lockfile fixes the dependency graph but
not the tool that resolves it, which is why the package manager is pinned explicitly.

## Enforced architectural boundaries

Four of the eight checks in [`docs/MODULE_MAP.md` §13](../docs/MODULE_MAP.md#13-enforcement-and-verification)
are executable and run inside `npm run verify`:

| Check | Rule | Severity |
|---|---|---|
| `layer-direction` | Imports point downward only; same-layer modules communicate by event; unregistered units are rejected | P1 |
| `kernel-purity` | The kernel never depends on a business module, the design system or an app | P1 |
| `financial-zone-ai` | The deterministic financial authority zone never imports K-13 | **P0** |
| `provider-import` | Only `kernel/ai-gateway` (K-13) may import a model-provider SDK | P1 |

Each has a committed planted-violation fixture under `tests/fixtures/` asserted to be rejected —
a check that cannot fail is a placeholder (v3 §54).

Two limits, stated plainly: the checks read **static imports only**, so runtime indirection (a
service locator, dependency injection by name, or raw SQL reaching another module's table) is
invisible to them; and the **kernel is treated as one layer**, so its internal ordering
(K-01 → K-02/K-03 → K-04) is not checked.

Delivered by FND-001a (toolchain) and FND-001b (manifest and boundary checks). Database access,
migrations, queueing, object storage and logging are **not** here yet — they belong to FND-002.
The four remaining §13 checks — table ownership, policy-literal scan, contract presence, cycle
detection — need a schema, policy values and module contracts to exist first.
