/**
 * K-05 Configuration — the service (FND-003a, corrected).
 *
 * Publication is two operations, not one:
 *
 *   `createDraft`  writes an immutable draft. A draft is validated, stored and invisible to
 *                  resolution. Nothing half-decided is ever resolvable, and nothing is ever
 *                  constructed already active.
 *   `publishDraft` supersedes the expected incumbent and *then* activates the draft, in that
 *                  order, inside one transaction.
 *
 * The order is not stylistic. The migration declares a partial unique index on
 * `(config_key, scope_level, scope_id) WHERE status = 'active'`, so two active rows for one key
 * and scope may not coexist at any instant. Inserting the replacement already active and
 * superseding the incumbent afterwards — which is what the first revision did — asks the database
 * to hold both, and it will refuse. Superseding first also gives the concurrency control for free:
 * each step is conditional on the row's current status, so the second of two racing publications
 * finds nothing to change and is refused.
 *
 * Other properties, unchanged in intent:
 *
 *   - **Immutable versions.** Content is fixed at creation; only lifecycle state moves.
 *   - **Effective time.** Resolution answers "what was the value at T", not merely "what is it now".
 *   - **Idempotent retries.** A repeated idempotency key returns the original result *only when
 *     the whole logical request matches*. The same key with different content is a mistake, not a
 *     retry, and is refused rather than silently answered with the wrong version.
 *   - **Explicit scope relationships.** A tenant request that should fall back to a region carries
 *     that region. This component does not know which region a tenant belongs to and does not
 *     guess.
 *
 * Deterministic by construction: the caller supplies `now`, the version id and the idempotency
 * key. Nothing here reads a clock or generates randomness.
 *
 * Owned by: K-05 Configuration. No API, no UI — events and audit records are emitted through the
 * transactional outbox (FND-003d) rather than published directly.
 */

import type { OutboxEntry } from '../../platform/outbox/types.ts';
import { assertInstant, compareInstants, instantsEqual } from './instant.ts';
import {
  CONFIGURATION_VERSION_PUBLISHED_ACTION,
  CONFIGURATION_VERSION_PUBLISHED_EVENT,
} from './outbox.ts';
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
  type ScopeLevel,
  sameScope,
  scopeRank,
} from './types.ts';

/** Everything that identifies a logical publication request. All of it must match on a retry. */
export interface CreateDraftRequest {
  readonly key: string;
  readonly scope: Scope;
  readonly value: ConfigurationValue;
  /** ISO-8601 instant from which the new value applies. Never in the past. */
  readonly effectiveFrom: string;
  /** Stable across retries of one logical publication. */
  readonly idempotencyKey: string;
  /** Caller-supplied identity for the draft, so the service stays deterministic. */
  readonly versionId: string;
  readonly origin: PublicationOrigin;
  /**
   * The broadest scope level the actor is entitled to change.
   *
   * K-04 Permissions does not exist yet, so this is supplied by the caller rather than derived
   * from a session. It is enforced anyway.
   */
  readonly authorityLevel: ScopeLevel;
  readonly now: string;
  /** Ties this change to a causal chain. Defaults to the version id. */
  readonly correlationId?: string;
  /** The event or record that caused this one, or null when it starts the chain. */
  readonly causationId?: string | null;
}

export interface CreateDraftResult {
  readonly draft: ConfigurationVersion;
  /** True when this idempotency key had already produced this exact draft. */
  readonly deduplicated: boolean;
}

