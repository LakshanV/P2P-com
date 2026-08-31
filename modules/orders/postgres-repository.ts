/**
 * M-11 Orders — PostgreSQL adapter.
 *
 * Implements the persistence port against `module_orders`. It knows SQL and nothing else: no
 * validation, no lifecycle, no referential check. Those live in the service, where they can be
 * tested without a server.
 *
 * Every `timestamptz` is projected as UTC text. JSON objects are stored as `jsonb` and read as
 * objects. Money is `bigint` minor units.
 *
 * No statement names another unit's schema, and there is no foreign key out of `module_orders`. The
 * module's outbox table lives in the same schema.
 *
 * Owned by: M-11 Orders.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealOrder, sealOrderEvent, sealOrderItem, sealOrderSnapshot } from './immutable.ts';
import type { OrderRepository, OrderTransaction } from './repository.ts';
import {
  OrderError,
  type Order,
  type OrderErrorCode,
  type OrderEvent,
  type OrderItem,
  type OrderSnapshot,
} from './types.ts';
import {
  validateOrder,
  validateOrderEvent,
  validateOrderItem,
  validateOrderSnapshot,
} from './validate.ts';

export const ORDERS_SCHEMA = 'module_orders';
export const ORDER_HEADER_TABLE = `${ORDERS_SCHEMA}.order_header`;
export const ORDER_ITEM_TABLE = `${ORDERS_SCHEMA}.order_item`;
export const ORDER_SNAPSHOT_TABLE = `${ORDERS_SCHEMA}.order_snapshot`;
export const ORDER_EVENT_TABLE = `${ORDERS_SCHEMA}.order_event`;
export const OUTBOX_TABLE = `${ORDERS_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: OrderErrorCode; readonly explanation: string }>
> = {
  order_header_pkey: {
    code: 'duplicate-order-id',
    explanation: 'an order with this id already exists, and an order is never overwritten',
  },
  order_header_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an order',
  },
  order_item_pkey: {
    code: 'duplicate-item-id',
    explanation: 'an item with this id already exists, and an item is never rewritten',
  },
  order_item_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an item',
  },
  order_snapshot_pkey: {
    code: 'duplicate-snapshot-id',
    explanation: 'a snapshot with this id already exists, and a snapshot is never rewritten',
  },
  order_snapshot_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a snapshot',
  },
  order_snapshot_order_unique: {
    code: 'snapshot-exists',
    explanation: 'this order already has a snapshot. An order is agreed once',
  },
  order_event_pkey: {
    code: 'duplicate-event-id',
    explanation: 'an event with this id already exists, and an event is never rewritten',
  },
  order_event_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an event',
  },
  outbox_pkey: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox id already exists',
  },
  outbox_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this outbox idempotency key has already been used',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof OrderError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new OrderError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const ORDER_HEADER_COLUMNS = [
  'order_id',
  'buyer_account_id',
  'seller_account_id',
  'status',
  'parent_order_id',
  'fulfilment_role',
  'currency',
  'subtotal_minor',
  'total_minor',
  'item_count',
  'placed_at',
  'confirmed_at',
  'completed_at',
  'cancelled_at',
  'cancellation_reason',
  'created_at',
  'updated_at',
  'correlation_id',
  'idempotency_key',
] as const;

const ORDER_ITEM_COLUMNS = [
  'item_id',
  'order_id',
  'listing_id',
  'version_id',
  'commerce_unit_type_id',
  'quantity',
  'unit_price_minor',
  'line_total_minor',
  'currency',
  'reservation_id',
  'added_at',
  'correlation_id',
  'idempotency_key',
] as const;

const ORDER_SNAPSHOT_COLUMNS = [
  'snapshot_id',
  'order_id',
  'buyer_account_id',
  'seller_account_id',
  'currency',
  'subtotal_minor',
  'total_minor',
  'lines',
  'policy_version_id',
  'captured_at',
  'correlation_id',
  'idempotency_key',
] as const;

const ORDER_EVENT_COLUMNS = [
  'event_id',
  'order_id',
  'kind',
  'from_status',
  'to_status',
  'reason',
  'occurred_at',
  'correlation_id',
  'idempotency_key',
] as const;

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const ORDER_HEADER_PROJECTION = [
  'order_id',
  'buyer_account_id',
  'seller_account_id',
  'status',
  'parent_order_id',
  'fulfilment_role',
  'currency',
  'subtotal_minor',
  'total_minor',
  'item_count',
  utcText('placed_at'),
  utcText('confirmed_at'),
  utcText('completed_at'),
  utcText('cancelled_at'),
  'cancellation_reason',
  utcText('created_at'),
  utcText('updated_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const ORDER_ITEM_PROJECTION = [
  'item_id',
  'order_id',
  'listing_id',
  'version_id',
  'commerce_unit_type_id',
  'quantity',
  'unit_price_minor',
  'line_total_minor',
  'currency',
  'reservation_id',
  utcText('added_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const ORDER_SNAPSHOT_PROJECTION = [
  'snapshot_id',
  'order_id',
  'buyer_account_id',
  'seller_account_id',
  'currency',
  'subtotal_minor',
  'total_minor',
  'lines',
  'policy_version_id',
  utcText('captured_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const ORDER_EVENT_PROJECTION = [
  'event_id',
  'order_id',
  'kind',
  'from_status',
  'to_status',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMN_NAMES = [
  'outbox_id',
  'idempotency_key',
  'kind',
  'payload',
  'recorded_at',
  'producer',
  'correlation_id',
  'processed_at',
  'retry_count',
  'last_error',
] as const;
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new OrderError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new OrderError('malformed-record', `${column} is ${typeof value}; expected text or null`);
  }
  return value === '' ? null : value;
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OrderError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

function bigintValue(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new OrderError('malformed-record', `${column} "${value}" is not an integer string`);
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new OrderError('malformed-record', `${column} is ${value}; expected a safe integer`);
    }
    return BigInt(value);
  }
  throw new OrderError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

export function toOrder(row: Record<string, unknown>): Order {
  return sealOrder(
    validateOrder(
      {
        orderId: text(row.order_id, 'order_id'),
        buyerAccountId: text(row.buyer_account_id, 'buyer_account_id'),
        sellerAccountId: text(row.seller_account_id, 'seller_account_id'),
        status: text(row.status, 'status'),
        parentOrderId: optionalText(row.parent_order_id, 'parent_order_id'),
        fulfilmentRole: text(row.fulfilment_role, 'fulfilment_role'),
        currency: text(row.currency, 'currency'),
        subtotalMinor: bigintValue(row.subtotal_minor, 'subtotal_minor'),
        totalMinor: bigintValue(row.total_minor, 'total_minor'),
        itemCount: row.item_count,
        placedAt: optionalText(row.placed_at, 'placed_at'),
        confirmedAt: optionalText(row.confirmed_at, 'confirmed_at'),
        completedAt: optionalText(row.completed_at, 'completed_at'),
        cancelledAt: optionalText(row.cancelled_at, 'cancelled_at'),
        cancellationReason: optionalText(row.cancellation_reason, 'cancellation_reason'),
        createdAt: text(row.created_at, 'created_at'),
        updatedAt: text(row.updated_at, 'updated_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toOrderItem(row: Record<string, unknown>): OrderItem {
  return sealOrderItem(
    validateOrderItem(
      {
        itemId: text(row.item_id, 'item_id'),
        orderId: text(row.order_id, 'order_id'),
        listingId: text(row.listing_id, 'listing_id'),
        versionId: text(row.version_id, 'version_id'),
        commerceUnitTypeId: text(row.commerce_unit_type_id, 'commerce_unit_type_id'),
        quantity: bigintValue(row.quantity, 'quantity'),
        unitPriceMinor: bigintValue(row.unit_price_minor, 'unit_price_minor'),
        lineTotalMinor: bigintValue(row.line_total_minor, 'line_total_minor'),
        currency: text(row.currency, 'currency'),
        reservationId: optionalText(row.reservation_id, 'reservation_id'),
        addedAt: text(row.added_at, 'added_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toOrderSnapshot(row: Record<string, unknown>): OrderSnapshot {
  return sealOrderSnapshot(
    validateOrderSnapshot(
      {
        snapshotId: text(row.snapshot_id, 'snapshot_id'),
        orderId: text(row.order_id, 'order_id'),
        buyerAccountId: text(row.buyer_account_id, 'buyer_account_id'),
        sellerAccountId: text(row.seller_account_id, 'seller_account_id'),
        currency: text(row.currency, 'currency'),
        subtotalMinor: bigintValue(row.subtotal_minor, 'subtotal_minor'),
        totalMinor: bigintValue(row.total_minor, 'total_minor'),
        lines: jsonObject(row.lines, 'lines'),
        policyVersionId: optionalText(row.policy_version_id, 'policy_version_id'),
        capturedAt: text(row.captured_at, 'captured_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toOrderEvent(row: Record<string, unknown>): OrderEvent {
  return sealOrderEvent(
    validateOrderEvent(
      {
        eventId: text(row.event_id, 'event_id'),
        orderId: text(row.order_id, 'order_id'),
        kind: text(row.kind, 'kind'),
        fromStatus: optionalText(row.from_status, 'from_status'),
        toStatus: text(row.to_status, 'to_status'),
        reason: text(row.reason, 'reason'),
        occurredAt: text(row.occurred_at, 'occurred_at'),
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new OrderError(
            'nested-transaction',
            `an enlisted order write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller',
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export class EnlistedOrderRepository implements OrderRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresOrderTransaction(this.#client));
  }
}

export class PostgresOrderRepository implements OrderRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): OrderRepository {
    return new EnlistedOrderRepository(client);
  }

  async withTransaction<T>(body: (tx: OrderTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresOrderTransaction(client));
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

export const TIMESTAMP_COLUMNS = [
  'created_at',
  'updated_at',
  'placed_at',
  'confirmed_at',
  'completed_at',
  'cancelled_at',
  'added_at',
  'captured_at',
  'occurred_at',
] as const;

class PostgresOrderTransaction implements OrderTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${OUTBOX_TABLE} (${OUTBOX_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        entry.outboxId,
        entry.idempotencyKey,
        entry.kind,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.producer,
        entry.correlationId,
        entry.processedAt,
        entry.retryCount,
        entry.lastError,
      ],
    );
  }

  async findOrderById(orderId: string): Promise<Order | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_HEADER_PROJECTION} FROM ${ORDER_HEADER_TABLE} WHERE order_id = $1;`,
      [orderId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrder(row);
  }

  async findOrderByIdempotencyKey(idempotencyKey: string): Promise<Order | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_HEADER_PROJECTION} FROM ${ORDER_HEADER_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrder(row);
  }

  async findOrdersByBuyerAccountId(buyerAccountId: string): Promise<readonly Order[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_HEADER_PROJECTION} FROM ${ORDER_HEADER_TABLE}
       WHERE buyer_account_id = $1 ORDER BY created_at ASC, order_id ASC;`,
      [buyerAccountId],
    );
    return Object.freeze(result.rows.map(toOrder));
  }

  async findOrdersBySellerAccountId(sellerAccountId: string): Promise<readonly Order[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_HEADER_PROJECTION} FROM ${ORDER_HEADER_TABLE}
       WHERE seller_account_id = $1 ORDER BY created_at ASC, order_id ASC;`,
      [sellerAccountId],
    );
    return Object.freeze(result.rows.map(toOrder));
  }

  async findChildrenByParentId(parentOrderId: string): Promise<readonly Order[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_HEADER_PROJECTION} FROM ${ORDER_HEADER_TABLE}
       WHERE parent_order_id = $1 ORDER BY order_id ASC;`,
      [parentOrderId],
    );
    return Object.freeze(result.rows.map(toOrder));
  }

  async insertOrder(order: Order): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORDER_HEADER_TABLE} (${ORDER_HEADER_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19);`,
        [
          order.orderId,
          order.buyerAccountId,
          order.sellerAccountId,
          order.status,
          order.parentOrderId,
          order.fulfilmentRole,
          order.currency,
          order.subtotalMinor,
          order.totalMinor,
          order.itemCount,
          order.placedAt,
          order.confirmedAt,
          order.completedAt,
          order.cancelledAt,
          order.cancellationReason,
          order.createdAt,
          order.updatedAt,
          order.correlationId,
          order.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertOrder');
    }
  }

  async updateOrder(order: Order): Promise<void> {
    await this.#client.query(
      `UPDATE ${ORDER_HEADER_TABLE}
       SET buyer_account_id = $1, seller_account_id = $2, status = $3, parent_order_id = $4,
           fulfilment_role = $5, currency = $6,
           subtotal_minor = $7, total_minor = $8, item_count = $9, placed_at = $10,
           confirmed_at = $11, completed_at = $12, cancelled_at = $13,
           cancellation_reason = $14, created_at = $15, updated_at = $16,
           correlation_id = $17, idempotency_key = $18
       WHERE order_id = $19;`,
      [
        order.buyerAccountId,
        order.sellerAccountId,
        order.status,
        order.parentOrderId,
        order.fulfilmentRole,
        order.currency,
        order.subtotalMinor,
        order.totalMinor,
        order.itemCount,
        order.placedAt,
        order.confirmedAt,
        order.completedAt,
        order.cancelledAt,
        order.cancellationReason,
        order.createdAt,
        order.updatedAt,
        order.correlationId,
        order.idempotencyKey,
        order.orderId,
      ],
    );
  }

  async findItemById(itemId: string): Promise<OrderItem | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_ITEM_PROJECTION} FROM ${ORDER_ITEM_TABLE} WHERE item_id = $1;`,
      [itemId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderItem(row);
  }

  async findItemByIdempotencyKey(idempotencyKey: string): Promise<OrderItem | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_ITEM_PROJECTION} FROM ${ORDER_ITEM_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderItem(row);
  }

  async findItemsByOrderId(orderId: string): Promise<readonly OrderItem[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_ITEM_PROJECTION} FROM ${ORDER_ITEM_TABLE}
       WHERE order_id = $1 ORDER BY added_at ASC, item_id ASC;`,
      [orderId],
    );
    return Object.freeze(result.rows.map(toOrderItem));
  }

  async insertItem(item: OrderItem): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORDER_ITEM_TABLE} (${ORDER_ITEM_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          item.itemId,
          item.orderId,
          item.listingId,
          item.versionId,
          item.commerceUnitTypeId,
          item.quantity,
          item.unitPriceMinor,
          item.lineTotalMinor,
          item.currency,
          item.reservationId,
          item.addedAt,
          item.correlationId,
          item.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertItem');
    }
  }

  async findSnapshotById(snapshotId: string): Promise<OrderSnapshot | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_SNAPSHOT_PROJECTION} FROM ${ORDER_SNAPSHOT_TABLE} WHERE snapshot_id = $1;`,
      [snapshotId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderSnapshot(row);
  }

  async findSnapshotByOrderId(orderId: string): Promise<OrderSnapshot | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_SNAPSHOT_PROJECTION} FROM ${ORDER_SNAPSHOT_TABLE} WHERE order_id = $1;`,
      [orderId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderSnapshot(row);
  }

  async insertSnapshot(snapshot: OrderSnapshot): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORDER_SNAPSHOT_TABLE} (${ORDER_SNAPSHOT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);`,
        [
          snapshot.snapshotId,
          snapshot.orderId,
          snapshot.buyerAccountId,
          snapshot.sellerAccountId,
          snapshot.currency,
          snapshot.subtotalMinor,
          snapshot.totalMinor,
          JSON.stringify(snapshot.lines),
          snapshot.policyVersionId,
          snapshot.capturedAt,
          snapshot.correlationId,
          snapshot.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertSnapshot');
    }
  }

  async findEventById(eventId: string): Promise<OrderEvent | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_EVENT_PROJECTION} FROM ${ORDER_EVENT_TABLE} WHERE event_id = $1;`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderEvent(row);
  }

  async findEventByIdempotencyKey(idempotencyKey: string): Promise<OrderEvent | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_EVENT_PROJECTION} FROM ${ORDER_EVENT_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrderEvent(row);
  }

  async findEventsByOrderId(orderId: string): Promise<readonly OrderEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORDER_EVENT_PROJECTION} FROM ${ORDER_EVENT_TABLE}
       WHERE order_id = $1 ORDER BY occurred_at ASC, event_id ASC;`,
      [orderId],
    );
    return Object.freeze(result.rows.map(toOrderEvent));
  }

  async insertEvent(event: OrderEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORDER_EVENT_TABLE} (${ORDER_EVENT_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
        [
          event.eventId,
          event.orderId,
          event.kind,
          event.fromStatus,
          event.toStatus,
          event.reason,
          event.occurredAt,
          event.correlationId,
          event.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertEvent');
    }
  }
}
