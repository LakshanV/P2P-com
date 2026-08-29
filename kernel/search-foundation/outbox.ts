/**
 * K-15 Search Foundation — outbox event and audit definitions.
 *
 * These definitions describe the facts K-15 publishes when a document is indexed, removed or a
 * query is performed. They are declared separately from the service so a relay can register them
 * without importing K-15 internals.
 *
 * Owned by: K-15 Search Foundation.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { SearchDocument, SearchQueryLog } from './types.ts';

export const SEARCH_INDEXED_EVENT: EventTypeDefinition = {
  type: 'search.indexed',
  schemaVersion: 1,
  owner: 'K-15',
  description: 'A document was indexed or re-indexed in the search foundation.',
  payloadFields: [
    {
      name: 'document_id',
      kind: 'string',
      required: true,
      description: 'The indexed document id.',
    },
    {
      name: 'owner_type',
      kind: 'string',
      required: true,
      description: 'The search vocabulary owner type.',
    },
    {
      name: 'owner_id',
      kind: 'string',
      required: true,
      description: 'The opaque owner entity id.',
    },
    {
      name: 'scope',
      kind: 'string',
      required: true,
      description: 'The search scope.',
    },
    {
      name: 'language',
      kind: 'string',
      required: true,
      description: 'The document language.',
    },
    {
      name: 'updated_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when this version of the document was written.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when indexing the document.',
    },
  ] satisfies PayloadField[],
};

export const SEARCH_REMOVED_EVENT: EventTypeDefinition = {
  type: 'search.removed',
  schemaVersion: 1,
  owner: 'K-15',
  description: 'A document was removed from the search foundation.',
  payloadFields: [
    {
      name: 'document_id',
      kind: 'string',
      required: true,
      description: 'The removed document id.',
    },
    {
      name: 'removed_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the document was removed.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when removing the document.',
    },
  ] satisfies PayloadField[],
};

export const SEARCH_PERFORMED_EVENT: EventTypeDefinition = {
  type: 'search.performed',
  schemaVersion: 1,
  owner: 'K-15',
  description: 'A search query was performed.',
  payloadFields: [
    {
      name: 'query_id',
      kind: 'string',
      required: true,
      description: 'The query id.',
    },
    {
      name: 'query_text',
      kind: 'string',
      required: true,
      description: 'The text the caller searched for.',
    },
    {
      name: 'result_count',
      kind: 'integer',
      required: true,
      description: 'The number of results returned for the query.',
    },
    {
      name: 'executed_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the query was executed.',
    },
    {
      name: 'correlation_id',
      kind: 'string',
      required: true,
      description: 'The correlation id supplied by the caller.',
    },
  ] satisfies PayloadField[],
};

export const SEARCH_INDEXED_ACTION: AuditActionDefinition = {
  action: 'search.indexed',
  owner: 'K-15',
  authority: 'business-authoritative',
  description: 'A document was indexed or re-indexed in the search foundation.',
  resourceTypes: ['search_document'],
  evidenceFields: [
    {
      name: 'document_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The indexed document id.',
    },
    {
      name: 'owner_type',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The search vocabulary owner type.',
    },
    {
      name: 'owner_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The opaque owner entity id.',
    },
    {
      name: 'scope',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The search scope.',
    },
    {
      name: 'language',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The document language.',
    },
    {
      name: 'updated_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when this version of the document was written.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when indexing the document.',
    },
  ] satisfies EvidenceField[],
};

export const SEARCH_REMOVED_ACTION: AuditActionDefinition = {
  action: 'search.removed',
  owner: 'K-15',
  authority: 'business-authoritative',
  description: 'A document was removed from the search foundation.',
  resourceTypes: ['search_document'],
  evidenceFields: [
    {
      name: 'document_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The removed document id.',
    },
    {
      name: 'removed_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the document was removed.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when removing the document.',
    },
  ] satisfies EvidenceField[],
};

export const SEARCH_PERFORMED_ACTION: AuditActionDefinition = {
  action: 'search.performed',
  owner: 'K-15',
  authority: 'business-authoritative',
  description: 'A search query was performed.',
  resourceTypes: ['search_query'],
  evidenceFields: [
    {
      name: 'query_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The query id.',
    },
    {
      name: 'query_text',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The text the caller searched for.',
    },
    {
      name: 'result_count',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'The number of results returned for the query.',
    },
    {
      name: 'executed_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the query was executed.',
    },
    {
      name: 'correlation_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The correlation id supplied by the caller.',
    },
  ] satisfies EvidenceField[],
};

export function makeSearchIndexedEvent(
  document: SearchDocument,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${document.documentId}:${document.idempotencyKey}:indexed`;
  const recordedAt = document.updatedAt;

  return eventOutboxEntry({
    outboxId: `K-15:${eventId}`,
    idempotencyKey: `K-15:${eventId}`,
    payload: {
      eventId,
      type: SEARCH_INDEXED_EVENT.type,
      schemaVersion: SEARCH_INDEXED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-15',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-15' },
      idempotencyKey: `K-15:${eventId}`,
      now: recordedAt,
      payload: {
        document_id: document.documentId,
        owner_type: document.ownerType,
        owner_id: document.ownerId,
        scope: document.scope,
        language: document.language,
        updated_at: document.updatedAt,
        idempotency_key: document.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-15',
    correlationId,
    causationId,
  });
}

export function makeSearchIndexedAction(
  document: SearchDocument,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${document.documentId}:${document.idempotencyKey}:indexed`;
  const outboxId = `K-15:audit:${recordId}`;
  const recordedAt = document.updatedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: SEARCH_INDEXED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'K-15', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-15', type: 'search_document', id: document.documentId },
      outcome: 'succeeded',
      reason: `document ${document.documentId} indexed with owner ${document.ownerType}:${document.ownerId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        document_id: document.documentId,
        owner_type: document.ownerType,
        owner_id: document.ownerId,
        scope: document.scope,
        language: document.language,
        updated_at: document.updatedAt,
        idempotency_key: document.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'K-15',
    correlationId,
    causationId,
  });
}

export function makeSearchRemovedEvent(
  documentId: string,
  idempotencyKey: string,
  removedAt: string,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${documentId}:removed`;

  return eventOutboxEntry({
    outboxId: `K-15:${eventId}`,
    idempotencyKey: `K-15:${eventId}`,
    payload: {
      eventId,
      type: SEARCH_REMOVED_EVENT.type,
      schemaVersion: SEARCH_REMOVED_EVENT.schemaVersion,
      occurredAt: removedAt,
      recordedAt: removedAt,
      producer: 'K-15',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-15' },
      idempotencyKey: `K-15:${eventId}`,
      now: removedAt,
      payload: {
        document_id: documentId,
        removed_at: removedAt,
        idempotency_key: idempotencyKey,
      },
    },
    occurredAt: removedAt,
    recordedAt: removedAt,
    producer: 'K-15',
    correlationId,
    causationId,
  });
}

export function makeSearchRemovedAction(
  documentId: string,
  idempotencyKey: string,
  removedAt: string,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${documentId}:removed`;
  const outboxId = `K-15:audit:${recordId}`;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: SEARCH_REMOVED_ACTION.action,
      recordedAt: removedAt,
      actor: { kind: 'system', id: 'K-15', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-15', type: 'search_document', id: documentId },
      outcome: 'succeeded',
      reason: `document ${documentId} removed from search index`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        document_id: documentId,
        removed_at: removedAt,
        idempotency_key: idempotencyKey,
      },
    },
    recordedAt: removedAt,
    producer: 'K-15',
    correlationId,
    causationId,
  });
}

export function makeSearchPerformedEvent(
  log: SearchQueryLog,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${log.queryId}:performed`;

  return eventOutboxEntry({
    outboxId: `K-15:${eventId}`,
    idempotencyKey: `K-15:${eventId}`,
    payload: {
      eventId,
      type: SEARCH_PERFORMED_EVENT.type,
      schemaVersion: SEARCH_PERFORMED_EVENT.schemaVersion,
      occurredAt: log.executedAt,
      recordedAt: log.executedAt,
      producer: 'K-15',
      correlationId: log.correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-15' },
      idempotencyKey: `K-15:${eventId}`,
      now: log.executedAt,
      payload: {
        query_id: log.queryId,
        query_text: log.queryText,
        result_count: log.resultCount,
        executed_at: log.executedAt,
        correlation_id: log.correlationId,
      },
    },
    occurredAt: log.executedAt,
    recordedAt: log.executedAt,
    producer: 'K-15',
    correlationId: log.correlationId,
    causationId,
  });
}

export function makeSearchPerformedAction(
  log: SearchQueryLog,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${log.queryId}:performed`;
  const outboxId = `K-15:audit:${recordId}`;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: SEARCH_PERFORMED_ACTION.action,
      recordedAt: log.executedAt,
      actor: { kind: 'system', id: 'K-15', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'K-15', type: 'search_query', id: log.queryId },
      outcome: 'succeeded',
      reason: `query ${log.queryId} performed with ${log.resultCount} results`,
      correlationId: log.correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        query_id: log.queryId,
        query_text: log.queryText,
        result_count: log.resultCount,
        executed_at: log.executedAt,
        correlation_id: log.correlationId,
      },
    },
    recordedAt: log.executedAt,
    producer: 'K-15',
    correlationId: log.correlationId,
    causationId,
  });
}
