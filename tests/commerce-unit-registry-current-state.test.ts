/**
 * K-11 Commerce Unit Registry — what the adapter does when the store disagrees with itself (FND-005c).
 *
 * Every test here is about one question: *which version of this category is in force right now.*
 * It is the question every listing, order line, commission decision and risk pack keys off, and
 * the two reads that answer it — `findCurrentActivation` for one type, `listInForce` for the
 * lineage walk — are the only places in K-11 where a broken store can produce a **plausible**
 * answer rather than an error.
 *
 * That is the failure mode being closed. The activation table has two partial unique indexes and
 * the version table has a primary key, so none of these states is reachable through the service;
 * reaching one means a row arrived another way — a restored dump, an `INSERT` run by hand, an
 * index dropped for a bulk load and not rebuilt. What matters is what the adapter does then:
 *
 *   - Two activations at the end of one chain: `LIMIT 1` would have picked whichever row the plan
 *     reached first, per read, and reported it as the version in force.
 *   - An activation whose version row is absent: an inner join drops it, so a registered category
 *     reads as one that was never registered — and everything descending from it reads as
 *     `missing-parent`, which is a true-sounding answer to a question nobody asked.
 *   - An activation and its version naming different types: the service files the in-force set by
 *     the *version's* type key, so one category answers with another category's definition while
 *     its own disappears from the set.
 *
 * None of the three throws anything on its own. Each is a wrong answer delivered confidently, and
 * a wrong answer here is copied into every record created under it. So all three are refused, and
 * these are the tests that say so.
 *
 * Driven through `RecordingDatabase`, which runs the real adapter and the real service against
 * canned rows: the states under test cannot be created through the component that is supposed to
 * make them impossible, and a live server would refuse to hold them.
 *
 * What that seam can and cannot carry is worth being exact about, because one of the three faults
 * is decided by the *statement* rather than by the rows. The recorder does not execute SQL, so no
 * fixture here can make a join drop a row. So "a dangling reference is not omitted" is asserted in
 * two halves — the statement is a `LEFT JOIN` with no `type_key` in its condition, which is what
 * makes the broken row arrive at all, and the decoder refuses that row naming the activation and
 * the version it points at. The ambiguity and mismatch faults are carried by the rows themselves
 * and are asserted end to end.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  CommerceUnitRegistryService,
  PostgresCommerceUnitRepository,
  toUnitTypeActivation,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  BRANCH,
  FixedClock,
  PLATFORM_REGISTRAR,
  ROOT,
  StubConfiguration,
  StubPolicy,
  activationRow,
  versionRow,
} from './helpers/commerce-unit-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

/** The columns `listInForce` re-prefixes, taken from the fixture so the two cannot drift. */
const VERSION_ROW_COLUMNS = Object.keys(versionRow());

/**
 * One row of the `listInForce` projection: the activation's columns, plus the version's under a
 * `version_` prefix.
 *
 * A `null` version is what a `LEFT JOIN` returns when the version row the activation names is not
 * there — every `version_` column null, rather than the row simply being absent. Modelling it that
 * way is the point: an inner join makes a dangling reference indistinguishable from a type that
 * was never activated, and this suite is about telling those two apart.
 */
function inForceRow(
  activation: Record<string, unknown>,
  version: Record<string, unknown> | null,
): Record<string, unknown> {
  const row: Record<string, unknown> = { ...activation };
  for (const column of VERSION_ROW_COLUMNS) {
    row[`version_${column}`] = version === null ? null : version[column];
  }
  return row;
}

/** The second type in the fixtures: `goods.electronics`, extending `goods`. */
const BRANCH_VERSION_ID = 'typever_01HQZXTESTS';
const branchActivation = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  activationRow({
    activation_id: 'act_01HQZXTESTROW2',
    type_key: BRANCH,
    type_version_id: BRANCH_VERSION_ID,
    idempotency_key: 'idem_01HQZXTESTRW4',
    ...overrides,
  });
const branchVersion = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  versionRow({
    type_version_id: BRANCH_VERSION_ID,
    type_key: BRANCH,
    parent_type_key: ROOT,
    idempotency_key: 'idem_01HQZXTESTRW5',
    ...overrides,
  });

/**
 * A database answering `listInForce` with the rows given, and every other read with nothing.
 *
 * Matched on the joined table rather than on the word `LEFT`, so that a test asserting the set
 * still comes back intact is answering the same rows whichever join the adapter issues — a matcher
 * that only recognised the hardened statement would report an unchanged happy path as broken.
 */
const listing = (rows: readonly Record<string, unknown>[]): RecordingDatabase =>
  new RecordingDatabase({ selects: [{ match: /commerce_unit_type_version definition/i, rows }] });

