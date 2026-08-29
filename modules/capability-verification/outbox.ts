/**
 * M-02 Capability & Verification — outbox event and audit definitions.
 *
 * These definitions describe the facts M-02 publishes when a verification case is opened, evidence
 * is submitted, a level changes, or a seller-onboarding case is approved at standard or above. They
 * are declared separately from the service so a relay can register them without importing M-02
 * internals.
 *
 * Owned by: M-02 Capability & Verification.
 */

import type {
  AuditActionDefinition,
  EvidenceField,
} from '../../kernel/audit-foundation/registry.ts';
import { auditOutboxEntry, eventOutboxEntry } from '../../platform/outbox/builder.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';
import type {
  EventTypeDefinition,
  PayloadField,
} from '../../kernel/event-infrastructure/registry.ts';

import type { Evidence, LevelRecord, VerificationCase } from './types.ts';

export const VERIFICATION_STARTED_EVENT: EventTypeDefinition = {
  type: 'verification.started',
  schemaVersion: 1,
  owner: 'M-02',
  description: 'A verification case was opened.',
  payloadFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'purpose',
      kind: 'string',
      required: true,
      description: 'What the verification is for.',
    },
    {
      name: 'requested_level',
      kind: 'string',
      required: true,
      description: 'The level the case is trying to reach.',
    },
    {
      name: 'opened_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the case was opened.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when opening the case.',
    },
  ] satisfies PayloadField[],
};

export const EVIDENCE_SUBMITTED_EVENT: EventTypeDefinition = {
  type: 'verification.evidence_submitted',
  schemaVersion: 1,
  owner: 'M-02',
  description: 'A piece of evidence was submitted against a verification case.',
  payloadFields: [
    {
      name: 'evidence_id',
      kind: 'string',
      required: true,
      description: 'The evidence identifier.',
    },
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      description: 'The verification case the evidence belongs to.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account the evidence belongs to.',
    },
    {
      name: 'kind',
      kind: 'string',
      required: true,
      description: 'The kind of evidence submitted.',
    },
    {
      name: 'submitted_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the evidence was submitted.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when submitting the evidence.',
    },
  ] satisfies PayloadField[],
};

export const LEVEL_CHANGED_EVENT: EventTypeDefinition = {
  type: 'verification.level_changed',
  schemaVersion: 1,
  owner: 'M-02',
  description: 'The verification level reached by a case changed.',
  payloadFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'from_level',
      kind: 'string',
      required: false,
      description: 'The previous level; null for the first change.',
    },
    {
      name: 'to_level',
      kind: 'string',
      required: true,
      description: 'The new level.',
    },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the level changed.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when recording the change.',
    },
  ] satisfies PayloadField[],
};

/**
 * A rejection changes no level, so it produces no level record and cannot be reported by
 * `verification.level_changed`. It is nevertheless the most consequential thing that can happen to
 * a case: an account was refused. Without its own event a rejection would be silent, and the only
 * trace of it would be a status column nobody is subscribed to.
 */
export const VERIFICATION_REJECTED_EVENT: EventTypeDefinition = {
  type: 'verification.rejected',
  schemaVersion: 1,
  owner: 'M-02',
  description: 'A verification case was closed as rejected.',
  payloadFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'purpose',
      kind: 'string',
      required: true,
      description: 'What the verification was for.',
    },
    {
      name: 'achieved_level',
      kind: 'string',
      required: true,
      description: 'The level the case had reached when it was rejected; unchanged by rejection.',
    },
    {
      name: 'decided_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the case was rejected.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      description: 'Why the case was rejected.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when rejecting the case.',
    },
  ] satisfies PayloadField[],
};

export const SELLER_VERIFIED_EVENT: EventTypeDefinition = {
  type: 'seller.verified',
  schemaVersion: 1,
  owner: 'M-02',
  description: 'A seller-onboarding verification case was approved at standard or above.',
  payloadFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      description: 'The universal account that was verified as a seller.',
    },
    {
      name: 'achieved_level',
      kind: 'string',
      required: true,
      description: 'The level reached at approval.',
    },
    {
      name: 'decided_at',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant when the case was approved.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      description: 'The idempotency key supplied when approving the case.',
    },
  ] satisfies PayloadField[],
};

