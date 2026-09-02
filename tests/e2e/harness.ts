/**
 * The end-to-end harness: the whole platform, over a socket, against a real database.
 *
 * **What makes this different from `tests/integration/api.integration.ts`**, which is the thing it
 * would be easy to mistake it for. That suite proves the HTTP layer works against PostgreSQL: a
 * request in, a row written, a response out. It is a good test and it is not a journey, because
 * nothing in it crosses a module boundary the way the running platform does — through the outbox,
 * K-08 and a consumer.
 *
 * This harness runs that path. A request commits a fact **and** an outbox row in one transaction;
 * `settle()` then does what the relay worker and the delivery worker do in production — polls every
 * module's outbox, publishes to K-08, records to K-09, and runs each registered consumer over its
 * due deliveries. So when a buyer accepts an offer here, an order really is opened, by the same
 * machinery that would open it in production, and the test can then ask for that order over HTTP.
 *
 * Three deliberate properties.
 *
 * **Nothing is stubbed.** K-01 mints the subject, K-03 opens the account, K-02 issues the session,
 * K-04 evaluates the grant, every repository is the PostgreSQL one, and the server is a real
 * `node:http` server on an ephemeral port reached with `fetch`. The only fake is the payment
 * provider, because no live gateway adapter ships (BL-05) — and that is stated rather than hidden.
 *
 * **Time is injected and settlement is explicit.** `settle()` is called where production would wait
 * for a worker's next pass. A journey that slept would be a journey that is flaky; one that called
 * the consumer directly would be testing the consumer rather than the wiring.
 *
 * **The database is created and dropped per journey.** A journey that inherited another's rows would
 * pass for reasons nobody could name.
 *
 * Owned by: tests.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import {
  AuditActionRegistry,
  AuditService,
  AuditServiceRecorder,
  PostgresAuditRepository,
} from '../../kernel/audit-foundation/index.ts';
import { PostgresAccountRepository } from '../../kernel/accounts/index.ts';
import { PostgresAuthenticationRepository } from '../../kernel/authentication/index.ts';
import {
  EventService,
  EventServicePublisher,
  EventTypeRegistry,
  PostgresEventRepository,
  SubscriptionRegistry,
} from '../../kernel/event-infrastructure/index.ts';
import { PostgresIdentityRepository } from '../../kernel/identity/index.ts';
import { LedgerService, PostgresLedgerRepository } from '../../kernel/ledger-foundation/index.ts';
import { PostgresPermissionRepository } from '../../kernel/permissions/index.ts';
import {
  CommerceRequestService,
  PostgresCommerceRequestRepository,
} from '../../modules/commerce-request/index.ts';
import {
  FinancialLedgerService,
  K10LedgerPort,
  PostgresFinancialLedgerRepository,
} from '../../modules/financial-ledger/index.ts';
import {
  MatchingService,
  PostgresMatchingRepository,
  catalogueRung,
} from '../../modules/matching/index.ts';
import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import {
  PaymentService,
  PostgresPaymentRepository,
  resolveMockProvider,
} from '../../modules/payments/index.ts';
import { PostgresQuoteRepository, QuoteService } from '../../modules/quotes/index.ts';
import { PostgresRfqRepository, RfqService } from '../../modules/rfq/index.ts';
import {
  PostgresUniversalListingRepository,
  UniversalListingService,
} from '../../modules/universal-listing/index.ts';
import { UserCockpitService } from '../../modules/user-cockpit/index.ts';
import { buildApi } from '../../apps/api/app.ts';
import { catalogueSourceFor } from '../../apps/api/catalogue-source.ts';
import {
  ORDER_INVENTORY_SUBSCRIPTION,
  ORDER_INVENTORY_SUBSCRIPTION_DEFINITION,
  orderInventoryHandler,
} from '../../apps/api/consumers/order-inventory.ts';
import {
  QUOTE_ORDER_SUBSCRIPTION,
  QUOTE_ORDER_SUBSCRIPTION_DEFINITION,
  quoteOrderHandler,
} from '../../apps/api/consumers/quote-order.ts';
import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_EVENT_TYPES,
  PLATFORM_OUTBOX_SCHEMAS,
} from '../../apps/api/platform-events.ts';
import { tenderBuyerSourceFor, tenderSourceFor } from '../../apps/api/tender-source.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { PostgresOutboxSource } from '../../platform/outbox/postgres-source.ts';
import { runOutboxRelay } from '../../platform/outbox/relay.ts';
import { createHttpServer } from '../../platform/http/server.ts';
import type { Database } from '../../platform/db/client.ts';

import { identityStack, type SignedIn } from '../helpers/api-identity.ts';
import { liveTestOptions, withTestDatabase } from '../integration/harness.ts';

export { liveTestOptions };

/** What a client sees. */
export interface Response {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface Journey {
  /** Call the API as somebody, over a real socket. */
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
    options?: { readonly as?: SignedIn | null; readonly key?: string },
  ) => Promise<Response>;
  /**
   * Do what the workers do: publish every outbox row, then run every consumer over its deliveries.
   *
   * Called where production would wait for the next pass. Returns how much moved, so a journey can
   * assert that something actually happened rather than that nothing broke.
   */
  readonly settle: () => Promise<{ readonly dispatched: number; readonly delivered: number }>;
  /** Sign somebody in. Every journey names its own people. */
  readonly signUp: (handle: string, roles: readonly string[]) => Promise<SignedIn>;
  readonly listings: UniversalListingService;
  readonly ledger: LedgerService;
  readonly database: Database;
  /** The instant every request is served at. Journeys move it forward by hand. */
  readonly at: (instant: string) => void;
}

