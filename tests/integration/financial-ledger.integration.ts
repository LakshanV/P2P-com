/**
 * M-13 Financial Ledger against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0032 declares two rules that no amount of unit testing can prove, because the in-memory
 * repository enforces no constraint of its own:
 *
 *   * `value_leg_rate_is_exact` — the no-rounding rule as a database rule, checked by
 *     cross-multiplication so a rate that does not divide evenly cannot be stored at all.
 *   * `value_plan_legs_sum_to_target` — a **deferred constraint trigger**, because the invariant
 *     spans rows and no CHECK can express it. It fires at commit, so a plan whose legs do not add up
 *     is refused however the transaction was ordered.
 *
 * The second is the one worth having. It means the last thing standing between a short payment and
 * the ledger is not code somebody might edit, and it is proved here by inserting a plan and legs
 * that do not add up and watching the COMMIT fail.
 *
 * Also proved here: the partial unique index that permits one live plan per obligation while
 * leaving a cancelled attempt out of the way, the append-only wallet history, and a full
 * mixed-value settlement driven through the service against a real K-10 in the same database.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LedgerService,
  PostgresLedgerRepository,
  type RegisterAssetTypeRequest,
} from '../../kernel/ledger-foundation/index.ts';
import {
  FinancialLedgerService,
  K10LedgerPort,
  PostgresFinancialLedgerRepository,
} from '../../modules/financial-ledger/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  rollBackTo,
  withTestDatabase,
} from './harness.ts';

const BUYER = 'acct_live_fbuyer01';
const SELLER = 'acct_live_fseller1';

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

/**
 * Run several statements in one transaction and report whether the **commit** succeeded.
 *
 * The allocation invariant is deferred, so it can only be observed this way: each statement passes
 * and the transaction as a whole is refused.
 */
