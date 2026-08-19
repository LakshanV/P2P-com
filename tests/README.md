# /tests — cross-cutting tests

| Path | Purpose |
|---|---|
| `node-version.test.ts` | Version parsing, comparison and range checking (FND-001a). |
| `toolchain.test.ts` | The reproducibility contract: pinned toolchain vs supported ranges (FND-001a). |
| `manifest.test.ts` | Structural integrity of the architecture manifest against `docs/MODULE_MAP.md`. |
| `boundaries.test.ts` | Positive and planted-violation proofs for each of the four boundary checks. |
| `fixtures/` | Deliberately non-conforming source trees. **Excluded from TypeScript, ESLint and Prettier on purpose.** |

Run with `npm test`.

`fixtures/` is not broken code awaiting repair — it is the evidence that each check can fail.
"Fixing" a fixture silently disables the proof that the corresponding rule is enforced.

Module-local tests will live beside their modules once modules exist. This directory holds only
what spans the whole repository.
