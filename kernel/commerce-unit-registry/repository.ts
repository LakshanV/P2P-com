/**
 * K-11 Commerce Unit Registry — the persistence port (FND-005c).
 *
 * Three record types and one rule running through all of them: **registry history is append-only**.
 * There is no update and no delete — not for a version, not for an activation, not for a
 * retirement.
 *
 * The reason is what a type key means once anything uses it. A listing, an order line, an invoice
 * and a commission decision all copy the type it was created under; editing that type in place
 * changes what every one of those records says it is, retroactively and with nothing in the
 * history to find. It is v3 §24's rule about policy, arriving through the vocabulary instead of
 * through the rates.
 *
 * Uniqueness is what makes idempotency and the guarded activation real, so it is enforced here
 * rather than by a read-then-write in the service: every record id, every idempotency key, the
 * version number within a type key, and one retirement per key. Two identical concurrent
 * publications can both pass a read; they cannot both pass a constraint.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import {
  sealActivation,
  sealActivations,
  sealRetirement,
  sealRetirements,
  sealVersion,
  sealVersions,
} from './immutable.ts';
import {
  CommerceUnitError,
  type CommerceUnitErrorCode,
  type UnitTypeActivation,
  type UnitTypeRetirement,
  type UnitTypeVersion,
} from './types.ts';

export interface CommerceUnitTransaction {
  findVersionById(typeVersionId: string): Promise<UnitTypeVersion | null>;
  findVersionByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeVersion | null>;
  /** The highest version number published for this type key, or 0 when there is none. */
  highestVersion(typeKey: string): Promise<number>;
  insertVersion(version: UnitTypeVersion): Promise<void>;

  /** The activation nothing supersedes, which names the version in force. */
  findCurrentActivation(typeKey: string): Promise<UnitTypeActivation | null>;
  findActivationByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeActivation | null>;
  insertActivation(activation: UnitTypeActivation): Promise<void>;

  findRetirement(typeKey: string): Promise<UnitTypeRetirement | null>;
  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeRetirement | null>;
  insertRetirement(retirement: UnitTypeRetirement): Promise<void>;

  /**
   * Every type key with a version in force, with that version.
   *
   * Resolution needs the whole chain, and a chain is walked key by key. Reading the in-force set
   * once and walking it in memory keeps the walk pure (`hierarchy.ts`) and keeps a deep lineage
   * from becoming one query per level.
   */
  listInForce(): Promise<readonly { activation: UnitTypeActivation; version: UnitTypeVersion }[]>;
}

export interface CommerceUnitRepository {
  withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same uniqueness the database does — every id, every idempotency key, the version number within a
 * type key, the activation guard and one retirement per key — and it checks them **at commit
 * against the store as it stands**, so two callers that overlap behave here as they would against
 * a server. K-08 shipped without that parity and every concurrency guarantee proved against it was
 * worth less than it appeared (CURRENT_IMPLEMENTATION_STATUS §11.15).
 */
export class InMemoryCommerceUnitRepository implements CommerceUnitRepository {
  #versions: UnitTypeVersion[] = [];
  #activations: UnitTypeActivation[] = [];
  #retirements: UnitTypeRetirement[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  versions(): readonly UnitTypeVersion[] {
    return sealVersions(this.#versions);
  }

  activations(): readonly UnitTypeActivation[] {
    return sealActivations(this.#activations);
  }

  retirements(): readonly UnitTypeRetirement[] {
    return sealRetirements(this.#retirements);
  }

  seed(state: {
    readonly versions?: readonly UnitTypeVersion[];
    readonly activations?: readonly UnitTypeActivation[];
    readonly retirements?: readonly UnitTypeRetirement[];
  }): void {
    // Sealed on the way in: a test that seeds a type and then edits its measures must not be
    // editing the store. A shallow copy would have shared every measure object.
    this.#versions = (state.versions ?? []).map(sealVersion);
    this.#activations = (state.activations ?? []).map(sealActivation);
    this.#retirements = (state.retirements ?? []).map(sealRetirement);
  }

  async withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      versions: this.#versions.map(sealVersion),
      activations: this.#activations.map(sealActivation),
      retirements: this.#retirements.map(sealRetirement),
    });