async function commits(database: Database, statements: readonly string[]): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query('BEGIN;');
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT;');
    return null;
  } catch (error) {
    await client.query('ROLLBACK;');
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

const WALLET_COLUMNS =
  '(wallet_id, owner_account_id, asset_type_id, purpose, ledger_account_id, status, created_at, ' +
  'updated_at, correlation_id, idempotency_key)';

const PLAN_COLUMNS =
  '(plan_id, obligation_id, obligation_kind, payer_account_id, payee_account_id, status, ' +
  'settlement_asset_type_id, target_amount_minor, committed_at, settled_at, cancelled_at, ' +
  'cancellation_reason, created_at, updated_at, correlation_id, idempotency_key)';

const LEG_COLUMNS =
  '(leg_id, plan_id, kind, status, asset_type_id, source_wallet_id, destination_wallet_id, ' +
  'amount_minor, rate_numerator, rate_denominator, settlement_equivalent_minor, ' +
  'ledger_transaction_id, reversal_transaction_id, external_reference, created_at, updated_at, ' +
  'correlation_id, idempotency_key)';

function walletRow(id: string, suffix: string, purpose = 'spending', asset = 'lkr'): string {
  return (
    `('${id}', '${BUYER}', '${asset}', '${purpose}', 'lac_live_${suffix}', 'open', ` +
    `'2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

function planRow(id: string, suffix: string, target: string, obligation: string): string {
  return (
    `('${id}', '${obligation}', 'order', '${BUYER}', '${SELLER}', 'draft', 'lkr', ${target}, ` +
    `NULL, NULL, NULL, NULL, '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', ` +
    `'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

function legRow(
  id: string,
  planId: string,
  suffix: string,
  amount: string,
  numerator: string,
  denominator: string,
  equivalent: string,
): string {
  return (
    `('${id}', '${planId}', 'internal', 'planned', 'lkr', 'wal_live_src001', 'wal_live_dst001', ` +
    `${amount}, ${numerator}, ${denominator}, ${equivalent}, NULL, NULL, NULL, ` +
    `'2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', 'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

/** Register the three asset types the suite uses, into a live K-10. */
async function registerAssets(ledger: LedgerService): Promise<void> {
  const base: RegisterAssetTypeRequest = {
    assetTypeId: 'lkr',
    assetClass: 'fiat',
    symbol: 'LKR',
    precision: 2,
    transferability: true,
    withdrawability: true,
    valuationSource: 'fixed',
    issuer: 'iss_live_central1',
    unit: 'cent',
    redeemable: true,
    convertible: true,
    expiryDays: null,
    restrictions: {},
    custodyProvider: null,
    jurisdiction: 'LK',
  };
  await ledger.registerAssetType(base);
  await ledger.registerAssetType({
    ...base,
    assetTypeId: 'jaya_reward',
    assetClass: 'reward',
    symbol: 'JAYAREWARD',
    // Indivisible: this is the case migration 0031 exists for, and it is exercised here against a
    // real CHECK rather than only against the validator.
    precision: 0,
    unit: 'point',
    transferability: false,
    withdrawability: false,
    convertible: false,
    issuer: 'iss_live_jayaplt1',
    jurisdiction: 'GLOBAL',
  });
}

test(
  'a mixed-value purchase settles end-to-end against the real schema',
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

      const ledger = new LedgerService(new PostgresLedgerRepository(database));
      await registerAssets(ledger);

      const service = new FinancialLedgerService(
        new PostgresFinancialLedgerRepository(database),
        new K10LedgerPort(ledger),
      );

      const wallets = [
        { id: 'wal_live_brew001', owner: BUYER, asset: 'jaya_reward', purpose: 'spending' },
        { id: 'wal_live_srew001', owner: SELLER, asset: 'jaya_reward', purpose: 'earnings' },
        { id: 'wal_live_bset001', owner: BUYER, asset: 'lkr', purpose: 'settlement' },
        { id: 'wal_live_scash01', owner: SELLER, asset: 'lkr', purpose: 'earnings' },
      ] as const;

      for (const [index, wallet] of wallets.entries()) {
        await service.openWallet({
          walletId: wallet.id,
          ownerAccountId: wallet.owner,
          assetTypeId: wallet.asset,
          purpose: wallet.purpose,
          ledgerAccountId: `lac_live_w${String(index).padStart(6, '0')}`,
          normalBalance: wallet.purpose === 'settlement' ? 'debit' : 'credit',
          openedAt: '2026-07-01T09:00:00Z',
          correlationId: `corr_live_w${String(index).padStart(5, '0')}`,
          idempotencyKey: `idem_live_w${String(index).padStart(5, '0')}`,
        });
      }

      // 1,000 in reward points and 9,000 on a card, against an obligation of 10,000 cents.
      await service.allocatePlan({
        planId: 'pln_live_mix0001',
        obligationId: 'ord_live_mix0001',
        obligationKind: 'order',
        payerAccountId: BUYER,
        payeeAccountId: SELLER,
        settlementAssetTypeId: 'lkr',
        targetAmountMinor: 10_000n,
        legs: [
          {
            legId: 'leg_live_mix0001',
            kind: 'internal',
            assetTypeId: 'jaya_reward',
            sourceWalletId: 'wal_live_brew001',
            destinationWalletId: 'wal_live_srew001',
            amountMinor: 1_000n,
            rate: { numerator: 1n, denominator: 1n },
            settlementEquivalentMinor: 1_000n,
            idempotencyKey: 'idem_live_leg0001',
          },
          {
            legId: 'leg_live_mix0002',
            kind: 'external',
            assetTypeId: 'lkr',
            sourceWalletId: null,
            destinationWalletId: 'wal_live_scash01',
            amountMinor: 9_000n,
            rate: { numerator: 1n, denominator: 1n },
            settlementEquivalentMinor: 9_000n,
            idempotencyKey: 'idem_live_leg0002',
          },
        ],
        allocatedAt: '2026-07-01T10:00:00Z',
        correlationId: 'corr_live_plan001',
        idempotencyKey: 'idem_live_plan001',
        eventId: 'fev_live_plan001',
      });

      await service.commitPlan({
        planId: 'pln_live_mix0001',
        postings: [{ legId: 'leg_live_mix0001', ledgerTransactionId: 'ltx_live_post0001' }],
        committedAt: '2026-07-01T11:00:00Z',
        correlationId: 'corr_live_cmt001',
        idempotencyKey: 'idem_live_cmt001',
        eventId: 'fev_live_cmt001',
      });

      const midway = await service.getCoverage('pln_live_mix0001');
      assert.equal(midway.postedMinor, 1_000n);
      assert.equal(midway.outstandingMinor, 9_000n);

      await service.settleExternalLeg({
        planId: 'pln_live_mix0001',
        legId: 'leg_live_mix0002',
        ledgerTransactionId: 'ltx_live_post0002',
        externalReference: 'pay_live_mixpay01',
        settledAt: '2026-07-01T11:05:00Z',
        correlationId: 'corr_live_stl001',
        idempotencyKey: 'idem_live_stl001',
        eventId: 'fev_live_stl001',
      });

      const coverage = await service.getCoverage('pln_live_mix0001');
      assert.equal(coverage.fullySettled, true);
      assert.equal(coverage.internalMinor + coverage.externalMinor, 10_000n);

      // The journal agrees, in each unit separately, read back from a real database.
      const rewards = await ledger.getBalance('lac_live_w000001');
      assert.equal(rewards.total, 1_000n, 'the seller holds the reward points');
      const cash = await ledger.getBalance('lac_live_w000003');
      assert.equal(cash.total, 9_000n, 'the seller holds the cash');

      assert.equal(await count(database, 'module_financial_ledger.wallet'), 4);
      assert.equal(await count(database, 'module_financial_ledger.value_plan'), 1);
      assert.equal(await count(database, 'module_financial_ledger.value_leg'), 2);
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
  'the database refuses a plan whose legs do not add up, at commit',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      // Each statement is individually legal. The plan is owed 1,000 and its legs are worth 900, and
      // the only thing that can catch that is a constraint spanning both rows — which is why it is a
      // deferred trigger and why this test commits rather than inserting.
      const short = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_short01', 'sh01', '1000', 'ord_live_short01')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_short01', 'pln_live_short01', 'sh02', '900', '1', '1', '900')};`,
      ]);
      assert.ok(short !== null, 'a plan that under-covers its obligation was committed');
      assert.match(short, /add up exactly/);

      const over = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_over001', 'ov01', '1000', 'ord_live_over001')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_over001', 'pln_live_over001', 'ov02', '1100', '1', '1', '1100')};`,
      ]);
      assert.ok(over !== null, 'a plan that over-covers its obligation was committed');

      const exact = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_exact01', 'ex01', '1000', 'ord_live_exact01')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_exact01', 'pln_live_exact01', 'ex02', '600', '1', '1', '600')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_exact02', 'pln_live_exact01', 'ex03', '400', '1', '1', '400')};`,
      ]);
      assert.equal(exact, null, 'two legs summing exactly to the obligation must be accepted');
    });
  },
);

