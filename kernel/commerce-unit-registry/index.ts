/**
 * K-11 Commerce Unit Registry — public surface (FND-005c).
 *
 * Everything another unit may depend on is re-exported here; see
 * kernel/commerce-unit-registry/CONTRACT.md for the contract this fixes.
 *
 * **K-11 owns the vocabulary and nothing else.** v3 §11's ten kinds of `CommerceUnit` and v3 §12's
 * units of measure, as one versioned register with a hierarchy — so that "never hardcode commerce
 * assumptions around one category" stops being advice and becomes a place the assumption has to be
 * written down. It holds no price, no currency, no conversion factor, no tax rule, no display text
 * and no policy: it stores a K-06 policy *key* and pins the *version id* K-06 returns, which is
 * provenance rather than authority.
 *
 * **Resolution refuses rather than guesses.** A missing parent, a cycle, a chain past the bound, a
 * cross-tenant edge or a version outside its window is an error, not a best guess — everything
 * downstream believes what a registry says, so a guessed lineage becomes a risk pack that silently
 * stops applying.
 *
 * **No API and no UI ship in this slice**, and nothing in this repository resolves a type: it is a
 * capability, not an integration. Registration is gated by an injected authority that **defaults to
 * refusing** and carries the owner scope it may write for, which is the honest placeholder for the
 * K-02 session and K-04 authorisation that should eventually stand there. K-09 audit and K-08
 * events are not wired, so **retiring a category records nothing to the audit trail and tells
 * nobody**.
 */

export {
  KIND_FAMILIES,
  MEASURE_FAMILIES,
  MEASURE_FAMILY_NAMES,
  UNIT_KINDS,
  CommerceUnitError,
  ownerKey,
  sameOwner,
  type CommerceUnitErrorCode,
  type MeasureFamily,
  type Origin,
  type OriginKind,
  type OwnerScope,
  type ResolvedUnitType,
  type UnitKind,
  type UnitOfMeasure,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';

export {
  ASSERTED_OUTCOME_FIELDS,
  PINNED_VERSION_FIELDS,
  IDENTITY_REFUSALS,
  MAX_DEPTH,
  MAX_MEASURES,
  assertKind,
  assertMeasure,
  assertMeasures,
  assertOwner,
  assertTypeKey,
  assertUnitIdentifier,
} from './registry.ts';

export {
  assertEffective,
  assertSameOwnerEdge,
  explain,
  mayAdminister,
  resolveAncestry,
  type InForce,
  type LookupInForce,
} from './hierarchy.ts';

export { sealActivation, sealResolved, sealRetirement, sealVersion } from './immutable.ts';

export {
  inStoredRow,
  validateActivation,
  validateRetirement,
  validateUnitTypeVersion,
  type RecordSource,
} from './validate.ts';

export {
  REQUEST_FINGERPRINT,
  canonicalMeasures,
  canonicalTransitionRequest,
  canonicalVersionRequest,
  fingerprintTransitionRequest,
  fingerprintVersionRequest,
  type TransitionRequestFacts,
  type VersionRequestFacts,
} from './fingerprint.ts';

export {
  NO_CONFIGURATION,
  NO_POLICY_PROVENANCE,
  NO_REGISTRAR,
  PERMITTED_KINDS_KEY,
  asPermittedKinds,
  type Clock,
  type ConfigurationLookup,
  type PolicyProvenance,
  type RegistrarAuthority,
} from './ports.ts';

export { CommerceUnitRegistryService } from './service.ts';
export type {
  ActivateResult,
  ActivateTypeRequest,
  PublishResult,
  PublishTypeRequest,
  ResolveRequest,
  RetireResult,
  RetireTypeRequest,
} from './service.ts';

export { InMemoryCommerceUnitRepository } from './repository.ts';
export type { CommerceUnitRepository, CommerceUnitTransaction } from './repository.ts';

export {
  ACTIVATION_TABLE,
  COMMERCE_UNIT_SCHEMA,
  EnlistedCommerceUnitRepository,
  PostgresCommerceUnitRepository,
  RETIREMENT_TABLE,
  TIMESTAMP_COLUMNS,
  VERSION_TABLE,
  enlistedClient,
  toUnitTypeActivation,
  toUnitTypeRetirement,
  toUnitTypeVersion,
} from './postgres-repository.ts';
