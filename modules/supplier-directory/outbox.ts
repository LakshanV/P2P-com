/**
 * M-48 — the facts the directory publishes.
 *
 * **A supplier's declarations do not travel.** An event says that a supplier registered, opened,
 * was suspended or closed; it does not carry their categories, brands or districts. What a business
 * sells is commercially useful to their competitors, the event log is read by every subscriber and
 * kept indefinitely, and a directory that broadcast its own contents would be a market-intelligence
 * feed nobody agreed to publish. A consumer that needs the profile reads it through a route that
 * can check who is asking.
 *
 * The `status` and the `kind` do travel, because a notification consumer has to route on something
 * and neither says anything a competitor could use.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import type { DirectoryEntry } from './types.ts';

const DIRECTORY_FIELDS: readonly PayloadField[] = [
  { name: 'supplier_id', kind: 'string', required: true, description: 'The directory entry.' },
  {
    name: 'account_id',
    kind: 'string',
    required: true,
    description: 'The K-03 account that trades. What a notification consumer routes on.',
  },
  { name: 'kind', kind: 'string', required: true, description: 'supplier or merchant.' },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'accepts_orders',
    kind: 'boolean',
    required: true,
    description: 'Whether they are open. Distinct from their status, and from their capacity.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'When the fact happened.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key the originating request converged on.',
  },
];

export const SUPPLIER_REGISTERED_EVENT: EventTypeDefinition = {
  type: 'supplier.registered',
  schemaVersion: 1,
  owner: 'M-48',
  description:
    'A party registered to trade. They are not yet a candidate for sourcing: registration is not ' +
    'activation, and the categories they declared are not in this event.',
  payloadFields: DIRECTORY_FIELDS,
};

export const SUPPLIER_ACTIVATED_EVENT: EventTypeDefinition = {
  type: 'supplier.activated',
  schemaVersion: 1,
  owner: 'M-48',
  description: 'A party is open for business, and the sourcing rungs will now consider them.',
  payloadFields: DIRECTORY_FIELDS,
};

export const SUPPLIER_SUSPENDED_EVENT: EventTypeDefinition = {
  type: 'supplier.suspended',
  schemaVersion: 1,
  owner: 'M-48',
  description:
    'A party is temporarily not open. Reversible, and distinct from closing: a supplier who ' +
    'cannot be told the difference cannot tell whether to come back.',
  payloadFields: DIRECTORY_FIELDS,
};

export const SUPPLIER_CLOSED_EVENT: EventTypeDefinition = {
  type: 'supplier.closed',
  schemaVersion: 1,
  owner: 'M-48',
  description:
    'A party has stopped trading. Terminal, and the record stays: orders still name them.',
  payloadFields: DIRECTORY_FIELDS,
};

export const SUPPLIER_ACTION: AuditActionDefinition = {
  action: 'supplier.status_changed',
  owner: 'M-48',
  authority: 'business-authoritative',
  description: 'A directory entry was registered, activated, suspended or closed.',
  resourceTypes: ['supplier_directory_entry'],
  evidenceFields: [
    ...DIRECTORY_FIELDS.map((field) => ({
      name: field.name,
      kind: field.kind === 'boolean' ? ('boolean' as const) : ('string' as const),
      required: field.required,
      classification: 'internal' as const,
      description: field.description,
    })),
    {
      name: 'display_name',
      kind: 'string' as const,
      required: true,
      classification: 'internal' as const,
      description:
        'What they trade as. Public by design: it is what a buyer sees on an invitation.',
    },
    {
      name: 'reason',
      kind: 'string' as const,
      required: false,
      classification: 'internal' as const,
      description:
        'Why the status changed. A suspended supplier is entitled to know, and the audit trail is ' +
        'where that answer survives.',
    },
  ],
};

const EVENT_FOR_STATUS: Readonly<Record<string, EventTypeDefinition>> = Object.freeze({
  pending: SUPPLIER_REGISTERED_EVENT,
  active: SUPPLIER_ACTIVATED_EVENT,
  suspended: SUPPLIER_SUSPENDED_EVENT,
  closed: SUPPLIER_CLOSED_EVENT,
});

/** What a subscriber is told. Deliberately not what the supplier sells. */
function publishedPayload(entry: DirectoryEntry): Record<string, string | boolean> {
  return {
    supplier_id: entry.supplierId,
    account_id: entry.accountId,
    kind: entry.kind,
    status: entry.status,
    accepts_orders: entry.acceptsOrders,
    occurred_at: entry.updatedAt,
    idempotency_key: entry.idempotencyKey,
  };
}

/**
 * Keyed on the **transition**, not on the status.
 *
 * A directory status genuinely cycles — active, suspended, active again — so keying on
 * `supplierId:status` would refuse the second activation as a duplicate outbox row. The caller
 * supplies a stable id per transition, and a retry of that transition converges on the row already
 * written.
 */
export function makeDirectoryEvent(entry: DirectoryEntry, factId: string): OutboxEntry {
  const definition = EVENT_FOR_STATUS[entry.status] ?? SUPPLIER_REGISTERED_EVENT;
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-48:${eventId}`,
    idempotencyKey: `M-48:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt: entry.updatedAt,
      recordedAt: entry.updatedAt,
      producer: 'M-48',
      correlationId: entry.correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-48' },
      idempotencyKey: `M-48:${eventId}`,
      now: entry.updatedAt,
      payload: publishedPayload(entry),
    },
    occurredAt: entry.updatedAt,
    recordedAt: entry.updatedAt,
    producer: 'M-48',
    correlationId: entry.correlationId,
    causationId: null,
  });
}

export function makeDirectoryAction(
  entry: DirectoryEntry,
  reason: string,
  factId: string,
): OutboxEntry {
  const recordId = `${factId}:${SUPPLIER_ACTION.action}`;
  const outboxId = `M-48:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: SUPPLIER_ACTION.action,
      subjectId: entry.accountId,
      resourceType: 'supplier_directory_entry',
      resourceId: entry.supplierId,
      occurredAt: entry.updatedAt,
      recordedAt: entry.updatedAt,
      actor: { kind: 'system', id: 'M-48' },
      correlationId: entry.correlationId,
      idempotencyKey: outboxId,
      now: entry.updatedAt,
      evidence: { ...publishedPayload(entry), display_name: entry.displayName, reason },
    },
    recordedAt: entry.updatedAt,
    producer: 'M-48',
    correlationId: entry.correlationId,
    causationId: null,
  });
}
