/**
 * K-03 against a live PostgreSQL server (FND-004b) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-03 is proved against an injected repository. Four claims cannot be,
 * because they are claims *about PostgreSQL*:
 *
 *   - that `UNIQUE (subject_id)` really admits one account per party under a genuine race — the
 *     invariant the whole component exists to hold, and the one a reference implementation can only
 *     model;
 *   - that the write-once trigger refuses `UPDATE` and `DELETE`, so an account cannot be relinked;
 *   - that the `CHECK` constraints refuse what the service refuses, including an AI origin and a
 *     natural key in any of the four identifier columns;
 *   - that `kernel_accounts` can be **rolled back without touching `kernel_identity`**, which is
 *     the benefit the refused foreign key was traded for and the only place it is observable.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCOUNT_TABLE,
  AccountService,
  PostgresAccountRepository,
} from '../../kernel/accounts/index.ts';
import {
  IDENTITY_TABLE,
  IdentityService,
  PostgresIdentityRepository,
} from '../../kernel/identity/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import { openRequest } from '../helpers/account-fixtures.ts';
import { createRequest } from '../helpers/identity-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

/** Every column of the table, in declaration order, for a write that goes around the adapter. */
const PROBE_COLUMNS = 'account_id, subject_id, created_at, origin_kind, origin_id, idempotency_key';

function probeValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    account_id: `'acct_01HQZXPROBE001'`,
    subject_id: `'sub_01HQZXPROBE001'`,
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
  `INSERT INTO ${ACCOUNT_TABLE} (${PROBE_COLUMNS}) VALUES (${probeValues(overrides)});`;