export const VERIFICATION_STARTED_ACTION: AuditActionDefinition = {
  action: 'verification.started',
  owner: 'M-02',
  authority: 'business-authoritative',
  description: 'A verification case was opened.',
  resourceTypes: ['verification_case'],
  evidenceFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'purpose',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'What the verification is for.',
    },
    {
      name: 'requested_level',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The level the case is trying to reach.',
    },
    {
      name: 'opened_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the case was opened.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when opening the case.',
    },
  ] satisfies EvidenceField[],
};

export const EVIDENCE_SUBMITTED_ACTION: AuditActionDefinition = {
  action: 'verification.evidence_submitted',
  owner: 'M-02',
  authority: 'business-authoritative',
  description: 'A piece of evidence was submitted against a verification case.',
  resourceTypes: ['evidence'],
  evidenceFields: [
    {
      name: 'evidence_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The evidence identifier.',
    },
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The verification case the evidence belongs to.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account the evidence belongs to.',
    },
    {
      name: 'kind',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The kind of evidence submitted.',
    },
    {
      name: 'submitted_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the evidence was submitted.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when submitting the evidence.',
    },
  ] satisfies EvidenceField[],
};

export const LEVEL_CHANGED_ACTION: AuditActionDefinition = {
  action: 'verification.level_changed',
  owner: 'M-02',
  authority: 'business-authoritative',
  description: 'The verification level reached by a case changed.',
  resourceTypes: ['verification_case'],
  evidenceFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'from_level',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The previous level; null for the first change.',
    },
    {
      name: 'to_level',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The new level.',
    },
    {
      name: 'occurred_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the level changed.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when recording the change.',
    },
  ] satisfies EvidenceField[],
};

export const VERIFICATION_REJECTED_ACTION: AuditActionDefinition = {
  action: 'verification.rejected',
  owner: 'M-02',
  authority: 'business-authoritative',
  description: 'A verification case was closed as rejected.',
  resourceTypes: ['verification_case'],
  evidenceFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account the case belongs to.',
    },
    {
      name: 'purpose',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'What the verification was for.',
    },
    {
      name: 'achieved_level',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The level the case had reached when it was rejected.',
    },
    {
      name: 'decided_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the case was rejected.',
    },
    {
      name: 'reason',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Why the case was rejected.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when rejecting the case.',
    },
  ] satisfies EvidenceField[],
};

export const SELLER_VERIFIED_ACTION: AuditActionDefinition = {
  action: 'seller.verified',
  owner: 'M-02',
  authority: 'business-authoritative',
  description: 'A seller-onboarding verification case was approved at standard or above.',
  resourceTypes: ['verification_case'],
  evidenceFields: [
    {
      name: 'case_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The verification case identifier.',
    },
    {
      name: 'account_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The universal account that was verified as a seller.',
    },
    {
      name: 'achieved_level',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The level reached at approval.',
    },
    {
      name: 'decided_at',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'ISO-8601 instant when the case was approved.',
    },
    {
      name: 'idempotency_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The idempotency key supplied when approving the case.',
    },
  ] satisfies EvidenceField[],
};

/**
 * The event reporting that a verification case was opened.
 *
 * The outbox id is derived from the **level record** produced by opening the case, not from the
 * case id. A case produces multiple facts over its life, and an id derived from the case id alone
 * would collide with itself on the next fact.
 */
