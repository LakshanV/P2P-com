/**
 * K-05 Configuration — timestamp projection and decoding (FND-003a temporal fidelity).
 *
 * The defect these cover is invisible from inside the adapter: `pg` parses `timestamptz` into a
 * JavaScript `Date` by default, and a `Date` holds milliseconds where the column holds
 * microseconds. Selecting `effective_from` bare therefore truncated the value *before* any code
 * here saw it. Two versions 300µs apart came back as one instant — and two versions at one instant
 * cannot be ordered, which is exactly the ambiguity publication refuses on the way in. The
 * digits were gone by the time anything could notice.
 *
 * The fix has two halves, and both are asserted here because either alone is useless:
 *
 *   - **The projection.** Every timestamp column is selected through
 *     `to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, so the server produces the
 *     text and the driver's parser never runs. A test that only checked decoding would pass while
 *     the adapter quietly selected a `Date`.
 *   - **The decoder.** It accepts that form and nothing else, and refuses rather than falling back
 *     through `new Date(…)`. A wrong instant is worse than a failed read: it decides which version
 *     answered a question and leaves no trace of having been wrong.
 *
 * Structural assertions read the adapter's source, because "which columns appear in the SELECT
 * list" is not observable from a returned row.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ConfigurationError,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  PostgresConfigurationRepository,
  TIMESTAMP_COLUMNS,
  compareInstants,
} from '../kernel/configuration/index.ts';
import type { ConfigurationKey, PublishRequest } from '../kernel/configuration/index.ts';
import { RecordingDatabase, row } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_SOURCE = readFileSync(
  path.join(HERE, '..', 'kernel', 'configuration', 'postgres-repository.ts'),
  'utf8',
);

/**
 * The SELECTs the adapter actually sends, rendered.
 *
 * Read off a run rather than off the source, because the select list is interpolated: the source
 * says `SELECT ${PROJECTION}`, so scanning the file would prove nothing about what reaches the
 * server. Driving the three read paths and recording the SQL proves what is really issued.
 */
async function issuedSelects(): Promise<string[]> {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const repository = new PostgresConfigurationRepository(database);
  await repository.withTransaction(async (tx) => {
    await tx.findVersionById('ver-1');
    await tx.findByIdempotencyKey('idem-1');
    await tx.findVersions('session.timeout_seconds', [GLOBAL_SCOPE]);
  });
  return database.statements().filter((sql) => /^SELECT/i.test(sql));
}

const KEY = 'session.timeout_seconds';
const KEYS: readonly ConfigurationKey[] = [
  {
    id: KEY,
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'region', 'tenant'],
  },
];

const codeOf = (error: unknown): string | undefined =>
  error instanceof ConfigurationError ? error.code : undefined;

/** A repository whose every SELECT answers with one row. */
const readingBack = (
  overrides: Record<string, unknown>,
): { repository: PostgresConfigurationRepository; database: RecordingDatabase } => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [row(overrides)] }],
  });
  return { repository: new PostgresConfigurationRepository(database), database };
};

// ---------------------------------------------------------------------------
// 1. The projection: no timestamp column reaches the driver's parser
// ---------------------------------------------------------------------------

test('the adapter issues the three SELECTs this suite is about', async () => {
  const selects = await issuedSelects();
  assert.equal(selects.length, 3, 'findVersionById, findByIdempotencyKey and findVersions');
});

