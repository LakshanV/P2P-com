# /platform — substrate

Runtime foundations shared by everything above, containing **no business rules**.

| Path | Purpose |
|---|---|
| `runtime/node-version.ts` | Version parsing and minimum-range checking, so the `engines.node` pin is verifiable from code rather than only declared in a manifest. |

Delivered by FND-001a (toolchain substrate). Database access, migrations, queueing, object
storage, logging and the architectural boundary checks are **not** here yet — they belong to
later FND-001 subtasks and to FND-002.
