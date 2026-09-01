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
import type { FinancialLedgerService } from '../../modules/financial-ledger/index.ts';
import type { OrderService } from '../../modules/orders/index.ts';
import type { PaymentService } from '../../modules/payments/index.ts';
import { requestContext, type RequestContext } from '../../platform/http/context.ts';
import type { PipelineOptions, RawRequest, RequestRecord } from '../../platform/http/pipeline.ts';
import { Router } from '../../platform/http/router.ts';
import { json, type HttpRequest } from '../../platform/http/types.ts';

import { ApiError, describeApiError } from './errors.ts';
import { addLedgerRoutes } from './routes/ledger.ts';
import { addOrderRoutes } from './routes/orders.ts';
import { addPaymentRoutes } from './routes/payments.ts';

export interface ApiServices {
  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly ledger: FinancialLedgerService;
}

export interface ApiOptions {
  readonly services: ApiServices;
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
  addPaymentRoutes(router, { payments: options.services.payments, contextFor });
  addLedgerRoutes(router, { ledger: options.services.ledger, contextFor });

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

  return {
    router,
    describe: describeApiError,
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
