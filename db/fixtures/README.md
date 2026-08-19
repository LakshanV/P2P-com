# db/fixtures — seed data

Development and test data for the kernel foundations that exist. A fixture here is a **declared
dataset**, not a script: the runner reads it, validates it and inserts it, and there is no place in
a fixture to put code.

**Delivered by FND-002d.** Nothing has been loaded into a live PostgreSQL server — see
[Limitations](#limitations).

---

## Commands

```bash
npm run check:fixtures     # validate every dataset. No database needed; wired into npm run verify
npm run db:fixtures        # list datasets and the order they load in
npm run db:seed            # load, additively and idempotently, into DATABASE_URL
npm run db:seed:reset -- --confirm=<database>   # delete the declared rows and re-insert them
```

`db:seed` and `db:seed:reset` take their target from `DATABASE_URL` and never from an argument, so
a connection string cannot end up in shell history or a process listing. Copy `.env.example` to
`.env` and run `npm run db:up && npm run db:ready && npm run db:migrate` first — fixtures write into
schemas the migrations create.

An invalid fixture set never reaches the database, and that is enforced by the **runner** rather
than by the CLI. `seed`, `unseed` and `replace` each run the complete validation over whatever
manifests they are handed and refuse before opening a connection. Validating only in the CLI would
have meant the contract was enforced by the route taken to the runner: a programmatic caller passing
hand-built manifests would have bypassed every ownership, identity, determinism, credential,
personal-data, fingerprint and dependency check, and a guarantee that holds only for polite callers
is not one.

---

## Safety

Two different guards, because they refuse two different mistakes.

| Command | Refuses | Guard |
|---|---|---|
| `db:seed` | any host that is not this machine; any database whose name contains `prod`, `production`, `live`, `staging`, `stage`, `uat` or `preprod`; an unparseable connection string | `assertSeedableTarget` |
| `db:seed:reset` | everything above, **plus** any database not ending in `_test`, **plus** a missing or wrong `--confirm=<database>` | `assertSafeTestTarget` (the existing provisioning guard) and an explicit confirmation |

`reset` deletes and reloads in **one transaction**. It was previously an unseed followed by a
seed — each atomic on its own, which sounds like enough and is not: between the two commits the
database held no fixture data at all, and a reload that failed there left an empty database and an
error message. Any failure in either half now rolls the whole replacement back, and the original
rows are still there.

The development database is loadable and **never replaceable**. `reset` deletes rows, and the
database somebody has been working in all afternoon is not where that should be discovered. Only the
derived `_test` database — the one the integration harness creates and drops — may be replaced, and
even then the operator has to type its name.

`reset` deletes the rows the fixtures declare, by identity. It never truncates: the fixture set does
not own the tables it writes into, and a truncate would remove rows it never created.

---

## What a dataset declares

```jsonc
{
  "manifestVersion": 1,                    // checked, so a format change is never misread
  "dataset": "k05-configuration-baseline", // stable identifier, kebab-case, unique
  "owner": "K-05",                         // manifest unit id
  "schema": "kernel_configuration",        // the one schema it writes into; must belong to owner
  "purpose": "development",                // development | test — there is deliberately no production
  "description": "…",
  "dependsOn": [],                         // datasets that must load first
  "tables": [
    {
      "table": "kernel_configuration.config_version",
      "identity": ["version_id"],          // what makes a reload a no-op
      "jsonColumns": ["payload"],          // optional: columns holding a JSON document
      "rows": [{ "version_id": "ver-fixture-0001", "…": "…" }]
    }
  ]
}
```

### Rules, and what each prevents

| Refusal | Prevents |
|---|---|
| `malformed-manifest` | a format change being read as if it were the old format |
| `unknown-owner` | a dataset writing into a schema no unit owns, or claiming an owner that does not own it |
| `cross-owner-table` | a fixture reaching into another unit's namespace, which would make the boundary rules decorative |
| `duplicate-identity` | two rows claiming to be the same row, one of which is silently dead data |
| `dependency-cycle` | a set with no load order |
| `malformed-record` | a row missing its identity, or a nested value in a column not declared as JSON |
| `nondeterministic-value` | `now()`, `random()`, `gen_random_uuid()`, `DEFAULT` — a baseline whose content depends on when it loaded is not a baseline |
| `credential-in-fixture` | a seeded API key, private key or connection string. Seed data gets copied; a seeded credential is a real one the moment it lands somewhere shared |
| `personal-data` | a deliverable email address, a real-shaped phone number, or a 12–19 digit run. Use `example.com`, a `.test`/`.invalid` host, or a reserved `+1555…` range |
| `fingerprint-mismatch` | a row carrying a `payload_fingerprint` that is not the fingerprint of its own `payload`. Recomputed with the same canonical SHA-256 K-08 uses, before any database access |

Every rule has a planted-invalid fixture in `tests/fixtures/seed/` that the validator must reject.
A check with no planted violation is a check nobody has ever seen fail.

---

## Ownership and extension

A dataset belongs to the unit whose schema it writes into, and that unit owns its contents. To add
one:

1. Create `<dataset-name>.fixture.json` here. The owner must be a manifest unit **with an
   implemented contract** — there is no data to seed for a component that does not exist, and
   inventing some would be inventing its contract.
2. Write into that unit's schema and no other. A dataset that needs another unit's rows declares a
   `dependsOn` and lets that unit's dataset create them.
3. Give every table an `identity`. Without one, the second load duplicates every row.
4. Use fixed instants and literal identifiers throughout. Prefix ids with `fixture-` or similar so
   seeded rows are recognisable in a database somebody is debugging.
5. If a table keeps a payload and a fingerprint of it, compute the fingerprint from the payload —
   the validator recomputes and compares, so a copied or stale value is refused.
6. Run `npm run check:fixtures`. Calling the runner directly runs the same checks, so there is no
   route that skips them.

Loading order is a topological sort of `dependsOn` with ties broken by dataset name, so the same
manifests always produce the same plan. Within a dataset, tables load in declared order and rows in
declared order — put parents before children.

---

## Retention

Fixtures are **not** retained across a `db:reset` or a `db:destroy`: those recreate the database and
the fixtures must be loaded again. They are retained across `db:down`/`db:up`, because the compose
volume outlives the container.

Seeded rows are ordinary rows. Nothing marks them, and nothing cleans them up on a schedule — a
developer who wants them gone runs `db:seed:reset` against the `_test` database, or recreates the
development database with `npm run db:reset`.

---

## What is deliberately not here

- **No business-module data.** No module is implemented. Seeding orders, listings or payments would
  be inventing contracts that do not exist yet, and every test written against them would have to be
  rewritten when the real ones land.
- **No financial policy values.** Commission, fees, price, payout, settlement, tax, refund and
  interest belong to **K-06 Policy Engine**, which does not exist. `tests/seed-fixtures.test.ts`
  fails if a fixture declares one.
- **No production defaults.** A fixture is development and test data. Production configuration
  arrives through the application, and a seed file that could target production is one that
  eventually will.
- **No authoritative events.** The K-08 rows are delivery-state scenarios, not a real history: they
  were written by hand, not published through `EventService`, and nothing consumed them. They exist
  so a developer can see a delivered, a pending and a dead-lettered delivery without constructing
  each by hand.
- **No end-to-end commerce coverage.** Two kernel foundations' worth of rows is not a working
  marketplace, and no test here should be read as evidence that one exists.

---

## Limitations

- **Never loaded.** No PostgreSQL runtime is available to this repository. The datasets are
  validated statically and the runner is proved against an injected fake; that the rows satisfy the
  real `CHECK` constraints, foreign keys and unique indexes is **unverified**.
  `tests/integration/fixtures.integration.ts` makes exactly that check and skips, with its reason
  stated, when there is no server.
- The K-08 `payload_fingerprint` values are **recomputed and compared** by the validator, using
  the same canonical SHA-256 `EventService` uses, so editing a payload without recomputing its
  fingerprint is refused before any database access. The algorithm is duplicated in
  `platform/fixtures/fingerprint.ts` rather than imported: `platform/` sits below `kernel/` and
  may not import upward from it. `tests/seed-hardening.test.ts` runs both implementations over a
  corpus — including every payload in these fixtures — and fails if they ever disagree.
- There is no fixture versioning across schema changes. A migration that changes a column these
  datasets write leaves them invalid, and the validator will not notice — it checks the manifest
  contract, not the database schema. The live test above is what would catch it.
