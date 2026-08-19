/**
 * K-09 against a live PostgreSQL server (FND-003c) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-09 is proved against an injected repository, which is right: the refusals
 * are what matter and a fake makes them deterministic. Three claims cannot be proved that way,
 * because they are claims *about PostgreSQL*:
 *
 *   - that the append-only trigger really refuses `UPDATE` and `DELETE` — the strongest thing this
 *     component says, and a fake can only model it;
 *   - that the `CHECK` constraints refuse what the service refuses, so a write around the adapter
 *     is stopped too;
 *   - that `(recorded_at, record_id)` pagination is exact against the real index when every record
 *     shares an instant.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_TABLE,
  AuditActionRegistry,
  AuditService,
  PostgresAuditRepository,
} from '../../kernel/audit-foundation/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { ACTIONS, recordRequest } from '../helpers/audit-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const REGISTRY = new AuditActionRegistry(ACTIONS);

/** Every column of the table, in declaration order, for a write that goes around the adapter. */
const PROBE_COLUMNS =
  'record_id, action, recorded_at, actor_kind, actor_id, actor_authentication, ' +
  'actor_session_id, resource_owner, resource_type, resource_id, outcome, reason, ' +
  'correlation_id, causation_id, evidence, content_fingerprint, idempotency_key';

/** A row the constraints accept, with named literals replaced. */
function probeValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    record_id: `'aud-probe'`,
    action: `'configuration.version_published'`,
    recorded_at: `'2026-04-01T12:00:00Z'`,
    actor_kind: `'system'`,
    actor_id: `'K-05'`,
    actor_authentication: `'unauthenticated'`,
    actor_session_id: 'NULL',
    resource_owner: `'K-05'`,
    resource_type: `'configuration_version'`,
    resource_id: `'ver-1'`,
    outcome: `'succeeded'`,
    reason: `'published'`,
    correlation_id: `'corr-1'`,
    causation_id: 'NULL',
    evidence: `'{}'::jsonb`,
    content_fingerprint: `'${'a'.repeat(64)}'`,
    idempotency_key: `'idem-probe'`,
    ...overrides,
  };
  return PROBE_COLUMNS.split(', ')
    .map((column) => base[column] as string)
    .join(', ');
}

const probeInsert = (overrides: Record<string, string> = {}): string =>
  `INSERT INTO ${AUDIT_TABLE} (${PROBE_COLUMNS}) VALUES (${probeValues(overrides)});`;