async function countAccounts(database: Database): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${ACCOUNT_TABLE};`,
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

/** A K-01 subject and the K-03 service wired to the real K-01 service, both on this database. */
async function wire(database: Database, subjectId: string): Promise<AccountService> {
  const identity = new IdentityService(new PostgresIdentityRepository(database));
  await identity.create(
    createRequest({ subjectId, idempotencyKey: `idem_${subjectId.slice(-10)}` }),
  );
  return new AccountService(new PostgresAccountRepository(database), identity);
}

test(
  'an account opens against a real K-01 subject and reads back exactly',
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

      const service = await wire(database, 'sub_01HQZXLIVE0001');
      const request = openRequest({
        accountId: 'acct_01HQZXLIVE0001',
        subjectId: 'sub_01HQZXLIVE0001',
        idempotencyKey: 'idem_01HQZXLIVE0001',
        createdAt: '2026-04-01T12:00:00.123456Z',
      });

      const first = await service.open(request);
      assert.equal(first.deduplicated, false);
      assert.equal(await countAccounts(database), 1);

      // The claim a fake cannot make: the same key again, against the real unique constraint.
      const retry = await service.open({ ...request });
      assert.equal(retry.deduplicated, true);
      assert.equal(await countAccounts(database), 1, 'one party, one account');

      // Microseconds survived the real timestamptz column rather than being rounded by the driver.
      const read = await service.requireAccount('acct_01HQZXLIVE0001');
      assert.equal(read.createdAt, '2026-04-01T12:00:00.123456Z');
      assert.deepEqual(read, first.account);

      // And the party reaches its own account.
      const forSubject = await service.findAccountForSubject('sub_01HQZXLIVE0001');
      assert.equal(forSubject?.accountId, 'acct_01HQZXLIVE0001');
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
  'the real unique index admits one account per party under a race',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = await wire(database, 'sub_01HQZXLIVERACE');

      const outcomes = await Promise.allSettled(
        ['A', 'B', 'C'].map((suffix) =>
          service.open(
            openRequest({
              accountId: `acct_01HQZXLIVERC${suffix}`,
              subjectId: 'sub_01HQZXLIVERACE',
              idempotencyKey: `idem_01HQZXLIVERC${suffix}`,
            }),
          ),
        ),
      );

      assert.equal(await countAccounts(database), 1, 'three openers, one account');
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      for (const outcome of outcomes.filter((entry) => entry.status === 'rejected')) {
        assert.match(
          String(outcome.reason),
          /already/i,
          'the losers were told the party already has an account',
        );
      }
    });
  },
);

test('the database refuses to rewrite, relink or remove an account', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = await wire(database, 'sub_01HQZXLIVE0002');
    await service.open(
      openRequest({
        accountId: 'acct_01HQZXLIVE0002',
        subjectId: 'sub_01HQZXLIVE0002',
        idempotencyKey: 'idem_01HQZXLIVE0002',
      }),
    );

    // The component has no such operation, so this is SQL by hand — the case the trigger is for.
    const relinked = await refuses(
      database,
      `UPDATE ${ACCOUNT_TABLE} SET subject_id = 'sub_01HQZXSOMEONE' WHERE account_id = 'acct_01HQZXLIVE0002';`,
    );
    assert.ok(relinked !== null, 'relinking must be refused by the trigger');
    assert.match(relinked, /write-once/i);

    const deleted = await refuses(
      database,
      `DELETE FROM ${ACCOUNT_TABLE} WHERE account_id = 'acct_01HQZXLIVE0002';`,
    );
    assert.ok(deleted !== null, 'a DELETE must be refused by the trigger');
    assert.match(deleted, /write-once/i);

    assert.equal(await countAccounts(database), 1, 'the account is still there, unchanged');
    const read = await service.requireAccount('acct_01HQZXLIVE0002');
    assert.equal(read.subjectId, 'sub_01HQZXLIVE0002');
  });
});

test('the database refuses what the service refuses', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    for (const [why, overrides] of [
      ['an AI origin', { origin_kind: `'ai'` }],
      ['an unknown origin kind', { origin_kind: `'daemon'` }],
      ['an email as an account id', { account_id: `'alice@example.com'` }],
      ['a personal name as an account id', { account_id: `'alice.smith'` }],
      ['a domain as an account id', { account_id: `'example.com'` }],
      ['a telephone number as an account id', { account_id: `'0771234567'` }],
      ['a guessably short account id', { account_id: `'acct_1'` }],
      ['an email as a subject id', { subject_id: `'alice@example.com'` }],
      ['a compact IBAN as a subject id', { subject_id: `'GB29NWBK6016133192'` }],
      ['a credential as an origin id', { origin_id: `'api_key_for_alice'` }],
      ['a blank origin id', { origin_id: `'   '` }],
      ['a token as an idempotency key', { idempotency_key: `'bearer-zzzzzzzzzzzz'` }],
      ['a short idempotency key', { idempotency_key: `'k1'` }],
    ] as const) {
      const refusal = await refuses(database, probeInsert(overrides));
      assert.ok(refusal !== null, `${why} must be refused by the database`);
    }

    assert.equal(await countAccounts(database), 0, 'none of the probes landed');
  });
});

test(
  'a second account for one subject is refused by the constraint itself',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      // Straight past the service, which is the case the UNIQUE constraint exists for.
      assert.equal(await refuses(database, probeInsert()), null, 'the first one lands');
      const second = await refuses(
        database,
        probeInsert({
          account_id: `'acct_01HQZXPROBE002'`,
          idempotency_key: `'idem_01HQZXPROBE002'`,
        }),
      );
      assert.ok(second !== null, 'a second account for the same subject must be refused');
      assert.match(second, /universal_account_subject_unique/);

      assert.equal(await countAccounts(database), 1);
    });
  },
);

test('an enlisted opening commits and rolls back with the caller', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const committing = await database.connect();
    try {
      await committing.query('BEGIN;');
      await PostgresAccountRepository.enlist(committing).withTransaction((tx) =>
        tx.insertAccount({
          accountId: 'acct_01HQZXENLIST01',
          subjectId: 'sub_01HQZXENLIST01',
          createdAt: '2026-04-01T12:00:00Z',
          origin: { kind: 'system', id: 'K-03-account-service' },
          idempotencyKey: 'idem_01HQZXENLIST01',
        }),
      );
      await committing.query('COMMIT;');
    } finally {
      await committing.release();
    }
    assert.equal(await countAccounts(database), 1);

    const rolling = await database.connect();
    try {
      await rolling.query('BEGIN;');
      await PostgresAccountRepository.enlist(rolling).withTransaction((tx) =>
        tx.insertAccount({
          accountId: 'acct_01HQZXENLIST02',
          subjectId: 'sub_01HQZXENLIST02',
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
      await countAccounts(database),
      1,
      "the caller's rollback undid the enlisted write",
    );
  });
});

test('kernel_accounts rolls back without touching kernel_identity', liveTestOptions, async () => {
  // The benefit the refused foreign key was traded for, and the only place it is observable. With
  // a cross-schema FK, rolling K-03 back would be entangled with K-01 — and rolling K-01 back would
  // fail at its RESTRICT for a reason no K-01 migration mentions.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = await wire(database, 'sub_01HQZXROLLBACK');
    await service.open(
      openRequest({
        accountId: 'acct_01HQZXROLLBACK',
        subjectId: 'sub_01HQZXROLLBACK',
        idempotencyKey: 'idem_01HQZXROLLBACK',
      }),
    );

    await migrateDown(database, { directory, version: '0007' });

    const client = await database.connect();
    try {
      // K-03's table is gone...
      await assert.rejects(client.query(`SELECT 1 FROM ${ACCOUNT_TABLE} LIMIT 1;`));
      // ...and K-01's subject is exactly where it was.
      const subjects = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM ${IDENTITY_TABLE} WHERE subject_id = 'sub_01HQZXROLLBACK';`,
      );
      assert.equal(
        Number(subjects.rows[0]?.count ?? 0),
        1,
        'K-01 was untouched by K-03 rolling back',
      );
    } finally {
      await client.release();
    }
  });
});
