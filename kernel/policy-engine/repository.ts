/**
 * K-06 Policy Engine — the persistence port (FND-005b).
 *
 * Four record types and one rule running through all of them: **policy history is append-only**.
 * There is no update and no delete in this port — not for a draft, not for a version, not for an
 * activation, not for a retirement.
 *
 * v3 §24 states the reason in one sentence: *changing future policy must not rewrite historical
 * economics.* Every transaction stores the policy version applied at purchase time, and that id is
 * a promise that the version can still be read and still says what it said. An `UPDATE` on a rule
 * row breaks that promise for every decision ever pinned to it, silently and retroactively, and
 * there is no reconciliation that would find it.
 *
 * Uniqueness is what makes idempotency and the guarded activation real, so it is enforced here
 * rather than by a read-then-write in the service: every record id, every idempotency key, the
 * version number within a policy key, and one retirement per key. Two identical concurrent
 * publications can both pass a read; they cannot both pass a constraint.
 *
 * Owned by: K-06 Policy Engine.
 */

import {
  sealActivation,
  sealActivations,
  sealDraft,
  sealDrafts,
  sealRetirement,
  sealRetirements,
  sealVersion,
  sealVersions,
} from './immutable.ts';
import {
  PolicyError,
  type PolicyActivation,
  type PolicyDraft,
  type PolicyErrorCode,
  type PolicyRetirement,
  type PolicyVersion,
} from './types.ts';

export interface PolicyTransaction {
  findDraftById(draftId: string): Promise<PolicyDraft | null>;
  findDraftByIdempotencyKey(idempotencyKey: string): Promise<PolicyDraft | null>;
  insertDraft(draft: PolicyDraft): Promise<void>;

  findVersionById(policyVersionId: string): Promise<PolicyVersion | null>;
  findVersionByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null>;
  /** The highest version number published for this policy key, or 0 when there is none. */
  highestVersion(policyKey: string): Promise<number>;
  insertVersion(version: PolicyVersion): Promise<void>;

  /** The activation nothing supersedes, which names the version in force. */
  findCurrentActivation(policyKey: string): Promise<PolicyActivation | null>;
  findActivationByIdempotencyKey(idempotencyKey: string): Promise<PolicyActivation | null>;
  insertActivation(activation: PolicyActivation): Promise<void>;

  findRetirement(policyKey: string): Promise<PolicyRetirement | null>;
  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<PolicyRetirement | null>;
  insertRetirement(retirement: PolicyRetirement): Promise<void>;
}

