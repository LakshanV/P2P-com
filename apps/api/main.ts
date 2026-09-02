/**
 * The composition root: the one place that knows what the real world looks like.
 *
 * Everything else in this application is written against interfaces. This file picks the
 * implementations — a PostgreSQL pool, the K-10 journal, the mock payment provider — and starts the
 * process. It is the only file here that reads an environment variable, opens a connection or binds
 * a port, which is why nothing above it needs a test that does any of those things.
 *
 * **It refuses to call itself production, twice over, and says why each time.**
 *
 * BL-05 records that no payment sandbox exists, so there is no live gateway adapter to wire.
 * Starting with a mock in a live environment would be a way to take an order and never take the
 * money, so this refuses unless the operator has explicitly acknowledged it.
 *
 * And passwords are held in memory, because K-02's schema deliberately holds no credential and the
 * durable store has not been built. That refusal has no acknowledgement flag: locking every customer
 * out on the next deployment is not a trade-off somebody can accept their way past.
 *
 * A composition root that starts anyway and logs a warning is a composition root whose warning
 * nobody reads.
 *
 * Owned by: apps/api.
 */

import { randomInt } from 'node:crypto';

import { AccountService, PostgresAccountRepository } from '../../kernel/accounts/index.ts';
import {
  AuthenticationService,
  InMemoryPasswordCredentialStore,
  PasswordVerifier,
  PostgresAuthenticationRepository,
  ProviderRegistry,
} from '../../kernel/authentication/index.ts';
import type { EventService } from '../../kernel/event-infrastructure/index.ts';
import { IdentityService, PostgresIdentityRepository } from '../../kernel/identity/index.ts';
import { PermissionService, PostgresPermissionRepository } from '../../kernel/permissions/index.ts';
import { PostgresDatabase } from '../../platform/db/postgres.ts';
import { InMemoryRateLimitStore } from '../../platform/http/rate-limit.ts';
import { createHttpServer } from '../../platform/http/server.ts';
import type { RequestRecord } from '../../platform/http/pipeline.ts';
import { LedgerService, PostgresLedgerRepository } from '../../kernel/ledger-foundation/index.ts';
import {
  FinancialLedgerService,
  K10LedgerPort,
  PostgresFinancialLedgerRepository,
} from '../../modules/financial-ledger/index.ts';
import {
  CommerceRequestService,
  PostgresCommerceRequestRepository,
} from '../../modules/commerce-request/index.ts';
import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import {
  PostgresUniversalListingRepository,
  UniversalListingService,
} from '../../modules/universal-listing/index.ts';
import { UserCockpitService } from '../../modules/user-cockpit/index.ts';
import {
  PaymentService,
  PostgresPaymentRepository,
  resolveMockProvider,
} from '../../modules/payments/index.ts';

import {
  MatchingService,
  PostgresMatchingRepository,
  catalogueRung,
} from '../../modules/matching/index.ts';
import { PostgresQuoteRepository, QuoteService } from '../../modules/quotes/index.ts';
import { PostgresRfqRepository, RfqService } from '../../modules/rfq/index.ts';

import { buildApi, type ApiAccess, type ApiServices } from './app.ts';
import {
  ORDER_INVENTORY_SUBSCRIPTION,
  orderInventoryHandler,
  type InventoryResolution,
} from './consumers/order-inventory.ts';
import {
  PAYMENT_SETTLEMENT_SUBSCRIPTION,
  paymentSettlementHandler,
  settlementAssets,
  type SettlementAssets,
  type SettlementOutcome,
} from './consumers/payment-settlement.ts';
import {
  QUOTE_ORDER_SUBSCRIPTION,
  quoteOrderHandler,
  type QuoteOrderOutcome,
} from './consumers/quote-order.ts';
import { catalogueSourceFor } from './catalogue-source.ts';
import { tenderBuyerSourceFor, tenderSourceFor } from './tender-source.ts';
import { webhookSecrets, type WebhookSecrets } from './webhook-signature.ts';

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

/**
 * The identity stack: who is calling, and what they may do.
 *
 * K-01, K-02, K-03 and K-04, all against PostgreSQL, wired to each other exactly as their ports
 * describe — `AuthenticationService` *is* K-04's session validator and `AccountService` *is* its
 * account lookup, with no adapter in between.
 *
 * **The password credential store is in memory, and that is why this process refuses to call itself
 * production.** K-02's schema deliberately holds no credential of any kind — its own migration says
 * a dump of `kernel_authentication` yields nobody's password — so a durable store needs a schema of
 * its own, and writing one is a slice with a migration and an ownership decision in it. Until then
 * every password is forgotten on restart. That is survivable in a staging environment and
 * indefensible in a live one, so `start` refuses rather than letting somebody discover it.
 */