async function countRecords(database: Database): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${AUDIT_TABLE};`,
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
  'records append, satisfy the real constraints, and retry idempotently',
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

      const service = new AuditService(REGISTRY, new PostgresAuditRepository(database));
      const request = recordRequest({ recordId: 'aud-live-1', idempotencyKey: 'idem-live-1' });

      const first = await service.record(request);
      assert.equal(first.deduplicated, false);
      assert.equal(await countRecords(database), 1);

      // The claim a fake cannot make: the same key again, against the real unique constraint.
      const retry = await service.record({ ...request });
      assert.equal(retry.deduplicated, true);
      assert.equal(retry.record.contentFingerprint, first.record.contentFingerprint);
      assert.equal(await countRecords(database), 1);

      // And the record survives a round trip through the real column types.
      const read = await service.recordById('aud-live-1');
      assert.deepEqual(read, first.record);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((row) => row.version),
      before.applied.map((row) => row.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses to change or remove a record', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const service = new AuditService(REGISTRY, new PostgresAuditRepository(database));
    await service.record(recordRequest({ recordId: 'aud-live-1', idempotencyKey: 'idem-live-1' }));

    // A connection that never went through this component at all — which is the only interesting
    // case, since the component has no such operation to begin with.
    const updated = await refuses(
      database,
      `UPDATE ${AUDIT_TABLE} SET reason = 'rewritten' WHERE record_id = 'aud-live-1';`,
    );
    assert.ok(updated !== null, 'an UPDATE must be refused by the trigger');
    assert.match(updated, /append-only/i);

    const deleted = await refuses(
      database,
      `DELETE FROM ${AUDIT_TABLE} WHERE record_id = 'aud-live-1';`,
    );
    assert.ok(deleted !== null, 'a DELETE must be refused by the trigger');
    assert.match(deleted, /append-only/i);

    assert.equal(await countRecords(database), 1, 'the record is still there, unchanged');
    const read = await service.recordById('aud-live-1');
    assert.equal(read.reason, 'published by the configuration service');
  });
});

test('the database refuses what the service refuses', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // Each of these is refused by the service too. The point is that a write around it is refused
    // as well, which is what makes the constraints worth declaring.
    for (const [why, overrides] of [
      ['an AI actor', { actor_kind: `'ai'` }],
      ['an unknown outcome', { outcome: `'partially'` }],
      ['an empty reason', { reason: `'   '` }],
      ['an action name that is not dotted', { action: `'published'` }],
      ['evidence that is not an object', { evidence: `'[1,2]'::jsonb` }],
      ['a fingerprint that is not a SHA-256', { content_fingerprint: `'nope'` }],
    ] as const) {
      const refusal = await refuses(database, probeInsert(overrides));
      assert.ok(refusal !== null, `${why} must be refused by the database`);
    }

    assert.equal(await countRecords(database), 0, 'none of the probes landed');
  });
});

test(
  'the database accepts exactly one actor-authentication combination',
  liveTestOptions,
  async () => {
    // The whole matrix, not a sample. The first revision of migration 0005 said "a session id
    // requires an authentication method", which reads sensibly and accepted ('session', 'sess-1') —
    // a combination the service refuses, because K-02 does not exist and nothing has authenticated
    // anybody. A bypass write could therefore claim an authenticated session the platform has no
    // way to have established. Enumerating every combination is what makes that impossible to
    // reintroduce: only the documented placeholder may land.
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const METHODS = ['unauthenticated', 'session', 'service-credential'] as const;
      const SESSIONS = [null, 'sess-1'] as const;

      let accepted = 0;
      for (const method of METHODS) {
        for (const session of SESSIONS) {
          const isPlaceholder = method === 'unauthenticated' && session === null;
          const refusal = await refuses(
            database,
            probeInsert({
              record_id: `'aud-${method}-${session ?? 'none'}'`,
              idempotency_key: `'idem-${method}-${session ?? 'none'}'`,
              actor_authentication: `'${method}'`,
              actor_session_id: session === null ? 'NULL' : `'${session}'`,
            }),
          );

          if (isPlaceholder) {
            assert.equal(
              refusal,
              null,
              'the documented placeholder must still be writable, or K-09 could record nothing',
            );
            accepted += 1;
          } else {
            assert.ok(
              refusal !== null,
              `(${method}, ${session ?? 'NULL'}) must be refused: it claims an authentication ` +
                'K-02 cannot yet have performed',
            );
          }
        }
      }

      // An authentication method the enum does not know at all, for completeness.
      assert.ok(
        (await refuses(
          database,
          probeInsert({
            record_id: `'aud-unknown-method'`,
            idempotency_key: `'idem-unknown-method'`,
            actor_authentication: `'bearer-token'`,
          }),
        )) !== null,
        'an unknown authentication method must be refused',
      );

      assert.equal(accepted, 1, 'exactly one of the six combinations is permitted');
      assert.equal(await countRecords(database), 1, 'and exactly one row landed');
    });
  },
);

test(
  'pagination is exact against the real index when instants collide',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const service = new AuditService(REGISTRY, new PostgresAuditRepository(database));
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const recordId = `aud-live-${String(index).padStart(2, '0')}`;
        ids.push(recordId);
        await service.record(
          recordRequest({
            recordId,
            idempotencyKey: `idem-${recordId}`,
            // Every record shares one instant: the case where ordering on time alone breaks.
            recordedAt: '2026-04-01T12:00:00Z',
          }),
        );
      }

      const walked = await service.queryAll({ limit: 2 });
      assert.deepEqual(
        walked.map((record) => record.recordId),
        ids,
        'every record exactly once, in id order, with nothing skipped or repeated',
      );
      assert.equal(new Set(walked.map((record) => record.recordId)).size, ids.length);
    });
  },
);

test(
  'an enlisted append commits with the caller, or rolls back with it',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      // Committed together.
      const client = await database.connect();
      try {
        await client.query('BEGIN;');
        const service = new AuditService(REGISTRY, PostgresAuditRepository.enlist(client));
        await service.record(recordRequest({ recordId: 'aud-tx-1', idempotencyKey: 'idem-tx-1' }));
        await client.query('COMMIT;');
      } finally {
        await client.release();
      }
      assert.equal(await countRecords(database), 1);

      // Rolled back together: the caller's ROLLBACK must undo the append.
      const second = await database.connect();
      try {
        await second.query('BEGIN;');
        const service = new AuditService(REGISTRY, PostgresAuditRepository.enlist(second));
        await service.record(recordRequest({ recordId: 'aud-tx-2', idempotencyKey: 'idem-tx-2' }));
        await second.query('ROLLBACK;');
      } finally {
        await second.release();
      }
      assert.equal(await countRecords(database), 1, 'the rolled-back record left nothing behind');
    });
  },
);
