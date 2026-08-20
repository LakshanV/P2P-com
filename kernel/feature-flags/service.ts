/**
 * K-07 Feature Flags — the service (FND-004e).
 *
 * Five operations: publish a version, activate one, kill a flag, retire a flag, evaluate. Four
 * write and one does not, and the one that does not is the one every caller will use.
 *
 * **Evaluation is a read, and it records nothing.** That is a deliberate difference from K-04,
 * which writes a decision record for every authorisation. A permission decision is rare and
 * consequential; a flag evaluation happens on every request through every guarded path, and a
 * component that wrote a row per evaluation would be a write-amplification defect wearing a
 * compliance costume. What makes an evaluation accountable instead is that it is **pure and
 * reproducible**: given the active version, the lifecycle rows and the request, `decide.ts`
 * returns the same answer forever, so an incident is replayed rather than looked up. The audit
 * trail that matters — who changed what, and when it took effect — is the append-only history of
 * the four write operations.
 *
 * **The caller never states the answer**, and never states who authorised a change:
 *
 *   - `enabled`, `reason`, `bucket`, `variant`, `allowed` and their neighbours are refused **by
 *     name** (`registry.ts`), because a caller that could say whether a flag is on *is* the flag;
 *   - no mutation request carries an author. The identity written into every row comes from the
 *     injected `FlagAdministrator`, which **defaults to refusing**. K-04 shipped with authorship
 *     as a request field and any caller could sign a change in somebody else's name
 *     (CURRENT_IMPLEMENTATION_STATUS §11.28); this component does not repeat it.
 *
 * **Nothing here is an authorisation.** There is no code path by which an evaluation consults a
 * grant, and no flag key may name authority, money, entitlement, an experiment or AI autonomy —
 * `registry.ts` refuses those keys at publication, with the component that owns each decision
 * named in the refusal.
 *
 * Owned by: K-07 Feature Flags. No API, no UI, no flag console — see CONTRACT.md §9.
 */

import { evaluate, type DeploymentStage, type EvaluationInput } from './decide.ts';
import {
  fingerprintTransitionRequest,
  fingerprintVersionRequest,
  type TransitionRequestFacts,
  type VersionRequestFacts,
} from './fingerprint.ts';
import { sealActivation, sealFlagVersion, sealLifecycleEvent } from './immutable.ts';
import {
  DEPLOYMENT_STAGE_KEY,
  NO_ADMINISTRATION,
  NO_CONFIGURATION,
  asDeploymentStage,
  type Clock,
  type ConfigurationLookup,
  type FlagAdministrator,
} from './ports.ts';
import {
  assertContext,
  assertFlagIdentifier,
  assertFlagKey,
  assertKnownFields,
  assertNoAssertedOutcome,
  assertScope,
} from './registry.ts';
import { terminalWord, type FeatureFlagRepository } from './repository.ts';
import {
  FeatureFlagError,
  GLOBAL_SCOPE,
  type Activation,
  type Evaluation,
  type FlagVersion,
  type LifecycleEvent,
  type LifecycleKind,
  type Origin,
  type Scope,
} from './types.ts';
import { validateActivation, validateFlagVersion, validateLifecycleEvent } from './validate.ts';

export interface PublishVersionRequest {
  readonly flagVersionId: string;
  readonly flagKey: string;
  readonly state: string;
  readonly supportedScopes: readonly string[];
  readonly rules?: readonly unknown[];
  readonly percentage?: number;
  readonly rolloutSalt: string;
  readonly notBefore?: string | null;
  readonly notAfter?: string | null;
  readonly idempotencyKey: string;
}

export interface ActivateRequest {
  readonly activationId: string;
  readonly flagVersionId: string;
  /**
   * The version this replaces, or null for a flag's first activation.
   *
   * Required rather than inferred. An activation that read the current version for itself would
   * be a read-then-write, and two operators reacting to the same incident would both win.
   */
  readonly supersedesVersionId: string | null;
  readonly idempotencyKey: string;
}

