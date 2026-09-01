/**
 * M-12 Payments against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0030 declares what TypeScript cannot, and the unit suite cannot prove any of it: the
 * in-memory repository enforces no CHECK constraint, so a rule that exists only in SQL is a rule
 * 1857 passing unit tests say nothing about. M-11 shipped a split that passed 42 unit tests and
 * violated a CHECK on every real database, which is why these run.
 *
 * What is proved here by issuing the offending statement rather than by asserting the service
 * refuses it:
 *
 *   * `payment_refunded_within_captured` and `payment_captured_within_authorised` — a refund cannot
 *     exceed what was taken, and a capture cannot exceed what was authorised.
 *   * `webhook_receipt_provider_event_unique` — the redelivery every provider eventually sends is
 *     recorded once.
 *   * `payment_asset_is_externally_settleable` — JAYA-issued value cannot be written as settled.
 *   * `payment_instrument_token_opaque` — a card number cannot be stored as a "token".
 *   * the append-only triggers on attempts and refunds, and the one-way stamp on receipts.
 *
 * And two things only a real server can show: that `updatePaymentIfUnchanged` is a genuine row
 * lock rather than a hopeful read, and that a `bigint` beyond 2^53 round-trips exactly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PaymentService,
  PostgresPaymentRepository,
  resolveMockProvider,
} from '../../modules/payments/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  authoriseRequest,
  cancelRequest,
  captureRequest,
  refundRequest,
  requestPayment,
  webhookRequest,
} from '../helpers/payments-fixtures.ts';
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

const PAYMENT_COLUMNS =
  '(payment_id, order_id, payer_account_id, payee_account_id, status, provider, rail, ' +
  'instrument_token, asset_code, asset_scale, amount_minor, captured_minor, refunded_minor, ' +
  'provider_reference, authorised_at, captured_at, failed_at, cancelled_at, failure_code, ' +
  'created_at, updated_at, correlation_id, idempotency_key)';

const RECEIPT_COLUMNS =
  '(receipt_id, provider, provider_event_id, payment_id, kind, signature_verified, payload, ' +
  'received_at, processed_at, correlation_id, idempotency_key)';

/**
 * A payment row written straight to the table, bypassing the service.
 *
 * Only used to set up a state the service would refuse to produce, so that the *database's* answer
 * can be observed rather than the service's.
 */
