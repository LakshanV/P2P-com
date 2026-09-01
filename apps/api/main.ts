/**
 * The composition root: the one place that knows what the real world looks like.
 *
 * Everything else in this application is written against interfaces. This file picks the
 * implementations — a PostgreSQL pool, the K-10 journal, the mock payment provider — and starts the
 * process. It is the only file here that reads an environment variable, opens a connection or binds
 * a port, which is why nothing above it needs a test that does any of those things.
 *
 * **It ships the mock payment provider, and says so.** BL-05 records that no payment sandbox exists,
 * so there is no live gateway adapter to wire. Starting with a mock in an environment that calls
 * itself production would be a way to take an order and never take the money, so this refuses to
 * start when `JAYA_ENV=production` unless the operator has explicitly acknowledged it.
 *
 * Owned by: apps/api.
 */

import { PostgresDatabase } from '../../platform/db/postgres.ts';
import { createHttpServer } from '../../platform/http/server.ts';
import type { RequestRecord } from '../../platform/http/pipeline.ts';
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

import { buildApi, type ApiServices } from './app.ts';

/** Read a variable, or fail with a message that says what to set. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. The API cannot start without it.`);
  }
  return value;
}

/**
 * One line per request, as JSON.
 *
 * Structured rather than prose, because the first thing anybody does with an API log is filter it.
 * An unclassified failure carries its whole error: that is a defect, and the detail belongs
 * somewhere a developer will see it rather than in a response to a stranger.
 */
function logRequest(record: RequestRecord): void {
  const line: Record<string, unknown> = {
    at: new Date().toISOString(),
    method: record.method,
    path: record.path,
    status: record.status,
    correlationId: record.correlationId,
    ...(record.code === null ? {} : { code: record.code }),
  };
  if (record.unclassified !== null) {
    const error = record.unclassified;
    // Serialised rather than stringified: `String()` on a plain object yields "[object Object]",
    // which is the least useful thing a log line about an unexpected failure could contain.
    line.error =
      error instanceof Error
        ? (error.stack ?? error.message)
        : JSON.stringify(error, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
          );
  }
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

export interface StartOptions {
  readonly port: number;
  readonly databaseUrl: string;
  /** Set when the operator has accepted that no live payment gateway is wired. */
  readonly acknowledgeMockProvider: boolean;
  readonly environment: string;
}

export function servicesFor(databaseUrl: string): ApiServices {
  const database = new PostgresDatabase(databaseUrl);

  const orders = new OrderService(new PostgresOrderRepository(database));
  // The mock provider. There is no live adapter: BL-05 records that no payment sandbox exists, and
  // decision D-006 requires a port and a mock before any live one.
  const payments = new PaymentService(new PostgresPaymentRepository(database), resolveMockProvider);
  const ledger = new FinancialLedgerService(
    new PostgresFinancialLedgerRepository(database),
    new K10LedgerPort(new LedgerService(new PostgresLedgerRepository(database))),
  );

  return { orders, payments, ledger };
}

export function start(options: StartOptions): ReturnType<typeof createHttpServer> {
  if (options.environment === 'production' && !options.acknowledgeMockProvider) {
    throw new Error(
      'Refusing to start in production with the mock payment provider. No live gateway adapter ' +
        'ships (BL-05: no payment sandbox credentials), so every capture would succeed against ' +
        'nothing — an order taken and the money never collected. Wire a real adapter, or set ' +
        'JAYA_ACKNOWLEDGE_MOCK_PROVIDER=yes to say you know.',
    );
  }

  const api = buildApi({ services: servicesFor(options.databaseUrl), observe: logRequest });
  const server = createHttpServer(api);

  // Cooperative shutdown: stop accepting, let in-flight requests finish, then exit. A process that
  // exits mid-request leaves the client with a socket error for work that may well have committed.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      process.stdout.write(`{"at":"${new Date().toISOString()}","event":"shutting-down"}\n`);
      server.close(() => {
        process.exit(0);
      });
    });
  }

  server.listen(options.port, () => {
    process.stdout.write(
      `${JSON.stringify({
        at: new Date().toISOString(),
        event: 'listening',
        port: options.port,
        environment: options.environment,
        paymentProvider: 'mock',
      })}\n`,
    );
  });

  return server;
}

// Started only when run directly, so importing this file for its exports does not bind a port.
if (process.argv[1]?.endsWith('main.ts') === true) {
  start({
    port: Number(process.env.PORT ?? '8080'),
    databaseUrl: required('DATABASE_URL'),
    acknowledgeMockProvider: process.env.JAYA_ACKNOWLEDGE_MOCK_PROVIDER === 'yes',
    environment: process.env.JAYA_ENV ?? 'development',
  });
}
