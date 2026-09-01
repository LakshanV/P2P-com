/**
 * M-13 Financial Ledger — outbox event and audit definitions.
 *
 * These describe the facts M-13 publishes: a wallet opened or its status changed, a plan allocated,
 * committed, settled or cancelled, and each leg as it posts.
 *
 * Amounts cross the wire as **strings**, and every one of them travels with the asset type it is
 * denominated in. In a multi-value platform an amount without its unit is not merely imprecise, it
 * is meaningless: `1500` is 1,500 reward points or 1,500 rupee cents depending on a field a lazy
 * consumer might not read, and those are not the same amount of anything.
 *
 * A leg's event carries **both** figures — what moved, in its own asset, and what that counted for
 * against the obligation. A consumer that only had the second could not reconcile against K-10, and
 * one that only had the first could not tell whether the obligation was covered.
 *
 * Owned by: M-13 Financial Ledger.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { ValueLeg, ValuePlan, Wallet, WalletStateRecord } from './types.ts';

// ---------------------------------------------------------------------------
// Wallet facts
// ---------------------------------------------------------------------------

const WALLET_FIELDS = [
  { name: 'wallet_id', kind: 'string', required: true, description: 'The wallet identifier.' },
  {
    name: 'owner_account_id',
    kind: 'string',
    required: true,
    description: 'The K-03 account that holds it.',
  },
  {
    name: 'asset_type_id',
    kind: 'string',
    required: true,
    description: 'The K-10 asset type it is denominated in.',
  },
  {
    name: 'purpose',
    kind: 'string',
    required: true,
    description: 'What the wallet is for. Earnings is a purpose, not an asset class.',
  },
  {
    name: 'ledger_account_id',
    kind: 'string',
    required: true,
    description: 'The K-10 account this wallet names.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  { name: 'occurred_at', kind: 'string', required: true, description: 'ISO-8601 instant.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key supplied for the operation.',
  },
] satisfies PayloadField[];

export const WALLET_OPENED_EVENT: EventTypeDefinition = {
  type: 'wallet.opened',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'A named position was opened over a K-10 ledger account.',
  payloadFields: WALLET_FIELDS,
};

export const WALLET_STATUS_CHANGED_EVENT: EventTypeDefinition = {
  type: 'wallet.status-changed',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'A wallet was frozen, unfrozen or closed.',
  payloadFields: [
    ...WALLET_FIELDS,
    {
      name: 'from_status',
      kind: 'string',
      required: true,
      description: 'The status before the change.',
    },
    { name: 'reason', kind: 'string', required: true, description: 'Why it changed.' },
  ],
};

// ---------------------------------------------------------------------------
// Plan facts
// ---------------------------------------------------------------------------

const PLAN_FIELDS = [
  { name: 'plan_id', kind: 'string', required: true, description: 'The plan identifier.' },
  {
    name: 'obligation_id',
    kind: 'string',
    required: true,
    description: 'What is being paid for. Opaque; usually an M-11 order.',
  },
  {
    name: 'obligation_kind',
    kind: 'string',
    required: true,
    description: 'What kind of thing that is.',
  },
  { name: 'payer_account_id', kind: 'string', required: true, description: 'The party that owes.' },
  { name: 'payee_account_id', kind: 'string', required: true, description: 'The party owed.' },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'settlement_asset_type_id',
    kind: 'string',
    required: true,
    description: 'The asset the obligation is denominated in.',
  },
  {
    name: 'target_amount_minor',
    kind: 'string',
    required: true,
    description: 'The whole obligation, in settlement minor units, as a string.',
  },
  {
    name: 'internal_minor',
    kind: 'string',
    required: true,
    description: 'How much of the target came from value JAYA issued itself.',
  },
  {
    name: 'external_minor',
    kind: 'string',
    required: true,
    description: 'How much of the target crossed the platform boundary.',
  },
  {
    name: 'leg_count',
    kind: 'string',
    required: true,
    description: 'How many legs the allocation has.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'ISO-8601 instant.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key supplied for the operation.',
  },
] satisfies PayloadField[];

export const PLAN_ALLOCATED_EVENT: EventTypeDefinition = {
  type: 'value-plan.allocated',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'An obligation was allocated across several kinds of value. Nothing has moved yet.',
  payloadFields: PLAN_FIELDS,
};

export const PLAN_COMMITTED_EVENT: EventTypeDefinition = {
  type: 'value-plan.committed',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'Every internal leg has posted; any external leg awaits settlement.',
  payloadFields: PLAN_FIELDS,
};

export const PLAN_SETTLED_EVENT: EventTypeDefinition = {
  type: 'value-plan.settled',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'Every leg has posted. The obligation is covered in full.',
  payloadFields: PLAN_FIELDS,
};

export const PLAN_CANCELLED_EVENT: EventTypeDefinition = {
  type: 'value-plan.cancelled',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'Every posted leg was reversed by a compensating transaction.',
  payloadFields: [
    ...PLAN_FIELDS,
    { name: 'reason', kind: 'string', required: true, description: 'Why it was cancelled.' },
  ],
};

// ---------------------------------------------------------------------------
// Leg facts
// ---------------------------------------------------------------------------

const LEG_FIELDS = [
  { name: 'leg_id', kind: 'string', required: true, description: 'The leg identifier.' },
  { name: 'plan_id', kind: 'string', required: true, description: 'The plan it belongs to.' },
  {
    name: 'kind',
    kind: 'string',
    required: true,
    description: 'internal or external: whether the value crossed the platform boundary.',
  },
  { name: 'status', kind: 'string', required: true, description: 'The status after the change.' },
  {
    name: 'asset_type_id',
    kind: 'string',
    required: true,
    description: 'The asset this leg moves, which need not be the settlement asset.',
  },
  {
    name: 'amount_minor',
    kind: 'string',
    required: true,
    description: 'What moved, in minor units of asset_type_id, as a string.',
  },
  {
    name: 'settlement_equivalent_minor',
    kind: 'string',
    required: true,
    description: 'What that counted for against the obligation, as a string.',
  },
  {
    name: 'rate_numerator',
    kind: 'string',
    required: true,
    description: 'The rate, as an exact integer pair. Never a decimal.',
  },
  {
    name: 'rate_denominator',
    kind: 'string',
    required: true,
    description: 'The rate denominator.',
  },
  {
    name: 'source_wallet_id',
    kind: 'string',
    required: true,
    description: 'Where value left, or empty for an external leg.',
  },
  {
    name: 'destination_wallet_id',
    kind: 'string',
    required: true,
    description: 'Where value arrived.',
  },
  {
    name: 'ledger_transaction_id',
    kind: 'string',
    required: true,
    description: 'The K-10 transaction that moved it, or empty while only planned.',
  },
  { name: 'occurred_at', kind: 'string', required: true, description: 'ISO-8601 instant.' },
  {
    name: 'idempotency_key',
    kind: 'string',
    required: true,
    description: 'The key supplied for the operation.',
  },
] satisfies PayloadField[];

export const LEG_POSTED_EVENT: EventTypeDefinition = {
  type: 'value-leg.posted',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'One leg of a plan moved value, and K-10 recorded the transaction.',
  payloadFields: LEG_FIELDS,
};

export const LEG_REVERSED_EVENT: EventTypeDefinition = {
  type: 'value-leg.reversed',
  schemaVersion: 1,
  owner: 'M-13',
  description: 'A posted leg was undone by a compensating K-10 transaction.',
  payloadFields: [
    ...LEG_FIELDS,
    {
      name: 'reversal_transaction_id',
      kind: 'string',
      required: true,
      description: 'The compensating K-10 transaction. The original is never deleted.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Audit actions
// ---------------------------------------------------------------------------

const internal = (fields: readonly PayloadField[]) =>
  fields.map((field) => ({ ...field, classification: 'internal' as const }));

export const WALLET_OPENED_ACTION: AuditActionDefinition = {
  action: 'wallet.opened',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'A wallet was opened over a K-10 ledger account.',
  resourceTypes: ['wallet'],
  evidenceFields: internal(WALLET_FIELDS),
};

export const WALLET_STATUS_CHANGED_ACTION: AuditActionDefinition = {
  action: 'wallet.status-changed',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'A wallet was frozen, unfrozen or closed.',
  resourceTypes: ['wallet'],
  evidenceFields: internal([
    ...WALLET_FIELDS,
    { name: 'from_status', kind: 'string', required: true, description: 'The status before.' },
    { name: 'reason', kind: 'string', required: true, description: 'Why it changed.' },
  ]),
};

export const PLAN_ALLOCATED_ACTION: AuditActionDefinition = {
  action: 'value-plan.allocated',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'An obligation was allocated across several kinds of value.',
  resourceTypes: ['value-plan'],
  evidenceFields: internal(PLAN_FIELDS),
};

export const PLAN_COMMITTED_ACTION: AuditActionDefinition = {
  action: 'value-plan.committed',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'Every internal leg posted.',
  resourceTypes: ['value-plan'],
  evidenceFields: internal(PLAN_FIELDS),
};

export const PLAN_SETTLED_ACTION: AuditActionDefinition = {
  action: 'value-plan.settled',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'Every leg posted; the obligation is covered in full.',
  resourceTypes: ['value-plan'],
  evidenceFields: internal(PLAN_FIELDS),
};

export const PLAN_CANCELLED_ACTION: AuditActionDefinition = {
  action: 'value-plan.cancelled',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'Every posted leg was reversed.',
  resourceTypes: ['value-plan'],
  evidenceFields: internal([
    ...PLAN_FIELDS,
    { name: 'reason', kind: 'string', required: true, description: 'Why it was cancelled.' },
  ]),
};

export const LEG_POSTED_ACTION: AuditActionDefinition = {
  action: 'value-leg.posted',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'One leg moved value.',
  resourceTypes: ['value-leg'],
  evidenceFields: internal(LEG_FIELDS),
};

export const LEG_REVERSED_ACTION: AuditActionDefinition = {
  action: 'value-leg.reversed',
  owner: 'M-13',
  authority: 'business-authoritative',
  description: 'A posted leg was undone by a compensating transaction.',
  resourceTypes: ['value-leg'],
  evidenceFields: internal([
    ...LEG_FIELDS,
    {
      name: 'reversal_transaction_id',
      kind: 'string',
      required: true,
      description: 'The compensating K-10 transaction.',
    },
  ]),
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function walletPayload(wallet: Wallet, occurredAt: string, key: string): Record<string, string> {
  return {
    wallet_id: wallet.walletId,
    owner_account_id: wallet.ownerAccountId,
    asset_type_id: wallet.assetTypeId,
    purpose: wallet.purpose,
    ledger_account_id: wallet.ledgerAccountId,
    status: wallet.status,
    occurred_at: occurredAt,
    idempotency_key: key,
  };
}

/** The plan's totals, summed from its legs. Nothing here is read from a stored column. */
function planPayload(
  plan: ValuePlan,
  legs: readonly ValueLeg[],
  occurredAt: string,
  key: string,
): Record<string, string> {
  const sum = (kind: 'internal' | 'external'): bigint =>
    legs
      .filter((leg) => leg.kind === kind && leg.status !== 'reversed')
      .reduce((total, leg) => total + leg.settlementEquivalentMinor, 0n);

  return {
    plan_id: plan.planId,
    obligation_id: plan.obligationId,
    obligation_kind: plan.obligationKind,
    payer_account_id: plan.payerAccountId,
    payee_account_id: plan.payeeAccountId,
    status: plan.status,
    settlement_asset_type_id: plan.settlementAssetTypeId,
    target_amount_minor: String(plan.targetAmountMinor),
    internal_minor: String(sum('internal')),
    external_minor: String(sum('external')),
    leg_count: String(legs.length),
    occurred_at: occurredAt,
    idempotency_key: key,
  };
}