    try {
      const result = await body(new InMemoryCommerceUnitTransaction(working));
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
   * published until every check passes, so a refused transaction leaves no half-activated type.
   */
  #commit(working: WorkingSet): void {
    for (const version of working.newVersions) {
      if (this.#versions.some((held) => held.typeVersionId === version.typeVersionId)) {
        throw conflict('duplicate-type-version', `type version ${version.typeVersionId} exists`);
      }
      if (
        this.#versions.some(
          (held) => held.typeKey === version.typeKey && held.version === version.version,
        )
      ) {
        throw conflict(
          'duplicate-type-version',
          `version ${version.version} of ${version.typeKey} is taken`,
        );
      }
      if (this.#versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${version.idempotencyKey}" published another type version`,
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
      // The guard, re-checked at commit. Two registrars who both read the same version in force
      // and both activate must not both win: the second is stale, and stale here means a registry
      // whose history says two versions of one category were simultaneously in force.
      const current = currentOf(this.#activations, activation.typeKey);
      if ((current?.typeVersionId ?? null) !== activation.supersedesVersionId) {
        throw conflict(
          'stale-activation',
          `${activation.typeKey} now runs ${current?.typeVersionId ?? 'no version'}, not the ` +
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
      if (this.#retirements.some((held) => held.typeKey === retirement.typeKey)) {
        throw conflict('duplicate-retirement', `${retirement.typeKey} is already retired`);
      }
    }

    this.#versions = [...this.#versions, ...working.newVersions.map(sealVersion)];
    this.#activations = [...this.#activations, ...working.newActivations.map(sealActivation)];
    this.#retirements = [...this.#retirements, ...working.newRetirements.map(sealRetirement)];
  }
}

function conflict(code: CommerceUnitErrorCode, message: string): CommerceUnitError {
  return new CommerceUnitError(
    code,
    `${message}, written by another transaction while this one was open`,
  );
}

/**
 * The activation in force for a type key.
 *
 * Ordering is the activation chain, not the clock: each row names the version it supersedes, so
 * the current one is the row nothing else supersedes. Two activations can share an instant; only
 * one can be unsuperseded.
 */
function currentOf(
  activations: readonly UnitTypeActivation[],
  typeKey: string,
): UnitTypeActivation | null {
  const forType = activations.filter((entry) => entry.typeKey === typeKey);
  const superseded = new Set(
    forType.map((entry) => entry.supersedesVersionId).filter((id): id is string => id !== null),
  );
  return forType.find((entry) => !superseded.has(entry.typeVersionId)) ?? null;
}

class WorkingSet {
  versions: UnitTypeVersion[];
  activations: UnitTypeActivation[];
  retirements: UnitTypeRetirement[];
  readonly newVersions: UnitTypeVersion[] = [];
  readonly newActivations: UnitTypeActivation[] = [];
  readonly newRetirements: UnitTypeRetirement[] = [];

  constructor(snapshot: {
    versions: UnitTypeVersion[];
    activations: UnitTypeActivation[];
    retirements: UnitTypeRetirement[];
  }) {
    this.versions = snapshot.versions;
    this.activations = snapshot.activations;
    this.retirements = snapshot.retirements;
  }
}

const one = <T>(found: T | undefined, seal: (value: T) => T): Promise<T | null> =>
  Promise.resolve(found === undefined ? null : seal(found));

const reject = (code: CommerceUnitErrorCode, message: string): Promise<never> =>
  Promise.reject(new CommerceUnitError(code, message));

class InMemoryCommerceUnitTransaction implements CommerceUnitTransaction {
  readonly #state: WorkingSet;

  constructor(state: WorkingSet) {
    this.#state = state;
  }

  findVersionById(typeVersionId: string): Promise<UnitTypeVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.typeVersionId === typeVersionId),
      sealVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealVersion,
    );
  }

  highestVersion(typeKey: string): Promise<number> {
    return Promise.resolve(
      this.#state.versions
        .filter((entry) => entry.typeKey === typeKey)
        .reduce((highest, entry) => Math.max(highest, entry.version), 0),
    );
  }

