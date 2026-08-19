/**
 * K-05 Configuration — the service (FND-003a).
 *
 * Publication and resolution, with the properties that make configuration trustworthy rather than
 * merely storable:
 *
 *   - **Immutable versions.** Publishing never edits an existing record. A decision that recorded
 *     a version id can be replayed exactly, forever, however many versions land afterwards.
 *   - **Draft to active.** A draft exists, is validated, and becomes active only when published.
 *     Nothing half-written is ever resolvable.
 *   - **Effective time.** A version applies from an instant. Resolution answers "what was the
 *     value at T", not merely "what is the value now", because that is the question an audit asks.
 *   - **Optimistic concurrency.** A publication states which version it believes it is replacing.
 *     Two concurrent editors cannot both win; the second is refused rather than silently applied.
 *   - **Idempotent publication.** A retried request with the same idempotency key returns the
 *     version the first attempt created. A dropped response must not become a second version.
 *   - **Scoped overrides.** tenant beats region beats global, and only for keys that permit it.
 *
 * Deterministic by construction: the caller supplies `now`, the version id and the idempotency
 * key. Nothing here reads a clock or generates randomness, so every case above is reproducible.
 *
 * Owned by: K-05 Configuration. No API, no UI, no events — see CONTRACT.md for why.
 */

import type { ConfigurationRepository, ConfigurationTransaction } from './repository.ts';
import { assertScopePermitted, assertValidValue } from './registry.ts';
import type { ConfigurationRegistry } from './registry.ts';
import {
  ConfigurationError,
  GLOBAL_SCOPE,
  PERMITTED_ORIGINS,
  SCOPE_LEVELS,
  type ConfigurationDecisionRecord,
  type ConfigurationValue,
  type ConfigurationVersion,
  type PublicationOrigin,
  type Resolution,
  type Scope,
  sameScope,
  scopeRank,
} from './types.ts';

export interface PublishRequest {
  readonly key: string;
  readonly scope: Scope;
  readonly value: ConfigurationValue;
  /** ISO-8601 instant from which the new value applies. Never in the past. */
  readonly effectiveFrom: string;
  /** The version the caller believes is active at this scope, or null if it believes none is. */
  readonly expectedActiveVersionId: string | null;
  /** Stable across retries of one logical publication. */
  readonly idempotencyKey: string;
  /** Caller-supplied identity for the new version, so the service stays deterministic. */
  readonly versionId: string;
  readonly origin: PublicationOrigin;
  /**
   * The broadest scope level the actor is entitled to change.
   *
   * K-04 Permissions does not exist yet, so this is supplied by the caller rather than derived
   * from a session. It is enforced anyway: a component that adds the check later, once there is
   * something to derive it from, is a component that shipped without it in the meantime.
   */
  readonly authorityLevel: Scope['level'];
  /** The instant the publication is being made. */
  readonly now: string;
}

export interface PublishResult {
  readonly version: ConfigurationVersion;
  /** True when an earlier attempt with this idempotency key already created the version. */
  readonly deduplicated: boolean;
  readonly supersededVersionId: string | null;
}

export interface ResolveRequest {
  readonly key: string;
  /** The most specific scope the caller is asking about. Broader scopes are consulted in turn. */
  readonly scope: Scope;
  /** The instant to resolve at. Past instants answer historical questions. */
  readonly at: string;
}

export class ConfigurationService {
  readonly #registry: ConfigurationRegistry;
  readonly #repository: ConfigurationRepository;

  constructor(registry: ConfigurationRegistry, repository: ConfigurationRepository) {
    this.#registry = registry;
    this.#repository = repository;
  }

  /**
   * Publish a new active version.
   *
   * Everything happens inside one transaction: the new version is inserted and the one it replaces
   * is superseded together, so the database never holds two active versions for one key and scope.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const key = this.#registry.require(request.key);

    if (!PERMITTED_ORIGINS.includes(request.origin)) {
      throw new ConfigurationError(
        'origin-not-permitted',
        `origin "${request.origin}" may not publish configuration. AI may propose a change to a ` +
          'human, who publishes it and owns it; it is never itself the authority',
      );
    }

    assertScopePermitted(key, request.scope);
    assertValidValue(key, request.value);
    assertInstant(request.effectiveFrom, 'effectiveFrom');
    assertInstant(request.now, 'now');

    // Broader authority covers narrower scopes; the reverse is escalation. An actor entitled to
    // change one tenant's settings must not be able to change every tenant's by aiming higher.
    const authorityRank = SCOPE_LEVELS.indexOf(request.authorityLevel);
    if (authorityRank > scopeRank(request.scope)) {
      throw new ConfigurationError(
        'scope-escalation',
        `authority at ${request.authorityLevel} scope does not permit a change at the broader ` +
          `${request.scope.level} scope`,
      );
    }

    if (request.effectiveFrom < request.now) {
      throw new ConfigurationError(
        'retroactive-change',
        `effectiveFrom ${request.effectiveFrom} is before now (${request.now}). A retroactive ` +
          'change would rewrite what past decisions were made under, which no version history can ' +
          'undo — publish a new version effective from now instead',
      );
    }

    return this.#repository.withTransaction(async (tx) => {
      const duplicate = await tx.findByIdempotencyKey(request.idempotencyKey);
      if (duplicate !== null) {
        // A retry, not a second change. Returning the original version is the whole point.
        return { version: duplicate, deduplicated: true, supersededVersionId: null };
      }

      const existing = await tx.findVersions(request.key, [request.scope]);
      const active = existing.filter((version) => version.status === 'active');

      if (active.length > 1) {
        throw new ConfigurationError(
          'ambiguous-active-version',
          `"${request.key}" already has ${active.length} active versions at ${request.scope.level} ` +
            'scope, which should be impossible. Refusing to add a third rather than guessing',
        );
      }

      const current = active[0] ?? null;
      const expected = request.expectedActiveVersionId;
      if ((current?.versionId ?? null) !== expected) {
        throw new ConfigurationError(
          'concurrent-modification',
          `expected active version ${expected ?? 'none'} but found ${current?.versionId ?? 'none'} ` +
            '— someone published while this change was being prepared. Re-read and retry',
        );
      }

      if (current !== null && request.effectiveFrom <= current.effectiveFrom) {
        throw new ConfigurationError(
          'ambiguous-active-version',
          `effectiveFrom ${request.effectiveFrom} is not after the current version's ` +
            `${current.effectiveFrom}; two versions effective at the same instant cannot be ordered`,
        );
      }

      const version: ConfigurationVersion = {
        versionId: request.versionId,
        key: request.key,
        scope: request.scope,
        value: request.value,
        effectiveFrom: request.effectiveFrom,
        status: 'active',
        createdAt: request.now,
        publishedAt: request.now,
        supersededAt: null,
        previousVersionId: current?.versionId ?? null,
        idempotencyKey: request.idempotencyKey,
        origin: request.origin,
      };

      await tx.insertVersion(version);
      if (current !== null) await tx.supersedeVersion(current.versionId, request.now);

      return {
        version,
        deduplicated: false,
        supersededVersionId: current?.versionId ?? null,
      };
    });
  }

  /**
   * Resolve a key at an instant.
   *
   * Scopes are consulted most specific first. Within a scope the winner is the version with the
   * latest `effectiveFrom` at or before `at` that had not been superseded by then — so a
   * resolution at a past instant answers with what was true then, not with what is true now.
   */
  async resolve(request: ResolveRequest): Promise<Resolution> {
    this.#registry.require(request.key);
    assertInstant(request.at, 'at');

    const candidates = scopeChain(request.scope);
    const versions = await this.#repository.withTransaction((tx) =>
      tx.findVersions(request.key, candidates),
    );