function legPayload(leg: ValueLeg, occurredAt: string, key: string): Record<string, string> {
  return {
    leg_id: leg.legId,
    plan_id: leg.planId,
    kind: leg.kind,
    status: leg.status,
    asset_type_id: leg.assetTypeId,
    amount_minor: String(leg.amountMinor),
    settlement_equivalent_minor: String(leg.settlementEquivalentMinor),
    rate_numerator: String(leg.rate.numerator),
    rate_denominator: String(leg.rate.denominator),
    source_wallet_id: leg.sourceWalletId ?? '',
    destination_wallet_id: leg.destinationWalletId,
    ledger_transaction_id: leg.ledgerTransactionId ?? '',
    occurred_at: occurredAt,
    idempotency_key: key,
  };
}

/**
 * Build one event entry.
 *
 * `factId` is the record that produced the fact — a wallet state record, a plan transition, a leg —
 * never the parent entity alone. One plan is allocated, committed and settled; an id derived from
 * the plan would collide with itself on the second fact, which is the bug M-01 shipped and
 * `outbox_pkey` refused.
 */
function eventEntry(
  factId: string,
  definition: EventTypeDefinition,
  payload: Record<string, string>,
  occurredAt: string,
  correlationId: string,
): OutboxEntry {
  const eventId = `${factId}:${definition.type}`;
  return eventOutboxEntry({
    outboxId: `M-13:${eventId}`,
    idempotencyKey: `M-13:${eventId}`,
    payload: {
      eventId,
      type: definition.type,
      schemaVersion: definition.schemaVersion,
      occurredAt,
      recordedAt: occurredAt,
      producer: 'M-13',
      correlationId,
      causationId: null,
      origin: 'system',
      actor: { kind: 'system', id: 'M-13' },
      idempotencyKey: `M-13:${eventId}`,
      now: occurredAt,
      payload,
    },
    occurredAt,
    recordedAt: occurredAt,
    producer: 'M-13',
    correlationId,
    causationId: null,
  });
}