export function accessFor(database: PostgresDatabase, clock: () => string): ApiAccess {
  const identity = new IdentityService(new PostgresIdentityRepository(database));
  const accounts = new AccountService(new PostgresAccountRepository(database), identity);

  let assertions = 0;
  const passwords = new PasswordVerifier({
    store: new InMemoryPasswordCredentialStore(),
    now: clock,
    newAssertionId: () => {
      assertions += 1;
      return `asrt_${randomOpaque(18)}${String(assertions).padStart(4, '0')}`;
    },
  });

  const authentication = new AuthenticationService({
    repository: new PostgresAuthenticationRepository(database),
    providers: new ProviderRegistry([
      { provider: 'password', description: 'A password, verified against a scrypt hash by K-02.' },
    ]),
    verifiers: [passwords],
    subjects: identity,
    clock: { now: clock },
    entropy: { token: () => randomOpaque(43) },
  });

  const permissions = new PermissionService({
    repository: new PostgresPermissionRepository(database),
    sessions: authentication,
    accounts,
    clock: { now: clock },
    // No bootstrap authority. Publishing the first policy is an operator act performed out of band,
    // not something an HTTP process may do to itself on startup.
  });

  return { permissions, sessions: authentication, accounts };
}

/**
 * Which K-10 asset type each payment asset settles into.
 *
 * `JAYA_SETTLEMENT_ASSET_<CODE>_<SCALE>` — so `JAYA_SETTLEMENT_ASSET_LKR_2=lkr_cash` says a payment
 * in LKR at scale 2 posts against the `lkr_cash` asset type. Undeclared pairings are refused by the
 * settlement consumer rather than assumed to match by string equality, which happens to work for
 * `LKR` and quietly posts the wrong unit for everything else.
 */
function settlementAssetsFromEnvironment(): SettlementAssets {
  const prefix = 'JAYA_SETTLEMENT_ASSET_';
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix) || value === undefined || value === '') continue;
    const suffix = name.slice(prefix.length);
    const split = suffix.lastIndexOf('_');
    if (split <= 0) continue;
    found[`${suffix.slice(0, split)}:${suffix.slice(split + 1)}`] = value;
  }
  return settlementAssets(found);
}

/**
 * Webhook signing secrets, from the environment.
 *
 * `JAYA_WEBHOOK_SECRET_<PROVIDER>` — so `JAYA_WEBHOOK_SECRET_MOCK` configures the `mock` provider.
 * A provider with no variable set has no secret, and every delivery claiming to be from it is
 * refused. Reading them here rather than anywhere else keeps the one file that touches the
 * environment the one file that touches the environment.
 */
function webhookSecretsFromEnvironment(): WebhookSecrets {
  const prefix = 'JAYA_WEBHOOK_SECRET_';
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix) || value === undefined || value === '') continue;
    found[name.slice(prefix.length).toLowerCase()] = value;
  }
  return webhookSecrets(found);
}

/** The current instant, in the microsecond-width form every validator in this repository accepts. */
function nowMicros(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** A random opaque handle K-01's rules accept: no long digit runs, no natural identifier. */
function randomOpaque(length: number): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZabcdefghjkmnpqrstvwxyz0123456789';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[randomInt(alphabet.length)] ?? 'A';
  }
  return out;
}

/**
 * Register the cross-module consumers on K-08.
 *
 * The application is the only place these can live. M-12 and M-13 are the same layer, so neither may
 * import the other; the join between "a payment was captured" and "this obligation is now met" has
 * to be made from above both, and this is above both.
 *
 * Returns the subscription definitions the caller must have registered with K-08's
 * `SubscriptionRegistry` — K-08 refuses to claim work for a subscription it does not know, which is
 * the right refusal: claiming work with nothing to run it burns attempts and dead-letters events
 * that were never actually delivered.
 */