function paymentRow(
  id: string,
  suffix: string,
  overrides: {
    status?: string;
    assetCode?: string;
    token?: string;
    amount?: string;
    captured?: string;
    refunded?: string;
    authorisedAt?: string;
    capturedAt?: string;
  } = {},
): string {
  const status = overrides.status ?? 'requires-authorisation';
  const authorisedAt = overrides.authorisedAt ?? 'NULL';
  const capturedAt = overrides.capturedAt ?? 'NULL';
  return (
    `('${id}', 'ord_live_pay01', 'acct_live_payer1', 'acct_live_payee1', '${status}', ` +
    `'mock', 'card', '${overrides.token ?? 'tok_live_good01'}', ` +
    `'${overrides.assetCode ?? 'LKR'}', 2, ${overrides.amount ?? '1000000'}, ` +
    `${overrides.captured ?? '0'}, ${overrides.refunded ?? '0'}, NULL, ` +
    `${authorisedAt}, ${capturedAt}, NULL, NULL, NULL, ` +
    `'2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', 'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

test(
  'requests, authorises, captures and refunds end-to-end against the real schema',
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

      const service = new PaymentService(
        new PostgresPaymentRepository(database),
        resolveMockProvider,
      );

      const request = requestPayment({ paymentId: 'pay_live_flow01' });
      await service.requestPayment(request);
      await service.authorisePayment(authoriseRequest(request.paymentId));
      await service.capturePayment(captureRequest(request.paymentId));

      const captured = await service.getPayment(request.paymentId);
      assert.equal(captured.status, 'captured');
      assert.equal(
        captured.capturedMinor,
        1_000_000n,
        'a bigint amount round-trips through PostgreSQL as a bigint, not a rounded double',
      );
      assert.equal(
        captured.capturedAt,
        '2026-07-01T09:10:00Z',
        'an instant projected through to_char comes back as the string that went in',
      );
      assert.notEqual(captured.providerReference, null);

      await service.refundPayment(refundRequest(request.paymentId, { amountMinor: 400_000n }));
      const partly = await service.getPayment(request.paymentId);
      assert.equal(partly.status, 'partially-refunded');
      assert.equal(partly.refundedMinor, 400_000n);

      await service.refundPayment(refundRequest(request.paymentId, { amountMinor: 600_000n }));
      const closed = await service.getPayment(request.paymentId);
      assert.equal(closed.status, 'refunded');
      assert.equal(closed.refundedMinor, 1_000_000n);

      assert.equal(await count(database, 'module_payments.payment'), 1);
      assert.equal(await count(database, 'module_payments.payment_attempt'), 4);
      assert.equal(await count(database, 'module_payments.refund'), 2);
      assert.equal(
        await count(database, 'module_payments.outbox'),
        10,
        'five facts — requested, authorised, captured and two refunds — each emitting an event ' +
          'and an audit record',
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
  'an amount beyond the safe-integer range survives the round trip exactly',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new PaymentService(
        new PostgresPaymentRepository(database),
        resolveMockProvider,
      );

      // 2^53 + 1. A driver that handed this back as a JavaScript number would return ...992.
      const huge = 9_007_199_254_740_993n;
      const request = requestPayment({ paymentId: 'pay_live_huge01', amountMinor: huge });
      await service.requestPayment(request);

      const stored = await service.getPayment(request.paymentId);
      assert.equal(stored.amountMinor, huge);
    });
  },
);

test('the database refuses a refund larger than what was captured', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const over = await refuses(
      database,
      `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_over01', 'ov01', {
           status: 'captured',
           captured: '500000',
           refunded: '600000',
           authorisedAt: `'2026-07-01T09:05:00Z'`,
           capturedAt: `'2026-07-01T09:10:00Z'`,
         })};`,
    );
    assert.ok(over !== null, 'a refund exceeding the capture reached the table');
    assert.match(over, /refunded_within_captured/);

    const within = await refuses(
      database,
      `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_over02', 'ov02', {
           status: 'partially-refunded',
           captured: '500000',
           refunded: '200000',
           authorisedAt: `'2026-07-01T09:05:00Z'`,
           capturedAt: `'2026-07-01T09:10:00Z'`,
         })};`,
    );
    assert.equal(within, null, 'a refund within the capture must be accepted');
  });
});

test(
  'the database refuses a capture larger than what was authorised',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const over = await refuses(
        database,
        `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_cap01', 'cp01', {
           status: 'captured',
           amount: '100000',
           captured: '100001',
           authorisedAt: `'2026-07-01T09:05:00Z'`,
           capturedAt: `'2026-07-01T09:10:00Z'`,
         })};`,
      );
      assert.ok(over !== null, 'a capture exceeding the authorisation reached the table');
      assert.match(over, /captured_within_authorised/);
    });
  },
);

test(
  'the database refuses internally issued JAYA value as a settlement asset',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      for (const code of ['JAYA_REWARD', 'MERCHANT_CREDIT', 'PROMO_CREDIT']) {
        const refused = await refuses(
          database,
          `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
           VALUES ${paymentRow(
             `pay_live_${code.toLowerCase().slice(0, 6)}`,
             `iv${code.slice(0, 2)}`,
             {
               assetCode: code,
             },
           )};`,
        );
        assert.ok(
          refused !== null,
          `${code} was written as an externally settled asset. No bank, card network or custodian ` +
            'has heard of it, and a row claiming it settled is a claim on money never held',
        );
      }

      const digital = await refuses(
        database,
        `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_usdc01', 'uc01', { assetCode: 'USDC' })};`,
      );
      assert.equal(
        digital,
        null,
        'a four-character digital asset must be accepted; assuming ISO-4217 would make the column ' +
          'fiat-only for ever',
      );
    });
  },
);

test(
  'the database refuses a card number stored as an instrument token',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const pan = await refuses(
        database,
        `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_pan001', 'pn01', { token: '4111111111111111' })};`,
      );
      assert.ok(pan !== null, 'a card number was stored in the instrument_token column');
      assert.match(pan, /instrument_token_opaque/);

      const email = await refuses(
        database,
        `INSERT INTO module_payments.payment ${PAYMENT_COLUMNS}
         VALUES ${paymentRow('pay_live_pan002', 'pn02', { token: 'payer@example.com' })};`,
      );
      assert.ok(email !== null, 'an email address was stored as an instrument token');
    });
  },
);

test('the same provider event cannot be recorded twice', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const first = await refuses(
      database,
      `INSERT INTO module_payments.webhook_receipt ${RECEIPT_COLUMNS}
         VALUES ('whk_live_dup001', 'mock', 'evt_provider_1', NULL, 'charge.captured', true,
                 '{}'::jsonb, '2026-07-01T09:20:00Z', NULL, 'corr_live_wh01', 'idem_live_wh01');`,
    );
    assert.equal(first, null, 'the first delivery must be accepted');

    // A different receipt id, the same provider event. Every provider eventually does this.
    const second = await refuses(
      database,
      `INSERT INTO module_payments.webhook_receipt ${RECEIPT_COLUMNS}
         VALUES ('whk_live_dup002', 'mock', 'evt_provider_1', NULL, 'charge.captured', true,
                 '{}'::jsonb, '2026-07-01T09:21:00Z', NULL, 'corr_live_wh02', 'idem_live_wh02');`,
    );
    assert.ok(second !== null, 'a redelivered provider event was recorded a second time');
    assert.match(second, /provider_event_unique/);
  });
});

