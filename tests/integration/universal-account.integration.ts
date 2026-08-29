/**
 * M-01 Universal Account against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0024 declares a great deal: a `UNIQUE (account_id, capability)` that makes "one active
 * role per account" a database fact, a CHECK tying `status` to `deactivated_at`, an append-only
 * trigger on the transition log, and M-01's copy of the `is_opaque_identifier` rule set. None of
 * that is evidence of anything until it has actually refused something, so these cases issue the
 * offending statements directly rather than asserting that the service does not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PostgresUniversalAccountRepository,
  UniversalAccountService,
} from '../../modules/universal-account/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  ACCOUNT,
  activateRequest,
  deactivateRequest,
} from '../helpers/universal-account-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  rollBackTo,
  withTestDatabase,
} from './harness.ts';

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

/** The error message when the statement is refused, or null when it succeeded. */
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

const CAPABILITY_COLUMNS =
  '(capability_id, account_id, capability, status, activated_at, deactivated_at, attributes, ' +
  'created_at, updated_at, correlation_id, idempotency_key)';

test(
  'activates, deactivates and reactivates end-to-end against the real schema',
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

      const service = new UniversalAccountService(new PostgresUniversalAccountRepository(database));

      const request = activateRequest({ capability: 'seller' });
      const activated = await service.activateCapability(request);
      assert.equal(activated.replayed, false);
      assert.equal(activated.capability.status, 'active');
      assert.equal(
        activated.capability.activatedAt,
        request.activatedAt,
        'an instant projected through to_char comes back as the string that went in',
      );

      const deactivateOne = deactivateRequest(request.capabilityId);
      const deactivated = await service.deactivateCapability(deactivateOne);
      assert.equal(deactivated.capability.status, 'deactivated');
      assert.equal(deactivated.capability.deactivatedAt, deactivateOne.deactivatedAt);

      await service.activateCapability(
        activateRequest({
          capabilityId: request.capabilityId,
          capability: 'seller',
          activatedAt: '2026-04-03T09:00:00Z',
          updatedAt: '2026-04-03T09:00:00Z',
          reason: 'the seller reopened their storefront',
        }),
      );

      const history = await service.getCapabilityHistory(request.capabilityId);
      assert.deepEqual(
        history.map((state) => [state.fromStatus, state.toStatus]),
        [
          [null, 'active'],
          ['active', 'deactivated'],
          ['deactivated', 'active'],
        ],
      );

      // One row for the capability however many times it moved; one per transition; and two
      // outbox entries — an event and an audit record — per fact.
      assert.equal(await count(database, 'module_universal_account.account_capability'), 1);
      assert.equal(await count(database, 'module_universal_account.capability_state'), 3);
      assert.equal(
        await count(database, 'module_universal_account.outbox'),
        6,
        'three facts, each emitting one event and one audit record; a reused outbox id would have ' +
          'been refused by outbox_pkey instead',
      );
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test(
  'the database refuses a second capability of the same role for one account',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new UniversalAccountService(new PostgresUniversalAccountRepository(database));

      await service.activateCapability(
        activateRequest({ capabilityId: 'cap_live_dup_0001', capability: 'host' }),
      );

      const result = await refuses(
        database,
        `INSERT INTO module_universal_account.account_capability ${CAPABILITY_COLUMNS}
       VALUES ('cap_live_dup_0002', '${ACCOUNT}', 'host', 'active', '2026-04-01T12:00:00Z', NULL,
               '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z', 'corr_live_dup_0002',
               'idem_live_dup_0002');`,
      );
      assert.ok(result !== null, 'UNIQUE (account_id, capability) must refuse the second row');
      assert.match(result, /unique constraint/i);
    });
  },
);

test(
  'the database refuses a status and a deactivated_at that disagree',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const activeButDeactivated = await refuses(
        database,
        `INSERT INTO module_universal_account.account_capability ${CAPABILITY_COLUMNS}
       VALUES ('cap_live_chk_0001', '${ACCOUNT}', 'buyer', 'active', '2026-04-01T12:00:00Z',
               '2026-04-02T12:00:00Z', '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z',
               'corr_live_chk_0001', 'idem_live_chk_0001');`,
      );
      assert.ok(activeButDeactivated !== null, 'an active row carrying a deactivation instant');
      assert.match(activeButDeactivated, /deactivated_at_matches_status/);

      const deactivatedWithout = await refuses(
        database,
        `INSERT INTO module_universal_account.account_capability ${CAPABILITY_COLUMNS}
       VALUES ('cap_live_chk_0002', '${ACCOUNT}', 'driver', 'deactivated', '2026-04-01T12:00:00Z',
               NULL, '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z',
               'corr_live_chk_0002', 'idem_live_chk_0002');`,
      );
      assert.ok(deactivatedWithout !== null, 'a deactivated row carrying no deactivation instant');
      assert.match(deactivatedWithout, /deactivated_at_matches_status/);
    });
  },
);

test('the database refuses to rewrite or delete a transition', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new UniversalAccountService(new PostgresUniversalAccountRepository(database));

    const request = activateRequest({ capabilityId: 'cap_live_app_0001', capability: 'provider' });
    await service.activateCapability(request);

    const update = await refuses(
      database,
      `UPDATE module_universal_account.capability_state
          SET reason = 'rewritten'
        WHERE capability_id = '${request.capabilityId}';`,
    );
    assert.ok(update !== null, 'the append-only trigger must refuse an UPDATE');
    assert.match(update, /append-only/i);

    const remove = await refuses(
      database,
      `DELETE FROM module_universal_account.capability_state
        WHERE capability_id = '${request.capabilityId}';`,
    );
    assert.ok(remove !== null, 'the append-only trigger must refuse a DELETE');
    assert.match(remove, /append-only/i);

    assert.equal(await count(database, 'module_universal_account.capability_state'), 1);
  });
});

test(
  'the database refuses a natural-key or credential-shaped account id',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      for (const accountId of ['someone@example.com', 'api_key_9f2b7c1d4e', 'short']) {
        const result = await refuses(
          database,
          `INSERT INTO module_universal_account.account_capability ${CAPABILITY_COLUMNS}
         VALUES ('cap_live_opq_0001', '${accountId}', 'buyer', 'active', '2026-04-01T12:00:00Z',
                 NULL, '{}', '2026-04-01T12:00:00Z', '2026-04-01T12:00:00Z',
                 'corr_live_opq_0001', 'idem_live_opq_0001');`,
        );
        assert.ok(
          result !== null,
          `"${accountId}" reached the table; the opacity rule set is in the schema precisely so ` +
            'TypeScript is not the only thing standing between a natural key and a stored row',
        );
        assert.match(result, /account_id_opaque/);
      }
    });
  },
);

test('migration 0024 rolls back and leaves no trace of the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const client = await database.connect();
    try {
      const present = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_universal_account';`,
      );
      assert.equal(Number(present.rows[0]?.count ?? 0), 1);
    } finally {
      await client.release();
    }

    await rollBackTo(database, directory, '0024');

    const after = await database.connect();
    try {
      const gone = await after.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_universal_account';`,
      );
      assert.equal(
        Number(gone.rows[0]?.count ?? 0),
        0,
        'the rollback dropped the tables but left the schema, so the migration is not reversible',
      );
    } finally {
      await after.release();
    }
  });
});