export function registerConsumers(options: {
  readonly events: EventService;
  readonly ledger: FinancialLedgerService;
  readonly orders: OrderService;
  readonly listings: UniversalListingService;
  /** M-10, for the offer an accepted quote was priced from. */
  readonly quotes: QuoteService;
  /** M-09, for who is buying. Never taken from anything a caller can influence. */
  readonly tenders: RfqService;
  readonly observe?: (outcome: SettlementOutcome | InventoryResolution | QuoteOrderOutcome) => void;
}): void {
  options.events.register(
    PAYMENT_SETTLEMENT_SUBSCRIPTION,
    paymentSettlementHandler({
      ledger: options.ledger,
      assets: settlementAssetsFromEnvironment(),
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    }),
  );

  // Both endings of an order resolve the stock its lines held. Registering only one would be the
  // leak with extra steps: a cancelled order whose reservation nobody releases is stock nobody can
  // ever buy again.
  options.events.register(
    ORDER_INVENTORY_SUBSCRIPTION,
    orderInventoryHandler({
      orders: options.orders,
      listings: options.listings,
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    }),
  );

  // Where the differentiated path becomes a purchase. Without this the customer chooses a supplier
  // and nothing is bought: quote.accepted is published and nobody listens.
  options.events.register(
    QUOTE_ORDER_SUBSCRIPTION,
    quoteOrderHandler({
      orders: options.orders,
      quotes: options.quotes,
      tenders: tenderBuyerSourceFor(options.tenders),
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    }),
  );
}

export function servicesFor(databaseUrl: string): ApiServices {
  const database = new PostgresDatabase(databaseUrl);

  const journal = new LedgerService(new PostgresLedgerRepository(database));
  const orders = new OrderService(new PostgresOrderRepository(database));
  // The mock provider. There is no live adapter: BL-05 records that no payment sandbox exists, and
  // decision D-006 requires a port and a mock before any live one.
  const payments = new PaymentService(new PostgresPaymentRepository(database), resolveMockProvider);
  const ledger = new FinancialLedgerService(
    new PostgresFinancialLedgerRepository(database),
    new K10LedgerPort(journal),
  );
  const cockpit = new UserCockpitService({ orders, payments, ledger, journal });

  const listings = new UniversalListingService(new PostgresUniversalListingRepository(database));

  const needs = new CommerceRequestService(new PostgresCommerceRequestRepository(database));

  // M-09 and M-10 are the same layer, so M-10 reaches M-09 through a two-method port rather than an
  // import. The adapter is built here, above both, which is the only place that join may be made.
  const tenders = new RfqService(new PostgresRfqRepository(database));
  const quotes = new QuoteService(new PostgresQuoteRepository(database), tenderSourceFor(tenders));

  // The ladder, with the one rung this deployment can actually wire. The supplier rungs need a
  // directory nothing implements yet and external discovery needs an adapter that does not ship, so
  // both are left unwired — and M-07 records `unavailable` for them rather than `empty`. That is the
  // difference between a configuration choice and an outage, and it is why a Need that reaches a
  // tender here can say honestly that nothing looked rather than that nothing was found.
  const matching = new MatchingService(new PostgresMatchingRepository(database), {
    catalogue: catalogueRung({ source: catalogueSourceFor({ listings }), listings }),
  });

  return { orders, payments, ledger, cockpit, listings, needs, tenders, quotes, matching };
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
  if (options.environment === 'production') {
    // No acknowledgement flag for this one. A password store that forgets everything on restart is
    // not a thing an operator can accept their way past: locking every customer out on the next
    // deployment is not a trade-off, it is an outage.
    throw new Error(
      'Refusing to start in production: passwords are held in memory. K-02 stores no credential ' +
        'by design, and the durable credential store has not been built yet, so every password ' +
        'would be forgotten on restart and nobody could sign in again.',
    );
  }

  const database = new PostgresDatabase(options.databaseUrl);
  const api = buildApi({
    services: servicesFor(options.databaseUrl),
    access: accessFor(database, nowMicros),
    webhookSecrets: webhookSecretsFromEnvironment(),
    throttle: {
      // In memory, which is correct for one process and honestly wrong for two: each instance would
      // enforce the limit separately, so two instances permit twice as much. That is acceptable
      // while one process serves the platform, and stops being acceptable the moment a second one
      // starts. Whoever adds the second instance owns replacing this with a shared store.
      store: new InMemoryRateLimitStore(),
      now: nowMicros,
      // Zero unless the deployment says otherwise, and the default is the safe one: with no
      // declared proxy, `X-Forwarded-For` is ignored entirely. Setting this too high is worse than
      // leaving it at zero — it lets a caller choose its own bucket by writing the header, which
      // removes the limit rather than loosening it.
      trustedProxyCount: Number(process.env.JAYA_TRUSTED_PROXY_COUNT ?? '0'),
    },
    observe: logRequest,
  });
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
