/**
 * K-07 Feature Flags — domain types (FND-004e).
 *
 * A feature flag answers exactly one question: **is this deployment currently running this piece
 * of code for this subject?** It is a deployment control, and the whole design turns on what that
 * sentence excludes:
 *
 * | A flag is not | Because |
 * |---|---|
 * | a permission | "may this party do this" is K-04's question, decided from grants against a policy version. A flag that gated authority would be an allow nobody granted, revocable only by a deploy |
 * | an entitlement | what a party has bought or been verified for belongs to the Capability & Verification module. A flag turning a paid feature on for 10% of accounts is a billing defect |
 * | an experiment | an A/B assignment must be stable, recorded and analysable against outcomes. That is Analytics (v3 §48); a rollout percentage is not a variant |
 * | financial policy | fees, rates, hold periods and guarantee percentages are K-06/K-10 and are versioned so a historic transaction keeps the policy applied to it (v3 §35). A flag has no such semantics |
 * | AI authority | what an agent may do is K-04 plus v3 §38. A flag that granted an agent a capability would be authority with no audit trail |
 *
 * Those five are not commentary: `registry.ts` refuses a flag key that reads like any of them, and
 * refuses a request field by which a caller would assert one. A component that merely *documented*
 * the distinction would be one flag key away from becoming the platform's authorisation system.
 *
 * Deterministic and provider-neutral by construction: no clock is read here, no randomness is
 * generated here, and nothing in this component knows that AI exists. The service takes its time
 * from an injected clock and its rollout bucket from a pure hash, which is what makes every
 * behaviour in `decide.ts` reproducible from its inputs alone.
 *
 * Owned by: K-07 Feature Flags. See kernel/feature-flags/CONTRACT.md.
 */

/**
 * The rollout states, in the order v3 §36 lists them.
 *
 * `killed` is deliberately **not** here. An emergency stop is not a state somebody edits a
 * definition into — it is an appended event that outranks whatever the definition says, so that
 * turning something off in an incident is one insert rather than a publication plus an activation.
 * See `LIFECYCLE_KINDS`.
 */
export const FLAG_STATES = ['off', 'internal-only', 'targeted', 'percentage', 'on'] as const;
export type FlagState = (typeof FLAG_STATES)[number];

/**
 * Scope levels, ordered from least to most specific.
 *
 * These are v3 §36's "selected accounts / selected categories / selected countries" as a
 * hierarchy rather than four unrelated switches. A flag version declares which levels it may be
 * evaluated at; a request naming any other level is refused rather than silently widened, because
 * a flag written to be evaluated per account and evaluated globally by mistake is a full rollout
 * nobody asked for.
 */
