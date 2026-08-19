# Planted-invalid fixtures

Every file here is **deliberately wrong**. Each one violates exactly one rule of the
fixture-manifest contract in `platform/fixtures/manifest.ts`, and `tests/seed-fixtures.test.ts`
requires the validator to reject it with that rule's check id.

**Do not fix them.** A planted fixture that passes validation is a check that cannot fail, which is
the same as no check at all. If a file here starts passing, the validator has regressed — repair
the validator, not the fixture.

They are excluded from TypeScript, ESLint and Prettier (see `tsconfig.json` and `.prettierignore`),
because formatting them would rewrite the very text the tests assert against.

| File | Violates | The mistake it stands for |
|---|---|---|
| `malformed-manifest.fixture.json` | `malformed-manifest` | a format version this code does not read |
| `unknown-owner.fixture.json` | `unknown-owner` | a schema no unit in the architecture manifest owns |
| `cross-owner-table.fixture.json` | `cross-owner-table` | a K-05 dataset writing into K-08's schema |
| `duplicate-identity.fixture.json` | `duplicate-identity` | two rows claiming to be the same row, so one is dead data |
| `dependency-cycle-a/b.fixture.json` | `dependency-cycle` | two datasets each waiting for the other |
| `malformed-record.fixture.json` | `malformed-record` | a nested value in a column not declared as JSON |
| `nondeterministic-value.fixture.json` | `nondeterministic-value` | `now()` in a row, so the baseline depends on the clock |
| `credential-in-fixture.fixture.json` | `credential-in-fixture` | a seeded API key |
| `personal-data.fixture.json` | `personal-data` | a deliverable email address at a real domain |
| `fingerprint-mismatch.fixture.json` | `fingerprint-mismatch` | a payload edited without recomputing its fingerprint |
| `fingerprint-mismatch-altered-hash.fixture.json` | `fingerprint-mismatch` | a fingerprint edited without recomputing from the payload |
| `fingerprint-mismatch-orphan.fixture.json` | `fingerprint-mismatch` | a fingerprint with no payload to confirm it |
