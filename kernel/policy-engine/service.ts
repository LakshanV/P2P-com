/**
 * K-06 Policy Engine — the service (FND-005b).
 *
 * Five operations: draft, publish, activate, retire, evaluate. Four write and one does not, and the
 * one that does not is the one every financial module will use.
 *
 * **Every successful evaluation returns a policy version id, and there is no path that does not.**
 * v3 §35 requires historic transactions to retain the policy version originally applied; v3 §24
 * requires every transaction to store the exact commission policy version applied at purchase
 * time. Those are promises a caller can only keep if this component hands it something to store —
 * so `PolicyDecision.policyVersionId` is not optional, not nullable and not derivable later, and
 * when a `configured` output is read the **K-05 version id is pinned beside it** for the same
 * reason.
 *
 * **The lifecycle is explicit, and each step is a separate append.** Drafting writes a candidate
 * nothing can evaluate. Publishing turns a reviewed draft into a numbered immutable version, still
 * not in force. Activating puts one version in force, guarded so two operators cannot both win.
 * Retiring ends the policy's life without erasing the versions historic decisions are pinned to.
 * Four steps rather than one because the interesting failures happen between them: a policy edited
 * while live, two people changing the rate at once, a version withdrawn along with the evidence
 * for the transactions it priced.
 *
 * **The caller never states the answer, and never states who authored a change.** `outputs`,
 * `rate`, `commission`, `ruleId` and — most importantly — `policyVersionId` are refused by name; a
 * caller choosing the version that applied to its own transaction is v3 §24 read backwards. No
 * mutation request carries an author: the identity comes from the injected `PolicyAuthority`,
 * which defaults to refusing, because K-04 shipped with authorship as a request field and any
 * caller could sign a change in somebody else's name (§11.28).
 *
 * **Nothing here computes money.** K-06 returns "17.5000%" and the version that said so. K-10
 * Ledger foundation multiplies. A policy engine that did the arithmetic would be a second place
 * money is calculated, and v3 §38 wants exactly one.
 *
 * Owned by: K-06 Policy Engine. No API, no UI, no policy studio — see CONTRACT.md §9.
 */

import { assertFacts, select, staticOutput } from './decide.ts';
import {
  fingerprintDraftRequest,
  fingerprintTransitionRequest,
  type DraftRequestFacts,
} from './fingerprint.ts';
import { sealActivation, sealDraft, sealRetirement, sealVersion } from './immutable.ts';
import { NO_AUTHORITY, NO_CONFIGURATION, type Clock, type ConfigurationLookup, type PolicyAuthority } from './ports.ts';
import {
  assertKnownFields,
  assertNoAssertedOutcome,
  assertNoPinnedVersion,
  assertPolicyIdentifier,
  assertPolicyKey,
} from './registry.ts';
import type { PolicyRepository, PolicyTransaction } from './repository.ts';
import {
  PolicyError,
  type Origin,
  type OutputValue,
  type PolicyActivation,
  type PolicyDecision,
  type PolicyDraft,
  type PolicyRetirement,
  type PolicyVersion,
  type ResolvedOutput,
} from './types.ts';
import { validateActivation, validatePolicyDraft, validatePolicyVersion, validateRetirement } from './validate.ts';

export interface DraftPolicyRequest {
  readonly draftId: string;
  readonly policyKey: string;
  readonly outputSchema: Record<string, unknown>;
  readonly rules: readonly unknown[];
  readonly defaultOutputs?: Record<string, unknown> | null;
  readonly notes?: string;
  readonly idempotencyKey: string;
}

export interface PublishPolicyRequest {
  readonly policyVersionId: string;
  /** The draft being published. Its content is copied verbatim; nothing may be changed here. */
  readonly draftId: string;
  readonly effectiveFrom?: string | null;
  readonly effectiveUntil?: string | null;
  readonly idempotencyKey: string;
}