test(
  'attempts and refunds are append-only, and a receipt may only be stamped once',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new PaymentService(
        new PostgresPaymentRepository(database),
        resolveMockProvider,
      );

      const request = requestPayment({ paymentId: 'pay_live_apnd01' });
      await service.requestPayment(request);
      const { attempt } = await service.authorisePayment(authoriseRequest(request.paymentId));
      await service.capturePayment(captureRequest(request.paymentId));
      const { refund } = await service.refundPayment(refundRequest(request.paymentId));

      const editedAttempt = await refuses(
        database,
        `UPDATE module_payments.payment_attempt SET outcome = 'succeeded', failure_code = NULL
         WHERE attempt_id = '${attempt.attemptId}';`,
      );
      assert.ok(editedAttempt !== null, 'a provider attempt was rewritten');
      assert.match(editedAttempt, /append-only/);

      const deletedRefund = await refuses(
        database,
        `DELETE FROM module_payments.refund WHERE refund_id = '${refund.refundId}';`,
      );
      assert.ok(deletedRefund !== null, 'a refund was deleted');

      // The receipt: stamping once is permitted, rewriting the delivery is not, and a second stamp
      // is refused because it would erase when the platform actually acted.
      await service.recordWebhook(
        webhookRequest({
          receiptId: 'whk_live_stmp01',
          providerEventId: 'evt_live_stamp_1',
          paymentId: request.paymentId,
        }),
      );

      const restamped = await refuses(
        database,
        `UPDATE module_payments.webhook_receipt SET processed_at = '2026-07-05T09:00:00Z'
         WHERE receipt_id = 'whk_live_stmp01';`,
      );
      assert.ok(restamped !== null, 'a processed receipt was stamped a second time');
      assert.match(restamped, /one-way/);

      const rewritten = await refuses(
        database,
        `UPDATE module_payments.webhook_receipt SET payload = '{"tampered": true}'::jsonb
         WHERE receipt_id = 'whk_live_stmp01';`,
      );
      assert.ok(rewritten !== null, 'the evidence of what a provider sent was rewritten');
    });
  },
);

test(
  'the conditional update is a real row lock, so two captures cannot both take the money',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new PaymentService(
        new PostgresPaymentRepository(database),
        resolveMockProvider,
      );

      const request = requestPayment({ paymentId: 'pay_live_race01' });
      await service.requestPayment(request);
      await service.authorisePayment(authoriseRequest(request.paymentId));

      // Two captures issued together against one server. Each opens its own connection, reads the
      // payment as `authorised`, calls the provider, and then races for the row.
      const outcomes = await Promise.allSettled([
        service.capturePayment(captureRequest(request.paymentId)),
        service.capturePayment(captureRequest(request.paymentId)),
      ]);

      assert.equal(
        outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
        1,
        'both captures succeeded against a real database. The money left twice',
      );

      const payment = await service.getPayment(request.paymentId);
      assert.equal(payment.status, 'captured');
      assert.equal(payment.capturedMinor, 1_000_000n);
      assert.equal(
        await count(database, 'module_payments.payment_attempt'),
        3,
        'the authorisation and both capture calls are recorded. Losing the loser’s attempt would ' +
          'leave a possible movement of money with nothing written down',
      );
    });
  },
);

test('a cancelled payment cannot claim to have captured anything', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new PaymentService(
      new PostgresPaymentRepository(database),
      resolveMockProvider,
    );

    const request = requestPayment({ paymentId: 'pay_live_cxl001' });
    await service.requestPayment(request);
    await service.authorisePayment(authoriseRequest(request.paymentId));
    await service.cancelPayment(cancelRequest(request.paymentId));

    const cancelled = await service.getPayment(request.paymentId);
    assert.equal(cancelled.status, 'cancelled');
    assert.notEqual(cancelled.cancelledAt, null);

    const contradiction = await refuses(
      database,
      `UPDATE module_payments.payment SET captured_minor = 500000
         WHERE payment_id = 'pay_live_cxl001';`,
    );
    assert.ok(
      contradiction !== null,
      'a cancelled payment was recorded as having captured value; the two facts disagree with ' +
        'nobody to arbitrate',
    );
  });
});

test(
  'migration 0030 rolls back cleanly and leaves no trace of the schema',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      assert.equal(await count(database, 'module_payments.payment'), 0);

      await rollBackTo(database, directory, '0030');

      const client = await database.connect();
      try {
        const schemas = await client.query<{ nspname: string }>(
          `SELECT nspname FROM pg_namespace WHERE nspname = 'module_payments';`,
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