test('every timestamp column in every SELECT is projected as UTC text', async () => {
  assert.deepEqual(
    [...TIMESTAMP_COLUMNS],
    ['effective_from', 'created_at', 'published_at', 'superseded_at'],
    'all four timestamptz columns are covered, not only the one resolution reads',
  );

  for (const sql of await issuedSelects()) {
    const selectList = sql.slice(0, sql.search(/\bFROM\b/i));

    for (const column of TIMESTAMP_COLUMNS) {
      const projected = `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
      assert.ok(selectList.includes(projected), `${column} must be projected as text in: ${sql}`);

      // And bare nowhere in the select list. A stray `, effective_from,` would hand the driver a
      // timestamptz to parse, which is the whole defect.
      const withoutProjection = selectList.split(projected).join(' ');
      assert.ok(
        !new RegExp(`(^|[\\s,(])${column}(\\s*,|\\s*$)`).test(withoutProjection),
        `${column} also appears bare in the select list of: ${sql}`,
      );
    }
  }
});

test('the projection is deterministic: UTC, fixed precision, no locale-dependent field', async () => {
  for (const sql of await issuedSelects()) {
    assert.ok(sql.includes("AT TIME ZONE 'UTC'"), 'the session TimeZone must not decide the value');
    assert.ok(sql.includes('.US"Z"'), 'six fractional digits, which is what timestamptz stores');
    assert.ok(
      !/(?:^|[^A-Za-z])(?:Mon|Day|MONTH|DY|TZ)(?:[^A-Za-z]|$)/.test(sql),
      'a month name, day name or time-zone abbreviation would depend on server settings',
    );
  }
});

test('the SELECT list carries no caller data', async () => {
  for (const sql of await issuedSelects()) {
    assert.ok(
      !sql.includes('${'),
      'an unresolved interpolation means something other than a constant reached the SQL',
    );
  }
  assert.match(
    ADAPTER_SOURCE,
    /const PROJECTION = COLUMN_NAMES\.map\(/,
    'PROJECTION must be derived from the literal column list, not assembled from input',
  );
});

test('ordering is done on the timestamp column, not on the projected text', async () => {
  const ordered = (await issuedSelects()).find((sql) => /ORDER BY/i.test(sql));
  assert.ok(ordered !== undefined, 'findVersions orders its results');
  assert.match(
    ordered,
    /ORDER BY config_version\.effective_from ASC/,
    'an unqualified name would resolve to the text output column, making the sort lexical',
  );
});

test('the adapter never falls back through the Date parser', () => {
  const decoder = ADAPTER_SOURCE.slice(
    ADAPTER_SOURCE.indexOf('function instant('),
    ADAPTER_SOURCE.indexOf('export function encodeValue'),
  );
  assert.ok(decoder.length > 0, 'the decoder was found');
  assert.ok(
    !/new Date\(/.test(decoder),
    'a Date fallback silently approximates whatever it does not recognise',
  );
});

// ---------------------------------------------------------------------------
// 2. Decoding: exact, or refused
// ---------------------------------------------------------------------------

test('distinct microsecond instants stay distinct', async () => {
  const first = await readingBack({
    effective_from: '2026-01-01T00:00:00.000200Z',
  }).repository.withTransaction((tx) => tx.findVersionById('ver-1'));
  const second = await readingBack({
    effective_from: '2026-01-01T00:00:00.000500Z',
  }).repository.withTransaction((tx) => tx.findVersionById('ver-1'));

  assert.equal(first?.effectiveFrom, '2026-01-01T00:00:00.0002Z');
  assert.equal(second?.effectiveFrom, '2026-01-01T00:00:00.0005Z');
  assert.equal(
    compareInstants(first?.effectiveFrom ?? '', second?.effectiveFrom ?? ''),
    -1,
    'a Date round trip would have collapsed both to 2026-01-01T00:00:00Z and made them unorderable',
  );

  // The defect, stated directly: the driver's parser truncates both to the same millisecond, so
  // two versions 300µs apart arrive indistinguishable and unorderable.
  assert.equal(new Date('2026-01-01T00:00:00.000200Z').toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(new Date('2026-01-01T00:00:00.000500Z').toISOString(), '2026-01-01T00:00:00.000Z');
});

test('equivalent spellings decode to one spelling and compare equal', async () => {
  const cases = [
    ['2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00Z'],
    ['2026-01-01T00:00:00.120000Z', '2026-01-01T00:00:00.12Z'],
    ['2026-01-01T00:00:00.500000Z', '2026-01-01T00:00:00.5Z'],
    ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123456Z'],
  ] as const;

  for (const [stored, expected] of cases) {
    const version = await readingBack({ effective_from: stored }).repository.withTransaction((tx) =>
      tx.findVersionById('ver-1'),
    );
    assert.equal(version?.effectiveFrom, expected, `${stored} decodes as ${expected}`);
    assert.equal(
      compareInstants(version?.effectiveFrom ?? '', stored),
      0,
      'and is the same moment',
    );
  }
});

test('all four timestamp columns decode, and the nullable two stay null', async () => {
  const version = await readingBack({
    effective_from: '2026-02-01T00:00:00.000001Z',
    created_at: '2026-01-01T12:30:45.654321Z',
    published_at: null,
    superseded_at: null,
    status: 'draft',
  }).repository.withTransaction((tx) => tx.findVersionById('ver-1'));

  assert.equal(version?.effectiveFrom, '2026-02-01T00:00:00.000001Z');
  assert.equal(version?.createdAt, '2026-01-01T12:30:45.654321Z');
  assert.equal(version?.publishedAt, null, 'not yet published stays not yet published');
  assert.equal(version?.supersededAt, null);

  const superseded = await readingBack({
    published_at: '2026-01-15T00:00:00.000000Z',
    superseded_at: '2026-02-01T00:00:00.750000Z',
    status: 'superseded',
  }).repository.withTransaction((tx) => tx.findVersionById('ver-1'));

  assert.equal(superseded?.publishedAt, '2026-01-15T00:00:00Z');
  assert.equal(superseded?.supersededAt, '2026-02-01T00:00:00.75Z');
});

test('a timestamp that arrives as a Date is refused, not approximated', async () => {
  for (const column of TIMESTAMP_COLUMNS) {
    const { repository } = readingBack({
      [column]: new Date('2026-01-01T00:00:00Z'),
      status: 'superseded',
      published_at: column === 'published_at' ? new Date() : '2026-01-01T00:00:00.000000Z',
      superseded_at: column === 'superseded_at' ? new Date() : '2026-02-01T00:00:00.000000Z',
    });

    await assert.rejects(
      repository.withTransaction((tx) => tx.findVersionById('ver-1')),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-value');
        assert.match((error as ConfigurationError).message, /rather than text|already lost/);
        return true;
      },
      `${column} arriving as a Date means the projection was bypassed`,
    );
  }
});

test('malformed and non-finite stored timestamps are refused', async () => {
  const rejected = [
    ['infinity', 'PostgreSQL permits an infinite timestamptz; this component does not'],
    ['-infinity', 'and neither direction is an instant a version can be effective from'],
    ['2026-01-01 00:00:00+00', 'a session-formatted timestamp did not come from the projection'],
    ['2026-01-01T00:00:00Z', 'the projection always emits six fractional digits'],
    ['2026-01-01T00:00:00.000Z', 'three digits is not the projected form either'],
    ['2026-01-01', 'a bare date is not an instant'],
    ['', 'empty text is not an instant'],
    ['not a timestamp at all', 'nor is arbitrary text'],
    ['2026-02-30T00:00:00.000000Z', 'the right shape, but not a date the calendar contains'],
    ['2026-01-01T24:00:00.000000Z', 'nor is hour 24'],
  ] as const;

  for (const [stored, why] of rejected) {
    await assert.rejects(
      readingBack({ effective_from: stored }).repository.withTransaction((tx) =>
        tx.findVersionById('ver-1'),
      ),
      (error: unknown) => codeOf(error) === 'invalid-value',
      `"${stored}" must be refused: ${why}`,
    );
  }

  // A number, a boolean and undefined are refused on the same fail-closed path.
  for (const stored of [0, 1_767_225_600_000, true]) {
    await assert.rejects(
      readingBack({ effective_from: stored }).repository.withTransaction((tx) =>
        tx.findVersionById('ver-1'),
      ),
      (error: unknown) => codeOf(error) === 'invalid-value',
      `${String(stored)} is not text`,
    );
  }
});

test('a refusal names the column, so a bad row can be found', async () => {
  await assert.rejects(
    readingBack({ superseded_at: 'infinity', status: 'superseded' }).repository.withTransaction(
      (tx) => tx.findVersionById('ver-1'),
    ),
    (error: unknown) => {
      assert.match((error as ConfigurationError).message, /superseded_at/);
      assert.match((error as ConfigurationError).message, /infinity/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. Round trips: what was published is what comes back
// ---------------------------------------------------------------------------

test('a publication round trip preserves the exact instant it was given', async () => {
  const effectiveFrom = '2026-02-01T00:00:00.123456Z';
  const database = new RecordingDatabase({
    selects: [
      // The re-read after activation, once the row exists.
      { match: /SELECT[\s\S]*WHERE version_id = \$1/, rows: [] },
    ],
  });
  const repository = new PostgresConfigurationRepository(database);
  const service = new ConfigurationService(new ConfigurationRegistry(KEYS), repository);

  const request: PublishRequest = {
    key: KEY,
    scope: GLOBAL_SCOPE,
    value: 1800,
    effectiveFrom,
    idempotencyKey: 'idem-round-trip',
    versionId: 'ver-round-trip',
    origin: 'human',
    authorityLevel: 'global',
    now: '2026-01-15T00:00:00.000000Z',
    expectedActiveVersionId: null,
  };

  // The re-read finds nothing in this fake, so publication cannot complete; what matters is the
  // instant that was sent to the INSERT, unrounded and unreformatted.
  await assert.rejects(service.publish(request));

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined, 'the draft was written');
  assert.ok(
    insert.params.includes(effectiveFrom),
    `the exact instant must reach the INSERT; params were ${JSON.stringify(insert.params)}`,
  );
});

test('resolution answers with the instant the row holds, to the microsecond', async () => {
  const database = new RecordingDatabase({
    selects: [
      {
        match: /SELECT[\s\S]*config_key = \$1/,
        rows: [
          row({
            version_id: 'ver-1',
            effective_from: '2026-01-01T00:00:00.000000Z',
            value_text: '900',
          }),
          row({
            version_id: 'ver-2',
            effective_from: '2026-01-01T00:00:00.000400Z',
            value_text: '1800',
            status: 'active',
          }),
        ],
      },
    ],
  });
  const service = new ConfigurationService(
    new ConfigurationRegistry(KEYS),
    new PostgresConfigurationRepository(database),
  );

  const before = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00.000300Z',
  });
  assert.equal(before.value, 900, 'the later version is not yet effective at this microsecond');
  assert.equal(before.versionId, 'ver-1');

  const after = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00.000400Z',
  });
  assert.equal(after.value, 1800, '400µs later, the second version answers');
  assert.equal(after.versionId, 'ver-2');
});

test('a decision record pins the exact stored instant', async () => {
  const { repository } = readingBack({
    version_id: 'ver-pinned',
    effective_from: '2026-01-01T00:00:00.000750Z',
    published_at: '2026-01-01T00:00:00.000750Z',
  });
  const version = await repository.withTransaction((tx) => tx.findVersionById('ver-pinned'));

  assert.equal(version?.effectiveFrom, '2026-01-01T00:00:00.00075Z');
  assert.equal(version?.publishedAt, '2026-01-01T00:00:00.00075Z');
  assert.equal(
    compareInstants(version?.effectiveFrom ?? '', '2026-01-01T00:00:00.0007Z'),
    1,
    'the 750th microsecond is after the 700th — a distinction milliseconds cannot hold',
  );
});
