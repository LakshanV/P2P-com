# /platform — substrate

Runtime foundations shared by everything above, containing **no business rules**.

| Path | Purpose |
|---|---|
| `runtime/node-version.ts` | Version parsing, comparison and minimum-range checking, so `engines.node` is verifiable from code rather than only declared in a manifest. |
| `runtime/package-manager.ts` | Parses the `packageManager` pin. Accepts only an exact `name@major.minor.patch`; rejects range syntax, because a pin that admits a span of versions is not a pin. |

## Pinned toolchain vs supported range

These answer different questions and are deliberately kept apart:

| | Node | npm |
|---|---|---|
| **Pinned** — what this repository is developed and verified against | `26.7.0` (`.nvmrc`) | `11.19.0` (`packageManager`) |
| **Supported** — what the project will run on | `>=22.18.0` (`engines.node`) | `>=10.0.0` (`engines.npm`) |

`tests/toolchain.test.ts` binds them together: each pin must be exact, each range must stay a
minimum, and every pin must lie inside its own range. A lockfile fixes the dependency graph but
not the tool that resolves it, which is why the package manager is pinned explicitly.

Delivered by FND-001a (toolchain substrate). Database access, migrations, queueing, object
storage, logging and the architectural boundary checks are **not** here yet — they belong to
later FND-001 subtasks and to FND-002.
