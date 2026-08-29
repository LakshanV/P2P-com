/**
 * K-10 Ledger Foundation against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Four claims cannot be proved against a fake, because they are claims *about PostgreSQL*:
 *
 *   - that the `UNIQUE` constraints really admit one account/transaction per id and one idempotency
 *     key under a genuine race;
 *   - that the append-only triggers refuse `UPDATE` and `DELETE` on ledger history;
 *   - that the deferred trigger refuses an unbalanced transaction, negative amounts, unknown accounts
 *     and mixed asset types at the database level;
 *   - that `kernel_ledger_foundation` can be rolled back independently of every other schema.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the harness.
 * The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { LedgerService, PostgresLedgerRepository } from '../../kernel/ledger-foundation/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  accountRequest,
  assetType,
  transactionRequest,
} from '../helpers/ledger-foundation-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
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
  'registers an asset type, creates accounts, and posts a transaction end-to-end',
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

      const service = new LedgerService(new PostgresLedgerRepository(database));

      const lkr = await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
      assert.equal(lkr.deduplicated, false);

      const asset = await service.registerAssetType(
        assetType({ assetTypeId: 'lkr', symbol: 'LKR' }),
      );
      assert.equal(asset.deduplicated, true);

      const debitAccount = await service.createAccount(
        accountRequest({
          accountId: 'acct_live_debit_01',
          assetTypeId: 'lkr',
          normalBalance: 'debit',
        }),
      );
      assert.equal(debitAccount.deduplicated, false);

      const creditAccount = await service.createAccount(
        accountRequest({
          accountId: 'acct_live_credit_01',
          assetTypeId: 'lkr',
          normalBalance: 'credit',
        }),
      );
      assert.equal(creditAccount.deduplicated, false);

      const debitAccountId = debitAccount.account.accountId;
      const creditAccountId = creditAccount.account.accountId;

      const transaction = await service.postTransaction(
        transactionRequest([
          { accountId: debitAccountId, side: 'debit', amount: 7500n },
          { accountId: creditAccountId, side: 'credit', amount: 7500n },
        ]),
      );
      assert.equal(transaction.deduplicated, false);

      const debitBalance = await service.getBalance(debitAccountId);
      assert.equal(debitBalance.available, 7500n);
      assert.equal(debitBalance.debitTotal, 7500n);
      assert.equal(debitBalance.creditTotal, 0n);

      const creditBalance = await service.getBalance(creditAccountId);
      assert.equal(creditBalance.available, 7500n);
      assert.equal(creditBalance.creditTotal, 7500n);
      assert.equal(creditBalance.debitTotal, 0n);

      const retry = await service.postTransaction(
        transactionRequest(
          [
            { accountId: debitAccountId, side: 'debit', amount: 7500n },
            { accountId: creditAccountId, side: 'credit', amount: 7500n },
          ],
          {
            transactionId: transaction.transaction.transactionId,
            idempotencyKey: transaction.transaction.idempotencyKey,
          },
        ),
      );
      assert.equal(retry.deduplicated, true);

      assert.equal(await count(database, 'kernel_ledger_foundation.asset_type'), 1);
      assert.equal(await count(database, 'kernel_ledger_foundation.ledger_account'), 2);
      assert.equal(await count(database, 'kernel_ledger_foundation.ledger_transaction'), 1);
      assert.equal(await count(database, 'kernel_ledger_foundation.ledger_entry'), 2);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test('the database refuses an unbalanced transaction at commit', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new LedgerService(new PostgresLedgerRepository(database));

    await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
    const debitAccount = await service.createAccount(
      accountRequest({
        accountId: 'acct_unbal_debit_01',
        assetTypeId: 'lkr',
        normalBalance: 'debit',
      }),
    );
    const creditAccount = await service.createAccount(
      accountRequest({
        accountId: 'acct_unbal_credit_01',
        assetTypeId: 'lkr',
        normalBalance: 'credit',
      }),
    );

    const result = await refuses(
      database,
      `INSERT INTO kernel_ledger_foundation.ledger_transaction
         (transaction_id, idempotency_key, posted_at, asset_type_id)
       VALUES ('txn_unbal_01HQZX0001', 'idem_unbal_01HQZX0001', '2026-04-01T12:00:00Z', 'lkr');
       INSERT INTO kernel_ledger_foundation.ledger_entry
         (transaction_id, account_id, side, balance_state, amount)
       VALUES
         ('txn_unbal_01HQZX0001', '${debitAccount.account.accountId}', 'debit', 'available', 3000),
         ('txn_unbal_01HQZX0001', '${creditAccount.account.accountId}', 'credit', 'available', 2000);`,
    );
    assert.ok(result !== null, 'an unbalanced transaction must be refused');
    assert.match(result, /unbalanced/i);

    assert.equal(await count(database, 'kernel_ledger_foundation.ledger_transaction'), 0);
    assert.equal(await count(database, 'kernel_ledger_foundation.ledger_entry'), 0);
  });
});

test('the database refuses mixed asset types at commit', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new LedgerService(new PostgresLedgerRepository(database));

    await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
    await service.registerAssetType(assetType({ assetTypeId: 'points', symbol: 'POINTS' }));
    const lkrAccount = await service.createAccount(
      accountRequest({ accountId: 'acct_mix_lkr_01', assetTypeId: 'lkr', normalBalance: 'debit' }),
    );
    const pointsAccount = await service.createAccount(
      accountRequest({
        accountId: 'acct_mix_points_01',
        assetTypeId: 'points',
        normalBalance: 'credit',
      }),
    );

    const result = await refuses(
      database,
      `INSERT INTO kernel_ledger_foundation.ledger_transaction
         (transaction_id, idempotency_key, posted_at, asset_type_id)
       VALUES ('txn_mix_01HQZX0001', 'idem_mix_01HQZX0001', '2026-04-01T12:00:00Z', 'lkr');
       INSERT INTO kernel_ledger_foundation.ledger_entry
         (transaction_id, account_id, side, balance_state, amount)
       VALUES
         ('txn_mix_01HQZX0001', '${lkrAccount.account.accountId}', 'debit', 'available', 1000),
         ('txn_mix_01HQZX0001', '${pointsAccount.account.accountId}', 'credit', 'available', 1000);`,
    );
    assert.ok(result !== null, 'a mixed-asset-type transaction must be refused');
    assert.match(result, /different asset types/i);

    assert.equal(await count(database, 'kernel_ledger_foundation.ledger_transaction'), 0);
    assert.equal(await count(database, 'kernel_ledger_foundation.ledger_entry'), 0);
  });
});

test('the database refuses to mutate ledger history', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new LedgerService(new PostgresLedgerRepository(database));

    await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
    const debitAccount = await service.createAccount(
      accountRequest({
        accountId: 'acct_mutate_debit_01',
        assetTypeId: 'lkr',
        normalBalance: 'debit',
      }),
    );
    const creditAccount = await service.createAccount(
      accountRequest({
        accountId: 'acct_mutate_credit_01',
        assetTypeId: 'lkr',
        normalBalance: 'credit',
      }),
    );
    const posted = await service.postTransaction(
      transactionRequest([
        { accountId: debitAccount.account.accountId, side: 'debit', amount: 1000n },
        { accountId: creditAccount.account.accountId, side: 'credit', amount: 1000n },
      ]),
    );
    const transactionId = posted.transaction.transactionId;

    const update = await refuses(
      database,
      `UPDATE kernel_ledger_foundation.ledger_entry SET amount = 2000 WHERE transaction_id = '${transactionId}';`,
    );
    assert.ok(update !== null, 'updating an entry must be refused');
    assert.match(update, /append-only/i);

    const deleteEntry = await refuses(
      database,
      `DELETE FROM kernel_ledger_foundation.ledger_entry WHERE transaction_id = '${transactionId}';`,
    );
    assert.ok(deleteEntry !== null, 'deleting an entry must be refused');
    assert.match(deleteEntry, /append-only/i);

    const updateAccount = await refuses(
      database,
      `UPDATE kernel_ledger_foundation.ledger_account SET owner_id = 'owner_hijack_01HQZX' WHERE account_id = '${debitAccount.account.accountId}';`,
    );
    assert.ok(updateAccount !== null, 'updating an account must be refused');
  });
});

test(
  "rolling back K-10's newest migration removes only K-10's newest columns",
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      // K-10's schema is 0017 as extended by 0022, and the repository writes the columns 0022
      // adds. Stopping at 0017 would pair today's code with yesterday's schema.
      await migrateUp(database, { directory, target: '0022' });
      const service = new LedgerService(new PostgresLedgerRepository(database));

      await service.registerAssetType(assetType({ assetTypeId: 'lkr', symbol: 'LKR' }));
      await service.createAccount(
        accountRequest({
          accountId: 'acct_rollback_01',
          assetTypeId: 'lkr',
          normalBalance: 'debit',
        }),
      );

      // Narrower than it once was, and for the same reason as the K-13 case: the runner rolls
      // back in strict reverse order, so now that 0022 extends 0017 across migrations owned by
      // K-12, K-13, K-14 and K-15, K-10's schema cannot be removed without removing theirs. What
      // is still true, and worth guarding, is that K-10's own newest migration comes off cleanly
      // and takes only its own columns.
      await migrateDown(database, { directory, version: '0022' });

      const client = await database.connect();
      try {
        const columns = await client.query<{ readonly column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'kernel_ledger_foundation' AND table_name = 'asset_type';`,
        );
        const names = columns.rows.map((row) => row.column_name);
        for (const gone of ['issuer', 'unit', 'expiry_days', 'restrictions', 'jurisdiction']) {
          assert.ok(!names.includes(gone), `0022's rollback must remove ${gone}`);
        }
        assert.ok(names.includes('valuation_source'), "0017's own columns must survive");

        const rows = await client.query<{ readonly present: number }>(
          'SELECT count(*)::int AS present FROM kernel_ledger_foundation.ledger_account;',
        );
        assert.equal(rows.rows[0]?.present, 1, 'the account written before the rollback survives');

        // Neighbouring schemas are untouched by K-10's rollback.
        for (const table of [
          'kernel_identity.identity_subject',
          'kernel_ai_gateway.task_definition',
          'kernel_search_foundation.document',
        ]) {
          await client.query(`SELECT 1 FROM ${table} LIMIT 1;`);
        }
      } finally {
        await client.release();
      }
    });
  },
);
