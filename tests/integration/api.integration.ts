/**
 * The API over a real socket, against a real database — opt-in, and honestly skipped otherwise.
 *
 * The unit suite calls the pipeline as a function, which is right for testing the layer's logic and
 * says nothing about the parts only a socket exercises: that a body is read off the wire correctly,
 * that `JSON.stringify` survives what the handlers return, that a status reaches the client, and
 * that PostgreSQL-backed services behave the same as in-memory ones behind the same routes.
 *
 * The serialisation point is not hypothetical. Every amount in this platform is a `bigint`, and
 * `JSON.stringify` **throws** on one — so before the pipeline converted them, every response
 * carrying an order total would have failed at the socket, after the work was committed. The client
 * would have seen a 500 for a request that succeeded, and no unit test that stopped short of the
 * wire would have noticed.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { LedgerService, PostgresLedgerRepository } from '../../kernel/ledger-foundation/index.ts';
import {
  FinancialLedgerService,
  K10LedgerPort,
  PostgresFinancialLedgerRepository,
} from '../../modules/financial-ledger/index.ts';
import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import {
  PaymentService,
  PostgresPaymentRepository,
  resolveMockProvider,
} from '../../modules/payments/index.ts';
import { UserCockpitService } from '../../modules/user-cockpit/index.ts';
import { buildApi } from '../../apps/api/app.ts';
import type { Database } from '../../platform/db/client.ts';
import { createHttpServer } from '../../platform/http/server.ts';
import { migrateUp } from '../../platform/db/runner.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const BUYER = 'acct_live_apibuyer1';
const SELLER = 'acct_live_apisellr1';

interface Client {
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; body: Record<string, unknown>; headers: Headers }>;
}

/** Start the real server on an ephemeral port and hand back a client for it. */
async function withServer(
  database: Database,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const journal = new LedgerService(new PostgresLedgerRepository(database));
  const orders = new OrderService(new PostgresOrderRepository(database));
  const payments = new PaymentService(new PostgresPaymentRepository(database), resolveMockProvider);
  const ledger = new FinancialLedgerService(
    new PostgresFinancialLedgerRepository(database),
    new K10LedgerPort(journal),
  );
  const api = buildApi({
    services: {
      orders,
      payments,
      ledger,
      cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
    },
  });

  const server = createHttpServer(api);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const call: Client['call'] = async (method, path, payload, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      headers: response.headers,
    };
  };

  try {
    await body({ call });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test(
  'an order journey survives the wire, end to end, against PostgreSQL',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      await withServer(database, async ({ call }) => {
        const health = await call('GET', '/v1/health');
        assert.equal(health.status, 200);
        assert.deepEqual(health.body, { status: 'ok' });

        const created = await call(
          'POST',
          '/v1/orders',
          {
            buyerAccountId: BUYER,
            sellerAccountId: SELLER,
            currency: 'LKR',
            reason: 'the buyer started a basket',
          },
          { 'idempotency-key': 'idem_live_api_ord1' },
        );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const orderId = (created.body as { order: { orderId: string } }).order.orderId;

        const item = await call(
          'POST',
          `/v1/orders/${orderId}/items`,
          {
            listingId: 'lst_live_api000001',
            versionId: 'ver_live_api000001',
            commerceUnitTypeId: 'cut_live_api000001',
            quantity: '4',
            unitPriceMinor: '250',
            lineTotalMinor: '1000',
            currency: 'LKR',
            reservationId: null,
          },
          { 'idempotency-key': 'idem_live_api_itm1' },
        );
        assert.equal(item.status, 201, JSON.stringify(item.body));

        const placed = await call(
          'POST',
          `/v1/orders/${orderId}/placement`,
          { expectedTotalMinor: '1000', policyVersionId: null, reason: 'placed' },
          { 'idempotency-key': 'idem_live_api_plc1' },
        );
        assert.equal(placed.status, 200, JSON.stringify(placed.body));

        // The whole point of the live suite: a total is a bigint in the module, and this is the
        // first place anything actually serialises it.
        const read = await call('GET', `/v1/orders/${orderId}`);
        const order = (read.body as { order: { totalMinor: unknown; status: string } }).order;
        assert.equal(order.status, 'placed');
        assert.equal(
          order.totalMinor,
          '1000',
          'the total crossed the wire as a decimal string; JSON.stringify throws on a bigint',
        );
      });
    });
  },
);