export interface TerminateRequest {
  readonly eventId: string;
  readonly flagKey: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** What a caller may ask. Note what is not here: the answer. */
export interface EvaluateRequest {
  readonly flagKey: string;
  readonly scope?: Scope;
  /** The opaque, non-PII handle a percentage rollout buckets on. */
  readonly subjectKey?: string | null;
  readonly attributes?: Record<string, string>;
}

export interface PublishResult {
  readonly version: FlagVersion;
  readonly deduplicated: boolean;
}

export interface ActivateResult {
  readonly activation: Activation;
  readonly deduplicated: boolean;
}

export interface TerminateResult {
  readonly event: LifecycleEvent;
  readonly deduplicated: boolean;
}

const PUBLISH_KEYS: readonly string[] = [
  'flagVersionId',
  'flagKey',
  'state',
  'supportedScopes',
  'rules',
  'percentage',
  'rolloutSalt',
  'notBefore',
  'notAfter',
  'idempotencyKey',
];

const ACTIVATE_KEYS: readonly string[] = [
  'activationId',
  'flagVersionId',
  'supersedesVersionId',
  'idempotencyKey',
];

const TERMINATE_KEYS: readonly string[] = ['eventId', 'flagKey', 'reason', 'idempotencyKey'];

const EVALUATE_KEYS: readonly string[] = ['flagKey', 'scope', 'subjectKey', 'attributes'];

export class FeatureFlagService {
  readonly #repository: FeatureFlagRepository;
  readonly #clock: Clock;
  readonly #configuration: ConfigurationLookup;
  readonly #authority: FlagAdministrator;

  constructor(options: {
    readonly repository: FeatureFlagRepository;
    readonly clock: Clock;
    /** K-05, through its public contract. Defaults to resolving nothing, which fails closed. */
    readonly configuration?: ConfigurationLookup;
    /** Defaults to refusing every mutation. */
    readonly authority?: FlagAdministrator;
  }) {
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#configuration = options.configuration ?? NO_CONFIGURATION;
    this.#authority = options.authority ?? NO_ADMINISTRATION;
  }

  /**
   * Publish an immutable version of a flag's definition.
   *
   * Publishing does not turn anything on. A version becomes current only when it is activated,
   * which is a separate guarded step — so a definition can be written, reviewed and then switched
   * to in one atomic transition rather than existing half-live while somebody edits it.
   */
  async publish(request: PublishVersionRequest): Promise<PublishResult> {
    this.#checkRequest(request, PUBLISH_KEYS, 'publish');
    const author = this.#administrator();
    const flagKey = assertFlagKey(request.flagKey);
    const idempotencyKey = assertFlagIdentifier(request.idempotencyKey, 'idempotencyKey');

    return this.#repository.withTransaction(async (tx) => {
      await this.#refuseTerminated(tx, flagKey, 'publish a version of');

      const nextVersion = (await tx.highestVersion(flagKey)) + 1;
      const candidate = validateFlagVersion(
        {
          flagVersionId: request.flagVersionId,
          flagKey,
          version: nextVersion,
          state: request.state,
          supportedScopes: request.supportedScopes,
          rules: request.rules ?? [],
          percentage: request.percentage ?? 0,
          rolloutSalt: request.rolloutSalt,
          notBefore: request.notBefore ?? null,
          notAfter: request.notAfter ?? null,
          publishedAt: this.#clock.now(),
          publishedBy: author,
          idempotencyKey,
          requestFingerprint: fingerprintVersionRequest(
            versionFacts(request, flagKey, author.id, nextVersion),
          ),
        },
        'request',
      );

      const existing = await tx.findVersionByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        assertSameVersionRequest(existing, candidate);
        return { version: sealFlagVersion(existing), deduplicated: true };
      }

