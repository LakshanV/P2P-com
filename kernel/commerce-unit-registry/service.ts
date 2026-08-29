/**
 * K-11 Commerce Unit Registry — the service (FND-005c).
 *
 * Four operations: publish a type version, activate one, retire a type, resolve. Three write and
 * one does not, and the one that does not is the one every listing, search and commission rule
 * will use.
 *
 * **The registry is the platform's shared vocabulary, so it refuses rather than guesses.** A
 * missing parent, a cycle, a chain deeper than the bound, a cross-tenant edge, a unit the kind does
 * not permit, a version outside its window — each is a refusal, not a best guess. Everything
 * downstream believes what a registry says: a guessed lineage becomes a risk pack that silently
 * stops applying, and a guessed unit becomes a price nobody can interpret.
 *
 * **The caller never states the answer, and never states the derived hierarchy.** `ancestry`,
 * `depth`, `path` and `root` are computed by walking the activation chain; a caller that could
 * supply one could describe a category as descending from something it does not, which every
 * category rule downstream would then act on. And no mutation request carries an author: the
 * identity, *and the owner scope it may write for*, come from the injected `RegistrarAuthority`,
 * which defaults to refusing. K-04 shipped with authorship as a request field and any caller could
 * sign a change in somebody else's name (CURRENT_IMPLEMENTATION_STATUS §11.28).
 *
 * **K-11 decides nothing about policy, money or language.** It stores a K-06 policy *key* and pins
 * the *version id* K-06 has in force at activation — provenance and nothing else. It holds no
 * price, no currency, no conversion factor and no display text.
 *
 * Owned by: K-11 Commerce Unit Registry. No API, no UI, no catalogue console — see CONTRACT.md §9.
 */

