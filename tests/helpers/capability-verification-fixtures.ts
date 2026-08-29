/**
 * Shared fixtures for the M-02 Capability & Verification suites.
 *
 * Every identifier and every instant is supplied here rather than read from a clock, so a replayed
 * request produces a byte-identical record and the suites need no fake timers.
 */

import {
  CapabilityVerificationService,
  InMemoryCapabilityVerificationRepository,
  type EvaluateLevelRequest,
  type Evidence,
  type LevelRecord,
  type RejectVerificationRequest,
  type StartVerificationRequest,
  type SubmitEvidenceRequest,
  type VerificationCase,
} from '../../modules/capability-verification/index.ts';

export interface Harness {
  readonly service: CapabilityVerificationService;
  readonly repository: InMemoryCapabilityVerificationRepository;
}

export function build(): Harness {
  const repository = new InMemoryCapabilityVerificationRepository();
  return { service: new CapabilityVerificationService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

/** A stable account id, so several cases can be opened against one account. */
export const ACCOUNT = 'acct_01HQZVA0001';

export function startRequest(
  overrides: Partial<StartVerificationRequest> = {},
): StartVerificationRequest {
  const n = seq();
  return {
    caseId: `case_01HQZVA${n}`,
    accountId: ACCOUNT,
    purpose: 'seller-onboarding',
    requestedLevel: 'standard',
    attributes: {},
    openedAt: '2026-05-01T09:00:00Z',
    createdAt: '2026-05-01T09:00:00Z',
    updatedAt: '2026-05-01T09:00:00Z',
    correlationId: `corr_01HQZVA${n}`,
    idempotencyKey: `idem_start_${n}`,
    recordId: `rec_01HQZVA${n}`,
    reason: 'the account began seller onboarding',
    ...overrides,
  };
}

export function evidenceRequest(
  caseId: string,
  overrides: Partial<SubmitEvidenceRequest> = {},
): SubmitEvidenceRequest {
  const n = seq();
  return {
    evidenceId: `evid_01HQZVE${n}`,
    caseId,
    kind: 'identity-document',
    reference: `docref_01HQZVE${n}`,
    note: 'national identity document, front and back',
    submittedAt: '2026-05-02T09:00:00Z',
    caseUpdatedAt: '2026-05-02T09:00:00Z',
    correlationId: `corr_01HQZVE${n}`,
    idempotencyKey: `idem_evid_${n}`,
    ...overrides,
  };
}

export function evaluateRequest(
  caseId: string,
  overrides: Partial<EvaluateLevelRequest> = {},
): EvaluateLevelRequest {
  const n = seq();
  return {
    caseId,
    level: 'standard',
    reason: 'identity document accepted by the reviewer',
    occurredAt: '2026-05-03T09:00:00Z',
    decidedAt: '2026-05-03T09:00:00Z',
    updatedAt: '2026-05-03T09:00:00Z',
    correlationId: `corr_01HQZVL${n}`,
    idempotencyKey: `idem_eval_${n}`,
    recordId: `rec_01HQZVL${n}`,
    ...overrides,
  };
}

export function rejectRequest(
  caseId: string,
  overrides: Partial<RejectVerificationRequest> = {},
): RejectVerificationRequest {
  const n = seq();
  return {
    caseId,
    decidedAt: '2026-05-04T09:00:00Z',
    updatedAt: '2026-05-04T09:00:00Z',
    correlationId: `corr_01HQZVR${n}`,
    idempotencyKey: `idem_rej_${n}`,
    recordId: `rec_01HQZVR${n}`,
    reason: 'the document supplied did not match the account holder',
    ...overrides,
  };
}

export function caseRecord(overrides: Partial<VerificationCase> = {}): VerificationCase {
  const n = seq();
  return {
    caseId: `case_01HQZVC${n}`,
    accountId: ACCOUNT,
    purpose: 'seller-onboarding',
    status: 'open',
    requestedLevel: 'standard',
    achievedLevel: 'none',
    openedAt: '2026-05-01T09:00:00Z',
    decidedAt: null,
    attributes: {},
    createdAt: '2026-05-01T09:00:00Z',
    updatedAt: '2026-05-01T09:00:00Z',
    correlationId: `corr_01HQZVC${n}`,
    idempotencyKey: `idem_case_${n}`,
    ...overrides,
  };
}

export function evidenceRecord(overrides: Partial<Evidence> = {}): Evidence {
  const n = seq();
  return {
    evidenceId: `evid_01HQZVD${n}`,
    caseId: `case_01HQZVD${n}`,
    accountId: ACCOUNT,
    kind: 'identity-document',
    status: 'submitted',
    reference: `docref_01HQZVD${n}`,
    note: 'national identity document',
    submittedAt: '2026-05-02T09:00:00Z',
    correlationId: `corr_01HQZVD${n}`,
    idempotencyKey: `idem_evrec_${n}`,
    ...overrides,
  };
}

export function levelRecord(overrides: Partial<LevelRecord> = {}): LevelRecord {
  const n = seq();
  return {
    recordId: `rec_01HQZVM${n}`,
    caseId: `case_01HQZVM${n}`,
    accountId: ACCOUNT,
    fromLevel: null,
    toLevel: 'none',
    reason: 'case opened',
    occurredAt: '2026-05-01T09:00:00Z',
    correlationId: `corr_01HQZVM${n}`,
    idempotencyKey: `idem_lvl_${n}`,
    ...overrides,
  };
}

/** The outbox entries of one kind, oldest first, as the relay would read them. */
export function entriesOfKind(
  repository: InMemoryCapabilityVerificationRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}

/** The `type` of every event entry, oldest first. */
export function eventTypes(
  repository: InMemoryCapabilityVerificationRepository,
): readonly string[] {
  return entriesOfKind(repository, 'event').map(
    (entry) => (entry.payload as { type: string }).type,
  );
}
