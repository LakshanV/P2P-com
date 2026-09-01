/**
 * K-02 Authentication — public surface (FND-004c).
 *
 * Everything another unit may depend on is re-exported here; see kernel/authentication/CONTRACT.md
 * for the contract this fixes.
 *
 * **This component authenticates by asking a verifier, never by believing a caller.** A request
 * that carries `authenticated`, `factors`, `assurance` or an assertion is refused by name. That is
 * the one thing to understand about it: everything else — bindings, evidence, sessions, rotation,
 * revocation — is bookkeeping around a decision made behind an injected port.
 *
 * **No verifier ships in this slice.** No password checking, no OAuth SDK, no passkey library, no
 * email or SMS delivery. A provider with no verifier wired cannot authenticate, and refuses rather
 * than treating an unverifiable proof as verified — so nothing here can currently authenticate a
 * real person, and the contract says so plainly.
 *
 * Also absent, and belonging elsewhere: registration (nothing creates subjects or accounts),
 * permissions (K-04 — authentication is not authorisation), profiles and capabilities, recovery
 * flows, API and UI. K-09 audit and K-08 events are not wired: **signing in records nothing to the
 * audit trail and publishes no event**, which are the two integrations most obviously wanted next.
 */

export {
  ASSURANCE_LEVELS,
  ASSURANCE_RANK,
  AuthenticationError,
  FACTOR_CATEGORIES,
  REVOCATION_REASONS,
  type AssuranceLevel,
  type AuthenticationBinding,
  type AuthenticationErrorCode,
  type AuthenticationEvidence,
  type AuthenticationSession,
  type FactorCategory,
  type RevocationReason,
} from './types.ts';

export {
  ASSERTED_AUTHENTICATION_FIELDS,
  DEFAULT_MFA_POLICY,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  ProviderRegistry,
  assertAuthIdentifier,
  satisfiesPolicy,
  type MfaPolicy,
  type ProviderDefinition,
} from './registry.ts';

export { NO_SUBJECTS, refusingVerifier } from './ports.ts';
export type {
  Clock,
  EntropySource,
  SubjectLookup,
  Verifier,
  VerifierAssertion,
  VerifierChallenge,
} from './ports.ts';

export { REDACTED, SessionToken, TOKEN_HASH, hashToken, hashesEqual } from './tokens.ts';

export {
  isSealed,
  sealBinding,
  sealBindings,
  sealEvidence,
  sealFactors,
  sealSession,
  sealSessions,
} from './immutable.ts';

export { validateBinding, validateEvidence, validateSession } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { AuthenticationService, DEFAULT_SESSION_POLICY } from './service.ts';
export type {
  AuthenticateRequest,
  AuthenticateResult,
  BindRequest,
  RevokeRequest,
  RotateRequest,
  RotateResult,
  SessionPolicy,
} from './service.ts';

export { InMemoryAuthenticationRepository } from './repository.ts';
export type {
  AuthenticationRepository,
  AuthenticationTransaction,
  RevocationCommand,
  RotationCommand,
} from './repository.ts';

export {
  AUTH_SCHEMA,
  BINDING_TABLE,
  EVIDENCE_TABLE,
  EnlistedAuthenticationRepository,
  PostgresAuthenticationRepository,
  SESSION_TABLE,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toBinding,
  toEvidence,
  toSession,
} from './postgres-repository.ts';

export { MockVerifier } from './verifiers/index.ts';
export type { ClockSupplier, MockVerifierOptions, ProofPredicate } from './verifiers/index.ts';

/**
 * The password verifier: the first thing in this repository that can authenticate a real person.
 *
 * Behind the same `Verifier` port as the mock, so OTP or OIDC later means another implementation
 * of one interface rather than a change here. K-02 still never holds a password — this holds a
 * scrypt hash, and holding it is the only thing it does.
 */
export {
  InMemoryPasswordCredentialStore,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  PRODUCTION_PARAMETERS,
  PasswordVerifier,
  TEST_ONLY_FAST_PARAMETERS,
  WeakPasswordError,
  hashPassword,
  needsRehash,
  parseStoredHash,
  resetDecoyForTests,
  verifyPassword,
} from './verifiers/index.ts';
export type {
  PasswordCredential,
  PasswordCredentialStore,
  PasswordVerifierOptions,
  ScryptParameters,
} from './verifiers/index.ts';