function auditEntry(
  factId: string,
  definition: AuditActionDefinition,
  resourceType: string,
  resourceId: string,
  reason: string,
  evidence: Record<string, string>,
  occurredAt: string,
  correlationId: string,
): OutboxEntry {
  const recordId = `${factId}:${definition.action}`;
  const outboxId = `M-13:audit:${recordId}`;
  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: definition.action,
      recordedAt: occurredAt,
      actor: { kind: 'system', id: 'M-13', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-13', type: resourceType, id: resourceId },
      outcome: 'succeeded',
      reason,
      correlationId,
      causationId: null,
      idempotencyKey: outboxId,
      evidence,
    },
    recordedAt: occurredAt,
    producer: 'M-13',
    correlationId,
    causationId: null,
  });
}

/** The event and audit record for a newly opened wallet. */
export function makeWalletOpenedEntries(wallet: Wallet): readonly OutboxEntry[] {
  const payload = walletPayload(wallet, wallet.createdAt, wallet.idempotencyKey);
  return Object.freeze([
    eventEntry(
      wallet.walletId,
      WALLET_OPENED_EVENT,
      payload,
      wallet.createdAt,
      wallet.correlationId,
    ),
    auditEntry(
      wallet.walletId,
      WALLET_OPENED_ACTION,
      'wallet',
      wallet.walletId,
      `wallet ${wallet.walletId} was opened for ${wallet.purpose}`,
      payload,
      wallet.createdAt,
      wallet.correlationId,
    ),
  ]);
}

