/**
 * K-06 Policy Engine — public surface (FND-005b).
 *
 * Everything another unit may depend on is re-exported here; see kernel/policy-engine/CONTRACT.md
 * for the contract this fixes.
 *
 * **Every successful evaluation returns the policy version id that produced it.** That is the one
 * thing to understand about this component. v3 §35 requires historic transactions to retain the
 * policy version originally applied and v3 §24 requires every transaction to store the exact
 * commission policy version applied at purchase time — promises a caller can only keep if the
 * engine hands it something to store. So `PolicyDecision.policyVersionId` is never optional, and
 * when an output reads K-05 the configuration version id is pinned beside it.
 *
 * **Nothing here computes money.** K-06 returns the rate and the version that said so; K-10 Ledger
 * foundation multiplies. And no value in this component is ever a `number` where exactness matters:
 * rates, amounts and thresholds are `{ units, scale }` decimals carried as text end to end, because
 * a double cannot hold most of them and money computed from an inexact rate is money nobody can
 * reconcile.
 *
 * **No API and no UI ship in this slice**, and nothing in this repository evaluates a policy: it is
 * a capability, not an integration. Authoring is gated by an injected authority that **defaults to
 * refusing**, which is the honest placeholder for the K-02 session and K-04 authorisation that
 * should eventually stand there. K-09 audit and K-08 events are not wired, so **publishing a new
 * commission rate records nothing to the audit trail and notifies nobody**.
 */

export {
  DECISION_REASONS,
  OUTPUT_KINDS,
  PREDICATE_KINDS,
  PolicyError,
  SCOPE_DIMENSIONS,
  specificity,
  type Decimal,
  type DecisionReason,
  type Origin,
  type OriginKind,
  type OutputKind,
  type OutputSchema,
  type OutputValue,
  type PolicyActivation,
  type PolicyDecision,
  type PolicyDraft,
  type PolicyErrorCode,
  type PolicyFacts,
  type PolicyRetirement,
  type PolicyRule,
  type PolicyVersion,
  type Predicate,
  type PredicateKind,
  type ResolvedOutput,
  type ScopeDimension,
  type ScopeSelector,
} from './types.ts';

export {
  MAX_DIGITS,
  MAX_SCALE,
  assertDecimal,
  compareDecimals,
  decimalFromText,
  decimalToText,
  decimalsEqual,
  isNegative,
  isZero,
  refuseFloatingPoint,
} from './decimal.ts';

export {
  AMOUNT_FACT,
  ASSERTED_OUTCOME_FIELDS,
  PINNED_VERSION_FIELDS,
  FACTS,
  FACT_NAMES,
  IDENTITY_REFUSALS,
  MAX_PREDICATE_BRANCH,
  MAX_PREDICATE_DEPTH,
  MAX_RULES,
  assertFactName,
  assertPolicyIdentifier,
  assertPolicyKey,
  assertPredicate,
  assertScopeSelector,
  factsOf,
} from './registry.ts';

export {
  sealActivation,
  sealDraft,
  sealPredicate,
  sealRetirement,
  sealRule,
  sealVersion,
} from './immutable.ts';

export {
  assertOutputSchema,
  assertOutputValue,
  inStoredRow,
  validateActivation,
  validatePolicyDraft,
  validatePolicyVersion,
  validateRetirement,
  type RecordSource,
} from './validate.ts';

export {
  assertFacts,
  conditionHolds,
  select,
  staticOutput,
  type EvaluationFacts,
  type EvaluationInput,
  type Selection,
} from './decide.ts';

export {
  REQUEST_FINGERPRINT,
  canonicalDraftRequest,
  canonicalPredicate,
  canonicalRule,
  canonicalTransitionRequest,
  fingerprintDraftRequest,
  fingerprintTransitionRequest,
  type DraftRequestFacts,
  type TransitionRequestFacts,
} from './fingerprint.ts';

export {
  NO_AUTHORITY,
  NO_CONFIGURATION,
  type Clock,
  type ConfigurationLookup,
  type PolicyAuthority,
} from './ports.ts';

export { PolicyService } from './service.ts';
export type {
  ActivatePolicyRequest,
  ActivateResult,
  DraftPolicyRequest,
  DraftResult,
  EvaluateRequest,
  PublishPolicyRequest,
  PublishResult,
  RetirePolicyRequest,
  RetireResult,
} from './service.ts';

export { InMemoryPolicyRepository } from './repository.ts';
export type { PolicyRepository, PolicyTransaction } from './repository.ts';

export {
  ACTIVATION_TABLE,
  DRAFT_TABLE,
  EnlistedPolicyRepository,
  POLICY_SCHEMA,
  PostgresPolicyRepository,
  RETIREMENT_TABLE,
  TIMESTAMP_COLUMNS,
  VERSION_TABLE,
  enlistedClient,
  toPolicyActivation,
  toPolicyDraft,
  toPolicyRetirement,
  toPolicyVersion,
} from './postgres-repository.ts';