/** A database answering the terminal-activation read with the rows given. */
const chain = (rows: readonly Record<string, unknown>[]): RecordingDatabase =>
  new RecordingDatabase({
    selects: [{ match: /commerce_unit_type_activation current/i, rows }],
  });

const serviceOn = (database: RecordingDatabase): CommerceUnitRegistryService =>
  new CommerceUnitRegistryService({
    repository: new PostgresCommerceUnitRepository(database),
    clock: new FixedClock(),
    configuration: new StubConfiguration(),
    policy: new StubPolicy(),
    registrar: PLATFORM_REGISTRAR,
  });

const selectsOf = (database: RecordingDatabase): string[] =>
  database.statements().filter((sql) => sql.startsWith('SELECT'));

// ---------------------------------------------------------------------------
// findCurrentActivation — the end of one chain
// ---------------------------------------------------------------------------

test('the version in force is found by anti-join, and the query may not converge on one of two', async () => {
  const database = chain([]);
  await new PostgresCommerceUnitRepository(database).withTransaction((tx) =>
    tx.findCurrentActivation(ROOT),
  );

  const sql = selectsOf(database)[0] ?? '';
  assert.match(sql, /NOT EXISTS/i, 'the version in force must be found by anti-join');
  assert.match(sql, /later\.supersedes_version_id = current\.type_version_id/);
  assert.ok(
    !/ORDER BY\s+(current\.)?activated_at/i.test(sql),
    'ordering by the clock would pick arbitrarily between two activations sharing an instant',
  );
  // The claim this suite exists for: the statement reads one row *more* than an answer may be, so
  // a second end of the chain is something the adapter can see rather than something it discards.
  assert.ok(
    !/\bLIMIT\s+1\b/i.test(sql),
    'LIMIT 1 would silently choose between two terminal activations',
  );
  assert.match(sql, /\bLIMIT\s+2\b/i, 'the read must stay bounded while still seeing ambiguity');
  assert.match(
    sql,
    /ORDER BY current\.activation_id/,
    'the two rows a refusal names must not depend on the plan',
  );
});

test('one terminal activation is still just the answer', async () => {
  const database = chain([activationRow()]);
  const activation = await new PostgresCommerceUnitRepository(database).withTransaction((tx) =>
    tx.findCurrentActivation(ROOT),
  );

  assert.equal(activation?.activationId, 'act_01HQZXTESTROW1');
  assert.equal(activation?.typeKey, ROOT);
  assert.equal(activation?.typeVersionId, 'typever_01HQZXTESTR');
  assert.equal(activation?.activatedAt, '2026-04-01T12:00:00.654321Z');
  assert.equal(activation?.supersedesVersionId, null);
});

test('a type nobody activated is null, which is not the same as a broken one', async () => {
  const activation = await new PostgresCommerceUnitRepository(chain([])).withTransaction((tx) =>
    tx.findCurrentActivation(ROOT),
  );
  assert.equal(activation, null);
});

