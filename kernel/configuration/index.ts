/**
 * K-05 Configuration — public surface (FND-003a).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/configuration/CONTRACT.md for the contract this fixes.
 *
 * There is deliberately no API and no UI. Those wait on K-02 Authentication, K-04 Permissions and
 * K-09 Audit, none of which exists — an administrative surface for configuration before there is
 * anyone to authorise it, or any record of who changed what, is a hole rather than a feature.
 *
 * **This component publishes no events, and that is now a deferred integration rather than a
 * missing dependency.** K-08 Event Infrastructure exists (`kernel/event-infrastructure`, FND-003b):
 * an append-only log with at-least-once delivery, and an append path a caller can enlist in its own
 * transaction. Wiring publication into it is separate, undelivered work — a `configuration.*` event
 * type would have to be registered, and each publication would have to append its event inside the
 * same transaction that activates the version, or the fact and the change could disagree. Nothing
 * here does that yet, and no consumer is waiting for it.
 */

export {
  ConfigurationError,
  GLOBAL_SCOPE,
  PERMITTED_ORIGINS,
  PUBLICATION_ORIGINS,
  SCOPE_LEVELS,
  sameScope,
  scopeKey,
  scopeRank,
} from './types.ts';

export type {
  ConfigurationDecisionRecord,
  ConfigurationErrorCode,
  ConfigurationKey,
  ConfigurationValue,
  ConfigurationVersion,
  PublicationOrigin,
  Resolution,
  Scope,
  ScopeLevel,
  ValueSchema,
  VersionStatus,
} from './types.ts';

export {
  ConfigurationRegistry,
  FINANCIAL_KEY_PREFIXES,
  SECRET_KEY_FRAGMENTS,
  assertRegistrableKey,
  assertScopePermitted,
  assertValidValue,
  describeSchemaFailure,
} from './registry.ts';

export {
  assertInstant,
  canonicalInstant,
  compareInstants,
  instantsEqual,
  parseInstant,
} from './instant.ts';
export type { Instant } from './instant.ts';

export { ConfigurationService, scopeChain } from './service.ts';
export type {
  CreateDraftRequest,
  CreateDraftResult,
  PublishDraftRequest,
  PublishRequest,
  PublishResult,
  ResolveRequest,
} from './service.ts';

export { InMemoryConfigurationRepository } from './repository.ts';
export type { ConfigurationRepository, ConfigurationTransaction } from './repository.ts';

export {
  CONFIG_SCHEMA,
  CONFIG_TABLE,
  PostgresConfigurationRepository,
  TIMESTAMP_COLUMNS,
  decodeValue,
  encodeValue,
} from './postgres-repository.ts';