const START = '2026-07-01T09:00:00.000000Z';

/**
 * The subscriptions this deployment runs.
 *
 * Both live in `apps/`, because both join two modules of the same layer that may not import each
 * other. K-08 refuses to claim work for a subscription it does not know, so they are registered
 * here as well as handled.
 */
const SUBSCRIPTIONS = [
  ORDER_INVENTORY_SUBSCRIPTION_DEFINITION,
  QUOTE_ORDER_SUBSCRIPTION_DEFINITION,
];

let namespace = 0;

/** Run one journey against its own database, and drop it afterwards whatever happens. */
export async function journey(body: (context: Journey) => Promise<void>): Promise<void> {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const journal = new LedgerService(new PostgresLedgerRepository(database));
    const orders = new OrderService(new PostgresOrderRepository(database));
    const payments = new PaymentService(
      new PostgresPaymentRepository(database),
      // The mock provider. No live gateway adapter ships — BL-05 records that no sandbox exists —
      // so this is the one thing in the journey that is not the real component, and it is named.
      resolveMockProvider,
    );
    const ledger = new FinancialLedgerService(
      new PostgresFinancialLedgerRepository(database),
      new K10LedgerPort(journal),
    );
    const listings = new UniversalListingService(new PostgresUniversalListingRepository(database));
    const needs = new CommerceRequestService(new PostgresCommerceRequestRepository(database));
    const tenders = new RfqService(new PostgresRfqRepository(database));
    const quotes = new QuoteService(
      new PostgresQuoteRepository(database),
      tenderSourceFor(tenders),
    );
    const matching = new MatchingService(new PostgresMatchingRepository(database), {
      catalogue: catalogueRung({ source: catalogueSourceFor({ listings }), listings }),
    });

    const eventTypes = new EventTypeRegistry(PLATFORM_EVENT_TYPES);
    const events = new EventService(
      eventTypes,
      new SubscriptionRegistry(SUBSCRIPTIONS, eventTypes),
      new PostgresEventRepository(database),
    );
    const audit = new AuditService(
      new AuditActionRegistry(PLATFORM_AUDIT_ACTIONS),
      new PostgresAuditRepository(database),
    );

    events.register(ORDER_INVENTORY_SUBSCRIPTION, orderInventoryHandler({ orders, listings }));
    events.register(
      QUOTE_ORDER_SUBSCRIPTION,
      quoteOrderHandler({ orders, quotes, tenders: tenderBuyerSourceFor(tenders) }),
    );

    let now = START;
    const identity = await identityStack({
      namespace: `e2e:${String(namespace++)}`,
      repositories: {
        identity: new PostgresIdentityRepository(database),
        accounts: new PostgresAccountRepository(database),
        authentication: new PostgresAuthenticationRepository(database),
        permissions: new PostgresPermissionRepository(database),
      },
    });

    const api = buildApi({
      services: {
        orders,
        payments,
        ledger,
        listings,
        needs,
        tenders,
        quotes,
        matching,
        cockpit: new UserCockpitService({ orders, payments, ledger, journal }),
      },
      access: identity,
      clock: () => now,
    });

    const server = createHttpServer(api);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;

    const sources = PLATFORM_OUTBOX_SCHEMAS.map(
      (schema) => new PostgresOutboxSource({ name: schema, schema, database }),
    );

    let sequence = 0;
    let signedIn: SignedIn | null = null;

    const call: Journey['call'] = async (method, path, payload, options = {}) => {
      sequence += 1;
      const principal = options.as === undefined ? signedIn : options.as;
      const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
        method,
        headers: {
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(principal === null ? {} : { authorization: `Bearer ${principal.token}` }),
          'idempotency-key': options.key ?? `idem_e2e_${String(sequence).padStart(5, '0')}`,
          'x-correlation-id': `corr_01HR0E2E${String(sequence).padStart(6, '0')}`,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
    };

    const settle: Journey['settle'] = async () => {
      // Exactly what the two workers do, in the order they do it: publish, then deliver. Running
      // them in the other order would deliver an event that had not been published yet, which is
      // not a thing production can do.
      const relayed = await runOutboxRelay(
        {
          sources,
          events: new EventServicePublisher(events),
          audit: new AuditServiceRecorder(audit),
          limit: 200,
        },
        now,
      );
      assert.equal(
        relayed.sourceFailures,
        0,
        'a source the relay cannot poll reports a healthy zero while that module’s events pile up',
      );

      let delivered = 0;
      for (const subscription of SUBSCRIPTIONS) {
        sequence += 1;
        const outcomes = await events.deliver({
          subscription: subscription.subscription,
          worker: { kind: 'system', id: 'e2e-worker' },
          claimToken: `clm_01HR0E2E${String(sequence).padStart(6, '0')}`,
          now,
          limit: 50,
        });
        delivered += outcomes.length;
      }

      return { dispatched: relayed.dispatched, delivered };
    };

    try {
      await body({
        call,
        settle,
        signUp: async (handle, roles) => {
          const person = await identity.register({ handle, roles: [...roles] });
          signedIn ??= person;
          return person;
        },
        listings,
        ledger: journal,
        database,
        at: (instant) => {
          now = instant;
          identity.clock.set(instant);
        },
      });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
}
