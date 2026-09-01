/**
 * The API application: routes, error classification, and how a request becomes a context.
 *
 * `buildApi` takes services rather than repositories, so the whole surface can be exercised against
 * in-memory modules in a suite that runs in milliseconds, and against PostgreSQL in one that does
 * not. Nothing here opens a connection; `main.ts` does that.
 *
 * Two conventions the whole API rests on:
 *
 * **`Idempotency-Key` is how a client makes a write safe to retry.** Every identifier a write needs
 * is derived from it, so the same key produces the same order, the same payment, the same plan. A
 * client that omits it on a write is refused rather than quietly given a fresh key — a payment
 * endpoint that silently treats every retry as a new payment is a way to charge somebody twice, and
 * making the client say so is the whole point.
 *
 * **`X-Correlation-Id` ties a request to everything it caused.** Supplied by the client or minted
 * here, echoed on every response, and carried into every record and event the request produces.
 *
 * Owned by: apps/api.
 */

import { assertOpaqueIdentifier } from '../../kernel/identity/index.ts';
import type {
  AccountLookup,
  PermissionService,
  SessionValidator,
} from '../../kernel/permissions/index.ts';
import type { FinancialLedgerService } from '../../modules/financial-ledger/index.ts';
import type { OrderService } from '../../modules/orders/index.ts';
import type { PaymentService } from '../../modules/payments/index.ts';
import type { UserCockpitService } from '../../modules/user-cockpit/index.ts';
import { requestContext, type RequestContext } from '../../platform/http/context.ts';
import type {
  MatchedRoute,
  PipelineOptions,
  RawRequest,
  RequestRecord,
} from '../../platform/http/pipeline.ts';
import { Router } from '../../platform/http/router.ts';
import { json, type HttpRequest } from '../../platform/http/types.ts';

import { accessFor, guard } from './access.ts';
import { ApiError, describeApiError } from './errors.ts';
import { NO_WEBHOOK_SECRETS, type WebhookSecrets } from './webhook-signature.ts';
import { addCockpitRoutes } from './routes/cockpit.ts';
import { addLedgerRoutes } from './routes/ledger.ts';
import { addOrderRoutes } from './routes/orders.ts';
import { addPaymentRoutes } from './routes/payments.ts';

export interface ApiServices {
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
  /** M-36: the buyer's own read-only screens. Owns no data and writes nothing. */
  readonly cockpit: UserCockpitService;
}

/**
 * What the API needs to decide who is calling and what they may do.
 *
 * **Required, not optional.** An optional access field is a field somebody leaves out, and leaving
 * it out would silently reopen every route. Building an API therefore means deciding this, and a
 * suite that wants to exercise a handler has to authenticate like a client does — which is the only
 * way the suites prove the routes work *with* the guard rather than only without it.
 */
export interface ApiAccess {
  readonly permissions: PermissionService;
  /** K-02. `AuthenticationService` satisfies it. */
  readonly sessions: SessionValidator;
  /** K-03. `AccountService` satisfies it. */
  readonly accounts: AccountLookup;
}

export interface ApiOptions {
  readonly services: ApiServices;
  readonly access: ApiAccess;
  /**
   * Per-provider webhook signing secrets.
   *
   * Optional, and the default refuses every delivery. Optional is safe *here* — unlike `access` —
   * because leaving it out closes the route rather than opening it.
   */
  readonly webhookSecrets?: WebhookSecrets;
  /** Overridable so a suite can pin the clock and the generated ids. Defaults to the real ones. */
  readonly clock?: () => string;
  readonly generateCorrelationId?: () => string;
  readonly observe?: (record: RequestRecord) => void;
}

/** K-01's opacity rule, wired into the request context. */
const validate = (candidate: string): void => {
  assertOpaqueIdentifier(candidate, 'identifier');
};

/**
 * Writes need an idempotency key; reads do not.
 *
 * A GET has nothing to converge on. A POST does, and refusing one without a key is the honest
 * position: the alternative is to invent a key, which makes every retry a new payment and hides
 * that decision from the client who would be charged for it.
 */
