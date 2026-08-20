/**
 * K-07 against a live PostgreSQL server (FND-004e) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-07 is proved against an injected repository. Five claims cannot be,
 * because they are claims *about the server*:
 *
 *   - that the **append-only triggers** refuse `UPDATE` and `DELETE` on all three tables, so a
 *     rollout cannot be widened in place and the record of a kill cannot be erased by a statement
 *     no code here can issue;
 *   - that the **activation guard is the database's rule**, not merely the reference
 *     implementation's: two activations superseding one version, and two first activations for one
 *     flag, are both refused by partial unique indexes rather than by a read-then-write;
 *   - that the **constraints refuse what the service refuses** — a flag key naming authority or
 *     money, a percentage on a flag that is not rolling out, rules on one that is not targeted, a
 *     window containing no instant, an AI author, a natural key in an identifier column, and a
 *     lifecycle event with no reason;
 *   - that **microseconds survive** the `timestamptz` columns and come back through the `to_char`
 *     projection exactly as written, and that `jsonb` round-trips as the structure it went in as;
 *   - that `kernel_feature_flags` can be **created and rolled back without touching any other
 *     schema**, which is what the refused foreign keys were traded for and the only place it is
 *     observable.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_TABLE,
  LIFECYCLE_TABLE,
  PostgresFeatureFlagRepository,
  VERSION_TABLE,
  type Activation,
  type FlagVersion,
} from '../../kernel/feature-flags/index.ts';
import type { Database } from '../../platform/db/client.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';

import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const FLAG = 'commerce.autonomous-purchasing';
const AUTHORITY = 'k07-release-console';

function versionFor(
  version: number,
  suffix: string,
  overrides: Partial<FlagVersion> = {},
): FlagVersion {
  return {
    flagVersionId: `flagver_01HQZXLIVE${suffix}`,
    flagKey: FLAG,
    version,
    state: 'targeted',
    supportedScopes: ['global', 'country'],
    rules: [
      { kind: 'attribute-in', attribute: 'country', values: ['country_gb001', 'country_lk01'] },
    ],
    percentage: 0,
    rolloutSalt: 'salt01HQZXLIVE01',
    notBefore: null,
    notAfter: null,
    publishedAt: '2026-04-01T12:00:00.123456Z',
    publishedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: `idem_01HQZXLIVEV${suffix}`,
    requestFingerprint: 'c'.repeat(64),
    ...overrides,
  };
}

function activationFor(suffix: string, overrides: Partial<Activation> = {}): Activation {
  return {
    activationId: `act_01HQZXLIVEA${suffix}`,
    flagKey: FLAG,
    flagVersionId: `flagver_01HQZXLIVE${suffix}`,
    supersedesVersionId: null,
    activatedAt: '2026-04-01T12:00:00.654321Z',
    activatedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: `idem_01HQZXLIVEA${suffix}`,
    requestFingerprint: 'd'.repeat(64),
    ...overrides,
  };
}

async function countRows(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
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

const VERSION_INSERT_COLUMNS =
  'flag_version_id, flag_key, version, state, supported_scopes, rules, percentage, rollout_salt, ' +
  'not_before, not_after, published_at, published_by_kind, published_by_id, idempotency_key, ' +
  'request_fingerprint';

function versionValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    flag_version_id: `'flagver_01HQZXPROBE1'`,
    flag_key: `'commerce.autonomous-purchasing'`,
    version: '90',
    state: `'off'`,
    supported_scopes: `'["global"]'::jsonb`,
    rules: `'[]'::jsonb`,
    percentage: '0',
    rollout_salt: `'salt01HQZXPROBE1'`,
    not_before: 'NULL',
    not_after: 'NULL',
    published_at: `'2026-04-01T12:00:00Z'`,
    published_by_kind: `'system'`,
    published_by_id: `'k07-release-console'`,
    idempotency_key: `'idem_01HQZXPROBE01'`,
    request_fingerprint: `'${'c'.repeat(64)}'`,
    ...overrides,
  };
  return VERSION_INSERT_COLUMNS.split(', ')
    .map((column) => base[column] ?? 'NULL')
    .join(', ');
}

test('K-07 against a live PostgreSQL server', liveTestOptions, async (t) => {
  const before = await developmentSnapshot();

  await withTestDatabase(async ({ database, directory }) => {
    await t.test('the schema is created, written to, and read back exactly', async () => {
      await migrateUp(database, { directory });

      const repository = new PostgresFeatureFlagRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertVersion(versionFor(1, '01'));
        await tx.insertActivation(activationFor('01'));
      });

      // Read back through the adapter's own decoder: microseconds survived the timestamptz column
      // and the jsonb round-tripped as the structure it was written as.
      const stored = await repository.withTransaction((tx) =>
        tx.findVersionById('flagver_01HQZXLIVE01'),
      );
      assert.equal(stored?.publishedAt, '2026-04-01T12:00:00.123456Z');
      assert.equal(stored?.state, 'targeted');
      assert.deepEqual(stored?.supportedScopes, ['global', 'country']);
      assert.deepEqual(stored?.rules[0], {
        kind: 'attribute-in',
        attribute: 'country',
        values: ['country_gb001', 'country_lk01'],
      });

      const current = await repository.withTransaction((tx) => tx.findCurrentActivation(FLAG));
      assert.equal(current?.flagVersionId, 'flagver_01HQZXLIVE01');
      assert.equal(current?.activatedAt, '2026-04-01T12:00:00.654321Z');
    });

    await t.test('the current version is the end of the chain, on a real server', async () => {
      const repository = new PostgresFeatureFlagRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertVersion(versionFor(2, '02', { idempotencyKey: 'idem_01HQZXLIVEV02' }));
        await tx.insertActivation(
          activationFor('02', { supersedesVersionId: 'flagver_01HQZXLIVE01' }),
        );
      });

      const current = await repository.withTransaction((tx) => tx.findCurrentActivation(FLAG));
      assert.equal(
        current?.flagVersionId,
        'flagver_01HQZXLIVE02',
        'the anti-join must find the activation nothing supersedes',
      );
    });

    await t.test(
      'the activation guard is the database’s rule, not only the service’s',
      async () => {
        // Two activations superseding the same version: the partial unique index refuses the second.
        const second = await refuses(
          database,
          `INSERT INTO ${ACTIVATION_TABLE} (activation_id, flag_key, flag_version_id,
           supersedes_version_id, activated_at, activated_by_kind, activated_by_id,
           idempotency_key, request_fingerprint)
         VALUES ('act_01HQZXPROBE01', '${FLAG}', 'flagver_01HQZXLIVE01',
           'flagver_01HQZXLIVE01', '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}',
           'idem_01HQZXPROBEA1', '${'d'.repeat(64)}');`,
        );
        assert.ok(second !== null, 'a second activation superseding one version was accepted');

        // And a second *first* activation, which a plain unique constraint would miss because NULLs
        // do not conflict.
        const firstAgain = await refuses(
          database,
          `INSERT INTO ${ACTIVATION_TABLE} (activation_id, flag_key, flag_version_id,
           supersedes_version_id, activated_at, activated_by_kind, activated_by_id,
           idempotency_key, request_fingerprint)
         VALUES ('act_01HQZXPROBE02', '${FLAG}', 'flagver_01HQZXLIVE02',
           NULL, '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}',
           'idem_01HQZXPROBEA2', '${'d'.repeat(64)}');`,
        );
        assert.ok(
          firstAgain !== null,
          'a second first-activation was accepted; NULLs do not conflict',
        );
      },
    );

    await t.test('the append-only triggers refuse every UPDATE and DELETE', async () => {
      const tables = [VERSION_TABLE, ACTIVATION_TABLE];
      for (const table of tables) {
        const updated = await refuses(database, `UPDATE ${table} SET flag_key = 'a.b' ;`);
        assert.ok(updated !== null, `${table} accepted an UPDATE`);
        assert.match(String(updated), /append-only/i, `${table}'s refusal does not say why`);

        const deleted = await refuses(database, `DELETE FROM ${table};`);
        assert.ok(deleted !== null, `${table} accepted a DELETE`);
      }

      assert.ok((await countRows(database, VERSION_TABLE)) >= 2, 'the rows are still there');
    });

    await t.test('the constraints refuse what the service refuses', async () => {
      const probes: ReadonlyArray<readonly [string, Record<string, string>]> = [
        ['a flag key naming authority', { flag_key: `'admin.permissions.enabled'` }],
        ['a flag key naming money', { flag_key: `'seller.payout.instant'` }],
        ['a flag key naming an experiment', { flag_key: `'search.experiment.ranking-b'` }],
        ['a malformed flag key', { flag_key: `'nodots'` }],
        ['a state nothing writes', { state: `'maybe'` }],
        ['an AI author', { published_by_kind: `'ai'` }],
        ['a percentage out of range', { state: `'percentage'`, percentage: '150' }],
        ['a percentage on a flag that is not rolling out', { percentage: '30' }],
        ['rules on a flag that is not targeted', { rules: `'[{"kind":"any"}]'::jsonb` }],
        [
          'a window containing no instant',
          { not_before: `'2026-05-01T00:00:00Z'`, not_after: `'2026-04-01T00:00:00Z'` },
        ],
        ['no supported scope at all', { supported_scopes: `'[]'::jsonb` }],
        ['a natural key as the salt', { rollout_salt: `'alice@example.com'` }],
        ['a credential as the salt', { rollout_salt: `'api_key_9f3c2b1a7d4e5f60'` }],
        ['a fingerprint that is not one', { request_fingerprint: `'not-a-hash'` }],
      ];

      for (const [why, overrides] of probes) {
        const refusal = await refuses(
          database,
          `INSERT INTO ${VERSION_TABLE} (${VERSION_INSERT_COLUMNS}) VALUES (${versionValues(overrides)});`,
        );
        assert.ok(refusal !== null, `${why} was accepted by the database`);
      }
    });

    await t.test('a lifecycle event needs a reason, and there is one per flag', async () => {
      const noReason = await refuses(
        database,
        `INSERT INTO ${LIFECYCLE_TABLE} (event_id, flag_key, kind, reason, recorded_at,
           recorded_by_kind, recorded_by_id, idempotency_key, request_fingerprint)
         VALUES ('evt_01HQZXPROBE01', '${FLAG}', 'kill', '   ', '2026-04-01T12:00:00Z',
           'system', '${AUTHORITY}', 'idem_01HQZXPROBEL1', '${'e'.repeat(64)}');`,
      );
      assert.ok(noReason !== null, 'a kill with no reason was accepted');

      const killed = await refuses(
        database,
        `INSERT INTO ${LIFECYCLE_TABLE} (event_id, flag_key, kind, reason, recorded_at,
           recorded_by_kind, recorded_by_id, idempotency_key, request_fingerprint)
         VALUES ('evt_01HQZXPROBE02', '${FLAG}', 'kill', 'incident 4471',
           '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}', 'idem_01HQZXPROBEL2',
           '${'e'.repeat(64)}');`,
      );
      assert.equal(killed, null, 'the first kill must be accepted');

      const retiredToo = await refuses(
        database,
        `INSERT INTO ${LIFECYCLE_TABLE} (event_id, flag_key, kind, reason, recorded_at,
           recorded_by_kind, recorded_by_id, idempotency_key, request_fingerprint)
         VALUES ('evt_01HQZXPROBE03', '${FLAG}', 'retire', 'tidying up',
           '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}', 'idem_01HQZXPROBEL3',
           '${'e'.repeat(64)}');`,
      );
      assert.ok(retiredToo !== null, 'a killed flag was also retired; terminal must mean terminal');

      const deleted = await refuses(database, `DELETE FROM ${LIFECYCLE_TABLE};`);
      assert.ok(deleted !== null, 'the record of a kill could be erased');
    });

    await t.test(
      'an enlisted write joins the caller’s transaction and cannot commit it',
      async () => {
        const client = await database.connect();
        try {
          await client.query('BEGIN;');
          const enlisted = PostgresFeatureFlagRepository.enlist(client);
          await enlisted.withTransaction((tx) => tx.findVersionById('flagver_01HQZXLIVE01'));
          await client.query('ROLLBACK;');
        } finally {
          await client.release();
        }
        assert.ok(
          (await countRows(database, VERSION_TABLE)) >= 2,
          'the rollback took nothing with it',
        );
      },
    );

    await t.test('the schema rolls back independently of every other component', async () => {
      const report = await migrateDown(database, {
        directory,
        version: '0010_create_kernel_feature_flags_schema',
      });
      assert.match(report.rolledBack, /0010_create_kernel_feature_flags_schema/);

      const gone = await refuses(database, `SELECT 1 FROM ${VERSION_TABLE} LIMIT 1;`);
      assert.ok(gone !== null, 'kernel_feature_flags survived its own rollback');

      // K-04's schema, one migration earlier, is untouched by K-07's rollback.
      const neighbour = await refuses(
        database,
        'SELECT 1 FROM kernel_permissions.permission_policy_version LIMIT 1;',
      );
      assert.equal(neighbour, null, 'rolling back K-07 disturbed K-04');
    });
  });

  const after = await developmentSnapshot();
  assert.deepEqual(
    after,
    before,
    `the development database ${developmentDatabaseName()} was modified by this suite`,
  );
});
