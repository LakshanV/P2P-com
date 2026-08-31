/**
 * M-11 Orders — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice.
 *
 * M-11 owns the order lifecycle, its immutable items, snapshot and event log. It depends on the
 * platform substrate and K-03 Accounts (for identifier rules and the account reference). It does not
 * import any other business module.
 *
 * Owned by: M-11 Orders.
 */

export {
  CANCELLATION_REASONS,
  ORDER_EVENT_KINDS,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  OrderError,
} from './types.ts';
export type {
  CancellationReason,
  Order,
  OrderErrorCode,
  OrderEvent,
  OrderEventKind,
  OrderItem,
  OrderSnapshot,
  OrderStatus,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertCancellationReason,
  assertOrderEventKind,
  assertOrderIdentifier,
  assertOrderStatus,
} from './registry.ts';

export {
  isOrderEventSealed,
  isOrderItemSealed,
  isOrderSealed,
  isOrderSnapshotSealed,
  sealOrder,
  sealOrderEvent,
  sealOrderEvents,
  sealOrderItem,
  sealOrderItems,
  sealOrderSnapshot,
  sealOrderSnapshots,
  sealOrders,
} from './immutable.ts';

export {
  validateOrder,
  validateOrderEvent,
  validateOrderItem,
  validateOrderSnapshot,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export { OrderService } from './service.ts';
export type {
  AddItemRequest,
  AddItemResult,
  CancelOrderRequest,
  CancelOrderResult,
  CompleteOrderRequest,
  CompleteOrderResult,
  ConfirmOrderRequest,
  ConfirmOrderResult,
  CreateOrderRequest,
  CreateOrderResult,
  PlaceOrderRequest,
  PlaceOrderResult,
  StartFulfilmentRequest,
  StartFulfilmentResult,
} from './service.ts';

export { InMemoryOrderRepository } from './repository.ts';
export type { OrderRepository, OrderTransaction } from './repository.ts';

export {
  EnlistedOrderRepository,
  ORDER_EVENT_TABLE,
  ORDER_HEADER_TABLE,
  ORDER_ITEM_TABLE,
  ORDER_SNAPSHOT_TABLE,
  ORDERS_SCHEMA,
  OUTBOX_TABLE,
  PostgresOrderRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toOrder,
  toOrderEvent,
  toOrderItem,
  toOrderSnapshot,
} from './postgres-repository.ts';

export {
  ORDER_CANCELLED_ACTION,
  ORDER_CANCELLED_EVENT,
  ORDER_COMPLETED_ACTION,
  ORDER_COMPLETED_EVENT,
  ORDER_CONFIRMED_ACTION,
  ORDER_CONFIRMED_EVENT,
  ORDER_CREATED_ACTION,
  ORDER_CREATED_EVENT,
  ORDER_FULFILLING_ACTION,
  ORDER_FULFILLING_EVENT,
  ORDER_PLACED_ACTION,
  ORDER_PLACED_EVENT,
  makeOrderCancelledAction,
  makeOrderCancelledEvent,
  makeOrderCompletedAction,
  makeOrderCompletedEvent,
  makeOrderConfirmedAction,
  makeOrderConfirmedEvent,
  makeOrderCreatedAction,
  makeOrderCreatedEvent,
  makeOrderFulfillingAction,
  makeOrderFulfillingEvent,
  makeOrderPlacedAction,
  makeOrderPlacedEvent,
} from './outbox.ts';