export interface ActivatePolicyRequest {
  readonly activationId: string;
  readonly policyVersionId: string;
  /**
   * The version this replaces, or null for a policy's first activation.
   *
   * Required rather than inferred. An activation that read the version in force for itself would
   * be a read-then-write, and two operators reacting to the same commercial decision would both win.
   */
  readonly supersedesVersionId: string | null;
  readonly idempotencyKey: string;
}

export interface RetirePolicyRequest {
  readonly retirementId: string;
  readonly policyKey: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** What a caller may ask. Note what is not here: the answer, and which version gave it. */
export interface EvaluateRequest {
  readonly policyKey: string;
  readonly facts?: Record<string, unknown>;
  /** The instant to decide as of. Defaults to now; supplied when replaying a historic decision. */
  readonly at?: string;
}

export interface DraftResult {
  readonly draft: PolicyDraft;
  readonly deduplicated: boolean;
}

export interface PublishResult {
  readonly version: PolicyVersion;
  readonly deduplicated: boolean;
}

export interface ActivateResult {
  readonly activation: PolicyActivation;
  readonly deduplicated: boolean;
}

export interface RetireResult {
  readonly retirement: PolicyRetirement;
  readonly deduplicated: boolean;
}

const DRAFT_KEYS: readonly string[] = [
  'draftId',
  'policyKey',
  'outputSchema',
  'rules',
  'defaultOutputs',
  'notes',
  'idempotencyKey',
];

const PUBLISH_KEYS: readonly string[] = [
  'policyVersionId',
  'draftId',
  'effectiveFrom',
  'effectiveUntil',
  'idempotencyKey',
];

const ACTIVATE_KEYS: readonly string[] = [
  'activationId',
  'policyVersionId',
  'supersedesVersionId',
  'idempotencyKey',
];

const RETIRE_KEYS: readonly string[] = ['retirementId', 'policyKey', 'reason', 'idempotencyKey'];

const EVALUATE_KEYS: readonly string[] = ['policyKey', 'facts', 'at'];

/** The conflicts that mean "somebody else got there first", and so may converge. */
const RECOVERABLE: readonly string[] = [
  'duplicate-draft',
  'duplicate-policy-version',
  'duplicate-activation',
  'duplicate-retirement',
  'idempotency-key-reuse',
];

export class PolicyService {
  readonly #repository: PolicyRepository;
  readonly #clock: Clock;
  readonly #configuration: ConfigurationLookup;
  readonly #authority: PolicyAuthority;

  constructor(options: {
    readonly repository: PolicyRepository;
    readonly clock: Clock;
    /** K-05, through its public contract. Defaults to resolving nothing, which fails closed. */
    readonly configuration?: ConfigurationLookup;
    /** Defaults to refusing every mutation. */
    readonly authority?: PolicyAuthority;
  }) {
    this.#repository = options.repository;
    this.#clock = options.clock;
    this.#configuration = options.configuration ?? NO_CONFIGURATION;
    this.#authority = options.authority ?? NO_AUTHORITY;
  }