export interface PublishDraftRequest {
  readonly draftId: string;
  /** The version the caller believes is active at this scope, or null if it believes none is. */
  readonly expectedActiveVersionId: string | null;
  readonly now: string;
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export interface PublishResult {
  readonly version: ConfigurationVersion;
  /** True when an earlier attempt already produced this result. */
  readonly deduplicated: boolean;
  readonly supersededVersionId: string | null;
}

/** The one-call convenience: create the draft, then publish it. */
export interface PublishRequest extends CreateDraftRequest {
  readonly expectedActiveVersionId: string | null;
}

export interface ResolveRequest {
  readonly key: string;
  /** The most specific scope the caller is asking about. */
  readonly scope: Scope;
  /**
   * The region a tenant belongs to, supplied explicitly when tenant values should fall back to a
   * regional default. Omitted or null means the chain skips straight to global — this component
   * has no tenant-to-region map and refuses to invent one.
   */
  readonly region?: Scope | null;
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
   * Validate a change and store it as a draft.
   *
   * A draft is a real, immutable record that resolution ignores. It exists so that the decision
   * to change something and the moment that change takes over are separable — and so that
   * activation has something to activate rather than something to construct.
   */
  async createDraft(request: CreateDraftRequest): Promise<CreateDraftResult> {
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
    if (SCOPE_LEVELS.indexOf(request.authorityLevel) > scopeRank(request.scope)) {
      throw new ConfigurationError(
        'scope-escalation',
        `authority at ${request.authorityLevel} scope does not permit a change at the broader ` +
          `${request.scope.level} scope`,
      );
    }

    if (compareInstants(request.effectiveFrom, request.now, 'effectiveFrom') < 0) {
      throw new ConfigurationError(
        'retroactive-change',
        `effectiveFrom ${request.effectiveFrom} is before now (${request.now}). A retroactive ` +
          'change would rewrite what past decisions were made under, which no version history can ' +
          'undo — publish a new version effective from now instead',
      );
    }

    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findByIdempotencyKey(request.idempotencyKey);
      if (existing !== null) {
        assertSameLogicalRequest(existing, request);
        return { draft: existing, deduplicated: true };
      }

      const draft: ConfigurationVersion = {
        versionId: request.versionId,
        key: request.key,
        scope: request.scope,
        value: request.value,
        effectiveFrom: request.effectiveFrom,
        status: 'draft',
        createdAt: request.now,
        publishedAt: null,
        supersededAt: null,
        previousVersionId: null,
        idempotencyKey: request.idempotencyKey,
        origin: request.origin,
      };
      await tx.insertDraft(draft);
      return { draft, deduplicated: false };
    });
  }

  /**
   * Activate a draft, superseding the expected incumbent first.
   *
   * Both steps are conditional on current status and both are in one transaction, so either the
   * replacement happens completely or the incumbent and the draft are left exactly as they were.
   */
  async publishDraft(request: PublishDraftRequest): Promise<PublishResult> {
    assertInstant(request.now, 'now');

    return this.#repository.withTransaction(async (tx) => {
      const draft = await tx.findVersionById(request.draftId);
      if (draft === null) {
        throw new ConfigurationError(
          'draft-not-found',
          `no configuration version ${request.draftId} to publish`,
        );
      }

      if (draft.status === 'active') {
        // A retried publication of a draft that already went live. Idempotent by state.
        return {
          version: draft,
          deduplicated: true,
          supersededVersionId: draft.previousVersionId,
        };
      }
      if (draft.status !== 'draft') {
        // Superseded, which means it *was* published and has since been replaced. Two very
        // different callers arrive here and they must not get the same answer:
        //
        //   - A retry of the original publication, naming the same incumbent that publication
        //     superseded. The work succeeded; a redelivery weeks later, after a third version
        //     took over, should still be told what it did rather than told it failed. Nothing is
        //     written — the original result is simply restated.
        //   - Someone asking to activate a superseded version afresh, against whatever is active
        //     now. That would resurrect a retired version, so it is refused.
        //
        // The expectation separates them, and it is the only thing that can: a retry carries the
        // predecessor this version replaced, a new activation carries the current incumbent.
        const isRetryOfItsOwnPublication =
          draft.publishedAt !== null &&
          (draft.previousVersionId ?? null) === request.expectedActiveVersionId;
        if (isRetryOfItsOwnPublication) {
          return {
            version: draft,
            deduplicated: true,
            supersededVersionId: draft.previousVersionId,
          };
        }

        throw new ConfigurationError(
          'not-a-draft',
          `version ${request.draftId} is ${draft.status} and was published over; only a draft ` +
            'can be published. A superseded version cannot be made active again — publish a new ' +
            'version carrying the value you want',
        );
      }

      const siblings = await tx.findVersions(draft.key, [draft.scope]);
      const active = siblings.filter((version) => version.status === 'active');
      if (active.length > 1) {
        throw new ConfigurationError(
          'ambiguous-active-version',
          `"${draft.key}" already has ${active.length} active versions at ${draft.scope.level} ` +
            'scope, which should be impossible. Refusing to add a third rather than guessing',
        );
      }

      const current = active[0] ?? null;
      if ((current?.versionId ?? null) !== request.expectedActiveVersionId) {
        throw new ConfigurationError(
          'concurrent-modification',
          `expected active version ${request.expectedActiveVersionId ?? 'none'} but found ` +
            `${current?.versionId ?? 'none'} — someone published while this change was being ` +
            'prepared. Re-read and retry',
        );
      }

      // Compared as instants, never as strings. `2026-01-01T00:00:00.000Z` and
      // `2026-01-01T00:00:00Z` are one moment, but the fractional spelling sorts *earlier* as
      // text, which let a replacement effective at the incumbent's own instant past this check —
      // the exact ambiguity the check exists to prevent.
      if (current !== null && compareInstants(draft.effectiveFrom, current.effectiveFrom) <= 0) {
        throw new ConfigurationError(
          'ambiguous-active-version',
          `effectiveFrom ${draft.effectiveFrom} is not after the current version's ` +
            `${current.effectiveFrom}; two versions effective at the same instant cannot be ordered`,
        );
      }

      // Order matters, and it is the index that decides it: the incumbent leaves the partial
      // unique index before the replacement enters it.
      if (current !== null) await tx.supersedeActiveVersion(current.versionId, request.now);
      await tx.activateDraft(draft.versionId, request.now, current?.versionId ?? null);

      const activated = await tx.findVersionById(draft.versionId);
      if (activated === null) {
        throw new ConfigurationError('draft-not-found', `version ${draft.versionId} vanished`);
      }

      const correlationId = request.correlationId ?? draft.versionId;
      const causationId = request.causationId ?? null;
      await tx.insertOutbox(
        this.#publishedEvent(activated, current?.versionId ?? null, correlationId, causationId),
      );
      await tx.insertOutbox(
        this.#publishedAudit(activated, current?.versionId ?? null, correlationId, causationId),
      );

      return {
        version: activated,
        deduplicated: false,
        supersededVersionId: current?.versionId ?? null,
      };
    });
  }

  /**
   * Create a draft and publish it. The common case, composed from the two steps rather than
   * reimplementing them, so there is exactly one activation path.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const { draft, deduplicated } = await this.createDraft(request);

    if (deduplicated && draft.status !== 'draft') {
      // The original attempt got all the way through; return what it produced.
      return {
        version: draft,
        deduplicated: true,
        supersededVersionId: draft.previousVersionId,
      };
    }

    const result = await this.publishDraft({
      draftId: draft.versionId,
      expectedActiveVersionId: request.expectedActiveVersionId,
      now: request.now,
      ...(request.correlationId !== undefined ? { correlationId: request.correlationId } : {}),
      ...(request.causationId !== undefined ? { causationId: request.causationId } : {}),
    });
    return { ...result, deduplicated: deduplicated || result.deduplicated };
  }

  /**
   * Resolve a key at an instant.
   *
   * Scopes are consulted most specific first: the requested scope, then the region if the caller
   * supplied one, then global. Drafts are invisible. Within a scope the winner is the version with
   * the latest `effectiveFrom` at or before `at`.
   */
  async resolve(request: ResolveRequest): Promise<Resolution> {
    this.#registry.require(request.key);
    assertInstant(request.at, 'at');

    const candidates = scopeChain(request.scope, request.region ?? null);
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
        'or any broader scope named in the request',
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
   * The exact version a decision recorded, whatever has happened since. Superseded versions are
   * returned deliberately: superseded is not deleted.
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

  #publishedEvent(
    version: ConfigurationVersion,
    supersededVersionId: string | null,
    correlationId: string,
    causationId: string | null,
  ): OutboxEntry {
    const eventId = `${version.versionId}:published`;
    return {
      outboxId: `K-05:${eventId}`,
      idempotencyKey: `K-05:${eventId}`,
      kind: 'event',
      producer: 'K-05',
      recordedAt: version.publishedAt ?? version.createdAt,
      correlationId,
      causationId,
      processedAt: null,
      retryCount: 0,
      lastError: null,
      payload: {
        eventId,
        type: CONFIGURATION_VERSION_PUBLISHED_EVENT.type,
        schemaVersion: CONFIGURATION_VERSION_PUBLISHED_EVENT.schemaVersion,
        occurredAt: version.publishedAt ?? version.createdAt,
        recordedAt: version.publishedAt ?? version.createdAt,
        producer: 'K-05',
        correlationId,
        causationId,
        origin: 'system',
        actor: { kind: 'system', id: 'K-05' },
        idempotencyKey: `K-05:${eventId}`,
        now: version.publishedAt ?? version.createdAt,
        payload: {
          version_id: version.versionId,
          config_key: version.key,
          scope_level: version.scope.level,
          scope_id: version.scope.id,
          effective_from: version.effectiveFrom,
          superseded_version_id: supersededVersionId,
        },
      },
    };
  }

  #publishedAudit(
    version: ConfigurationVersion,
    supersededVersionId: string | null,
    correlationId: string,
    causationId: string | null,
  ): OutboxEntry {
    const recordId = `${version.versionId}:published`;
    const outboxId = `K-05:audit:${recordId}`;
    return {
      outboxId,
      idempotencyKey: outboxId,
      kind: 'audit',
      producer: 'K-05',
      recordedAt: version.publishedAt ?? version.createdAt,
      correlationId,
      causationId,
      processedAt: null,
      retryCount: 0,
      lastError: null,
      payload: {
        recordId,
        action: CONFIGURATION_VERSION_PUBLISHED_ACTION.action,
        recordedAt: version.publishedAt ?? version.createdAt,
        actor: {
          kind: 'system',
          id: 'K-05',
          authentication: 'unauthenticated',
          sessionId: null,
        },
        resource: {
          owner: 'K-05',
          type: 'configuration_version',
          id: version.versionId,
        },
        outcome: 'succeeded',
        reason: `configuration version ${version.versionId} published for ${version.key} at ${version.scope.level}:${version.scope.id}`,
        correlationId,
        causationId,
        idempotencyKey: outboxId,
        evidence: {
          version_id: version.versionId,
          config_key: version.key,
          scope_level: version.scope.level,
          scope_id: version.scope.id,
          effective_from: version.effectiveFrom,
          superseded_version_id: supersededVersionId,
        },
      },
    };
  }
}

