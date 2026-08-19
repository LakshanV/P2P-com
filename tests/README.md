# /tests — cross-cutting tests

| Path | Purpose |
|---|---|
| `node-version.test.ts` | Version parsing, comparison and range checking (FND-001a). |
| `toolchain.test.ts` | The reproducibility contract: pinned toolchain vs supported ranges (FND-001a). |
| `manifest.test.ts` | Structural integrity of the architecture manifest against `docs/MODULE_MAP.md`. |
| `boundaries.test.ts` | Positive and planted-violation proofs for each of the four boundary checks. |
| `docs-contract.test.ts` | Anti-erosion proofs for `docs/CONTRIBUTING.md` (FND-001d). |
| `migrations.test.ts` | The migration contract and schema-namespace convention (FND-002a). |
| `migration-runner.test.ts` | The migration runner, against an injected fake database (FND-002b). |
| `provisioning-contract.test.ts` | Local provisioning and the isolated test-database guard (FND-002c). |
| `integration-safety.test.ts` | Proves no live suite can reach the development database, and that `.env` alone configures everything (FND-002c). |
| `helpers/fake-database.ts` | The in-memory stand-in for PostgreSQL. Not a test; imported by the runner tests. |
| `configuration.test.ts` | K-05 Configuration: refusals, effective time, decision pinning (FND-003a). |
| `configuration-lifecycle.test.ts` | K-05 draft lifecycle, replacement ordering, idempotency, explicit region, adapter query order. |
| `configuration-repository.test.ts` | K-05 port conformance and module contract. |
| `configuration-temporal.test.ts` | K-05 canonical instants, competing publications, constraint translation, retries after supersession. |
| `configuration-timestamp-projection.test.ts` | K-05 timestamps projected as UTC text, decoded fail-closed, round-tripped to the microsecond. |
| `events.test.ts` | K-08 event type registry, envelope validation and publication refusals (FND-003b). |
| `events-delivery.test.ts` | K-08 claiming, retry, dead-lettering, the crash window, and operator replay. |
| `events-repository.test.ts` | K-08 port conformance, adapter queries and module contract. |
| `events-concurrency.test.ts` | K-08 commit-time conflict parity, convergent concurrent retries, and appending inside a caller's transaction. |
| `helpers/recording-database.ts` | Records the SQL the PostgreSQL adapter issues. Not a test. |
| `integration/harness.ts` | The only sanctioned route to a database. Derives and guards the `_test` database, creates it, drops it in a `finally`. Not a test. |
| `integration/` | Opt-in live-PostgreSQL suites. **Outside `npm test`** — run with `npm run test:integration`; they skip with a stated reason when nothing is configured. Every one goes through the harness. |
| `fixtures/` | Deliberately non-conforming source trees, plus `fixtures/migrations/` — one directory per migration-contract check. **Excluded from TypeScript, ESLint and Prettier on purpose.** |

Run with `npm test`.

`fixtures/` is not broken code awaiting repair — it is the evidence that each check can fail.
"Fixing" a fixture silently disables the proof that the corresponding rule is enforced.

Module-local tests will live beside their modules once modules exist. This directory holds only
what spans the whole repository.
