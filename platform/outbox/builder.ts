/**
 * Helpers for constructing outbox entries (FND-003d).
 *
 * These remove the boilerplate of assembling the envelope that every producer must write, while
 * leaving each module responsible for its own payload shape and event/audit definitions.
 *
 * Owned by: platform substrate.
 */

import type { OutboxEntry } from './types.ts';

export interface EventOutboxOptions {
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface AuditOutboxOptions {
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly payload: unknown;
  readonly recordedAt: string;
  readonly producer: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export function eventOutboxEntry(options: EventOutboxOptions): OutboxEntry {
  return {
    outboxId: options.outboxId,
    idempotencyKey: options.idempotencyKey,
    kind: 'event',
    payload: options.payload,
    recordedAt: options.recordedAt,
    producer: options.producer,
    correlationId: options.correlationId,
    causationId: options.causationId ?? null,
    processedAt: null,
    retryCount: 0,
    lastError: null,
    // A newly produced entry has never been attempted, so it is eligible immediately and has not
    // been given up on. The relay owns these from here.
    nextAttemptAt: null,
    deadLetteredAt: null,
    deadLetterReason: null,
  };
}

export function auditOutboxEntry(options: AuditOutboxOptions): OutboxEntry {
  return {
    outboxId: options.outboxId,
    idempotencyKey: options.idempotencyKey,
    kind: 'audit',
    payload: options.payload,
    recordedAt: options.recordedAt,
    producer: options.producer,
    correlationId: options.correlationId,
    causationId: options.causationId ?? null,
    processedAt: null,
    retryCount: 0,
    lastError: null,
    // A newly produced entry has never been attempted, so it is eligible immediately and has not
    // been given up on. The relay owns these from here.
    nextAttemptAt: null,
    deadLetteredAt: null,
    deadLetterReason: null,
  };
}