  /**
   * Write a candidate policy.
   *
   * A draft is fully validated — schema, rules, decimals, precedence — so review happens against
   * something known to be well-formed, and so publication cannot fail on content. It is also
   * immutable: revising means drafting again, because a draft somebody edited during review is not
   * the thing that was reviewed.
   */
  async draft(request: DraftPolicyRequest): Promise<DraftResult> {
    this.#checkRequest(request, DRAFT_KEYS, 'draft');
    const author = this.#author();
    const policyKey = assertPolicyKey(request.policyKey);
    const idempotencyKey = assertPolicyIdentifier(request.idempotencyKey, 'idempotencyKey');

    const candidate = validatePolicyDraft(
      {
        draftId: request.draftId,
        policyKey,
        outputSchema: request.outputSchema,
        rules: request.rules,
        defaultOutputs: request.defaultOutputs ?? null,
        notes: request.notes ?? '',
        draftedAt: this.#clock.now(),
        draftedBy: author,
        idempotencyKey,
        requestFingerprint: 'f'.repeat(64),
      },
      'request',
    );
    // Fingerprinted from the *validated* content, so two requests that differ only in key order or
    // in how a decimal was spelled are the same request, and two that differ in a rate are not.
    const sealed = sealDraft({
      ...candidate,
      requestFingerprint: fingerprintDraftRequest(draftFacts(candidate, author.id)),
    });

    return this.#write(
      async (tx) => {
        await this.#refuseRetired(tx, policyKey, 'draft a policy for');
        const existing = await tx.findDraftByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, sealed.requestFingerprint, 'draft');
          return { draft: sealDraft(existing), deduplicated: true };
        }
        await tx.insertDraft(sealed);
        return { draft: sealed, deduplicated: false };
      },
      () => this.#repository.withTransaction((tx) => tx.findDraftByIdempotencyKey(idempotencyKey)),
      (found) => {
        assertSameFingerprint(found.requestFingerprint, sealed.requestFingerprint, 'draft');
        return { draft: sealDraft(found), deduplicated: true };
      },
    );
  }

  /**
   * Turn a reviewed draft into a numbered, immutable version.
   *
   * The content is copied from the draft verbatim — this request carries no rules, no schema and
   * no outputs, so there is no way to publish something other than what was reviewed. What it does
   * carry is the effective window, because *when* a policy applies is a publication decision
   * rather than an authoring one.
   *
   * Publishing does not put anything in force. That is `activate`.
   */
  async publish(request: PublishPolicyRequest): Promise<PublishResult> {
    this.#checkRequest(request, PUBLISH_KEYS, 'publish');
    const author = this.#author();
    const draftId = assertPolicyIdentifier(request.draftId, 'draftId');
    const idempotencyKey = assertPolicyIdentifier(request.idempotencyKey, 'idempotencyKey');

    const build = async (tx: PolicyTransaction): Promise<PolicyVersion> => {
      const draft = await tx.findDraftById(draftId);
      if (draft === null) {
        throw new PolicyError(
          'no-such-version',
          `draft ${draftId} does not exist. A version is published from a draft so that what is ` +
            'in force is always something that was reviewed',
        );
      }
      const nextVersion = (await tx.highestVersion(draft.policyKey)) + 1;
      return validatePolicyVersion(
        {
          policyVersionId: request.policyVersionId,
          policyKey: draft.policyKey,
          version: nextVersion,
          draftId,
          outputSchema: draft.outputSchema,
          rules: draft.rules,
          defaultOutputs: draft.defaultOutputs,
          effectiveFrom: request.effectiveFrom ?? null,
          effectiveUntil: request.effectiveUntil ?? null,
          publishedAt: this.#clock.now(),
          publishedBy: author,
          idempotencyKey,
          requestFingerprint: fingerprintTransitionRequest({
            operation: 'publish',
            recordId: String(request.policyVersionId),
            policyKey: draft.policyKey,
            detail: draftId,
            supersedesVersionId: null,
            effectiveFrom: request.effectiveFrom ?? null,
            effectiveUntil: request.effectiveUntil ?? null,
            authorityId: author.id,
          }),
        },
        'request',
      );
    };

    let fingerprint: string | null = null;
    return this.#write(
      async (tx) => {
        const candidate = await build(tx);
        fingerprint = candidate.requestFingerprint;
        const existing = await tx.findVersionByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, candidate.requestFingerprint, 'publication');
          return { version: sealVersion(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, candidate.policyKey, 'publish a version of');
        await tx.insertVersion(candidate);
        return { version: sealVersion(candidate), deduplicated: false };
      },
      () => this.#repository.withTransaction((tx) => tx.findVersionByIdempotencyKey(idempotencyKey)),
      (found) => {
        if (fingerprint === null) throw new PolicyError('malformed-record', 'nothing to converge on');
        assertSameFingerprint(found.requestFingerprint, fingerprint, 'publication');
        return { version: sealVersion(found), deduplicated: true };
      },
    );
  }

  /**
   * Put a published version in force, guarded against a concurrent activation.
   *
   * The guard is the whole point. Two operators acting on the same commercial decision read the
   * same version in force and both activate; without `supersedesVersionId` both writes land and
   * the policy's history says two versions were authoritative at once — with no way to tell which
   * one priced the transactions in between.
   */
  async activate(request: ActivatePolicyRequest): Promise<ActivateResult> {
    this.#checkRequest(request, ACTIVATE_KEYS, 'activate');
    const author = this.#author();
    const policyVersionId = assertPolicyIdentifier(request.policyVersionId, 'policyVersionId');
    const idempotencyKey = assertPolicyIdentifier(request.idempotencyKey, 'idempotencyKey');
    const supersedes =
      request.supersedesVersionId === null || request.supersedesVersionId === undefined
        ? null
        : assertPolicyIdentifier(request.supersedesVersionId, 'supersedesVersionId');

    let fingerprint: string | null = null;
    return this.#write(
      async (tx) => {
        const target = await tx.findVersionById(policyVersionId);
        if (target === null) {
          throw new PolicyError(
            'no-such-version',
            `policy version ${policyVersionId} does not exist. Publish it before activating it`,
          );
        }
        const candidate = validateActivation(
          {
            activationId: request.activationId,
            policyKey: target.policyKey,
            policyVersionId,
            supersedesVersionId: supersedes,
            activatedAt: this.#clock.now(),
            activatedBy: author,
            idempotencyKey,
            requestFingerprint: fingerprintTransitionRequest({
              operation: 'activate',
              recordId: String(request.activationId),
              policyKey: target.policyKey,
              detail: policyVersionId,
              supersedesVersionId: supersedes,
              effectiveFrom: null,
              effectiveUntil: null,
              authorityId: author.id,
            }),
          },
          'request',
        );
        fingerprint = candidate.requestFingerprint;

        const existing = await tx.findActivationByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, candidate.requestFingerprint, 'activation');
          return { activation: sealActivation(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, target.policyKey, 'activate a version of');
        await tx.insertActivation(candidate);
        return { activation: sealActivation(candidate), deduplicated: false };
      },
      () => this.#repository.withTransaction((tx) => tx.findActivationByIdempotencyKey(idempotencyKey)),
      (found) => {
        if (fingerprint === null) throw new PolicyError('malformed-record', 'nothing to converge on');
        assertSameFingerprint(found.requestFingerprint, fingerprint, 'activation');
        return { activation: sealActivation(found), deduplicated: true };
      },
    );
  }

  /**
   * End a policy's life.
   *
   * Terminal and appended. It stops new evaluations; it does not erase the versions historic
   * decisions are pinned to, because a retired policy whose history vanished would make every
   * transaction it ever priced unexplainable.
   */
  async retire(request: RetirePolicyRequest): Promise<RetireResult> {
    this.#checkRequest(request, RETIRE_KEYS, 'retire');
    const author = this.#author();
    const policyKey = assertPolicyKey(request.policyKey);
    const idempotencyKey = assertPolicyIdentifier(request.idempotencyKey, 'idempotencyKey');

    const candidate = validateRetirement(
      {
        retirementId: request.retirementId,
        policyKey,
        reason: request.reason,
        retiredAt: this.#clock.now(),
        retiredBy: author,
        idempotencyKey,
        requestFingerprint: fingerprintTransitionRequest({
          operation: 'retire',
          recordId: String(request.retirementId),
          policyKey,
          detail: typeof request.reason === 'string' ? request.reason : '',
          supersedesVersionId: null,
          effectiveFrom: null,
          effectiveUntil: null,
          authorityId: author.id,
        }),
      },
      'request',
    );

    return this.#write(
      async (tx) => {
        const existing = await tx.findRetirementByIdempotencyKey(idempotencyKey);
        if (existing !== null) {
          assertSameFingerprint(existing.requestFingerprint, candidate.requestFingerprint, 'retirement');
          return { retirement: sealRetirement(existing), deduplicated: true };
        }
        await this.#refuseRetired(tx, policyKey, 'retire');
        await tx.insertRetirement(candidate);
        return { retirement: sealRetirement(candidate), deduplicated: false };
      },
      () => this.#repository.withTransaction((tx) => tx.findRetirementByIdempotencyKey(idempotencyKey)),
      (found) => {
        assertSameFingerprint(found.requestFingerprint, candidate.requestFingerprint, 'retirement');
        return { retirement: sealRetirement(found), deduplicated: true };
      },
    );
  }

  /**
   * What does policy say, given these facts, as of this instant?
   *
   * Reads the version in force in one transaction, evaluates it purely, and resolves any
   * `configured` output through K-05 — pinning the configuration version id beside the policy
   * version id. Nothing is written: this is a read, and a component that wrote a row per
   * evaluation would be a write on the path of every priced transaction.
   */
  async evaluate(request: EvaluateRequest): Promise<PolicyDecision> {
    // Named first, and only here: supplying a version id is an ordinary input to publish and an
    // attempt to choose your own economics on evaluate, so the pointed refusal has to come before
    // the generic unknown-field one.
    assertNoPinnedVersion(request);
    this.#checkRequest(request, EVALUATE_KEYS, 'evaluate');
    const policyKey = assertPolicyKey(request.policyKey);
    const facts = assertFacts(request.facts);
    const at = request.at === undefined ? this.#clock.now() : String(request.at);

    const { version, retired } = await this.#repository.withTransaction(async (tx) => {
      const retirement = await tx.findRetirement(policyKey);
      const current = await tx.findCurrentActivation(policyKey);
      const inForce = current === null ? null : await tx.findVersionById(current.policyVersionId);
      return { version: inForce, retired: retirement };
    });

    if (retired !== null) {
      throw new PolicyError(
        'policy-retired',
        `${policyKey} was retired at ${retired.retiredAt} and decides nothing further. The ` +
          'versions it published remain readable, because decisions taken under them are still ' +
          'pinned to them',
      );
    }
    if (version === null) {
      throw new PolicyError(
        'no-such-policy',
        `no version of ${policyKey} is in force. A policy nobody has activated has not decided ` +
          'anything, and answering anyway would put a number into a financial record that no ' +
          'version ever justified',
      );
    }

    const selection = select({ version, facts: facts, at });
    const { outputs, configurationVersions } = await this.#resolveOutputs(selection.outputs, at);

    return Object.freeze({
      policyKey,
      policyVersionId: version.policyVersionId,
      version: version.version,
      outputs,
      reason: selection.reason,
      ruleId: selection.rule?.ruleId ?? null,
      explanation: selection.explanation,
      evaluatedAt: at,
      configurationVersions,
    });
  }

  // -------------------------------------------------------------------------

  /**
   * The author of every write, from the injected authority rather than from the request.
   *
   * Recorded as a `system` origin: this authority is a deployment-level capability, not a person.
   * When K-02 and K-04 are wired (CONTRACT.md §9) the author becomes the authenticated
   * administrator and the kind becomes `human` — a change to this method and to nothing else,
   * which is the reason the identity is derived in one place.
   */
  #author(): Origin {
    if (!this.#authority.permitsAuthoring()) {
      throw new PolicyError(
        'authoring-refused',
        'no authoring authority was injected, so nothing may draft, publish, activate or retire a ' +
          'policy. The default refuses on purpose: what this component holds is the commission ' +
          'rate, the hold period and the reserve percentage, and a caller who could change those ' +
          'by reaching the service could change the economics of every transaction that follows',
      );
    }
    return { kind: 'system', id: this.#authority.authorityId };
  }

  #checkRequest(request: object, known: readonly string[], operation: string): void {
    if (request === null || typeof request !== 'object') {
      throw new PolicyError('malformed-record', `${operation} needs a request object`);
    }
    // Asserted outcomes first: a request trying to state the answer — or to name the version that
    // gave it — must be refused by name before anything else looks at it.
    assertNoAssertedOutcome(request, operation);
    assertKnownFields(request, known, operation);
  }

  /** A retired policy accepts no further writes. Terminal means terminal. */
  async #refuseRetired(
    tx: Pick<PolicyTransaction, 'findRetirement'>,
    policyKey: string,
    attempt: string,
  ): Promise<void> {
    const retirement = await tx.findRetirement(policyKey);
    if (retirement !== null) {
      throw new PolicyError(
        'policy-retired',
        `${policyKey} was retired at ${retirement.retiredAt}, so nothing may ${attempt} it now. ` +
          'Reviving it through a new version would make the retirement advisory, and the ' +
          'transactions priced before it would no longer sit at the end of a closed history',
      );
    }
  }

  /**
   * Run a mutation, converging if another copy of the same call got there first.
   *
   * The pre-insert lookup cannot see a row written by a transaction that was open at the same
   * time, so the convergence happens here — comparing exactly what a retry compares. A convergence
   * that checked less than a retry would be the same hole reached by another route.
   */
  async #write<T, R>(
    body: (tx: PolicyTransaction) => Promise<T>,
    reread: () => Promise<R | null>,
    converge: (found: R) => T,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(body);
    } catch (error) {
      if (!(error instanceof PolicyError) || !RECOVERABLE.includes(error.code)) throw error;
      let found: R | null;
      try {
        found = await reread();
      } catch {
        // The re-read failing tells us nothing new, and the original refusal is the honest one.
        throw error;
      }
      if (found === null) throw error;
      return converge(found);
    }
  }

  /** Resolve `configured` outputs through K-05, pinning every version id the answer depends on. */
  async #resolveOutputs(
    outputs: Readonly<Record<string, OutputValue>>,
    at: string,
  ): Promise<{
    readonly outputs: Readonly<Record<string, ResolvedOutput>>;
    readonly configurationVersions: Readonly<Record<string, string>>;
  }> {
    const resolved: Record<string, ResolvedOutput> = {};
    const versions: Record<string, string> = {};

    for (const [name, output] of Object.entries(outputs)) {
      const stat = staticOutput(output);
      if (stat !== null) {
        resolved[name] = stat;
        continue;
      }
      const key = (output as { key: string }).key;
      const answer = await this.#configuration.resolve({
        key,
        scope: { level: 'global', id: '' },
        at,
      });
      if (
        answer === null ||
        typeof answer.versionId !== 'string' ||
        (typeof answer.value !== 'boolean' &&
          typeof answer.value !== 'number' &&
          typeof answer.value !== 'string')
      ) {
        throw new PolicyError(
          'malformed-record',
          `K-05 returned no usable value for "${key}", which this policy declares as a configured ` +
            'output. The evaluation is refused rather than defaulted: a financial decision taken ' +
            'from a value nobody supplied is worse than one not taken',
        );
      }
      resolved[name] = Object.freeze({
        kind: 'configured' as const,
        key,
        value: answer.value,
        configurationVersionId: answer.versionId,
      });
      versions[key] = answer.versionId;
    }

    return {
      outputs: Object.freeze(resolved),
      configurationVersions: Object.freeze(versions),
    };
  }
}

function draftFacts(draft: PolicyDraft, authorityId: string): DraftRequestFacts {
  return {
    draftId: draft.draftId,
    policyKey: draft.policyKey,
    outputSchema: draft.outputSchema,
    rules: draft.rules,
    defaultOutputs: draft.defaultOutputs,
    notes: draft.notes,
    authorityId,
  };
}

/**
 * A retry converges only on an exact match of everything the request decided.
 *
 * Compared by fingerprint, which covers the whole rule set: an operator who reused a key while
 * changing one commission rate would otherwise be handed the version id of the policy they did
 * *not* write, and would pin it into a transaction as the explanation for an amount it never
 * justified.
 */
function assertSameFingerprint(existing: string, incoming: string, what: string): void {
  if (existing === incoming) return;
  throw new PolicyError(
    'idempotency-key-reuse',
    `this idempotency key recorded a different ${what}. A key identifies one intent — returning ` +
      'the earlier record for a changed request would hand back a policy version id that does ' +
      'not describe the policy asked for, and that id is what gets pinned into a financial record',
  );
}
