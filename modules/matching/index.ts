/**
 * M-07 Matching — the public surface.
 *
 * Owned by: M-07 Matching.
 */

export {
  CANDIDATE_KINDS,
  MatchingError,
  RUNG_OUTCOMES,
  RUN_OUTCOMES,
  SOURCING_RUNGS,
} from './types.ts';
export type {
  CandidateKind,
  MatchCandidate,
  MatchRun,
  MatchingErrorCode,
  RunOutcome,
  RungAttempt,
  RungOutcome,
  SourcingRung,
} from './types.ts';

export { NOT_CONFIGURED } from './ports.ts';
export { catalogueRung } from './rungs/catalogue-rung.ts';
export { knownSupplierRung, verifiedSupplierRung } from './rungs/supplier-rungs.ts';
export type {
  SupplierDirectory,
  SupplierProfile,
  SupplierRungOptions,
} from './rungs/supplier-rungs.ts';
export {
  externalDiscoveryRung,
  failingExternalDiscovery,
  mockExternalDiscovery,
} from './rungs/external-discovery.ts';
export type {
  ExternalDiscoveryOptions,
  ExternalSupplierDiscoveryProvider,
  SupplierLead,
} from './rungs/external-discovery.ts';
export type {
  CatalogueEntry,
  CatalogueRungOptions,
  CatalogueSource,
} from './rungs/catalogue-rung.ts';
export type { RungCandidate, SourcingQuery, SourcingRungPort } from './ports.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  MINIMUM_EXPLANATION_LENGTH,
  assertCandidateKind,
  assertExplanation,
  assertMatchingIdentifier,
  assertRunOutcome,
  assertRungOutcome,
  assertScore,
  assertSourcingRung,
} from './registry.ts';

export {
  STORED_ROW_NOTE,
  validateCandidate,
  validateMatchRun,
  validateRungAttempt,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export {
  sealCandidate,
  sealCandidates,
  sealMatchRun,
  sealMatchRuns,
  sealRungAttempt,
  sealRungAttempts,
} from './immutable.ts';

export { DEFAULT_SUFFICIENCY_PER_MILLE, MatchingService } from './service.ts';
export type { RunLadderRequest, RunLadderResult, RungPorts } from './service.ts';

export { InMemoryMatchingRepository } from './repository.ts';
export type { MatchingRepository, MatchingTransaction } from './repository.ts';

export { ESCALATE_TO_RFQ_EVENT, MATCH_FOUND_EVENT, MATCH_RUN_ACTION } from './outbox.ts';

export {
  EnlistedMatchingRepository,
  MATCHING_SCHEMA,
  MATCH_CANDIDATE_TABLE,
  MATCH_RUN_TABLE,
  PostgresMatchingRepository,
  RUNG_ATTEMPT_TABLE,
  toCandidate,
  toMatchRun,
  toRungAttempt,
} from './postgres-repository.ts';