test('the database refuses a rate that does not divide evenly', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // 7 at 3/2 is 10.5. There is no honest integer answer, and the CHECK is a multiplication
    // rather than a division, so the row simply cannot exist.
    const rounded = await refuses(
      database,
      `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_round01', 'pln_live_round01', 'rd01', '7', '3', '2', '10')};`,
    );
    assert.ok(rounded !== null, 'a rate that needed rounding was stored');
    assert.match(rounded, /rate_is_exact/);

    const zero = await refuses(
      database,
      `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_zero001', 'pln_live_zero001', 'zr01', '100', '0', '1', '0')};`,
    );
    assert.ok(zero !== null, 'a zero rate numerator was stored');
  });
});

test(
  'one obligation may have one live plan, and a cancelled attempt does not block the next',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const first = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_live0001', 'lv01', '500', 'ord_live_live0001')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_live0001', 'pln_live_live0001', 'lv02', '500', '1', '1', '500')};`,
      ]);
      assert.equal(first, null);

      const second = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_live0002', 'lv03', '500', 'ord_live_live0001')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_live0002', 'pln_live_live0002', 'lv04', '500', '1', '1', '500')};`,
      ]);
      assert.ok(
        second !== null,
        'one obligation was given two live plans, so it can be paid twice',
      );

      // Cancelling the first frees the obligation: a failed attempt must not block the next one.
      const cancelled = await refuses(
        database,
        `UPDATE module_financial_ledger.value_plan
            SET status = 'cancelled', cancelled_at = '2026-07-02T09:00:00Z',
                cancellation_reason = 'the buyer changed their payment method'
          WHERE plan_id = 'pln_live_live0001';`,
      );
      assert.equal(cancelled, null);

      const third = await commits(database, [
        `INSERT INTO module_financial_ledger.value_plan ${PLAN_COLUMNS}
         VALUES ${planRow('pln_live_live0003', 'lv05', '500', 'ord_live_live0001')};`,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ${legRow('leg_live_live0003', 'pln_live_live0003', 'lv06', '500', '1', '1', '500')};`,
      ]);
      assert.equal(third, null, 'a cancelled attempt must not block the next one');
    });
  },
);

test(
  'one party may hold one wallet per asset type and purpose, and one wallet per K-10 account',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const first = await refuses(
        database,
        `INSERT INTO module_financial_ledger.wallet ${WALLET_COLUMNS}
         VALUES ${walletRow('wal_live_dup00001', 'du01')};`,
      );
      assert.equal(first, null);

      const samePosition = await refuses(
        database,
        `INSERT INTO module_financial_ledger.wallet ${WALLET_COLUMNS}
         VALUES ${walletRow('wal_live_dup00002', 'du02')};`,
      );
      assert.ok(samePosition !== null, 'one party was given two spending wallets in one asset');
      assert.match(samePosition, /wallet_position_unique/);

      // A different position, but pointing at the same K-10 account: both would report the whole
      // balance as their own, and the same money would appear twice in any total.
      const sameAccount = await refuses(
        database,
        `INSERT INTO module_financial_ledger.wallet ${WALLET_COLUMNS}
         VALUES ('wal_live_dup00003', '${BUYER}', 'lkr', 'earnings', 'lac_live_du01', 'open',
                 '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_du03',
                 'idem_live_du03');`,
      );
      assert.ok(sameAccount !== null, 'two wallets were pointed at one K-10 account');
      assert.match(sameAccount, /ledger_account_unique/);
    });
  },
);

test(
  'wallet history is append-only, and a leg cannot claim a posting it does not have',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      await refuses(
        database,
        `INSERT INTO module_financial_ledger.wallet ${WALLET_COLUMNS}
         VALUES ${walletRow('wal_live_hist0001', 'hi01')};`,
      );
      const recorded = await refuses(
        database,
        `INSERT INTO module_financial_ledger.wallet_state
           (state_id, wallet_id, from_status, to_status, reason, occurred_at, correlation_id,
            idempotency_key)
         VALUES ('wst_live_hist0001', 'wal_live_hist0001', 'open', 'frozen', 'a fraud hold',
                 '2026-07-02T09:00:00Z', 'corr_live_hi02', 'idem_live_hi02');`,
      );
      assert.equal(recorded, null);

      const rewritten = await refuses(
        database,
        `UPDATE module_financial_ledger.wallet_state SET reason = 'something else'
          WHERE state_id = 'wst_live_hist0001';`,
      );
      assert.ok(rewritten !== null, 'how a wallet came to be frozen was rewritten');
      assert.match(rewritten, /append-only/);

      // A planned leg has moved nothing, so it may not name a transaction; anything past planned
      // must.
      const lying = await refuses(
        database,
        `INSERT INTO module_financial_ledger.value_leg ${LEG_COLUMNS}
         VALUES ('leg_live_lie00001', 'pln_live_lie00001', 'internal', 'planned', 'lkr',
                 'wal_live_src001', 'wal_live_dst001', 100, 1, 1, 100, 'ltx_live_ghost01', NULL,
                 NULL, '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z', 'corr_live_li01',
                 'idem_live_li01');`,
      );
      assert.ok(lying !== null, 'a planned leg named a transaction that has not happened');
      assert.match(lying, /transaction_matches_status/);
    });
  },
);

test(
  'migration 0032 rolls back cleanly and leaves no trace of the schema',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      assert.equal(await count(database, 'module_financial_ledger.wallet'), 0);

      await rollBackTo(database, directory, '0032');

      const client = await database.connect();
      try {
        const schemas = await client.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace WHERE nspname = 'module_financial_ledger';`,
        );
        assert.equal(
          schemas.rows.length,
          0,
          'the schema survived its own down migration, so the reversal is not genuine',
        );
      } finally {
        await client.release();
      }
    });
  },
);