  insertVersion(version: UnitTypeVersion): Promise<void> {
    if (this.#state.versions.some((held) => held.typeVersionId === version.typeVersionId)) {
      return reject(
        'duplicate-type-version',
        `type version ${version.typeVersionId} already exists, and a version is never rewritten`,
      );
    }
    if (
      this.#state.versions.some(
        (held) => held.typeKey === version.typeKey && held.version === version.version,
      )
    ) {
      return reject(
        'duplicate-type-version',
        `version ${version.version} of ${version.typeKey} has already been published. Version ` +
          'numbers order the history every listing created under this type refers back to',
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

  findCurrentActivation(typeKey: string): Promise<UnitTypeActivation | null> {
    const current = currentOf(this.#state.activations, typeKey);
    return Promise.resolve(current === null ? null : sealActivation(current));
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeActivation | null> {
    return one(
      this.#state.activations.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealActivation,
    );
  }

  insertActivation(activation: UnitTypeActivation): Promise<void> {
    if (this.#state.activations.some((held) => held.activationId === activation.activationId)) {
      return reject('duplicate-activation', `activation ${activation.activationId} already exists`);
    }
    if (this.#state.activations.some((held) => held.idempotencyKey === activation.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${activation.idempotencyKey}" has already been used`,
      );
    }
    const current = currentOf(this.#state.activations, activation.typeKey);
    if ((current?.typeVersionId ?? null) !== activation.supersedesVersionId) {
      return reject(
        'stale-activation',
        `${activation.typeKey} currently runs ${current?.typeVersionId ?? 'no version'}; this ` +
          `activation claimed to supersede ${activation.supersedesVersionId ?? 'nothing'}. ` +
          'Re-read the version in force and decide again rather than overwriting somebody else',
      );
    }
    const sealed = sealActivation(activation);
    this.#state.activations.push(sealed);
    this.#state.newActivations.push(sealed);
    return Promise.resolve();
  }

  findRetirement(typeKey: string): Promise<UnitTypeRetirement | null> {
    return one(
      this.#state.retirements.find((entry) => entry.typeKey === typeKey),
      sealRetirement,
    );
  }

  findRetirementByIdempotencyKey(idempotencyKey: string): Promise<UnitTypeRetirement | null> {
    return one(
      this.#state.retirements.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealRetirement,
    );
  }

  insertRetirement(retirement: UnitTypeRetirement): Promise<void> {
    if (this.#state.retirements.some((held) => held.retirementId === retirement.retirementId)) {
      return reject('duplicate-retirement', `retirement ${retirement.retirementId} already exists`);
    }
    if (this.#state.retirements.some((held) => held.idempotencyKey === retirement.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${retirement.idempotencyKey}" has already been used`,
      );
    }
    if (this.#state.retirements.some((held) => held.typeKey === retirement.typeKey)) {
      return reject(
        'duplicate-retirement',
        `${retirement.typeKey} has already been retired. A second retirement would rewrite when ` +
          'the category actually stopped accepting listings',
      );
    }
    const sealed = sealRetirement(retirement);
    this.#state.retirements.push(sealed);
    this.#state.newRetirements.push(sealed);
    return Promise.resolve();
  }

  listInForce(): Promise<readonly { activation: UnitTypeActivation; version: UnitTypeVersion }[]> {
    const retired = new Set(this.#state.retirements.map((entry) => entry.typeKey));
    const keys = [...new Set(this.#state.activations.map((entry) => entry.typeKey))].sort();
    const rows: { activation: UnitTypeActivation; version: UnitTypeVersion }[] = [];

    for (const typeKey of keys) {
      if (retired.has(typeKey)) continue;
      const current = currentOf(this.#state.activations, typeKey);
      if (current === null) continue;
      const version = this.#state.versions.find(
        (entry) => entry.typeVersionId === current.typeVersionId,
      );
      if (version === undefined) continue;
      rows.push({ activation: sealActivation(current), version: sealVersion(version) });
    }
    return Promise.resolve(Object.freeze(rows));
  }
}
