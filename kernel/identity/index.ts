/**
 * K-01 Identity — public surface (FND-004a).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/identity/CONTRACT.md for the contract this fixes.
 *
 * There is deliberately no login, no password, no session, no account, no capability and no
 * profile. Each of those belongs to a named component that does not exist yet — K-02
 * Authentication, K-03 Accounts, K-04 Permissions, and the Capability & Verification module — and
 * putting any of them here would make the identity layer the thing every one of them was supposed
 * to be separate from. A request that carries one is refused by name rather than ignored.
 *
 * **No unit creates an identity subject yet.** This slice delivers the mechanism; K-03 will be its
 * first consumer, through the transaction-enlisted path, so that an account and its subject commit
 * together. That is a deferred integration, not a missing dependency.
 */

export {
  IdentityError,
  ORIGIN_KINDS,
  SUBJECT_KINDS,
  type IdentityErrorCode,
  type IdentityOrigin,
  type IdentitySubject,
  type OriginKind,
  type SubjectKind,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  NATURAL_IDENTIFIER_PATTERNS,
  SECRET_FRAGMENTS,
  SECRET_VALUE_PATTERNS,
  SUBJECT_KIND_DEFINITIONS,
  assertOpaqueIdentifier,
  isSubjectKind,
  requireSubjectKind,
  type SubjectKindDefinition,
} from './registry.ts';

export { isSealed, sealOrigin, sealSubject, sealSubjects } from './immutable.ts';

export { IdentityService } from './service.ts';
export type { CreateSubjectRequest, CreateSubjectResult } from './service.ts';

export { InMemoryIdentityRepository } from './repository.ts';
export type { IdentityRepository, IdentityTransaction } from './repository.ts';

export {
  EnlistedIdentityRepository,
  IDENTITY_SCHEMA,
  IDENTITY_TABLE,
  PostgresIdentityRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toSubject,
} from './postgres-repository.ts';