import { assertEffective, explain, resolveAncestry, type InForce } from './hierarchy.ts';
import {
  fingerprintTransitionRequest,
  fingerprintVersionRequest,
  type VersionRequestFacts,
} from './fingerprint.ts';
import { sealActivation, sealResolved, sealRetirement, sealVersion } from './immutable.ts';
import {
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
import {
  makeCommerceUnitActivatedAction,
  makeCommerceUnitActivatedEvent,
  makeCommerceUnitRetiredAction,
  makeCommerceUnitRetiredEvent,
  makeCommerceUnitVersionPublishedAction,
  makeCommerceUnitVersionPublishedEvent,
} from './outbox.ts';
import {
  assertKnownFields,
  assertNoAssertedOutcome,
  assertNoPinnedVersion,
  assertOwner,
  assertTypeKey,
  assertUnitIdentifier,
} from './registry.ts';
import type { CommerceUnitRepository, CommerceUnitTransaction } from './repository.ts';
import {
  CommerceUnitError,
  UNIT_KINDS,
  ownerKey,
  sameOwner,
  type Origin,
  type OwnerScope,
  type ResolvedUnitType,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';
import { validateActivation, validateRetirement, validateUnitTypeVersion } from './validate.ts';

export interface PublishTypeRequest {
  readonly typeVersionId: string;
  readonly typeKey: string;
  readonly kind: string;
  readonly parentTypeKey?: string | null;
  readonly measures: readonly unknown[];
  readonly riskPolicyKey?: string | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveUntil?: string | null;
  readonly idempotencyKey: string;
  /** Ties this change to a causal chain. Defaults to the type version id. */
  readonly correlationId?: string;
  /** The event or record that caused this one, or null when it starts the chain. */
  readonly causationId?: string | null;
}

export interface ActivateTypeRequest {
  readonly activationId: string;
  readonly typeVersionId: string;
  /**
   * The version this replaces, or null for a type's first activation.
   *
   * Required rather than inferred. An activation that read the version in force for itself would
   * be a read-then-write, and two registrars acting on the same category would both win.
   */
  readonly supersedesVersionId: string | null;
  readonly idempotencyKey: string;
  /** Ties this change to a causal chain. Defaults to the activation id. */
  readonly correlationId?: string;
  /** The event or record that caused this one, or null when it starts the chain. */
  readonly causationId?: string | null;
}

export interface RetireTypeRequest {
  readonly retirementId: string;
  readonly typeKey: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  /** Ties this change to a causal chain. Defaults to the retirement id. */
  readonly correlationId?: string;
  /** The event or record that caused this one, or null when it starts the chain. */
  readonly causationId?: string | null;
}

/** What a caller may ask. Note what is not here: the lineage, and the answer. */
export interface ResolveRequest {
  readonly typeKey: string;
  /** The instant to resolve as of. Defaults to now; supplied when reading a historic listing. */
  readonly at?: string;
}

export interface PublishResult {
  readonly version: UnitTypeVersion;
  readonly deduplicated: boolean;
}

export interface ActivateResult {
  readonly activation: UnitTypeActivation;
  readonly deduplicated: boolean;
}

export interface RetireResult {
  readonly retirement: UnitTypeRetirement;
  readonly deduplicated: boolean;
}

const PUBLISH_KEYS: readonly string[] = [
  'typeVersionId',
  'typeKey',
  'kind',
  'parentTypeKey',
  'measures',
  'riskPolicyKey',
  'effectiveFrom',
  'effectiveUntil',
  'idempotencyKey',
  'correlationId',
  'causationId',
];

const ACTIVATE_KEYS: readonly string[] = [
  'activationId',
  'typeVersionId',
  'supersedesVersionId',
  'idempotencyKey',
  'correlationId',
  'causationId',
];

const RETIRE_KEYS: readonly string[] = [
  'retirementId',
  'typeKey',
  'reason',
  'idempotencyKey',
  'correlationId',
  'causationId',
];

const RESOLVE_KEYS: readonly string[] = ['typeKey', 'at'];

/** The conflicts that mean "somebody else got there first", and so may converge. */
const RECOVERABLE: readonly string[] = [
  'duplicate-type-version',
  'duplicate-activation',
  'duplicate-retirement',
  'idempotency-key-reuse',
];

export class CommerceUnitRegistryService {
  readonly #repository: CommerceUnitRepository;
  readonly #clock: Clock;
  readonly #configuration: ConfigurationLookup;
  readonly #policy: PolicyProvenance;
  readonly #registrar: RegistrarAuthority;

  constructor(options: {
    readonly repository: CommerceUnitRepository;
    readonly clock: Clock;
    /** K-05, through its public contract. Defaults to resolving nothing, which permits no kind. */
    readonly configuration?: ConfigurationLookup;
    /** K-06, through its public contract, for provenance only. */
    readonly policy?: PolicyProvenance;
    /** Defaults to refusing every mutation. */
    readonly registrar?: RegistrarAuthority;
  }) {
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#configuration = options.configuration ?? NO_CONFIGURATION;
    this.#policy = options.policy ?? NO_POLICY_PROVENANCE;
    this.#registrar = options.registrar ?? NO_REGISTRAR;
  }

  /**
   * Publish an immutable version of a type's definition.
   *
   * Publishing does not put anything in force, and it does not resolve the hierarchy: the parent
   * is checked at **activation**, because a parent that exists now may be retired before the child
   * goes live, and the moment that matters is the one where the type starts describing listings.
   */
  async publish(request: PublishTypeRequest): Promise<PublishResult> {
    this.#checkRequest(request, PUBLISH_KEYS, 'publish');
    const author = this.#registrarIdentity();
    const owner: OwnerScope = this.#registrar.owner;
    const typeKey = assertTypeKey(request.typeKey);
    const idempotencyKey = assertUnitIdentifier(request.idempotencyKey, 'idempotencyKey');

    await this.#assertKindPermitted(request.kind);

    const candidate = validateUnitTypeVersion(
      {
        typeVersionId: request.typeVersionId,
        typeKey,
        version: 1,
        kind: request.kind,
        owner: assertOwner(owner),
        parentTypeKey: request.parentTypeKey ?? null,
        measures: request.measures,
        riskPolicyKey: request.riskPolicyKey ?? null,
        effectiveFrom: request.effectiveFrom ?? null,
        effectiveUntil: request.effectiveUntil ?? null,
        publishedAt: this.#clock.now(),
        publishedBy: author,
        idempotencyKey,
        requestFingerprint: 'f'.repeat(64),
      },
      'request',
    );
    // Fingerprinted from the *validated* content, so two requests differing only in the order the
    // measures were written are the same request, and two differing in a parent are not.
    const fingerprint = fingerprintVersionRequest(versionFacts(candidate, author.id));

    return this.#write(
      async (tx) => {
        const existing = await tx.findVersionByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, fingerprint, 'type version');
          return { version: sealVersion(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, typeKey, 'publish a version of');

        const version = sealVersion({
          ...candidate,
          version: (await tx.highestVersion(typeKey)) + 1,
          requestFingerprint: fingerprint,
        });
        await tx.insertVersion(version);

        const correlationId = request.correlationId ?? version.typeVersionId;
        const causationId = request.causationId ?? null;
        await tx.insertOutbox(
          makeCommerceUnitVersionPublishedEvent(version, correlationId, causationId),
        );
        await tx.insertOutbox(
          makeCommerceUnitVersionPublishedAction(version, correlationId, causationId),
        );

        return { version, deduplicated: false };
      },
      () =>
        this.#repository.withTransaction((tx) => tx.findVersionByIdempotencyKey(idempotencyKey)),
      (found) => {
        assertSameFingerprint(found.requestFingerprint, fingerprint, 'type version');
        return { version: sealVersion(found), deduplicated: true };
      },
    );
  }

  /**
   * Put a published version in force, guarded and with its lineage checked.
   *
   * This is where the hierarchy is resolved, where the cross-owner rule is enforced, and where the
   * K-06 risk-policy version is pinned. All three belong here rather than at publication because
   * this is the moment the type begins describing real listings — a lineage that was valid when
   * somebody drafted the type is not evidence that it is valid now.
   */
  async activate(request: ActivateTypeRequest): Promise<ActivateResult> {
    this.#checkRequest(request, ACTIVATE_KEYS, 'activate');
    const author = this.#registrarIdentity();
    const typeVersionId = assertUnitIdentifier(request.typeVersionId, 'typeVersionId');
    const idempotencyKey = assertUnitIdentifier(request.idempotencyKey, 'idempotencyKey');
    const supersedes =
      request.supersedesVersionId === null || request.supersedesVersionId === undefined
        ? null
        : assertUnitIdentifier(request.supersedesVersionId, 'supersedesVersionId');

    const at = this.#clock.now();
    let fingerprint: string | null = null;

    return this.#write(
      async (tx) => {
        const target = await tx.findVersionById(typeVersionId);
        if (target === null) {
          throw new CommerceUnitError(
            'no-such-version',
            `type version ${typeVersionId} does not exist. Publish it before activating it`,
          );
        }
        this.#assertMayAdminister(target.owner, 'activate');

        fingerprint = fingerprintTransitionRequest({
          operation: 'activate',
          recordId: String(request.activationId),
          typeKey: target.typeKey,
          detail: typeVersionId,
          supersedesVersionId: supersedes,
          authorityId: author.id,
        });

        const existing = await tx.findActivationByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, fingerprint, 'activation');
          return { activation: sealActivation(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, target.typeKey, 'activate a version of');

        // The lineage, checked against what is in force *now*. `resolveAncestry` refuses a cycle,
        // a missing parent, a chain past the bound and a cross-owner edge.
        const inForce = await this.#inForceIndex(tx);
        resolveAncestry(target, (key) => inForce.get(key), at);

        const riskPolicyVersionId =
          target.riskPolicyKey === null
            ? null
            : (await this.#policy.evaluate({ policyKey: target.riskPolicyKey, at }))
                .policyVersionId;

        const candidate = validateActivation(
          {
            activationId: request.activationId,
            typeKey: target.typeKey,
            typeVersionId,
            supersedesVersionId: supersedes,
            riskPolicyVersionId,
            activatedAt: at,
            activatedBy: author,
            idempotencyKey,
            requestFingerprint: fingerprint,
          },
          'request',
        );
        await tx.insertActivation(candidate);

        const correlationId = request.correlationId ?? candidate.activationId;
        const causationId = request.causationId ?? null;
        await tx.insertOutbox(
          makeCommerceUnitActivatedEvent(candidate, correlationId, causationId),
        );
        await tx.insertOutbox(
          makeCommerceUnitActivatedAction(candidate, correlationId, causationId),
        );

        return { activation: sealActivation(candidate), deduplicated: false };
      },
      () =>
        this.#repository.withTransaction((tx) => tx.findActivationByIdempotencyKey(idempotencyKey)),
      (found) => {
        if (fingerprint === null) {
          throw new CommerceUnitError('malformed-record', 'nothing to converge on');
        }
        assertSameFingerprint(found.requestFingerprint, fingerprint, 'activation');
        return { activation: sealActivation(found), deduplicated: true };
      },
    );
  }

  /**
   * End a type's life.
   *
   * Terminal and appended. It stops new listings being described by the type; it does not remove
   * the versions existing listings already reference, because a retired category whose history
   * vanished would make every record that used it unreadable.
   */
  async retire(request: RetireTypeRequest): Promise<RetireResult> {
    this.#checkRequest(request, RETIRE_KEYS, 'retire');
    const author = this.#registrarIdentity();
    const typeKey = assertTypeKey(request.typeKey);
    const idempotencyKey = assertUnitIdentifier(request.idempotencyKey, 'idempotencyKey');

    const candidate = validateRetirement(
      {
        retirementId: request.retirementId,
        typeKey,
        reason: request.reason,
        retiredAt: this.#clock.now(),
        retiredBy: author,
        idempotencyKey,
        requestFingerprint: fingerprintTransitionRequest({
          operation: 'retire',
          recordId: String(request.retirementId),
          typeKey,
          detail: typeof request.reason === 'string' ? request.reason : '',
          supersedesVersionId: null,
          authorityId: author.id,
        }),
      },
      'request',
    );

    return this.#write(
      async (tx) => {
        const existing = await tx.findRetirementByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(
            existing.requestFingerprint,
            candidate.requestFingerprint,
            'retirement',
          );
          return { retirement: sealRetirement(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, typeKey, 'retire');

        // Retiring somebody else's category is the isolation failure that matters most: it stops
        // listings a different owner is responsible for.
        const current = await tx.findCurrentActivation(typeKey);
        if (current !== null) {
          const version = await tx.findVersionById(current.typeVersionId);
          if (version !== null) this.#assertMayAdminister(version.owner, 'retire');
        }

        await tx.insertRetirement(candidate);

        const correlationId = request.correlationId ?? candidate.retirementId;
        const causationId = request.causationId ?? null;
        await tx.insertOutbox(makeCommerceUnitRetiredEvent(candidate, correlationId, causationId));
        await tx.insertOutbox(makeCommerceUnitRetiredAction(candidate, correlationId, causationId));

        return { retirement: sealRetirement(candidate), deduplicated: false };
      },
      () =>
        this.#repository.withTransaction((tx) => tx.findRetirementByIdempotencyKey(idempotencyKey)),
      (found) => {
        assertSameFingerprint(found.requestFingerprint, candidate.requestFingerprint, 'retirement');
        return { retirement: sealRetirement(found), deduplicated: true };
      },
    );
  }

  /**
   * What is this type, as of this instant — and what does it descend from?
   *
   * Reads the in-force set in one transaction and walks it purely. Nothing is written: this sits on
   * the path of every listing that names a category, and a component that wrote a row per read
   * would be a write there.
   */
  async resolve(request: ResolveRequest): Promise<ResolvedUnitType> {
    // Named first, and only here: supplying a version id is an ordinary input to publish and
    // activate, and an attempt to choose your own definition on resolve, so the pointed refusal
    // has to come before the generic unknown-field one.
    assertNoPinnedVersion(request);
    this.#checkRequest(request, RESOLVE_KEYS, 'resolve');
    const typeKey = assertTypeKey(request.typeKey);
    const at = request.at === undefined ? this.#clock.now() : String(request.at);

    const { inForce, retired } = await this.#repository.withTransaction(async (tx) => {
      const retirement = await tx.findRetirement(typeKey);
      return { inForce: await this.#inForceIndex(tx), retired: retirement };
    });

    if (retired !== null) {
      throw new CommerceUnitError(
        'type-retired',
        `${typeKey} was retired at ${retired.retiredAt} and describes nothing further. The ` +
          'versions it published remain readable, because listings created under them still ' +
          'reference them',
      );
    }

    const found = inForce.get(typeKey);
    if (found === undefined) {
      throw new CommerceUnitError(
        'no-such-type',
        `no version of ${typeKey} is in force. A category nobody activated describes nothing, and ` +
          'answering anyway would put a vocabulary entry into a listing that no version defines',
      );
    }

    assertEffective(found.version, at, true);
    const ancestry = resolveAncestry(found.version, (key) => inForce.get(key), at);

    return sealResolved({
      typeKey,
      typeVersionId: found.version.typeVersionId,
      version: found.version.version,
      kind: found.version.kind,
      owner: found.version.owner,
      measures: found.version.measures,
      ancestry,
      riskPolicyKey: found.version.riskPolicyKey,
      riskPolicyVersionId: found.riskPolicyVersionId,
      resolvedAt: at,
      explanation: explain(found.version, ancestry, found.riskPolicyVersionId),
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The author of every write, from the injected authority rather than from the request.
   *
   * Recorded as a `system` origin: this authority is a deployment capability, not a person. When
   * K-02 and K-04 are wired (CONTRACT.md §9) the author becomes the authenticated registrar and
   * the kind becomes `human` — a change to this method and to nothing else.
   */
  #registrarIdentity(): Origin {
    if (!this.#registrar.permitsRegistration()) {
      throw new CommerceUnitError(
        'registration-refused',
        'no registrar authority was injected, so nothing may publish, activate or retire a ' +
          'commerce unit type. The default refuses on purpose: the registry is the vocabulary ' +
          'every listing, risk pack and commission rule keys off, and a caller who could change ' +
          'it by reaching the service could change what the platform believes it is selling',
      );
    }
    return { kind: 'system', id: this.#registrar.authorityId };
  }

  /** A registrar writes for its own scope and no other. This is the isolation rule at the boundary. */
  #assertMayAdminister(target: OwnerScope, attempt: string): void {
    const actor: OwnerScope = this.#registrar.owner;
    if (sameOwner(actor, target)) return;
    throw new CommerceUnitError(
      'cross-owner-relationship',
      `a registrar for ${ownerKey(actor)} may not ${attempt} a type owned by ${ownerKey(target)}. ` +
        'A tenant that could retire the platform vocabulary — or another tenant’s — would stop ' +
        'listings it is not responsible for',
    );
  }

  #checkRequest(request: object, known: readonly string[], operation: string): void {
    if (request === null || typeof request !== 'object') {
      throw new CommerceUnitError('malformed-record', `${operation} needs a request object`);
    }
    // Asserted outcomes first: a request trying to state the lineage must be refused by name
    // before anything else looks at it, so the refusal says what was actually wrong.
    assertNoAssertedOutcome(request, operation);
    assertKnownFields(request, known, operation);
  }

  /** v3 §11's "other future permitted category" is a deployment decision, resolved through K-05. */
  async #assertKindPermitted(kind: unknown): Promise<void> {
    if (typeof kind !== 'string' || !(UNIT_KINDS as readonly string[]).includes(kind)) return;

    const resolved = await this.#configuration.resolve({
      key: PERMITTED_KINDS_KEY,
      scope: { level: 'global', id: '' },
      at: this.#clock.now(),
    });
    const permitted = asPermittedKinds(resolved.value);
    if (permitted === null) {
      throw new CommerceUnitError(
        'unsupported-kind',
        `K-05 returned no usable list for "${PERMITTED_KINDS_KEY}", so no kind can be confirmed ` +
          'as permitted. K-11 refuses rather than defaulting: a category nobody sanctioned is ' +
          'inherited by every listing created under it',
      );
    }
    if (!permitted.includes(kind as (typeof UNIT_KINDS)[number])) {
      throw new CommerceUnitError(
        'unsupported-kind',
        `"${kind}" is one of v3 §11's kinds but this deployment does not permit it. Permitted: ` +
          `${permitted.join(', ')}. Which kinds a marketplace trades in is configuration, not code`,
      );
    }
  }

  /** A retired type accepts no further writes. Terminal means terminal. */
  async #refuseRetired(
    tx: Pick<CommerceUnitTransaction, 'findRetirement'>,
    typeKey: string,
    attempt: string,
  ): Promise<void> {
    const retirement = await tx.findRetirement(typeKey);
    if (retirement !== null) {
      throw new CommerceUnitError(
        'type-retired',
        `${typeKey} was retired at ${retirement.retiredAt}, so nothing may ${attempt} it now. ` +
          'Reviving it through a new version would make the retirement advisory, and the listings ' +
          'created before it would no longer sit at the end of a closed history',
      );
    }
  }

  /**
   * The in-force set as a map, which is what a pure ancestry walk needs.
   *
   * **This is a trust boundary, and it is the last one.** The repository is an injected port: the
   * PostgreSQL adapter validates what it decodes, but the port also admits the in-memory
   * implementation, a future enlisted one, and whatever a caller passes to the constructor. What
   * arrives here is a claim about which definition describes every listing in the platform, and
   * everything downstream — the ancestry walk, the effective-window check, the risk pack a
   * category resolves to — believes it without re-deriving any of it.
   *
   * A `new Map(rows.map(…))` believed all of it. Four ways that reads as an answer rather than as
   * a fault, each of which resolves *successfully* to the wrong thing:
   *
   *   - **A record that is not one this component writes.** An unvalidated version carries any
   *     `kind`, any `measures`, any owner — a category nobody registered, copied into every
   *     listing created under it. So both records go back through the same validators that judge
   *     them on the way in, as `stored row`.
   *   - **An activation paired with a version it does not name.** The map was keyed on the
   *     *version's* type key while the risk policy id came from the *activation*, so a mismatched
   *     pair filed one category's definition under another's name, with a third's policy pinned to
   *     it — and the type that should have been there vanishes from the set, which reads as
   *     `no-such-type`: never registered.
   *   - **Two rows for one type key.** `Map.set` keeps the last silently. Which of two definitions
   *     described a listing would then depend on row order, decided per read.
   *   - **One activation or one version appearing twice.** The chain says a version is in force
   *     for two types at once, or one activation put two versions in force. Neither is a history
   *     anything can be resolved against.
   *
   * Every one of them is `malformed-record`, which is deliberately not in `RECOVERABLE`: a store
   * that contradicts itself must not be converged on by a retry.
   */
  async #inForceIndex(tx: CommerceUnitTransaction): Promise<Map<string, InForce>> {
    // Taken as `unknown` on purpose. The port's return type is a promise this method is here to
    // stop believing, and typing the local by that promise would hide the checks below behind a
    // compiler guarantee that holds for the two implementations in this repository and for no
    // injected one.
    const returned: unknown = await tx.listInForce();
    if (!Array.isArray(returned)) {
      throw new CommerceUnitError(
        'malformed-record',
        'the repository answered the in-force set with something that is not a list of rows',
      );
    }

    const index = new Map<string, InForce>();
    const activationIds = new Map<string, string>();
    const versionIds = new Map<string, string>();

    for (const entry of returned as readonly unknown[]) {
      if (entry === null || typeof entry !== 'object') {
        throw new CommerceUnitError(
          'malformed-record',
          `the in-force set holds ${entry === null ? 'null' : typeof entry} where a version and ` +
            'the activation putting it in force belong',
        );
      }
      const row = entry as { readonly activation?: unknown; readonly version?: unknown };

      const activation = validateActivation(row.activation, 'stored row');
      const version = sealVersion(validateUnitTypeVersion(row.version, 'stored row'));

      if (activation.typeVersionId !== version.typeVersionId) {
        throw new CommerceUnitError(
          'malformed-record',
          `activation ${activation.activationId} puts version ${activation.typeVersionId} in ` +
            `force and was paired with version ${version.typeVersionId}. The pair decides which ` +
            'definition describes every listing under this category, and two halves naming ' +
            'different versions decide nothing',
        );
      }
      if (activation.typeKey !== version.typeKey) {
        throw new CommerceUnitError(
          'malformed-record',
          `activation ${activation.activationId} is for ${activation.typeKey} and its version ` +
            `${version.typeVersionId} belongs to ${version.typeKey}. Filing it would answer for ` +
            `one category with another one’s definition, and lose ${activation.typeKey} from the ` +
            'set entirely — which reads as a category nobody ever registered',
        );
      }

      if (index.has(version.typeKey)) {
        throw new CommerceUnitError(
          'malformed-record',
          `${version.typeKey} appears twice in the in-force set. Only one version of a type is ` +
            'ever in force, and keeping the second would decide by row order which definition ' +
            'described every listing created since',
        );
      }
      const activationSeen = activationIds.get(activation.activationId);
      if (activationSeen !== undefined) {
        throw new CommerceUnitError(
          'malformed-record',
          `activation ${activation.activationId} appears twice in the in-force set, for ` +
            `${activationSeen} and for ${activation.typeKey}. One activation puts one version of ` +
            'one type in force',
        );
      }
      const versionSeen = versionIds.get(version.typeVersionId);
      if (versionSeen !== undefined) {
        throw new CommerceUnitError(
          'malformed-record',
          `version ${version.typeVersionId} is in force for ${versionSeen} and for ` +
            `${version.typeKey} at once. A version belongs to one type key, and a lineage walked ` +
            'through this set would find the same definition on two branches',
        );
      }

      activationIds.set(activation.activationId, activation.typeKey);
      versionIds.set(version.typeVersionId, version.typeKey);
      index.set(version.typeKey, {
        version,
        riskPolicyVersionId: activation.riskPolicyVersionId,
      });
    }

    return index;
  }

  /**
   * Run a mutation, converging if another copy of the same call got there first.
   *
   * The pre-insert lookup cannot see a row written by a transaction open at the same time, so the
   * convergence happens here — comparing exactly what a retry compares. A convergence that checked
   * less than a retry would be the same hole reached by another route.
   */
  async #write<T, R>(
    body: (tx: CommerceUnitTransaction) => Promise<T>,
    reread: () => Promise<R | null>,
    converge: (found: R) => T,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(body);
    } catch (error) {
      if (!(error instanceof CommerceUnitError) || !RECOVERABLE.includes(error.code)) throw error;
      let found: R | null;
      try {
        found = await reread();
      } catch {
        throw error;
      }
      if (found === null) throw error;
      return converge(found);
    }
  }
}

function versionFacts(version: UnitTypeVersion, authorityId: string): VersionRequestFacts {
  return {
    typeVersionId: version.typeVersionId,
    typeKey: version.typeKey,
    kind: version.kind,
    owner: version.owner,
    parentTypeKey: version.parentTypeKey,
    measures: version.measures,
    riskPolicyKey: version.riskPolicyKey,
    effectiveFrom: version.effectiveFrom,
    effectiveUntil: version.effectiveUntil,
    authorityId,
  };
}

/**
 * A retry converges only on an exact match of everything the request decided.
 *
 * Compared by fingerprint, which covers the whole definition: a registrar who reused a key while
 * changing a parent would otherwise be handed the version id of the category they did *not*
 * register, and would copy it into every listing created under it.
 */
function assertSameFingerprint(existing: string, incoming: string, what: string): void {
  if (existing === incoming) return;
  throw new CommerceUnitError(
    'idempotency-key-reuse',
    `this idempotency key recorded a different ${what}. A key identifies one intent — returning ` +
      'the earlier record for a changed request would hand back a type version id that does not ' +
      'describe the category asked for, and that id is copied into every listing that uses it',
  );
}