test('a retried write over the wire creates one record', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    await withServer(database, async ({ call }) => {
      const body = {
        buyerAccountId: BUYER,
        sellerAccountId: SELLER,
        currency: 'LKR',
        reason: 'a basket the client retried',
      };
      const key = { 'idempotency-key': 'idem_live_api_retry' };

      const first = await call('POST', '/v1/orders', body, key);
      const second = await call('POST', '/v1/orders', body, key);

      assert.equal(first.status, 201);
      assert.equal(second.status, 200, 'the retry created nothing');
      assert.equal(
        (first.body as { order: { orderId: string } }).order.orderId,
        (second.body as { order: { orderId: string } }).order.orderId,
      );

      const client = await database.connect();
      try {
        const count = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM module_orders.order_header;`,
        );
        assert.equal(count.rows[0]?.count, '1', 'one order in the database, not two');
      } finally {
        await client.release();
      }
    });
  });
});

test(
  'a payment journey survives the wire, and the amounts come back exact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      await withServer(database, async ({ call }) => {
        // 2^53 + 1 minor units: a JSON number could not carry this back.
        const huge = '9007199254740993';

        const created = await call(
          'POST',
          '/v1/payments',
          {
            orderId: 'ord_live_apipay001',
            payerAccountId: BUYER,
            payeeAccountId: SELLER,
            provider: 'mock',
            rail: 'card',
            instrumentToken: 'tok_live_apigood01',
            assetCode: 'LKR',
            assetScale: 2,
            amountMinor: huge,
          },
          { 'idempotency-key': 'idem_live_api_pay1' },
        );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const paymentId = (created.body as { payment: { paymentId: string } }).payment.paymentId;

        await call(
          'POST',
          `/v1/payments/${paymentId}/authorisation`,
          {},
          {
            'idempotency-key': 'idem_live_api_aut1',
          },
        );

        const read = await call('GET', `/v1/payments/${paymentId}`);
        const payment = (read.body as { payment: { amountMinor: unknown; status: string } })
          .payment;
        assert.equal(payment.status, 'authorised');
        assert.equal(
          payment.amountMinor,
          huge,
          'the last digit survived: a double would have returned ...992',
        );
      });
    });
  },
);

test(
  'refusals reach the client with their codes and a problem content type',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      await withServer(database, async ({ call }) => {
        const noKey = await call('POST', '/v1/orders', {
          buyerAccountId: BUYER,
          sellerAccountId: SELLER,
          currency: 'LKR',
          reason: 'basket',
        });
        assert.equal(noKey.status, 400);
        assert.equal(noKey.body.code, 'missing-idempotency-key');
        assert.match(String(noKey.headers.get('content-type')), /application\/problem\+json/);

        const missing = await call('GET', '/v1/orders/ord_live_apinothin');
        assert.equal(missing.status, 404);

        const wrongMethod = await call('DELETE', '/v1/health');
        assert.equal(wrongMethod.status, 405);
        assert.match(String(wrongMethod.headers.get('allow')), /GET/);

        const notJson = await fetch('http://127.0.0.1:1/nothing').catch(() => null);
        assert.equal(notJson, null, 'a connection to nowhere fails, as it should');
      });
    });
  },
);

test(
  'every response carries a correlation id, and a client’s own is honoured',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      await withServer(database, async ({ call }) => {
        const generated = await call('GET', '/v1/health');
        assert.match(String(generated.headers.get('x-correlation-id')), /^corr_/);

        const supplied = await call('GET', '/v1/health', undefined, {
          'x-correlation-id': 'corr_live_apiclient1',
        });
        assert.equal(supplied.headers.get('x-correlation-id'), 'corr_live_apiclient1');
      });
    });
  },
);