    for (const scope of candidates) {
      const winner = effectiveVersion(versions, scope, request.at);
      if (winner !== null) {
        return {
          key: request.key,
          value: winner.value,
          versionId: winner.versionId,
          scope: winner.scope,
          at: request.at,
        };
      }
    }

    throw new ConfigurationError(
      'no-value',
      `"${request.key}" has no version effective at ${request.at} for ${request.scope.level} scope ` +
        'or any broader scope',
    );
  }

  /**
   * Resolve and produce the record a caller stores alongside its decision.
   *
   * The version id is what makes the decision explicable later. A caller that stores only the
   * value cannot say where it came from; one that stores only the key cannot reproduce it at all.
   */
  async resolveForDecision(request: ResolveRequest): Promise<ConfigurationDecisionRecord> {
    const resolution = await this.resolve(request);
    return {
      key: resolution.key,
      versionId: resolution.versionId,
      value: resolution.value,
      scope: resolution.scope,
      resolvedAt: resolution.at,
    };
  }

  /**
   * The exact version a decision recorded, whatever has happened since.
   *
   * This is the read that makes history answerable. It returns superseded versions deliberately:
   * a superseded version is not a deleted one.
   */
  async versionById(versionId: string): Promise<ConfigurationVersion> {
    const version = await this.#repository.withTransaction((tx) => tx.findVersionById(versionId));
    if (version === null) {
      throw new ConfigurationError('no-value', `no configuration version ${versionId}`);
    }
    return version;
  }

  /** Every version for a key at a scope, oldest first. For inspection and tests. */
  history(key: string, scope: Scope): Promise<readonly ConfigurationVersion[]> {
    this.#registry.require(key);
    return this.#repository.withTransaction((tx: ConfigurationTransaction) =>
      tx.findVersions(key, [scope]),
    );
  }
}

/** The scopes to consult, most specific first, ending at global. */
export function scopeChain(scope: Scope): readonly Scope[] {
  const chain: Scope[] = [scope];
  for (let rank = scopeRank(scope) - 1; rank >= 0; rank -= 1) {
    const level = SCOPE_LEVELS[rank];
    if (level === undefined) continue;
    // Only `global` is reachable without an identifier; a broader *named* scope is not implied by
    // a narrower one, because a tenant does not know which region it belongs to at this layer.
    if (level === 'global') chain.push(GLOBAL_SCOPE);
  }
  return chain.filter(
    (candidate, index, all) => all.findIndex((c) => sameScope(c, candidate)) === index,
  );
}

/**
 * The version in force at `at` for one scope, or null.
 *
 * The window is bounded by effective time, not by `supersededAt`. Those are different instants and
 * conflating them is a real bug: `supersededAt` records when a successor was *published*, which is
 * typically before the successor *takes effect*. A version published on the 15th to take effect on
 * the 1st of next month must still answer questions about the 20th of this one — the predecessor
 * is superseded but remains in force. Ordering by `effectiveFrom` gives that for free: once the
 * successor's instant passes, it simply becomes the latest applicable version.
 */
function effectiveVersion(
  versions: readonly ConfigurationVersion[],
  scope: Scope,
  at: string,
): ConfigurationVersion | null {
  const applicable = versions
    .filter((version) => sameScope(version.scope, scope))
    .filter((version) => version.status !== 'draft')
    .filter((version) => version.effectiveFrom <= at)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

  return applicable[0] ?? null;
}

function assertInstant(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    throw new ConfigurationError(
      'invalid-value',
      `${field} must be an ISO-8601 UTC instant such as 2026-01-01T00:00:00Z, got "${value}"`,
    );
  }
}