/**
 * The scopes to consult, most specific first.
 *
 * A region is included only when the caller names one. This component holds no tenant-to-region
 * map, and inferring the relationship would mean either inventing data or silently returning a
 * neighbouring region's value — both worse than answering from global.
 */
export function scopeChain(scope: Scope, region: Scope | null = null): readonly Scope[] {
  if (region !== null && region.level !== 'region') {
    throw new ConfigurationError(
      'region-mismatch',
      `the region of a resolution must be a region scope, got ${region.level}`,
    );
  }
  if (region !== null && scope.level !== 'tenant') {
    throw new ConfigurationError(
      'region-mismatch',
      `a region may only be supplied for a tenant request, not for a ${scope.level} one`,
    );
  }

  const chain: Scope[] = [scope];
  if (region !== null) chain.push(region);
  chain.push(GLOBAL_SCOPE);

  return chain.filter(
    (candidate, index, all) => all.findIndex((other) => sameScope(other, candidate)) === index,
  );
}

/**
 * The version in force at `at` for one scope, or null.
 *
 * The window is bounded by effective time, not by `supersededAt`. Those are different instants and
 * conflating them is a real bug: `supersededAt` records when a successor was *published*, which is
 * typically before the successor *takes effect*. A version published on the 15th to take effect on
 * the 1st of next month must still answer questions about the 20th of this one.
 *
 * Drafts are excluded outright — a draft is a proposal, and resolution answers only from what was
 * actually published.
 */