/** The event and audit record for a wallet status change, keyed on the transition record. */
export function makeWalletStatusEntries(
  wallet: Wallet,
  record: WalletStateRecord,
): readonly OutboxEntry[] {
  const payload = {
    ...walletPayload(wallet, record.occurredAt, record.idempotencyKey),
    from_status: record.fromStatus ?? '',
    reason: record.reason,
  };
  return Object.freeze([
    eventEntry(
      record.stateId,
      WALLET_STATUS_CHANGED_EVENT,
      payload,
      record.occurredAt,
      record.correlationId,
    ),
    auditEntry(
      record.stateId,
      WALLET_STATUS_CHANGED_ACTION,
      'wallet',
      wallet.walletId,
      record.reason,
      payload,
      record.occurredAt,
      record.correlationId,
    ),
  ]);
}

/** The event and audit record for a plan transition, keyed on the fact id the caller supplies. */
export function makePlanEntries(
  plan: ValuePlan,
  legs: readonly ValueLeg[],
  event: EventTypeDefinition,
  action: AuditActionDefinition,
  factId: string,
  occurredAt: string,
  extra: Record<string, string> = {},
): readonly OutboxEntry[] {
  const payload = { ...planPayload(plan, legs, occurredAt, plan.idempotencyKey), ...extra };
  return Object.freeze([
    eventEntry(factId, event, payload, occurredAt, plan.correlationId),
    auditEntry(
      factId,
      action,
      'value-plan',
      plan.planId,
      `plan ${plan.planId} is ${plan.status}`,
      payload,
      occurredAt,
      plan.correlationId,
    ),
  ]);
}

/** The event and audit record for one leg, keyed on the leg and the fact. */
export function makeLegEntries(
  leg: ValueLeg,
  event: EventTypeDefinition,
  action: AuditActionDefinition,
  occurredAt: string,
  extra: Record<string, string> = {},
): readonly OutboxEntry[] {
  const payload = { ...legPayload(leg, occurredAt, leg.idempotencyKey), ...extra };
  return Object.freeze([
    eventEntry(leg.legId, event, payload, occurredAt, leg.correlationId),
    auditEntry(
      leg.legId,
      action,
      'value-leg',
      leg.legId,
      `leg ${leg.legId} is ${leg.status}`,
      payload,
      occurredAt,
      leg.correlationId,
    ),
  ]);
}
