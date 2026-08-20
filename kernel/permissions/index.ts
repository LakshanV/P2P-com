/**
 * K-04 Permissions — public surface (FND-004d).
 *
 * Everything another unit may depend on is re-exported here; see kernel/permissions/CONTRACT.md
 * for the contract this fixes.
 *
 * **This component decides from grants it stored itself, and never from what the caller says.** A
 * request carrying `subjectId`, `role`, `permissions`, `purposeSatisfied` or `allowed` is refused
 * by name. That is the one thing to understand about it: everything else — policy versions,
 * grants, revocations, decision records — is bookkeeping around a deny-by-default evaluation whose
 * inputs are a session K-02 validated and an account K-03 owns.
 *
 * **No API and no UI ship in this slice**, and no business module registers an action, so the
 * registered vocabulary is the kernel's own. Nothing calls `authorize` yet: it is a capability,
 * not an integration. K-09 audit and K-08 events are not wired, which means **a permission
 * decision records nothing to the audit trail and publishes no event** — the two integrations most
 * obviously wanted next, and the two most conspicuous by their absence given that v3 §53 lists
 * permission changes as auditable.
 */

export {
  ASSURANCE_LEVELS,
  ASSURANCE_RANK,
  DECISION_REASONS,
  EFFECTS,
  PURPOSES,
  PermissionError,
  REVOCATION_REASONS,
  ROLES,
  STAFF_ROLES,
  isStaffRole,
  type AssuranceLevel,
  type Capability,
  type Decision,
  type DecisionReason,
  type Effect,
  type Grant,
  type Origin,
  type PermissionErrorCode,
  type PolicyVersion,
  type Predicate,
  type Purpose,
  type Revocation,
  type Role,
  type RoleDefinition,
} from './types.ts';

export {
  ACTIONS,
  AI_FORBIDDEN_ACTIONS,
  AI_FORBIDDEN_RESOURCES,
  ASSERTED_AUTHORIZATION_FIELDS,
  CONTEXT_KEYS,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  RESOURCE_TYPES,
  assertAction,
  assertAiMayHold,
  assertContext,
  assertPermissionIdentifier,
  assertPredicate,
  assertPurpose,
  assertResourceType,
  assertRole,
} from './registry.ts';

export { NO_ACCOUNTS, NO_SESSIONS } from './ports.ts';
export type {
  AccountAssertion,
  AccountLookup,
  Clock,
  SessionAssertion,
  SessionValidator,
} from './ports.ts';

export {
  isSealed,
  sealDecision,
  sealDecisions,
  sealGrant,
  sealGrants,
  sealPolicyVersion,
  sealPredicate,
  sealRevocation,
  sealRevocations,
} from './immutable.ts';

export {
  REQUEST_FINGERPRINT,
  canonicalDecisionRequest,
  fingerprintDecisionRequest,
} from './fingerprint.ts';
export type { DecisionRequestFacts } from './fingerprint.ts';

export { evaluate, evaluatePredicate } from './decide.ts';
export type { Evaluation, EvaluationInput } from './decide.ts';

export {
  inStoredRow,
  validateDecision,
  validateGrant,
  validatePolicyVersion,
  validateRevocation,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export { PermissionService, requiresPurpose } from './service.ts';
export type {
  AuthorizeRequest,
  AuthorizeResult,
  GrantRequest,
  PublishPolicyRequest,
  RevokeRequest,
} from './service.ts';

export { InMemoryPermissionRepository } from './repository.ts';
export type { PermissionRepository, PermissionTransaction } from './repository.ts';

export {
  DECISION_TABLE,
  EnlistedPermissionRepository,
  GRANT_TABLE,
  PERMISSIONS_SCHEMA,
  POLICY_TABLE,
  PostgresPermissionRepository,
  REVOCATION_TABLE,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toDecision,
  toGrant,
  toPolicyVersion,
  toRevocation,
} from './postgres-repository.ts';