      await tx.insertVersion(candidate);
      return { version: sealFlagVersion(candidate), deduplicated: false };
    });
  }

  /**
   * Make a published version the current one, guarded against a concurrent activation.
   *
   * The guard is the whole point. Two operators reacting to the same incident read the same
   * current version and both activate; without `supersedesVersionId` both writes succeed and the
   * flag's history says two versions took effect at once, with no way to tell which one served
   * traffic. With it, the second is refused as stale and its operator re-reads.
   */
  async activate(request: ActivateRequest): Promise<ActivateResult> {
    this.#checkRequest(request, ACTIVATE_KEYS, 'activate');
    const author = this.#administrator();
    const flagVersionId = assertFlagIdentifier(request.flagVersionId, 'flagVersionId');
    const idempotencyKey = assertFlagIdentifier(request.idempotencyKey, 'idempotencyKey');
    const supersedes =
      request.supersedesVersionId === null || request.supersedesVersionId === undefined
        ? null
        : assertFlagIdentifier(request.supersedesVersionId, 'supersedesVersionId');

    return this.#repository.withTransaction(async (tx) => {
      const target = await tx.findVersionById(flagVersionId);
      if (target === null) {
        throw new FeatureFlagError(
          'no-such-flag-version',
          `flag version ${flagVersionId} does not exist. Publish it before activating it`,
        );
      }
      await this.#refuseTerminated(tx, target.flagKey, 'activate a version of');

      const candidate = validateActivation(
        {
          activationId: request.activationId,
          flagKey: target.flagKey,
          flagVersionId,
          supersedesVersionId: supersedes,
          activatedAt: this.#clock.now(),
          activatedBy: author,
          idempotencyKey,
          requestFingerprint: fingerprintTransitionRequest({
            operation: 'activate',
            recordId: request.activationId,
            flagKey: target.flagKey,
            detail: flagVersionId,
            supersedesVersionId: supersedes,
            authorityId: author.id,
          }),
        },
        'request',
      );

      const existing = await tx.findActivationByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        assertSameTransition(
          existing.requestFingerprint,
          candidate.requestFingerprint,
          'activation',
        );
        return { activation: sealActivation(existing), deduplicated: true };
      }

      await tx.insertActivation(candidate);
      return { activation: sealActivation(candidate), deduplicated: false };
    });
  }

  /**
   * The emergency stop of v3 §36.
   *
   * One insert, no publication, no activation — because an operator stopping autonomous purchasing
   * at two in the morning should not have to compose a definition first. It outranks every version
   * in `decide.ts`, and it cannot be undone here: restoring a killed feature means a new flag key,
   * which is deliberate, because a kill switch somebody can quietly lift is not one.
   */
  kill(request: TerminateRequest): Promise<TerminateResult> {
    return this.#terminate(request, 'kill');
  }

  /** The orderly end of a flag's life. Also terminal: a retired key is never republished. */
  retire(request: TerminateRequest): Promise<TerminateResult> {
    return this.#terminate(request, 'retire');
  }

  /**
   * Is this flag on, for this scope and this subject, right now?
   *
   * Reads the active version and the lifecycle rows in one transaction, resolves the deployment
   * stage through K-05's public contract when — and only when — the version is `internal-only`,
   * and hands all of it to the pure evaluator. Nothing is written.
   */
  async evaluate(request: EvaluateRequest): Promise<Evaluation> {
    this.#checkRequest(request, EVALUATE_KEYS, 'evaluate');
    const flagKey = assertFlagKey(request.flagKey);
    const scope = request.scope === undefined ? GLOBAL_SCOPE : assertScope(request.scope);
    const attributes = assertContext(request.attributes);
    const subjectKey =
      request.subjectKey === null || request.subjectKey === undefined
        ? null
        : assertFlagIdentifier(request.subjectKey, 'subjectKey');

    const { version, lifecycle } = await this.#repository.withTransaction(async (tx) => {
      const events = await tx.listLifecycleEvents(flagKey);
      const current = await tx.findCurrentActivation(flagKey);
      const active = current === null ? null : await tx.findVersionById(current.flagVersionId);
      return { version: active, lifecycle: events };
    });

    const input: EvaluationInput = {
      flagKey,
      version,
      lifecycle,
      scope,
      subjectKey,
      attributes,
      now: this.#clock.now(),
      deploymentStage:
        version?.state === 'internal-only' ? await this.#deploymentStage(scope) : null,
    };
    return evaluate(input);
  }

  // -------------------------------------------------------------------------

  /**
   * The author of every write, from the injected authority rather than from the request.
   *
   * Recorded as a `system` origin: this authority is a deployment-level capability, not a person.
   * When K-02 and K-04 are wired (CONTRACT.md §9) the author becomes the authenticated
   * administrator and the kind becomes `human` — and that is a change to this method and to
   * nothing else, which is the reason the identity is derived in one place.
   */
  #administrator(): Origin {
    if (!this.#authority.permitsAdministration()) {
      throw new FeatureFlagError(
        'administration-refused',
        'no administration authority was injected, so nothing may publish, activate, kill or ' +
          'retire a flag. The default refuses on purpose: a flag service that anybody reaching it ' +
          'could change is a switch on every guarded code path in the platform',
      );
    }
    return { kind: 'system', id: this.#authority.authorityId };
  }

  #checkRequest(request: object, known: readonly string[], operation: string): void {
    if (request === null || typeof request !== 'object') {
      throw new FeatureFlagError('malformed-record', `${operation} needs a request object`);
    }
    // Asserted outcomes first: a request trying to state the answer must be refused by name
    // before anything else looks at it, so the refusal says what was actually wrong.
    assertNoAssertedOutcome(request, operation);
    assertKnownFields(request, known, operation);
  }

  /** A killed or retired flag accepts no further writes. Terminal means terminal. */
  async #refuseTerminated(
    tx: { listLifecycleEvents(flagKey: string): Promise<readonly LifecycleEvent[]> },
    flagKey: string,
    attempt: string,
  ): Promise<void> {
    const events = await tx.listLifecycleEvents(flagKey);
    const terminal = events[0];
    if (terminal !== undefined) {
      throw new FeatureFlagError(
        'flag-terminated',
        `${flagKey} was ${terminalWord(terminal.kind)} at ${terminal.recordedAt}, so nothing may ` +
          `${attempt} it. Reversing that through a new definition would make the stop advisory`,
      );
    }
  }

  async #terminate(request: TerminateRequest, kind: LifecycleKind): Promise<TerminateResult> {
    this.#checkRequest(request, TERMINATE_KEYS, kind);
    const author = this.#administrator();
    const flagKey = assertFlagKey(request.flagKey);
    const idempotencyKey = assertFlagIdentifier(request.idempotencyKey, 'idempotencyKey');

    return this.#repository.withTransaction(async (tx) => {
      const candidate = validateLifecycleEvent(
        {
          eventId: request.eventId,
          flagKey,
          kind,
          reason: request.reason,
          recordedAt: this.#clock.now(),
          recordedBy: author,
          idempotencyKey,
          requestFingerprint: fingerprintTransitionRequest({
            operation: kind,
            recordId: request.eventId,
            flagKey,
            detail: typeof request.reason === 'string' ? request.reason : '',
            supersedesVersionId: null,
            authorityId: author.id,
          }),
        },
        'request',
      );

      const existing = await tx.findLifecycleEventByIdempotencyKey(idempotencyKey);
      if (existing !== null) {
        assertSameTransition(existing.requestFingerprint, candidate.requestFingerprint, kind);
        return { event: sealLifecycleEvent(existing), deduplicated: true };
      }

      await tx.insertLifecycleEvent(candidate);
      return { event: sealLifecycleEvent(candidate), deduplicated: false };
    });
  }

  /** K-05, through its public contract and nothing else. An unresolvable stage is `null`. */
  async #deploymentStage(scope: Scope): Promise<DeploymentStage | null> {
    try {
      const resolved = await this.#configuration.resolve({
        key: DEPLOYMENT_STAGE_KEY,
        scope: scope.level === 'global' ? GLOBAL_SCOPE : scope,
      });
      return resolved === null ? null : asDeploymentStage(resolved.value);
    } catch {
      // K-05 refusing is not this component's error to raise, and it is certainly not a reason to
      // treat an unknown deployment as internal. Fail closed and say so in the explanation.
      return null;
    }
  }
}

