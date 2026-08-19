/**
 * K-01 against a live PostgreSQL server (FND-004a) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-01 is proved against an injected repository, which is right: the refusals
 * are what matter and a reference implementation makes them deterministic. Three claims cannot be
 * proved that way, because they are claims *about PostgreSQL*:
 *
 *   - that the write-once trigger really refuses `UPDATE` and `DELETE` — the strongest thing this
 *     component says, and a fake can only model it;
 *   - that the `CHECK` constraints refuse what the service refuses, so a write around the adapter
 *     is stopped too — in particular an AI origin and a natural-key subject id;
 *   - that a concurrent retry against the real unique index converges rather than producing a
 *     second identity for one party.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 *
 * `tests/integration-safety.test.ts` fails the build if this file reaches around the harness.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDENTITY_TABLE,
  IdentityService,
  PostgresIdentityRepository,
} from '../../kernel/identity/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { createRequest } from '../helpers/identity-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

/** Every column of the table, in declaration order, for a write that goes around the adapter. */
const PROBE_COLUMNS = 'subject_id, kind, created_at, origin_kind, origin_id, idempotency_key';

/** A row the constraints accept, with named literals replaced. */
function probeValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    subject_id: `'sub_01HQZXPROBE001'`,
    kind: `'person'`,
    created_at: `'2026-04-01T12:00:00Z'`,
    origin_kind: `'system'`,
    origin_id: `'K-03-account-service'`,
    idempotency_key: `'idem_01HQZXPROBE001'`,
    ...overrides,
  };
  return PROBE_COLUMNS.split(', ')
    .map((column) => base[column] as string)
    .join(', ');
}

const probeInsert = (overrides: Record<string, string> = {}): string =>
  `INSERT INTO ${IDENTITY_TABLE} (${PROBE_COLUMNS}) VALUES (${probeValues(overrides)});`;

async function countSubjects(database: Database): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${IDENTITY_TABLE};`,
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

/** Run one statement and report whether the server refused it. */
async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

test(
  'subjects are created, read back exactly, and retry idempotently',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new IdentityService(new PostgresIdentityRepository(database));
      const request = createRequest({
        subjectId: 'sub_01HQZXLIVE0001',
        idempotencyKey: 'idem_01HQZXLIVE0001',
        createdAt: '2026-04-01T12:00:00.123456Z',
      });

      const first = await service.create(request);
      assert.equal(first.deduplicated, false);
      assert.equal(await countSubjects(database), 1);

      // The claim a fake cannot make: the same key again, against the real unique constraint.
      const retry = await service.create({ ...request });
      assert.equal(retry.deduplicated, true);
      assert.equal(await countSubjects(database), 1, 'one party, one subject');

      // And the microseconds survived the real timestamptz column, rather than being rounded to
      // milliseconds by the driver's Date parser.
      const read = await service.requireSubject('sub_01HQZXLIVE0001');
      assert.equal(read.createdAt, '2026-04-01T12:00:00.123456Z');
      assert.deepEqual(read, first.subject);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((row) => row.version),
      before.applied.map((row) => row.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses to rewrite or remove an identity', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const service = new IdentityService(new PostgresIdentityRepository(database));
    await service.create(
      createRequest({ subjectId: 'sub_01HQZXLIVE0002', idempotencyKey: 'idem_01HQZXLIVE0002' }),
    );

    // The component has no such operation, so this is SQL by hand — the case the trigger is for.
    const updated = await refuses(
      database,
      `UPDATE ${IDENTITY_TABLE} SET kind = 'organisation' WHERE subject_id = 'sub_01HQZXLIVE0002';`,
    );
    assert.ok(updated !== null, 'an UPDATE must be refused by the trigger');
    assert.match(updated, /write-once/i);

    const deleted = await refuses(
      database,
      `DELETE FROM ${IDENTITY_TABLE} WHERE subject_id = 'sub_01HQZXLIVE0002';`,
    );
    assert.ok(deleted !== null, 'a DELETE must be refused by the trigger');
    assert.match(deleted, /write-once/i);

    assert.equal(await countSubjects(database), 1, 'the subject is still there, unchanged');
    const read = await service.requireSubject('sub_01HQZXLIVE0002');
    assert.equal(read.kind, 'person');
  });
});

test('the database refuses what the service refuses', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // Each of these is refused by the service too. The point is that a write around it is refused
    // as well, which is what makes the constraints worth declaring.
    for (const [why, overrides] of [
      ['an AI origin', { origin_kind: `'ai'` }],
      ['an unknown origin kind', { origin_kind: `'daemon'` }],
      ['a role as a kind', { kind: `'seller'` }],
      ['an email as a subject id', { subject_id: `'alice@example.com'` }],
      ['a natural key as a subject id', { subject_id: `'199012345678901'` }],
      ['a guessably short subject id', { subject_id: `'sub_1'` }],
      ['an identifier with a space', { subject_id: `'sub 01HQZX0001'` }],
      ['an email as an origin id', { origin_id: `'alice@example.com'` }],
      ['a blank origin id', { origin_id: `'   '` }],
      ['a short idempotency key', { idempotency_key: `'k1'` }],
    ] as const) {
      const refusal = await refuses(database, probeInsert(overrides));
      assert.ok(refusal !== null, `${why} must be refused by the database`);
    }

    assert.equal(await countSubjects(database), 0, 'none of the probes landed');
  });
});

test('concurrent retries against the real unique index converge', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const service = new IdentityService(new PostgresIdentityRepository(database));
    const request = createRequest({
      subjectId: 'sub_01HQZXLIVERACE',
      idempotencyKey: 'idem_01HQZXLIVERACE',
    });

    const results = await Promise.all([
      service.create(request),
      service.create({ ...request }),
      service.create({ ...request }),
    ]);

    assert.equal(await countSubjects(database), 1, 'three creators, one identity');
    assert.equal(
      results.filter((result) => !result.deduplicated).length,
      1,
      'exactly one creator actually created it, and the others converged on it',
    );
    for (const result of results) {
      assert.deepEqual(result.subject, results[0]?.subject);
    }
  });
});

test('an enlisted create commits and rolls back with the caller', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // Committed together with a statement the caller owns.
    const committing = await database.connect();
    try {
      await committing.query('BEGIN;');
      await PostgresIdentityRepository.enlist(committing).withTransaction((tx) =>
        tx.insertSubject({
          subjectId: 'sub_01HQZXENLIST01',
          kind: 'organisation',
          createdAt: '2026-04-01T12:00:00Z',
          origin: { kind: 'system', id: 'K-03-account-service' },
          idempotencyKey: 'idem_01HQZXENLIST01',
        }),
      );
      await committing.query('COMMIT;');
    } finally {
      await committing.release();
    }
    assert.equal(await countSubjects(database), 1);

    // And discarded when the caller rolls back — the outcome enlistment exists to guarantee.
    const rolling = await database.connect();
    try {
      await rolling.query('BEGIN;');
      await PostgresIdentityRepository.enlist(rolling).withTransaction((tx) =>
        tx.insertSubject({
          subjectId: 'sub_01HQZXENLIST02',
          kind: 'person',
          createdAt: '2026-04-01T12:00:00Z',
          origin: { kind: 'human', id: 'ops-alice-console' },
          idempotencyKey: 'idem_01HQZXENLIST02',
        }),
      );
      await rolling.query('ROLLBACK;');
    } finally {
      await rolling.release();
    }

    assert.equal(
      await countSubjects(database),
      1,
      "the caller's rollback undid the enlisted write",
    );
  });
});
