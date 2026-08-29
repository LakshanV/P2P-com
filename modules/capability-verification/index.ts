/**
 * M-02 Capability & Verification — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice.
 *
 * M-02 owns how far the platform has checked a claim, and the evidence behind that. It depends on
 * the platform substrate and K-03 Accounts (for identifier rules and the account reference). It does
 * not import any other business module.
 *
 * Owned by: M-02 Capability & Verification.
 */

export {
  CASE_STATUSES,
  EVIDENCE_KINDS,
  EVIDENCE_STATUSES,
  VERIFICATION_LEVELS,
  CapabilityVerificationError,
  compareVerificationLevels,
} from './types.ts';
export type {
  CaseStatus,
  Evidence,
  EvidenceKind,
  EvidenceStatus,
  LevelRecord,
  VerificationCase,
  VerificationLevel,
  CapabilityVerificationErrorCode,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertCapabilityVerificationIdentifier,
  assertCaseStatus,
  assertEvidenceKind,
  assertEvidenceStatus,
  assertVerificationLevel,
} from './registry.ts';

export {
  isEvidenceSealed,
  isLevelRecordSealed,
  isVerificationCaseSealed,
  sealEvidence,
  sealEvidences,
  sealLevelRecord,
  sealLevelRecords,
  sealVerificationCase,
  sealVerificationCases,
} from './immutable.ts';

export { validateEvidence, validateLevelRecord, validateVerificationCase } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { CapabilityVerificationService } from './service.ts';
export type {
  EvaluateLevelRequest,
  EvaluateLevelResult,
  RejectVerificationRequest,
  RejectVerificationResult,
  StartVerificationRequest,
  StartVerificationResult,
  SubmitEvidenceRequest,
  SubmitEvidenceResult,
} from './service.ts';

export { InMemoryCapabilityVerificationRepository } from './repository.ts';
export type {
  CapabilityVerificationRepository,
  CapabilityVerificationTransaction,
} from './repository.ts';

export {
  CAPABILITY_VERIFICATION_SCHEMA,
  EVIDENCE_TABLE,
  EnlistedCapabilityVerificationRepository,
  LEVEL_RECORD_TABLE,
  OUTBOX_TABLE,
  PostgresCapabilityVerificationRepository,
  TIMESTAMP_COLUMNS,
  VERIFICATION_CASE_TABLE,
  enlistedClient,
  toEvidence,
  toLevelRecord,
  toVerificationCase,
} from './postgres-repository.ts';

export {
  EVIDENCE_SUBMITTED_ACTION,
  EVIDENCE_SUBMITTED_EVENT,
  LEVEL_CHANGED_ACTION,
  LEVEL_CHANGED_EVENT,
  SELLER_VERIFIED_ACTION,
  SELLER_VERIFIED_EVENT,
  VERIFICATION_REJECTED_ACTION,
  VERIFICATION_REJECTED_EVENT,
  VERIFICATION_STARTED_ACTION,
  VERIFICATION_STARTED_EVENT,
  makeEvidenceSubmittedAction,
  makeEvidenceSubmittedEvent,
  makeLevelChangedAction,
  makeLevelChangedEvent,
  makeSellerVerifiedAction,
  makeSellerVerifiedEvent,
  makeVerificationRejectedAction,
  makeVerificationRejectedEvent,
  makeVerificationStartedAction,
  makeVerificationStartedEvent,
} from './outbox.ts';