const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function buildApi(options: ApiOptions): PipelineOptions {
  const clock = options.clock ?? (() => nowMicros());
  const generateCorrelationId = options.generateCorrelationId ?? (() => randomCorrelationId());

  const contextFor = (request: HttpRequest): RequestContext => {
    const correlationId = correlationOf(request.headers, generateCorrelationId);
    const supplied = request.headers['idempotency-key'];

    if (WRITE_METHODS.includes(request.method) && (supplied === undefined || supplied === '')) {
      throw new ApiError(
        400,
        'missing-idempotency-key',
        'A write needs an "Idempotency-Key" header. Every identifier this request creates is ' +
          'derived from it, so retrying with the same key converges on the same record rather ' +
          'than making a second one — which for a payment is the difference between charging ' +
          'somebody once and charging them twice.',
      );
    }

    const idempotencyKey = supplied ?? correlationId;
    try {
      validate(idempotencyKey);
    } catch {
      throw new ApiError(
        400,
        'malformed-idempotency-key',
        'The "Idempotency-Key" header must be an opaque handle of 8 to 128 characters from ' +
          '[A-Za-z0-9._:-], starting alphanumeric. It must not be an email address, a telephone ' +
          'number, a document number or anything else that identifies a person: it is copied into ' +
          'every record this request creates.',
      );
    }

    return requestContext({ correlationId, idempotencyKey, now: clock(), validate });
  };

  const router = new Router();

  router.add({
    method: 'GET',
    path: '/v1/health',
    summary: 'Liveness. Answers without touching a module or a database.',
    handler: () => Promise.resolve(json(200, { status: 'ok' })),
  });

  addOrderRoutes(router, { orders: options.services.orders, contextFor });
  addPaymentRoutes(router, {
    payments: options.services.payments,
    contextFor,
    // Fails closed. A deployment that configures no secret accepts no webhook, rather than
    // accepting every webhook because there was nothing to check one against.
    webhookSecrets: options.webhookSecrets ?? NO_WEBHOOK_SECRETS,
  });
  addLedgerRoutes(router, { ledger: options.services.ledger, contextFor });
  addCockpitRoutes(router, { cockpit: options.services.cockpit, contextFor });

  router.add({
    method: 'GET',
    path: '/v1/routes',
    summary: 'The route inventory: every path this API serves, and what it is for.',
    handler: () =>
      Promise.resolve(
        json(200, {
          routes: router
            .routes()
            .map((route) => ({ method: route.method, path: route.path, summary: route.summary }))
            .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
        }),
      ),
  });

  const guardOptions = {
    permissions: options.access.permissions,
    sessions: options.access.sessions,
    accounts: options.access.accounts,
    services: options.services,
  };

  /**
   * Every request, before every handler.
   *
   * A route with no entry in `ACCESS_POLICY` is a **500**, not a 403: it is the API's own defect
   * rather than the caller's mistake, and answering 403 would let the defect sit there looking like
   * a working refusal. A test asserts the table and the router agree, so this should be unreachable
   * in a build that passed — but "should be unreachable" is not a reason to fail open.
   */
  const authorize = async (
    request: HttpRequest,
    route: MatchedRoute,
    correlationId: string,
  ): Promise<void> => {
    const access = accessFor(route.method, route.path);
    if (access === undefined) {
      throw new ApiError(
        500,
        'no-access-policy',
        `${route.method} ${route.path} has no entry in the access policy, so there is no rule ` +
          'saying who may call it. It is refused rather than guessed at.',
      );
    }
    if (access.anonymous === true) return;
    await guard(guardOptions, request, access, correlationId);
  };

  return {
    router,
    describe: describeApiError,
    authorize,
    correlationFor: (raw: RawRequest) => correlationOf(raw.headers, generateCorrelationId),
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  };
}

/**
 * The correlation id for a request.
 *
 * A client's own is honoured when it is an acceptable identifier, so a caller tracing a journey
 * across several requests can tie them together. One that is not acceptable is replaced rather than
 * refused: a bad correlation id is not worth failing a request over, and it would be copied into
 * every record the request produces.
 */
function correlationOf(headers: Readonly<Record<string, string>>, generate: () => string): string {
  const supplied = headers['x-correlation-id'];
  if (supplied === undefined || supplied === '') return generate();
  try {
    validate(supplied);
    return supplied;
  } catch {
    return generate();
  }
}

/** The current instant, in the microsecond-width form every validator accepts. */
function nowMicros(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** A correlation id for a request that did not bring one. */
function randomCorrelationId(): string {
  // Deliberately not `randomUUID`: a UUID's hex groups routinely contain a run of twelve digits,
  // which K-01's opacity rule refuses because that is what a card number looks like.
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  let out = 'corr_';
  for (let index = 0; index < 20; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'A';
  }
  try {
    validate(out);
    return out;
  } catch {
    // Vanishingly unlikely, and a correlation id is not worth a retry loop: this one is fixed and
    // still opaque, and a repeated correlation id degrades tracing rather than correctness.
    return 'corr_UNCORRELATED';
  }
}