function effectiveVersion(
  versions: readonly ConfigurationVersion[],
  scope: Scope,
  at: string,
): ConfigurationVersion | null {
  const applicable = versions
    .filter((version) => sameScope(version.scope, scope))
    .filter((version) => version.status !== 'draft')
    .filter((version) => compareInstants(version.effectiveFrom, at) <= 0)
    .sort((a, b) => compareInstants(b.effectiveFrom, a.effectiveFrom));

  return applicable[0] ?? null;
}

/**
 * A retry must be a retry of *this* request.
 *
 * Reusing one idempotency key for different content is not a duplicate delivery, it is a caller
 * bug — usually a key derived from too little of the request. Returning the earlier version would
 * report success for a change that never happened, which is the worst of the available outcomes.
 */
function assertSameLogicalRequest(
  existing: ConfigurationVersion,
  request: CreateDraftRequest,
): void {
  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (was !== now)
      differences.push(`${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
  };

  compare('key', existing.key, request.key);
  compare('scope.level', existing.scope.level, request.scope.level);
  compare('scope.id', existing.scope.id, request.scope.id);
  compare('value', existing.value, request.value);
  // The effective time is compared as an instant: a retry that spells the same moment with a
  // different precision is the same request, and refusing it would turn a harmless redelivery
  // into a caller error.
  if (!instantsEqual(existing.effectiveFrom, request.effectiveFrom)) {
    differences.push(
      `effectiveFrom was ${JSON.stringify(existing.effectiveFrom)}, now ` +
        JSON.stringify(request.effectiveFrom),
    );
  }
  compare('origin', existing.origin, request.origin);
  compare('versionId', existing.versionId, request.versionId);

  if (differences.length > 0) {
    throw new ConfigurationError(
      'idempotency-key-reuse',
      `idempotency key "${request.idempotencyKey}" was already used for a different request ` +
        `(${differences.join('; ')}). A retry must carry the same content; reusing a key for a ` +
        'different change would report success for a change that never happened',
    );
  }
}