export interface PolicyRepository {
  withTransaction<T>(body: (tx: PolicyTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same uniqueness the database does — every id, every idempotency key, the version number within a
 * policy key, the activation guard and one retirement per key — and it checks them **at commit
 * against the store as it stands**, so two callers that overlap behave here as they would against
 * a server. K-08 shipped without that parity and every concurrency guarantee proved against it was
 * worth less than it appeared (CURRENT_IMPLEMENTATION_STATUS §11.15).
 */
export class InMemoryPolicyRepository implements PolicyRepository {
  #drafts: PolicyDraft[] = [];
  #versions: PolicyVersion[] = [];
  #activations: PolicyActivation[] = [];
  #retirements: PolicyRetirement[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  drafts(): readonly PolicyDraft[] {
    return sealDrafts(this.#drafts);
  }

  versions(): readonly PolicyVersion[] {
    return sealVersions(this.#versions);
  }

  activations(): readonly PolicyActivation[] {
    return sealActivations(this.#activations);
  }

  retirements(): readonly PolicyRetirement[] {
    return sealRetirements(this.#retirements);
  }

  seed(state: {
    readonly drafts?: readonly PolicyDraft[];
    readonly versions?: readonly PolicyVersion[];
    readonly activations?: readonly PolicyActivation[];
    readonly retirements?: readonly PolicyRetirement[];
  }): void {
    // Sealed on the way in: a test that seeds a version and then edits a rule's outputs must not
    // be editing the store. A shallow copy would have shared every rule and every decimal.
    this.#drafts = (state.drafts ?? []).map(sealDraft);
    this.#versions = (state.versions ?? []).map(sealVersion);
    this.#activations = (state.activations ?? []).map(sealActivation);
    this.#retirements = (state.retirements ?? []).map(sealRetirement);
  }

  async withTransaction<T>(body: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      drafts: this.#drafts.map(sealDraft),
      versions: this.#versions.map(sealVersion),
      activations: this.#activations.map(sealActivation),
      retirements: this.#retirements.map(sealRetirement),
    });

    try {
      const result = await body(new InMemoryPolicyTransaction(working));
      this.#commit(working);
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Apply this transaction's writes to the store as it stands now, or refuse — all of it, or none.
   *
   * Conflicts are checked against the *current* store rather than the snapshot the transaction
   * read, which is what makes the races behave as they would against a server. Nothing is
   * published until every check passes, so a refused transaction leaves no half-activated policy.
   */
  #commit(working: WorkingSet): void {
    for (const draft of working.newDrafts) {
      if (this.#drafts.some((held) => held.draftId === draft.draftId)) {
        throw conflict('duplicate-draft', `draft ${draft.draftId} exists`);
      }
      if (this.#drafts.some((held) => held.idempotencyKey === draft.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${draft.idempotencyKey}" drafted another policy`,
        );
      }
    }

    for (const version of working.newVersions) {
      if (this.#versions.some((held) => held.policyVersionId === version.policyVersionId)) {
        throw conflict('duplicate-policy-version', `version ${version.policyVersionId} exists`);
      }
      if (
        this.#versions.some(
          (held) => held.policyKey === version.policyKey && held.version === version.version,
        )
      ) {
        throw conflict(
          'duplicate-policy-version',
          `version ${version.version} of ${version.policyKey} is taken`,
        );
      }
      if (this.#versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${version.idempotencyKey}" published another version`,
        );
      }
    }

    for (const activation of working.newActivations) {
      if (this.#activations.some((held) => held.activationId === activation.activationId)) {
        throw conflict('duplicate-activation', `activation ${activation.activationId} exists`);
      }
      if (this.#activations.some((held) => held.idempotencyKey === activation.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${activation.idempotencyKey}" recorded another activation`,
        );
      }
      // The guard, re-checked at commit. Two operators who both read the same version in force and
      // both activate must not both win: the second is stale, and stale here means a history in
      // which two policy versions were simultaneously authoritative.
      const current = currentOf(this.#activations, activation.policyKey);
      if ((current?.policyVersionId ?? null) !== activation.supersedesVersionId) {
        throw conflict(
          'stale-activation',
          `${activation.policyKey} now runs ${current?.policyVersionId ?? 'no version'}, not the ` +
            `${activation.supersedesVersionId ?? 'nothing'} this activation claimed to supersede`,
        );
      }
    }

    for (const retirement of working.newRetirements) {
      if (this.#retirements.some((held) => held.retirementId === retirement.retirementId)) {
        throw conflict('duplicate-retirement', `retirement ${retirement.retirementId} exists`);
      }
      if (this.#retirements.some((held) => held.idempotencyKey === retirement.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${retirement.idempotencyKey}" recorded another retirement`,
        );
      }
      if (this.#retirements.some((held) => held.policyKey === retirement.policyKey)) {
        throw conflict('duplicate-retirement', `${retirement.policyKey} is already retired`);
      }
    }

    this.#drafts = [...this.#drafts, ...working.newDrafts.map(sealDraft)];
    this.#versions = [...this.#versions, ...working.newVersions.map(sealVersion)];
    this.#activations = [...this.#activations, ...working.newActivations.map(sealActivation)];
    this.#retirements = [...this.#retirements, ...working.newRetirements.map(sealRetirement)];
  }
}

function conflict(code: PolicyErrorCode, message: string): PolicyError {
  return new PolicyError(
    code,
    `${message}, written by another transaction while this one was open`,
  );
}

/**
 * The activation in force for a policy key.
 *
 * Ordering is the activation chain, not the clock: each row names the version it supersedes, so
 * the current one is the row nothing else supersedes. Two activations can share an instant; only
 * one can be unsuperseded.
 */
function currentOf(
  activations: readonly PolicyActivation[],
  policyKey: string,
): PolicyActivation | null {
  const forPolicy = activations.filter((entry) => entry.policyKey === policyKey);
  const superseded = new Set(
    forPolicy.map((entry) => entry.supersedesVersionId).filter((id): id is string => id !== null),
  );
  return forPolicy.find((entry) => !superseded.has(entry.policyVersionId)) ?? null;
}

class WorkingSet {
  drafts: PolicyDraft[];
  versions: PolicyVersion[];
  activations: PolicyActivation[];
  retirements: PolicyRetirement[];
  readonly newDrafts: PolicyDraft[] = [];
  readonly newVersions: PolicyVersion[] = [];
  readonly newActivations: PolicyActivation[] = [];
  readonly newRetirements: PolicyRetirement[] = [];

  constructor(snapshot: {
    drafts: PolicyDraft[];
    versions: PolicyVersion[];
    activations: PolicyActivation[];
    retirements: PolicyRetirement[];
  }) {
    this.drafts = snapshot.drafts;
    this.versions = snapshot.versions;
    this.activations = snapshot.activations;
    this.retirements = snapshot.retirements;
  }
}

const one = <T>(found: T | undefined, seal: (value: T) => T): Promise<T | null> =>
  Promise.resolve(found === undefined ? null : seal(found));

const reject = (code: PolicyErrorCode, message: string): Promise<never> =>
  Promise.reject(new PolicyError(code, message));

class InMemoryPolicyTransaction implements PolicyTransaction {
  readonly #state: WorkingSet;