export function makeVerificationStartedEvent(
  verificationCase: VerificationCase,
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${record.recordId}:started`;
  const recordedAt = verificationCase.openedAt;

  return eventOutboxEntry({
    outboxId: `M-02:${eventId}`,
    idempotencyKey: `M-02:${eventId}`,
    payload: {
      eventId,
      type: VERIFICATION_STARTED_EVENT.type,
      schemaVersion: VERIFICATION_STARTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-02',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-02' },
      idempotencyKey: `M-02:${eventId}`,
      now: recordedAt,
      payload: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        purpose: verificationCase.purpose,
        requested_level: verificationCase.requestedLevel,
        opened_at: verificationCase.openedAt,
        idempotency_key: verificationCase.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a piece of evidence was submitted.
 *
 * The outbox id is derived from the evidence id, because one case may have many evidence submissions
 * and each is a distinct fact.
 */
export function makeEvidenceSubmittedEvent(
  evidence: Evidence,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${evidence.evidenceId}:submitted`;
  const recordedAt = evidence.submittedAt;

  return eventOutboxEntry({
    outboxId: `M-02:${eventId}`,
    idempotencyKey: `M-02:${eventId}`,
    payload: {
      eventId,
      type: EVIDENCE_SUBMITTED_EVENT.type,
      schemaVersion: EVIDENCE_SUBMITTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-02',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-02' },
      idempotencyKey: `M-02:${eventId}`,
      now: recordedAt,
      payload: {
        evidence_id: evidence.evidenceId,
        case_id: evidence.caseId,
        account_id: evidence.accountId,
        kind: evidence.kind,
        submitted_at: evidence.submittedAt,
        idempotency_key: evidence.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a case's achieved level changed.
 *
 * The outbox id is derived from the level record, not from the case. The same case may change level
 * several times, and each change is a separate fact.
 */
export function makeLevelChangedEvent(
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${record.recordId}:level_changed`;
  const recordedAt = record.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-02:${eventId}`,
    idempotencyKey: `M-02:${eventId}`,
    payload: {
      eventId,
      type: LEVEL_CHANGED_EVENT.type,
      schemaVersion: LEVEL_CHANGED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-02',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-02' },
      idempotencyKey: `M-02:${eventId}`,
      now: recordedAt,
      payload: {
        case_id: record.caseId,
        account_id: record.accountId,
        from_level: record.fromLevel,
        to_level: record.toLevel,
        occurred_at: record.occurredAt,
        idempotency_key: record.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a seller-onboarding case was approved at standard or above.
 *
 * The outbox id is derived from the level record that produced the approval, so a case approved
 * once emits exactly one seller.verified fact.
 */
export function makeSellerVerifiedEvent(
  verificationCase: VerificationCase,
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const eventId = `${record.recordId}:seller_verified`;
  const recordedAt = verificationCase.decidedAt ?? record.occurredAt;

  return eventOutboxEntry({
    outboxId: `M-02:${eventId}`,
    idempotencyKey: `M-02:${eventId}`,
    payload: {
      eventId,
      type: SELLER_VERIFIED_EVENT.type,
      schemaVersion: SELLER_VERIFIED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-02',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-02' },
      idempotencyKey: `M-02:${eventId}`,
      now: recordedAt,
      payload: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        achieved_level: verificationCase.achievedLevel,
        decided_at: verificationCase.decidedAt ?? record.occurredAt,
        idempotency_key: record.idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/** The audit record for one opened case, keyed by the level record for the reason given above. */
export function makeVerificationStartedAction(
  verificationCase: VerificationCase,
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${record.recordId}:started`;
  const outboxId = `M-02:audit:${recordId}`;
  const recordedAt = verificationCase.openedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: VERIFICATION_STARTED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-02', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-02', type: 'verification_case', id: verificationCase.caseId },
      outcome: 'succeeded',
      reason: `verification case ${verificationCase.caseId} opened for ${verificationCase.purpose}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        purpose: verificationCase.purpose,
        requested_level: verificationCase.requestedLevel,
        opened_at: verificationCase.openedAt,
        idempotency_key: verificationCase.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/** The audit record for one evidence submission. */
export function makeEvidenceSubmittedAction(
  evidence: Evidence,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${evidence.evidenceId}:submitted`;
  const outboxId = `M-02:audit:${recordId}`;
  const recordedAt = evidence.submittedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: EVIDENCE_SUBMITTED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-02', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-02', type: 'evidence', id: evidence.evidenceId },
      outcome: 'succeeded',
      reason: `evidence ${evidence.evidenceId} submitted for case ${evidence.caseId}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        evidence_id: evidence.evidenceId,
        case_id: evidence.caseId,
        account_id: evidence.accountId,
        kind: evidence.kind,
        submitted_at: evidence.submittedAt,
        idempotency_key: evidence.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/** The audit record for one level change, keyed by the level record. */
export function makeLevelChangedAction(
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${record.recordId}:level_changed`;
  const outboxId = `M-02:audit:${recordId}`;
  const recordedAt = record.occurredAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: LEVEL_CHANGED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-02', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-02', type: 'verification_case', id: record.caseId },
      outcome: 'succeeded',
      reason: `verification case ${record.caseId} changed level from ${record.fromLevel ?? 'none'} to ${record.toLevel}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        case_id: record.caseId,
        account_id: record.accountId,
        from_level: record.fromLevel,
        to_level: record.toLevel,
        occurred_at: record.occurredAt,
        idempotency_key: record.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/** The audit record for a seller-onboarding approval, keyed by the level record that produced it. */
export function makeSellerVerifiedAction(
  verificationCase: VerificationCase,
  record: LevelRecord,
  correlationId: string,
  causationId: string | null,
): OutboxEntry {
  const recordId = `${record.recordId}:seller_verified`;
  const outboxId = `M-02:audit:${recordId}`;
  const recordedAt = verificationCase.decidedAt ?? record.occurredAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: SELLER_VERIFIED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-02', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-02', type: 'verification_case', id: verificationCase.caseId },
      outcome: 'succeeded',
      reason: `seller-onboarding case ${verificationCase.caseId} approved at ${verificationCase.achievedLevel}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        achieved_level: verificationCase.achievedLevel,
        decided_at: verificationCase.decidedAt ?? record.occurredAt,
        idempotency_key: record.idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/**
 * The event reporting that a case was rejected.
 *
 * A rejection produces no level record, so there is no append-only row to derive an id from. The
 * caller's `recordId` — the one it would have used had the level changed — is the id instead: it is
 * caller-supplied, opaque and unique per decision, which is what `outbox_pkey` requires.
 */
export function makeVerificationRejectedEvent(
  verificationCase: VerificationCase,
  decisionId: string,
  reason: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const eventId = `${decisionId}:rejected`;
  const recordedAt = verificationCase.decidedAt ?? verificationCase.updatedAt;

  return eventOutboxEntry({
    outboxId: `M-02:${eventId}`,
    idempotencyKey: `M-02:${eventId}`,
    payload: {
      eventId,
      type: VERIFICATION_REJECTED_EVENT.type,
      schemaVersion: VERIFICATION_REJECTED_EVENT.schemaVersion,
      occurredAt: recordedAt,
      recordedAt,
      producer: 'M-02',
      correlationId,
      causationId,
      origin: 'system',
      actor: { kind: 'system', id: 'M-02' },
      idempotencyKey: `M-02:${eventId}`,
      now: recordedAt,
      payload: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        purpose: verificationCase.purpose,
        achieved_level: verificationCase.achievedLevel,
        decided_at: recordedAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    occurredAt: recordedAt,
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}

/** The audit record for one rejection, keyed by the decision for the reason given above. */
export function makeVerificationRejectedAction(
  verificationCase: VerificationCase,
  decisionId: string,
  reason: string,
  correlationId: string,
  causationId: string | null,
  idempotencyKey: string,
): OutboxEntry {
  const recordId = `${decisionId}:rejected`;
  const outboxId = `M-02:audit:${recordId}`;
  const recordedAt = verificationCase.decidedAt ?? verificationCase.updatedAt;

  return auditOutboxEntry({
    outboxId,
    idempotencyKey: outboxId,
    payload: {
      recordId,
      action: VERIFICATION_REJECTED_ACTION.action,
      recordedAt,
      actor: { kind: 'system', id: 'M-02', authentication: 'unauthenticated', sessionId: null },
      resource: { owner: 'M-02', type: 'verification_case', id: verificationCase.caseId },
      outcome: 'succeeded',
      reason: `case ${verificationCase.caseId} rejected: ${reason}`,
      correlationId,
      causationId,
      idempotencyKey: outboxId,
      evidence: {
        case_id: verificationCase.caseId,
        account_id: verificationCase.accountId,
        purpose: verificationCase.purpose,
        achieved_level: verificationCase.achievedLevel,
        decided_at: recordedAt,
        reason,
        idempotency_key: idempotencyKey,
      },
    },
    recordedAt,
    producer: 'M-02',
    correlationId,
    causationId,
  });
}