test('two activations that nothing supersedes are refused, not chosen between', async () => {
  const database = chain([
    activationRow(),
    activationRow({
      activation_id: 'act_01HQZXTESTROW2',
      type_version_id: BRANCH_VERSION_ID,
      idempotency_key: 'idem_01HQZXTESTRW4',
    }),
  ]);

  const error = await new PostgresCommerceUnitRepository(database)
    .withTransaction((tx) => tx.findCurrentActivation(ROOT))
    .then(
      (activation) => {
        assert.fail(`an ambiguous chain resolved to ${String(activation?.activationId)}`);
      },
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
  const message = error instanceof Error ? error.message : '';
  assert.match(message, /more than one activation that nothing supersedes/);
  // Both, by name. A refusal that does not say which rows disagree sends whoever reads it back to
  // a table of every activation ever recorded with nothing to search for.
  assert.match(message, /act_01HQZXTESTROW1/);
  assert.match(message, /act_01HQZXTESTROW2/);
  assert.match(message, new RegExp(ROOT));
});

test('the transaction that met an ambiguous chain rolls back and releases', async () => {
  const database = chain([activationRow(), activationRow({ activation_id: 'act_01HQZXTESTROW2' })]);

  await assert.rejects(
    new PostgresCommerceUnitRepository(database).withTransaction((tx) =>
      tx.findCurrentActivation(ROOT),
    ),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );

  assert.ok(database.indexOf(/^ROLLBACK/) >= 0, 'the refusal must not leave the transaction open');
  assert.equal(database.indexOf(/^COMMIT/), -1);
  assert.equal(database.sessionsReleased, database.sessionsOpened);
});

// ---------------------------------------------------------------------------
// listInForce — the whole set the lineage walk is built from
// ---------------------------------------------------------------------------

test('the in-force set keeps its shape: one pair per type, joined on the version id alone', async () => {
  const database = listing([
    inForceRow(activationRow(), versionRow()),
    inForceRow(branchActivation(), branchVersion()),
  ]);

  const rows = await new PostgresCommerceUnitRepository(database).withTransaction((tx) =>
    tx.listInForce(),
  );

  assert.equal(rows.length, 2);
  assert.ok(Object.isFrozen(rows));
  assert.deepEqual(
    rows.map((entry) => entry.activation.typeKey),
    [ROOT, BRANCH],
  );
  assert.deepEqual(
    rows.map((entry) => entry.version.typeVersionId),
    ['typever_01HQZXTESTR', BRANCH_VERSION_ID],
  );
  assert.equal(rows[1]?.version.parentTypeKey, ROOT);
  assert.equal(rows[0]?.version.publishedAt, '2026-04-01T12:00:00.123456Z');

  const sql = selectsOf(database).find((statement) => /definition/i.test(statement)) ?? '';
  // A LEFT JOIN, so a dangling reference arrives as a row with null columns rather than not
  // arriving; and no type_key in the join condition, so a mismatch is not silently dropped either.
  assert.match(sql, /LEFT JOIN kernel_commerce_unit_registry\.commerce_unit_type_version/);
  assert.match(sql, /ON definition\.type_version_id = current\.type_version_id WHERE/);
  assert.ok(
    !/ON definition\.type_version_id = current\.type_version_id AND/i.test(sql),
    'adding type_key to the join would turn a mismatch back into an omitted row',
  );
  assert.match(sql, /ORDER BY current\.type_key, current\.activation_id/);
  assert.match(sql, /commerce_unit_type_retirement retired/, 'retired types must be excluded here');
});

test('two terminal activations for one type make the whole set a refusal', async () => {
  // Both rows decode perfectly. Nothing about either one is malformed — the contradiction is that
  // both exist, which is why it has to be settled over the set rather than row by row.
  const database = listing([
    inForceRow(activationRow(), versionRow()),
    inForceRow(
      activationRow({
        activation_id: 'act_01HQZXTESTROW3',
        type_version_id: BRANCH_VERSION_ID,
        idempotency_key: 'idem_01HQZXTESTRW6',
      }),
      versionRow({ type_version_id: BRANCH_VERSION_ID, idempotency_key: 'idem_01HQZXTESTRW7' }),
    ),
  ]);

  const error = await new PostgresCommerceUnitRepository(database)
    .withTransaction((tx) => tx.listInForce())
    .then(
      (rows) => assert.fail(`an ambiguous set was returned with ${rows.length} rows`),
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
  const message = error instanceof Error ? error.message : '';
  assert.match(message, /more than one activation that nothing supersedes/);
  assert.match(message, /act_01HQZXTESTROW1/);
  assert.match(message, /act_01HQZXTESTROW3/);
});

test('a duplicate in one type does not let the other types through', async () => {
  // The set is indexed by type key and walked as a lineage. Returning the types that happen to be
  // unambiguous would answer a lineage question from a set that is missing a level, which is a
  // different wrong answer rather than a smaller one.
  const database = listing([
    inForceRow(activationRow(), versionRow()),
    inForceRow(
      activationRow({
        activation_id: 'act_01HQZXTESTROW3',
        type_version_id: BRANCH_VERSION_ID,
        idempotency_key: 'idem_01HQZXTESTRW6',
      }),
      versionRow({ type_version_id: BRANCH_VERSION_ID, idempotency_key: 'idem_01HQZXTESTRW7' }),
    ),
    inForceRow(branchActivation(), branchVersion()),
  ]);

  await assert.rejects(
    new PostgresCommerceUnitRepository(database).withTransaction((tx) => tx.listInForce()),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('an activation whose version row is absent is refused, not quietly dropped', async () => {
  const database = listing([
    inForceRow(activationRow(), null),
    inForceRow(branchActivation(), branchVersion()),
  ]);

  const error = await new PostgresCommerceUnitRepository(database)
    .withTransaction((tx) => tx.listInForce())
    .then(
      (rows) =>
        assert.fail(
          `a dangling version reference was omitted; ${rows.length} row(s) came back instead`,
        ),
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
  const message = error instanceof Error ? error.message : '';
  assert.match(message, /act_01HQZXTESTROW1/, 'the refusal must name the activation');
  assert.match(message, /typever_01HQZXTESTR/, 'and the version row that is not there');
  assert.match(message, /no such version row exists/);
});

test('an activation and a version disagreeing about the type key is refused', async () => {
  // The join is on the version id, so this row *exists*: an activation for goods.electronics
  // pointing at a version of goods. Unrefused, the service files it under the version's key — so
  // goods answers with the wrong definition and goods.electronics vanishes from the set entirely.
  const database = listing([
    inForceRow(branchActivation({ type_version_id: 'typever_01HQZXTESTR' }), versionRow()),
  ]);

  const error = await new PostgresCommerceUnitRepository(database)
    .withTransaction((tx) => tx.listInForce())
    .then(
      (rows) => assert.fail(`a mismatched pair was returned: ${JSON.stringify(rows[0]?.version)}`),
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
  const message = error instanceof Error ? error.message : '';
  assert.match(message, new RegExp(BRANCH), 'the refusal must name the type the activation claims');
  assert.match(message, new RegExp(`version of ${ROOT}`), 'and the type the version belongs to');
});

test('two separately broken activations are not reported as one ambiguous type', async () => {
  // Neither row has a readable type key, so neither belongs to any type. Counting them together
  // under a placeholder would name a fault — "this type has two ends" — that is not the one there.
  const database = listing([
    inForceRow(activationRow({ type_key: null }), versionRow()),
    inForceRow(branchActivation({ type_key: null }), branchVersion()),
  ]);

  const error = await new PostgresCommerceUnitRepository(database)
    .withTransaction((tx) => tx.listInForce())
    .then(
      (rows) => assert.fail(`rows with no type key came back: ${rows.length}`),
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
  const message = error instanceof Error ? error.message : '';
  assert.ok(
    !/more than one activation that nothing supersedes/.test(message),
    `a broken type key was reported as an ambiguous chain: ${message}`,
  );
  assert.match(message, /type_key/);
});

test('a malformed row anywhere in the set refuses the set, not just that row', async () => {
  // `kind` is not one of v3 §11's ten. The pre-existing decoder catches it; what this asserts is
  // that a set containing it does not come back with the well-formed rows and a hole where the
  // category was.
  const database = listing([
    inForceRow(activationRow(), versionRow({ kind: 'crypto-token' })),
    inForceRow(branchActivation(), branchVersion()),
  ]);

  await assert.rejects(
    new PostgresCommerceUnitRepository(database).withTransaction((tx) => tx.listInForce()),
    (error: unknown) => error instanceof CommerceUnitError,
  );
});

// ---------------------------------------------------------------------------
// Through the service, which is where a wrong answer would have been acted on
// ---------------------------------------------------------------------------

test('a well-formed store still resolves through the adapter, unchanged', async () => {
  const resolved = await serviceOn(
    listing([
      inForceRow(activationRow(), versionRow()),
      inForceRow(branchActivation(), branchVersion()),
    ]),
  ).resolve({ typeKey: BRANCH });

  assert.equal(resolved.typeVersionId, BRANCH_VERSION_ID);
  assert.equal(resolved.kind, 'new-product');
  // From the immediate parent outwards to the root, which for goods.electronics is just goods.
  assert.deepEqual(resolved.ancestry, [ROOT]);
});

test('resolve refuses a dangling version rather than reporting the category as unregistered', async () => {
  // `no-such-type` is the answer this must not give. It is what the inner join produced — the row
  // dropped, the key absent from the set — and a caller acting on it would conclude the category
  // had never been registered, while every listing already created under it holds its version id.
  // Whether the row reaches the decoder at all is the statement's business and is asserted above;
  // what is asserted here is that arriving broken does not become "not there".
  const error = await serviceOn(listing([inForceRow(activationRow(), null)]))
    .resolve({ typeKey: ROOT })
    .then(
      (resolved) => assert.fail(`resolve answered with ${JSON.stringify(resolved)}`),
      (thrown: unknown) => thrown,
    );

  assert.equal(codeOf(error), 'malformed-record');
});

test('resolve refuses a mismatched pair rather than answering with another category definition', async () => {
  const database = listing([
    inForceRow(branchActivation({ type_version_id: 'typever_01HQZXTESTR' }), versionRow()),
  ]);

  await assert.rejects(
    serviceOn(database).resolve({ typeKey: ROOT }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('the decoders are unchanged: a projected row still decodes, a driver Date still does not', () => {
  const activation = toUnitTypeActivation(activationRow());
  assert.equal(activation.typeKey, ROOT);
  assert.ok(Object.isFrozen(activation));

  assert.throws(
    () => toUnitTypeActivation(activationRow({ activated_at: new Date('2026-04-01T12:00:00Z') })),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});