  constructor(state: WorkingSet) {
    this.#state = state;
  }

  findDraftById(draftId: string): Promise<PolicyDraft | null> {
    return one(
      this.#state.drafts.find((entry) => entry.draftId === draftId),
      sealDraft,
    );
  }

  findDraftByIdempotencyKey(idempotencyKey: string): Promise<PolicyDraft | null> {
    return one(
      this.#state.drafts.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealDraft,
    );
  }

  insertDraft(draft: PolicyDraft): Promise<void> {
    if (this.#state.drafts.some((held) => held.draftId === draft.draftId)) {
      return reject('duplicate-draft', `draft ${draft.draftId} already exists`);
    }
    if (this.#state.drafts.some((held) => held.idempotencyKey === draft.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${draft.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealDraft(draft);
    this.#state.drafts.push(sealed);
    this.#state.newDrafts.push(sealed);
    return Promise.resolve();
  }

  findVersionById(policyVersionId: string): Promise<PolicyVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.policyVersionId === policyVersionId),
      sealVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealVersion,
    );
  }

  highestVersion(policyKey: string): Promise<number> {
    return Promise.resolve(
      this.#state.versions
        .filter((entry) => entry.policyKey === policyKey)
        .reduce((highest, entry) => Math.max(highest, entry.version), 0),
    );
  }

  insertVersion(version: PolicyVersion): Promise<void> {
    if (this.#state.versions.some((held) => held.policyVersionId === version.policyVersionId)) {
      return reject(
        'duplicate-policy-version',
        `policy version ${version.policyVersionId} already exists, and a version is never rewritten`,
      );
    }
    if (
      this.#state.versions.some(
        (held) => held.policyKey === version.policyKey && held.version === version.version,
      )
    ) {
      return reject(
        'duplicate-policy-version',
        `version ${version.version} of ${version.policyKey} has already been published. Version ` +
          'numbers order the history so a historic decision can be replayed against the policy ' +
          'that was in force when it was taken',
      );
    }
    if (this.#state.versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${version.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealVersion(version);
    this.#state.versions.push(sealed);
    this.#state.newVersions.push(sealed);
    return Promise.resolve();
  }

  findCurrentActivation(policyKey: string): Promise<PolicyActivation | null> {
    const current = currentOf(this.#state.activations, policyKey);
    return Promise.resolve(current === null ? null : sealActivation(current));
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<PolicyActivation | null> {
    return one(
      this.#state.activations.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealActivation,
    );
  }

  insertActivation(activation: PolicyActivation): Promise<void> {
    if (this.#state.activations.some((held) => held.activationId === activation.activationId)) {
      return reject('duplicate-activation', `activation ${activation.activationId} already exists`);
    }
    if (this.#state.activations.some((held) => held.idempotencyKey === activation.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${activation.idempotencyKey}" has already been used`,
      );
    }
    const current = currentOf(this.#state.activations, activation.policyKey);
    if ((current?.policyVersionId ?? null) !== activation.supersedesVersionId) {
      return reject(
        'stale-activation',
        `${activation.policyKey} currently runs ${current?.policyVersionId ?? 'no version'}; this ` +
          `activation claimed to supersede ${activation.supersedesVersionId ?? 'nothing'}. ` +
          'Re-read the version in force and decide again rather than overwriting somebody else',
      );
    }
    const sealed = sealActivation(activation);
    this.#state.activations.push(sealed);
    this.#state.newActivations.push(sealed);
    return Promise.resolve();
  }

  findRetirement(policyKey: string): Promise<PolicyRetirement | null> {
    return one(
      this.#state.retirements.find((entry) => entry.policyKey === policyKey),
      sealRetirement,
    );
  }

  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<PolicyRetirement | null> {
    return one(
      this.#state.retirements.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealRetirement,
    );
  }

  insertRetirement(retirement: PolicyRetirement): Promise<void> {
    if (this.#state.retirements.some((held) => held.retirementId === retirement.retirementId)) {
      return reject('duplicate-retirement', `retirement ${retirement.retirementId} already exists`);
    }
    if (this.#state.retirements.some((held) => held.idempotencyKey === retirement.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${retirement.idempotencyKey}" has already been used`,
      );
    }
    if (this.#state.retirements.some((held) => held.policyKey === retirement.policyKey)) {
      return reject(
        'duplicate-retirement',
        `${retirement.policyKey} has already been retired. A second retirement would rewrite when ` +
          'the policy actually stopped applying, which is what a historic decision is checked against',
      );
    }
    const sealed = sealRetirement(retirement);
    this.#state.retirements.push(sealed);
    this.#state.newRetirements.push(sealed);
    return Promise.resolve();
  }
}
