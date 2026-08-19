/**
 * K-01 Identity — public surface (FND-004a).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/identity/CONTRACT.md for the contract this fixes.
 *
 * There is deliberately no login, no password, no session, no account, no capability and no
 * profile. Each of those belongs to a named component — K-02 Authentication, K-04 Permissions and
 * the Capability & Verification module do not exist yet; **K-03 Accounts does** — and putting any
 * of them here would make the identity layer the thing every one of them was supposed to be
 * separate from. A request that carries one is refused by name rather than ignored.
 *
 * **K-03 Accounts is this component's first consumer, and it is implemented** (FND-004b). It asks
 * one question — does this subject exist — through `IdentityService.exists`, which satisfies its
 * `SubjectLookup` port structurally. There is no foreign key into `kernel_identity` and no SQL of
 * K-03's that reaches it; the coupling is that one method and nothing else.
 *
 * Two things remain deferred, and the distinction matters:
 *
 *   - **No caller creates an identity subject.** K-03 *reads* through the port; nothing in the
 *     platform *writes* a subject, because there is no registration path and no API.
 *   - **Transactional registration is not delivered.** Creating a subject and opening its account
 *     in one transaction — through K-01's and K-03's enlisted paths, so a party is never left with
 *     an identity and no account or the reverse — is the obvious next integration and is
 *     undelivered. The capability exists on both sides; nothing uses it.
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

export { validateSubject } from './validate.ts';
export type { SubjectSource } from './validate.ts';

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
