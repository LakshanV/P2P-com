/**
 * K-05 Configuration — domain types (FND-003a).
 *
 * Configuration is the first kernel component because almost everything else needs to ask "what is
 * the current value of X, and what was it when that decision was made?". The second half of that
 * question is why versions here are immutable records rather than mutable rows: a decision taken
 * last March must still be explicable in terms of the configuration that produced it, and a schema
 * that overwrites values in place makes that permanently unanswerable.
 *
 * Deterministic and provider-neutral by construction: no clock is read here, no randomness is
 * generated here, and nothing in this component knows that AI exists. Callers supply the time and
 * the identifiers, which is what makes every behaviour reproducible in a test.
 *
 * Owned by: K-05 Configuration. See kernel/configuration/CONTRACT.md.
 */

/** Scope levels, ordered from least to most specific. Resolution prefers the most specific. */
export const SCOPE_LEVELS = ['global', 'region', 'tenant'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

/**
 * A scope. `global` has no identifier; the others name the region or tenant they apply to.
 *
 * Precedence is by level, most specific first: tenant, then region, then global. Two versions can
 * never be equally specific for one key, because a scope is uniquely identified by level plus id.
 */
export interface Scope {
  readonly level: ScopeLevel;
  /** Empty string for `global`; the region or tenant identifier otherwise. */
  readonly id: string;
}

export const GLOBAL_SCOPE: Scope = { level: 'global', id: '' };

/** Specificity rank. Higher wins during resolution. */
export function scopeRank(scope: Scope): number {
  return SCOPE_LEVELS.indexOf(scope.level);
}

export function scopeKey(scope: Scope): string {
  return `${scope.level}:${scope.id}`;
}

export function sameScope(a: Scope, b: Scope): boolean {
  return a.level === b.level && a.id === b.id;
}

/** The value kinds a registered key may declare. Deliberately small. */
export type ValueSchema =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly kind: 'string'; readonly maxLength: number; readonly pattern?: string }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'duration-seconds'; readonly minimum: number; readonly maximum: number };

export type ConfigurationValue = boolean | number | string;

/** A registered key. Nothing may be published for a key that is not registered. */
export interface ConfigurationKey {
  readonly id: string;
  readonly description: string;
  readonly schema: ValueSchema;
  /** Scope levels at which this key may be set. A key not listed here cannot be overridden. */
  readonly scopes: readonly ScopeLevel[];
}

export type VersionStatus = 'draft' | 'active' | 'superseded';

/**
 * An immutable version record.
 *
 * The **content** is fixed at creation: `versionId`, `key`, `scope`, `value`, `effectiveFrom`,
 * `origin` and `idempotencyKey` never change afterwards. What moves is lifecycle state —
 * `status` walks draft → active → superseded, `publishedAt` is stamped at activation,
 * `previousVersionId` records what this version replaced at that moment, and `supersededAt` is
 * stamped when a later version takes over.
 *
 * A draft is created first and activated separately, so no version is ever constructed already
 * active. That matters for more than tidiness: activation is where the previous version is
 * superseded, and doing the two in one step is what forces a moment where two rows are active.
 */
export interface ConfigurationVersion {
  readonly versionId: string;
  readonly key: string;
  readonly scope: Scope;
  readonly value: ConfigurationValue;
  /** ISO-8601 instant from which this version applies. */
  readonly effectiveFrom: string;
  readonly status: VersionStatus;
  readonly createdAt: string;
  readonly publishedAt: string | null;
  readonly supersededAt: string | null;
  /** The version this one replaced at the same key and scope, if any. */
  readonly previousVersionId: string | null;
  /** Deduplicates retries. Two publications with one key produce one version. */
  readonly idempotencyKey: string;
  /** Who asked for this change. AI is never a permitted origin — see CONTRACT.md. */
  readonly origin: PublicationOrigin;
}

/**
 * Where a publication came from.
 *
 * `ai-suggested` exists in the type so that it can be **rejected explicitly** rather than being
 * absent and therefore un-refusable. AI may propose a change to a human; it may not publish one,
 * and it may not be the authority a resolution answers from.
 */
export const PUBLICATION_ORIGINS = ['human', 'system-migration', 'ai-suggested'] as const;
export type PublicationOrigin = (typeof PUBLICATION_ORIGINS)[number];

export const PERMITTED_ORIGINS: readonly PublicationOrigin[] = ['human', 'system-migration'];

/** The result of resolving a key: the value and the exact version it came from. */
export interface Resolution {
  readonly key: string;
  readonly value: ConfigurationValue;
  /** The version that supplied the value. Record this, not the value, for a decision. */
  readonly versionId: string;
  /** The scope the winning version was set at, which may be broader than the one asked for. */
  readonly scope: Scope;
  /** The instant the resolution was asked about. */
  readonly at: string;
}

/**
 * What a caller records when configuration influenced a decision.
 *
 * The version id is the load-bearing field. Storing the value alone loses the ability to explain
 * where it came from; storing the key alone loses the value entirely once a later version lands.
 */
export interface ConfigurationDecisionRecord {
  readonly key: string;
  readonly versionId: string;
  readonly value: ConfigurationValue;
  readonly scope: Scope;
  readonly resolvedAt: string;
}

export type ConfigurationErrorCode =
  | 'unknown-key'
  | 'idempotency-key-reuse'
  | 'draft-not-found'
  | 'not-a-draft'
  | 'region-mismatch'
  | 'invalid-value'
  | 'scope-not-permitted'
  | 'scope-escalation'
  | 'retroactive-change'
  | 'ambiguous-active-version'
  | 'concurrent-modification'
  | 'secret-bearing-value'
  | 'financial-policy-value'
  | 'origin-not-permitted'
  | 'immutable-version'
  | 'no-value';

/** A refusal the caller must act on, as distinct from an unexpected failure. */
export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode;

  constructor(code: ConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
  }
}