export const SCOPE_LEVELS = ['global', 'country', 'category', 'account'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export interface Scope {
  readonly level: ScopeLevel;
  /** Empty string for `global`; the opaque country, category or account handle otherwise. */
  readonly id: string;
}

export const GLOBAL_SCOPE: Scope = Object.freeze({ level: 'global', id: '' });

/** Specificity rank. Higher is more specific. */
export function scopeRank(scope: Scope): number {
  return SCOPE_LEVELS.indexOf(scope.level);
}

export function scopeKey(scope: Scope): string {
  return `${scope.level}:${scope.id}`;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.level === b.level && a.id === b.id;
}

/**
 * The chain from `global` up to and including this scope.
 *
 * Nothing resolves *through* the chain yet — one flag version applies to every level it supports,
 * and per-scope overrides are deferred (CONTRACT.md §9). The chain exists because the explanation
 * names it, so an operator reading "evaluated at account:acct_x" can see what that is inside of,
 * and because deferring a feature is not a reason to bury the structure it will need.
 */
export function scopeChain(scope: Scope): readonly Scope[] {
  const chain: Scope[] = [GLOBAL_SCOPE];
  for (const level of SCOPE_LEVELS) {
    if (level === 'global') continue;
    if (SCOPE_LEVELS.indexOf(level) > scopeRank(scope)) break;
    chain.push(level === scope.level ? scope : { level, id: '' });
  }
  return Object.freeze(chain.filter((entry) => entry.level === 'global' || entry.id !== ''));
}

/** The predicate kinds a targeting rule may use. Four, and no negation — see `registry.ts`. */
export const PREDICATE_KINDS = ['attribute-equals', 'attribute-in', 'all', 'any'] as const;
export type PredicateKind = (typeof PREDICATE_KINDS)[number];

export type Predicate =
  | { readonly kind: 'attribute-equals'; readonly attribute: string; readonly value: string }
  | { readonly kind: 'attribute-in'; readonly attribute: string; readonly values: readonly string[] }
  | { readonly kind: 'all'; readonly of: readonly Predicate[] }
  | { readonly kind: 'any'; readonly of: readonly Predicate[] };

/** Who published or appended something. There is no `ai` kind here — see `registry.ts`. */
export type OriginKind = 'human' | 'system';

export interface Origin {
  readonly kind: OriginKind;
  readonly id: string;
}

/**
 * One immutable version of one flag's definition.
 *
 * Versions are numbered per flag key and never edited. A change is a new version, and which
 * version is *current* is a separate appended fact (`Activation`) rather than a column here — so
 * "what was this flag doing at 14:05 on Tuesday" is answerable from rows that still exist.
 */
export interface FlagVersion {
  readonly flagVersionId: string;
  readonly flagKey: string;
  /** Monotonic per flag key, starting at 1. Ordering is the number, never the clock. */
  readonly version: number;
  readonly state: FlagState;
  /** Non-empty, deduplicated, ordered least-specific first. */
  readonly supportedScopes: readonly ScopeLevel[];
  /** Targeting rules. Meaningful only for `targeted`; empty for every other state. */
  readonly rules: readonly Predicate[];
  /** Whole percent, 0–100. Meaningful only for `percentage`; 0 for every other state. */
  readonly percentage: number;
  /**
   * The rollout salt.
   *
   * Bucketing hashes the flag key, this salt and the subject key together, so two flags at 10% do
   * not select the same tenth of the population — and so an operator who wants a genuinely fresh
   * draw can publish a new version with a new salt rather than hoping the hash moves.
   */
  readonly rolloutSalt: string;
  /** Bounded activation window, both ends optional, both inclusive of the instant they name. */
  readonly notBefore: string | null;
  readonly notAfter: string | null;
  readonly publishedAt: string;
  readonly publishedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * An appended record that a version became the current one for its flag key.
 *
 * Guarded: an activation names the version it supersedes, and one that names a version that is no
 * longer current is refused. Two operators activating different versions at once must not produce
 * a history in which both won.
 */
export interface Activation {
  readonly activationId: string;
  readonly flagKey: string;
  readonly flagVersionId: string;
  /** The version this replaces, or null when this is the flag's first activation. */
  readonly supersedesVersionId: string | null;
  readonly activatedAt: string;
  readonly activatedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * The two terminal facts about a flag key, both appended and neither reversible here.
 *
 * `kill` is the emergency stop of v3 §36: it outranks every definition, so a high-risk function
 * can be stopped without publishing anything. `retire` is the orderly end of a flag's life.
 * Neither can be undone through this component — restoring a killed flag is a new flag key, which
 * is deliberate: an emergency stop that could be quietly lifted is not one.
 */
export const LIFECYCLE_KINDS = ['kill', 'retire'] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export interface LifecycleEvent {
  readonly eventId: string;
  readonly flagKey: string;
  readonly kind: LifecycleKind;
  readonly reason: string;
  readonly recordedAt: string;
  readonly recordedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * Why an evaluation came out the way it did.
 *
 * Every reason is machine-readable and every one of them is reachable — a reason that can never
 * be produced is documentation pretending to be code.
 */
export const EVALUATION_REASONS = [
  /** No version of this flag has ever been activated. Fail closed: unknown means off. */
  'no-such-flag',
  /** An emergency stop is in force. Outranks every definition, including `on`. */
  'kill-switch',
  'flag-retired',
  /** The request named a scope level this flag was not published to be evaluated at. */
  'unsupported-scope',
  /** Now is before `notBefore` or after `notAfter`. */
  'outside-activation-window',
  'flag-off',
  'full-rollout',
  'internal-only',
  /** The flag is internal-only and this deployment is not an internal one. */
  'not-internal-deployment',
  /** The flag is internal-only and the deployment stage could not be resolved. */
  'deployment-stage-unknown',
  'targeting-matched',
  'targeting-unmatched',
  /** A rule names an attribute the request did not supply. Fail closed. */
  'missing-context',
  'percentage-included',
  'percentage-excluded',
  /** A percentage rollout with no subject key to bucket. Fail closed. */
  'missing-subject-key',
] as const;
export type EvaluationReason = (typeof EVALUATION_REASONS)[number];

/**
 * The answer, and enough to reproduce it.
 *
 * `explanation` names the flag, the version evaluated and what decided it. It never contains an
 * attribute *value*, a subject key or a configuration value — an explanation is the thing most
 * likely to be logged, and a targeting explanation that quoted the values it matched would put
 * whatever a caller passed as context into every log line that ever mentions this flag.
 */
export interface Evaluation {
  readonly flagKey: string;
  readonly enabled: boolean;
  readonly reason: EvaluationReason;
  readonly explanation: string;
  /** The version this answer came from, or null when there was none to evaluate. */
  readonly flagVersionId: string | null;
  readonly version: number | null;
  /** The scope the request was evaluated at. */
  readonly scope: Scope;
  /** The bucket, for a percentage rollout only. Null otherwise. 0–9999. */
  readonly bucket: number | null;
}

export type FeatureFlagErrorCode =
  /** The value is not a well-formed opaque identifier. */
  | 'malformed-identifier'
  /** The value looks like a natural or personal identifier. */
  | 'natural-identifier'
  /** The value looks like a credential. */
  | 'secret-bearing-input'
  /** A request carried a field by which the caller would decide the outcome. */
  | 'caller-asserted-outcome'
  /** A flag key names something another component owns: authority, money, entitlement, AI. */
  | 'not-a-feature-flag'
  /** A predicate kind, attribute or shape this component does not support. */
  | 'unsupported-predicate'
  /** A scope level this flag was not published for, or one that does not exist. */
  | 'unsupported-scope'
  /** `notAfter` is not after `notBefore`, or a bound is not a finite instant. */
  | 'invalid-activation-window'
  /** A flag key, version number, id or idempotency key that is already taken. */
  | 'duplicate-flag-version'
  | 'duplicate-activation'
  | 'duplicate-lifecycle-event'
  /** An idempotency key was reused for a different request. */
  | 'idempotency-key-reuse'
  /** An activation lost a race: the version it claimed to supersede is no longer current. */
  | 'stale-activation'
  /** The named flag version does not exist, or names a different flag key. */
  | 'no-such-flag-version'
  /** Nobody is permitted to administer flags: no administration authority was injected. */
  | 'administration-refused'
  /** A mutation was attempted on a flag that has been killed or retired. */
  | 'flag-terminated'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A write tried to rewrite flag history. */
  | 'immutable-history'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record';

export class FeatureFlagError extends Error {
  readonly code: FeatureFlagErrorCode;

  constructor(code: FeatureFlagErrorCode, message: string) {
    super(message);
    this.name = 'FeatureFlagError';
    this.code = code;
  }
}
