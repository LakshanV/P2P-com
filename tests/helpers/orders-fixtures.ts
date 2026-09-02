/**
 * Shared fixtures for the M-11 Orders suites.
 *
 * Every identifier and every instant is supplied here rather than read from a clock, so a replayed
 * request produces a byte-identical record. Money is `bigint` minor units throughout — a fixture
 * using a JavaScript number would quietly teach the suites a habit the financial zone refuses.
 */

import {
  InMemoryOrderRepository,
  OrderService,
  type AddItemRequest,
  type CancelOrderRequest,
  type ConfirmOrderRequest,
  type CreateOrderRequest,
  type Order,
  type OrderEvent,
  type OrderItem,
  type OrderSnapshot,
  type PlaceOrderRequest,
} from '../../modules/orders/index.ts';

export interface Harness {
  readonly service: OrderService;
  readonly repository: InMemoryOrderRepository;
}

export function build(): Harness {
  const repository = new InMemoryOrderRepository();
  return { service: new OrderService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export const BUYER = 'acct_01HR0A0buyer01';
export const SELLER = 'acct_01HR0A0seller1';
export const LISTING = 'lst_01HR0A000001';
export const VERSION = 'ver_01HR0A000001';
export const UNIT_TYPE = 'cut_01HR0A000001';

export function createRequest(overrides: Partial<CreateOrderRequest> = {}): CreateOrderRequest {
  const n = seq();
  return {
    orderId: `ord_01HR0AC${n}`,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0AC${n}`,
    idempotencyKey: `idem_order_${n}`,
    eventId: `oev_01HR0AC${n}`,
    reason: 'the buyer started a basket',
    ...overrides,
  };
}

export function itemRequest(
  orderId: string,
  overrides: Partial<AddItemRequest> = {},
): AddItemRequest {
  const n = seq();
  return {
    itemId: `oit_01HR0AI${n}`,
    orderId,
    listingId: LISTING,
    versionId: VERSION,
    commerceUnitTypeId: UNIT_TYPE,
    quoteId: null,
    lineKind: 'goods',
    quantity: 3n,
    unitPriceMinor: 249_500n,
    lineTotalMinor: 748_500n,
    currency: 'LKR',
    reservationId: `rsv_01HR0AI${n}`,
    addedAt: '2026-07-01T09:05:00Z',
    correlationId: `corr_01HR0AI${n}`,
    idempotencyKey: `idem_item_${n}`,
    ...overrides,
  };
}

export function placeRequest(
  orderId: string,
  overrides: Partial<PlaceOrderRequest> = {},
): PlaceOrderRequest {
  const n = seq();
  return {
    orderId,
    snapshotId: `osn_01HR0AP${n}`,
    expectedTotalMinor: 748_500n,
    policyVersionId: `pol_01HR0AP${n}`,
    placedAt: '2026-07-01T10:00:00Z',
    updatedAt: '2026-07-01T10:00:00Z',
    correlationId: `corr_01HR0AP${n}`,
    idempotencyKey: `idem_place_${n}`,
    eventId: `oev_01HR0AP${n}`,
    reason: 'the buyer placed the order',
    ...overrides,
  };
}

export function confirmRequest(
  orderId: string,
  overrides: Partial<ConfirmOrderRequest> = {},
): ConfirmOrderRequest {
  const n = seq();
  return {
    orderId,
    confirmedAt: '2026-07-02T09:00:00Z',
    updatedAt: '2026-07-02T09:00:00Z',
    correlationId: `corr_01HR0AF${n}`,
    idempotencyKey: `idem_confirm_${n}`,
    eventId: `oev_01HR0AF${n}`,
    reason: 'the seller accepted the order',
    ...overrides,
  };
}

export function cancelRequest(
  orderId: string,
  overrides: Partial<CancelOrderRequest> = {},
): CancelOrderRequest {
  const n = seq();
  return {
    orderId,
    cancellationReason: 'buyer-withdrew',
    cancelledAt: '2026-07-03T09:00:00Z',
    updatedAt: '2026-07-03T09:00:00Z',
    correlationId: `corr_01HR0AX${n}`,
    idempotencyKey: `idem_cancel_${n}`,
    eventId: `oev_01HR0AX${n}`,
    reason: 'the buyer changed their mind',
    ...overrides,
  };
}

export function orderRecord(overrides: Partial<Order> = {}): Order {
  const n = seq();
  return {
    orderId: `ord_01HR0AR${n}`,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    status: 'draft',
    parentOrderId: null,
    fulfilmentRole: 'standalone',
    currency: 'LKR',
    subtotalMinor: 0n,
    totalMinor: 0n,
    itemCount: 0,
    placedAt: null,
    confirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: '2026-07-01T09:00:00Z',
    updatedAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0AR${n}`,
    idempotencyKey: `idem_orec_${n}`,
    ...overrides,
  };
}

export function itemRecord(overrides: Partial<OrderItem> = {}): OrderItem {
  const n = seq();
  return {
    itemId: `oit_01HR0AT${n}`,
    orderId: `ord_01HR0AT${n}`,
    listingId: LISTING,
    versionId: VERSION,
    commerceUnitTypeId: UNIT_TYPE,
    quoteId: null,
    lineKind: 'goods',
    quantity: 3n,
    unitPriceMinor: 249_500n,
    lineTotalMinor: 748_500n,
    currency: 'LKR',
    reservationId: `rsv_01HR0AT${n}`,
    addedAt: '2026-07-01T09:05:00Z',
    correlationId: `corr_01HR0AT${n}`,
    idempotencyKey: `idem_irec_${n}`,
    ...overrides,
  };
}

export function snapshotRecord(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  const n = seq();
  return {
    snapshotId: `osn_01HR0AS${n}`,
    orderId: `ord_01HR0AS${n}`,
    buyerAccountId: BUYER,
    sellerAccountId: SELLER,
    currency: 'LKR',
    subtotalMinor: 748_500n,
    totalMinor: 748_500n,
    lines: {},
    policyVersionId: `pol_01HR0AS${n}`,
    capturedAt: '2026-07-01T10:00:00Z',
    correlationId: `corr_01HR0AS${n}`,
    idempotencyKey: `idem_srec_${n}`,
    ...overrides,
  };
}

export function eventRecord(overrides: Partial<OrderEvent> = {}): OrderEvent {
  const n = seq();
  return {
    eventId: `oev_01HR0AE${n}`,
    orderId: `ord_01HR0AE${n}`,
    kind: 'created',
    fromStatus: null,
    toStatus: 'draft',
    reason: 'the order was created',
    occurredAt: '2026-07-01T09:00:00Z',
    correlationId: `corr_01HR0AE${n}`,
    idempotencyKey: `idem_erec_${n}`,
    ...overrides,
  };
}

/** The outbox entries of one kind, oldest first, as the relay would read them. */
export function entriesOfKind(
  repository: InMemoryOrderRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}

/** The `type` of every event entry, oldest first. */
export function eventTypes(repository: InMemoryOrderRepository): readonly string[] {
  return entriesOfKind(repository, 'event').map(
    (entry) => (entry.payload as { type: string }).type,
  );
}

/** The business payload of the most recent event. */
export function lastEventPayload(repository: InMemoryOrderRepository): Record<string, unknown> {
  const entry = entriesOfKind(repository, 'event').at(-1);
  return (entry?.payload as { payload: Record<string, unknown> }).payload;
}
