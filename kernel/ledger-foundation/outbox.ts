/**
 * K-10 Ledger Foundation — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-10 publishes to the platform event log and audit log when a
 * transaction is posted. They are declared separately from the service so a relay can register them
 * without importing K-10 internals, and so the payloads stay stable once consumers depend on them.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

import type { LedgerTransaction } from './types.ts';

export const LEDGER_TRANSACTION_POSTED_EVENT: EventTypeDefinition = {
  type: 'ledger.transaction_posted',
  schemaVersion: 1,
  owner: 'K-10',
  description: 'A balanced ledger transaction was posted and its entries are now queryable.',
  payloadFields: [
    {
      name: 'transaction_id',
      kind: 'string',
      required: true,
      description: 'The posted transaction id.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when posting.',
    },
    {
      name: 'posted_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the transaction was posted.',
    },
    {
      name: 'asset_type_id',
      kind: 'string',
      required: true,
      description: 'The asset type all lines are denominated in.',
    },
    {
      name: 'debit_total',
      kind: 'string',
      required: true,
      description: 'Total debits in minor units, as a decimal string.',
    },
    {
      name: 'credit_total',
      kind: 'string',
      required: true,
      description: 'Total credits in minor units, as a decimal string.',
    },
    {
      name: 'entry_count',
      kind: 'integer',
      required: true,
      description: 'Number of lines in the transaction.',
    },
  ] satisfies PayloadField[],
};

export const LEDGER_TRANSACTION_POSTED_ACTION: AuditActionDefinition = {
  action: 'ledger.transaction_posted',
  owner: 'K-10',
  authority: 'business-authoritative',
  description: 'A balanced ledger transaction was posted to the immutable journal.',
  resourceTypes: ['ledger_transaction'],
  evidenceFields: [
    {
      name: 'transaction_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The posted transaction id.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when posting.',
    },
    {
      name: 'posted_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the transaction was posted.',
    },
    {
      name: 'asset_type_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The asset type all lines are denominated in.',
    },
    {
      name: 'debit_total',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Total debits in minor units, as a decimal string.',
    },
    {
      name: 'credit_total',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Total credits in minor units, as a decimal string.',
    },
    {
      name: 'entry_count',
      kind: 'integer',
      required: true,
      classification: 'internal',
      description: 'Number of lines in the transaction.',
    },
  ] satisfies EvidenceField[],
};

function transactionTotals(transaction: LedgerTransaction): { debits: bigint; credits: bigint } {
  let debits = 0n;
  let credits = 0n;
  for (const entry of transaction.entries) {
    if (entry.side === 'debit') {
      debits += entry.amount;
    } else {
      credits += entry.amount;
    }
  }
  return { debits, credits };
}

export function makeLedgerTransactionPostedEvent(
  transaction: LedgerTransaction,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${transaction.transactionId}:posted`;
  const recordedAt = transaction.postedAt;
  const { debits, credits } = transactionTotals(transaction);

  return eventOutboxEntry({
    outboxId: `K-10:${eventId}`,
    idempotencyKey: `K-10:${eventId}`,
    payload: {
      eventId,
      type: LEDGER_TRANSACTION_POSTED_EVENT.type,
      schemaVersion: LEDGER_TRANSACTION_POSTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'K-10',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'K-10' },
      idempotencyKey: `K-10:${eventId}`,
      now: recordedAt,
      payload: {
        transaction_id: transaction.transactionId,
        idempotency_key: transaction.idempotencyKey,
        posted_at: transaction.postedAt,
        asset_type_id: transaction.assetTypeId,
        debit_total: debits.toString(),
        credit_total: credits.toString(),
        entry_count: transaction.entries.length,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'K-10',
    correlationId,
    causationId,
  });
}

export function makeLedgerTransactionPostedAction(
  transaction: LedgerTransaction,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${transaction.transactionId}:posted`;
  const outboxId = `K-10:audit:${recordId}`;
  const recordedAt = transaction.postedAt;
  const { debits, credits } = transactionTotals(transaction);

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: LEDGER_TRANSACTION_POSTED_ACTION.action,
      recordedAt,
      actor: {
        kind: 'system',
        id: 'K-10',
        authentication: 'unauthenticated',
        sessionId: null,
      },
      resource: {
        owner: 'K-10',
        type: 'ledger_transaction',
        id: transaction.transactionId,
      },
      outcome: 'succeeded',
      reason: `ledger transaction ${transaction.transactionId} posted for ${transaction.assetTypeId} with ${transaction.entries.length} lines`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        transaction_id: transaction.transactionId,
        idempotency_key: transaction.idempotencyKey,
        posted_at: transaction.postedAt,
        asset_type_id: transaction.assetTypeId,
        debit_total: debits.toString(),
        credit_total: credits.toString(),
        entry_count: transaction.entries.length,
      },
    },
    recordedAt,
    producer: 'K-10',
    correlationId,
    causationId,
  });
}
