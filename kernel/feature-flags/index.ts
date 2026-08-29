/**
 * K-07 Feature Flags — public surface (FND-004e).
 *
 * Everything another unit may depend on is re-exported here; see kernel/feature-flags/CONTRACT.md
 * for the contract this fixes.
 *
 * **A flag says whether code is running. It never says whether something is permitted, owed,
 * priced or assigned.** That is the one thing to understand about this component, and it is
 * enforced rather than documented: a flag key naming authority, money, an entitlement, an
 * experiment or AI autonomy is refused at publication, with the component that owns that decision
 * named in the refusal. Everything else — versions, activations, kill switches, rollout buckets —
 * is bookkeeping around a deny-by-default evaluation that fails closed on every uncertainty.
 *
 * **No API and no UI ship in this slice**, and nothing in this repository evaluates a flag: it is
 * a capability, not an integration. Administration is gated by an injected authority that
 * **defaults to refusing**, which is the honest placeholder for the K-02 session and K-04
 * administration grant that should eventually stand there. K-09 audit and K-08 events are not
 * wired, so **a kill switch records nothing to the audit trail and publishes no event** — the two
 * integrations most obviously wanted next for a control whose whole purpose is to be used during
 * an incident.
 */

export {
  EVALUATION_REASONS,
  FLAG_STATES,
  FeatureFlagError,
  GLOBAL_SCOPE,
  LIFECYCLE_KINDS,
  PREDICATE_KINDS,
  SCOPE_LEVELS,
  sameScope,
  scopeChain,
  scopeKey,
  scopeRank,
  type Activation,
  type Evaluation,
  type EvaluationReason,
  type FeatureFlagErrorCode,
  type FlagState,
  type FlagVersion,
  type LifecycleEvent,
  type LifecycleKind,
  type Origin,
  type OriginKind,
  type Predicate,
  type PredicateKind,
  type Scope,
  type ScopeLevel,
} from './types.ts';

export {
  ASSERTED_OUTCOME_FIELDS,
  IDENTITY_REFUSALS,
  TARGET_ATTRIBUTES,
  TARGET_ATTRIBUTE_NAMES,
  assertAttribute,
  assertFlagIdentifier,
  assertFlagKey,
  assertPredicate,
  assertScope,
  assertSupportedScopes,
  attributesOf,
} from './registry.ts';

export { sealActivation, sealFlagVersion, sealLifecycleEvent, sealPredicate } from './immutable.ts';

export {
  inStoredRow,
  validateActivation,
  validateFlagVersion,
  validateLifecycleEvent,
  type RecordSource,
} from './validate.ts';

export { BUCKET_COUNT, bucketOf, inRollout } from './rollout.ts';

export {
  DEPLOYMENT_STAGES,
  evaluate,
  matches,
  type DeploymentStage,
  type EvaluationInput,
} from './decide.ts';

export {
  REQUEST_FINGERPRINT,
  canonicalPredicate,
  canonicalTransitionRequest,
  canonicalVersionRequest,
  fingerprintTransitionRequest,
  fingerprintVersionRequest,
  type TransitionRequestFacts,
  type VersionRequestFacts,
} from './fingerprint.ts';

export {
  DEPLOYMENT_STAGE_KEY,
  NO_ADMINISTRATION,
  NO_CONFIGURATION,
  asDeploymentStage,
  type Clock,
  type ConfigurationLookup,
  type FlagAdministrator,
} from './ports.ts';

export { FeatureFlagService } from './service.ts';
export type {
  ActivateRequest,
  ActivateResult,
  EvaluateRequest,
  PublishResult,
  PublishVersionRequest,
  TerminateRequest,
  TerminateResult,
} from './service.ts';

export { InMemoryFeatureFlagRepository, terminalWord } from './repository.ts';
export type { FeatureFlagRepository, FeatureFlagTransaction } from './repository.ts';

export {
  ACTIVATION_TABLE,
  EnlistedFeatureFlagRepository,
  FEATURE_FLAGS_SCHEMA,
  LIFECYCLE_TABLE,
  OUTBOX_COLUMNS,
  OUTBOX_TABLE,
  PostgresFeatureFlagRepository,
  TIMESTAMP_COLUMNS,
  VERSION_TABLE,
  enlistedClient,
  toActivation,
  toFlagVersion,
  toLifecycleEvent,
} from './postgres-repository.ts';

export {
  FEATURE_FLAG_RETIRED_ACTION,
  FEATURE_FLAG_RETIRED_EVENT,
  FEATURE_FLAG_VERSION_ACTIVATED_ACTION,
  FEATURE_FLAG_VERSION_ACTIVATED_EVENT,
  FEATURE_FLAG_VERSION_PUBLISHED_ACTION,
  FEATURE_FLAG_VERSION_PUBLISHED_EVENT,
  makeFeatureFlagRetiredAction,
  makeFeatureFlagRetiredEvent,
  makeFeatureFlagVersionActivatedAction,
  makeFeatureFlagVersionActivatedEvent,
  makeFeatureFlagVersionPublishedAction,
  makeFeatureFlagVersionPublishedEvent,
} from './outbox.ts';