function versionFacts(
  request: PublishVersionRequest,
  flagKey: string,
  authorityId: string,
  version: number,
): VersionRequestFacts {
  return {
    flagVersionId: String(request.flagVersionId),
    flagKey,
    version,
    state: String(request.state),
    supportedScopes: (request.supportedScopes ?? []).map(String),
    // Fingerprinted from the validated tree would be circular — validation happens after — so the
    // canonical form takes what the caller sent. Anything malformed is refused before it is used.
    rules: [],
    percentage: request.percentage ?? 0,
    rolloutSalt: String(request.rolloutSalt),
    notBefore: request.notBefore ?? null,
    notAfter: request.notAfter ?? null,
    authorityId,
  };
}

/**
 * A retry converges only on a complete match.
 *
 * Compared field by field rather than by fingerprint alone, so a mismatch can say *which* input
 * moved: an operator who reused a key while changing the percentage should be told that, not told
 * that two hashes differ.
 */
function assertSameVersionRequest(existing: FlagVersion, incoming: FlagVersion): void {
  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (JSON.stringify(was) !== JSON.stringify(now)) differences.push(field);
  };

  compare('flagVersionId', existing.flagVersionId, incoming.flagVersionId);
  compare('flagKey', existing.flagKey, incoming.flagKey);
  compare('state', existing.state, incoming.state);
  compare('supportedScopes', existing.supportedScopes, incoming.supportedScopes);
  compare('rules', existing.rules, incoming.rules);
  compare('percentage', existing.percentage, incoming.percentage);
  compare('rolloutSalt', existing.rolloutSalt, incoming.rolloutSalt);
  compare('notBefore', existing.notBefore, incoming.notBefore);
  compare('notAfter', existing.notAfter, incoming.notAfter);
  compare('publishedBy', existing.publishedBy, incoming.publishedBy);
  // `publishedAt` is service-generated and deliberately excluded: comparing it would make every
  // retry a mismatch and idempotency impossible. `version` is derived from the store, so a genuine
  // retry after the first insert would compute a higher one — the fingerprint below is what
  // actually binds the request, and it does not include the derived number.

  if (differences.length === 0) return;
  throw new FeatureFlagError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" published version ${existing.version} of ` +
      `${existing.flagKey}; this request differs in ${differences.join(', ')}. A key identifies ` +
      'one intent — reusing it for a different definition would return the wrong answer to a ' +
      'caller who believes it retried',
  );
}

function assertSameTransition(existing: string, incoming: string, what: string): void {
  if (existing === incoming) return;
  throw new FeatureFlagError(
    'idempotency-key-reuse',
    `this idempotency key recorded a different ${what}. A key identifies one intent, and ` +
      'returning the earlier record for a different request would tell the caller something ' +
      'happened that did not',
  );
}

export type { TransitionRequestFacts, VersionRequestFacts };
