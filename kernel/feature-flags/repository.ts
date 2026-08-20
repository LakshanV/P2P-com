/**
 * K-07 Feature Flags — the persistence port (FND-004e).
 *
 * Three record types and one rule running through all of them: **flag history is append-only**.
 * There is no update and no delete in this port — not for a version, not for an activation, not
 * for a kill or a retirement.
 *
 * That is not ceremony. The question asked after an incident is never "what is this flag set to"
 * — that is answerable from anything — but "what was it doing at 14:05, who changed it, and when
 * did the change take effect". A definition edited in place answers the first and destroys the
 * second, and the flags v3 §36 exists for are the ones on autonomous purchasing and referral
 * payouts, where that question is the whole investigation.
 *
 * Uniqueness is what makes idempotency and the guarded activation real, so it is enforced here
 * rather than by a read-then-write in the service: every record id, every idempotency key, the
 * version number within a flag key, and one lifecycle event per flag key. Two identical
 * concurrent publications can both pass a read; they cannot both pass a constraint.
 *
 * Owned by: K-07 Feature Flags.
 */

import {
  sealActivation,
  sealActivations,
  sealFlagVersion,
  sealFlagVersions,
  sealLifecycleEvent,
  sealLifecycleEvents,
} from './immutable.ts';
import {
  FeatureFlagError,
  type Activation,
  type FeatureFlagErrorCode,
  type FlagVersion,
  type LifecycleEvent,
  type LifecycleKind,
} from './types.ts';

export interface FeatureFlagTransaction {
  findVersionById(flagVersionId: string): Promise<FlagVersion | null>;
  findVersionByIdempotencyKey(idempotencyKey: string): Promise<FlagVersion | null>;
  /** The highest version number published for this flag key, or 0 when there is none. */
  highestVersion(flagKey: string): Promise<number>;
  insertVersion(version: FlagVersion): Promise<void>;

  /** The most recent activation for this flag key, which names the current version. */
  findCurrentActivation(flagKey: string): Promise<Activation | null>;
  findActivationByIdempotencyKey(idempotencyKey: string): Promise<Activation | null>;
  insertActivation(activation: Activation): Promise<void>;

  /** The kill or retire event for this flag key, if it has one. At most one, for good. */
  listLifecycleEvents(flagKey: string): Promise<readonly LifecycleEvent[]>;
  findLifecycleEventByIdempotencyKey(idempotencyKey: string): Promise<LifecycleEvent | null>;
  insertLifecycleEvent(event: LifecycleEvent): Promise<void>;
}

export interface FeatureFlagRepository {
  withTransaction<T>(body: (tx: FeatureFlagTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same uniqueness the database does — every id, every idempotency key, the version number within a
 * flag key, one lifecycle event per flag — and it checks them **at commit against the
 * store as it stands**, so two callers that overlap behave here as they would against a server.
 * K-08 shipped without that parity and every concurrency guarantee proved against it was worth
 * less than it appeared (CURRENT_IMPLEMENTATION_STATUS §11.15).
 */
export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  #versions: FlagVersion[] = [];
  #activations: Activation[] = [];
  #lifecycle: LifecycleEvent[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  versions(): readonly FlagVersion[] {
    return sealFlagVersions(this.#versions);
  }

  activations(): readonly Activation[] {
    return sealActivations(this.#activations);
  }

  lifecycleEvents(): readonly LifecycleEvent[] {
    return sealLifecycleEvents(this.#lifecycle);
  }

  seed(state: {
    readonly versions?: readonly FlagVersion[];
    readonly activations?: readonly Activation[];
    readonly lifecycle?: readonly LifecycleEvent[];
  }): void {
    // Sealed on the way in: a test that seeds a version and then edits its rules must not be
    // editing the store. A shallow copy would have shared every rule tree.
    this.#versions = (state.versions ?? []).map(sealFlagVersion);
    this.#activations = (state.activations ?? []).map(sealActivation);
    this.#lifecycle = (state.lifecycle ?? []).map(sealLifecycleEvent);
  }

  async withTransaction<T>(body: (tx: FeatureFlagTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      versions: this.#versions.map(sealFlagVersion),
      activations: this.#activations.map(sealActivation),
      lifecycle: this.#lifecycle.map(sealLifecycleEvent),
    });

    try {
      const result = await body(new InMemoryFeatureFlagTransaction(working));
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
   * published until every check has passed, so a refused transaction leaves no half-activated flag
   * behind.
   */
  #commit(working: WorkingSet): void {
    for (const version of working.newVersions) {
      if (this.#versions.some((held) => held.flagVersionId === version.flagVersionId)) {
        throw conflict('duplicate-flag-version', `flag version ${version.flagVersionId} exists`);
      }
      if (
        this.#versions.some(
          (held) => held.flagKey === version.flagKey && held.version === version.version,
        )
      ) {
        throw conflict(
          'duplicate-flag-version',
          `version ${version.version} of ${version.flagKey} is taken`,
        );
      }
      if (this.#versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${version.idempotencyKey}" published another flag version`,
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
      // The guard, re-checked at commit. Two operators who both read the same current version and
      // both activate must not both win: the second is stale, and stale here means a flag whose
      // history says two different versions took effect at once.
      const current = currentOf(this.#activations, activation.flagKey);
      if ((current?.flagVersionId ?? null) !== activation.supersedesVersionId) {
        throw conflict(
          'stale-activation',
          `${activation.flagKey} now runs ${current?.flagVersionId ?? 'no version'}, not the ` +
            `${activation.supersedesVersionId ?? 'nothing'} this activation claimed to supersede`,
        );
      }
    }

    for (const event of working.newLifecycle) {
      if (this.#lifecycle.some((held) => held.eventId === event.eventId)) {
        throw conflict('duplicate-lifecycle-event', `lifecycle event ${event.eventId} exists`);
      }
      if (this.#lifecycle.some((held) => held.idempotencyKey === event.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${event.idempotencyKey}" recorded another lifecycle event`,
        );
      }
      const terminal = this.#lifecycle.find((held) => held.flagKey === event.flagKey);
      if (terminal !== undefined) {
        throw conflict(
          'flag-terminated',
          `${event.flagKey} has already been ${terminalWord(terminal.kind)}`,
        );
      }
    }

    this.#versions = [...this.#versions, ...working.newVersions.map(sealFlagVersion)];
    this.#activations = [...this.#activations, ...working.newActivations.map(sealActivation)];
    this.#lifecycle = [...this.#lifecycle, ...working.newLifecycle.map(sealLifecycleEvent)];
  }
}

function conflict(code: FeatureFlagErrorCode, message: string): FeatureFlagError {
  return new FeatureFlagError(
    code,
    `${message}, written by another transaction while this one was open`,
  );
}

/**
 * The current activation for a flag key.
 *
 * Ordering is the activation chain, not the clock: each row names the version it supersedes, so
 * the current one is the row nothing else supersedes. Two activations can share an instant; only
 * one can be unsuperseded.
 */
function currentOf(activations: readonly Activation[], flagKey: string): Activation | null {
  const forFlag = activations.filter((entry) => entry.flagKey === flagKey);
  const superseded = new Set(
    forFlag.map((entry) => entry.supersedesVersionId).filter((id): id is string => id !== null),
  );
  return forFlag.find((entry) => !superseded.has(entry.flagVersionId)) ?? null;
}

class WorkingSet {
  versions: FlagVersion[];
  activations: Activation[];
  lifecycle: LifecycleEvent[];
  readonly newVersions: FlagVersion[] = [];
  readonly newActivations: Activation[] = [];
  readonly newLifecycle: LifecycleEvent[] = [];

  constructor(snapshot: {
    versions: FlagVersion[];
    activations: Activation[];
    lifecycle: LifecycleEvent[];
  }) {
    this.versions = snapshot.versions;
    this.activations = snapshot.activations;
    this.lifecycle = snapshot.lifecycle;
  }
}

function one<T>(found: T | undefined, seal: (value: T) => T): Promise<T | null> {
  return Promise.resolve(found === undefined ? null : seal(found));
}

function reject(code: FeatureFlagErrorCode, message: string): Promise<never> {
  return Promise.reject(new FeatureFlagError(code, message));
}

class InMemoryFeatureFlagTransaction implements FeatureFlagTransaction {
  readonly #state: WorkingSet;

  constructor(state: WorkingSet) {
    this.#state = state;
  }

  findVersionById(flagVersionId: string): Promise<FlagVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.flagVersionId === flagVersionId),
      sealFlagVersion,
    );
  }

  findVersionByIdempotencyKey(idempotencyKey: string): Promise<FlagVersion | null> {
    return one(
      this.#state.versions.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealFlagVersion,
    );
  }

  highestVersion(flagKey: string): Promise<number> {
    return Promise.resolve(
      this.#state.versions
        .filter((entry) => entry.flagKey === flagKey)
        .reduce((highest, entry) => Math.max(highest, entry.version), 0),
    );
  }

  insertVersion(version: FlagVersion): Promise<void> {
    if (this.#state.versions.some((held) => held.flagVersionId === version.flagVersionId)) {
      return reject(
        'duplicate-flag-version',
        `flag version ${version.flagVersionId} already exists, and a version is never rewritten`,
      );
    }
    if (
      this.#state.versions.some(
        (held) => held.flagKey === version.flagKey && held.version === version.version,
      )
    ) {
      return reject(
        'duplicate-flag-version',
        `version ${version.version} of ${version.flagKey} has already been published. Version ` +
          'numbers order the history of a flag so an evaluation can be replayed against the ' +
          'definition that was current when it happened',
      );
    }
    if (this.#state.versions.some((held) => held.idempotencyKey === version.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${version.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealFlagVersion(version);
    this.#state.versions.push(sealed);
    this.#state.newVersions.push(sealed);
    return Promise.resolve();
  }

  findCurrentActivation(flagKey: string): Promise<Activation | null> {
    const current = currentOf(this.#state.activations, flagKey);
    return Promise.resolve(current === null ? null : sealActivation(current));
  }

  findActivationByIdempotencyKey(idempotencyKey: string): Promise<Activation | null> {
    return one(
      this.#state.activations.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealActivation,
    );
  }

  insertActivation(activation: Activation): Promise<void> {
    if (this.#state.activations.some((held) => held.activationId === activation.activationId)) {
      return reject('duplicate-activation', `activation ${activation.activationId} already exists`);
    }
    if (this.#state.activations.some((held) => held.idempotencyKey === activation.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${activation.idempotencyKey}" has already been used`,
      );
    }
    const current = currentOf(this.#state.activations, activation.flagKey);
    if ((current?.flagVersionId ?? null) !== activation.supersedesVersionId) {
      return reject(
        'stale-activation',
        `${activation.flagKey} currently runs ${current?.flagVersionId ?? 'no version'}; this ` +
          `activation claimed to supersede ${activation.supersedesVersionId ?? 'nothing'}. ` +
          'Re-read the current version and decide again rather than overwriting somebody else',
      );
    }
    const sealed = sealActivation(activation);
    this.#state.activations.push(sealed);
    this.#state.newActivations.push(sealed);
    return Promise.resolve();
  }

  listLifecycleEvents(flagKey: string): Promise<readonly LifecycleEvent[]> {
    return Promise.resolve(
      sealLifecycleEvents(
        this.#state.lifecycle
          .filter((entry) => entry.flagKey === flagKey)
          .sort((a, b) => a.eventId.localeCompare(b.eventId)),
      ),
    );
  }

  findLifecycleEventByIdempotencyKey(idempotencyKey: string): Promise<LifecycleEvent | null> {
    return one(
      this.#state.lifecycle.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealLifecycleEvent,
    );
  }

  insertLifecycleEvent(event: LifecycleEvent): Promise<void> {
    if (this.#state.lifecycle.some((held) => held.eventId === event.eventId)) {
      return reject('duplicate-lifecycle-event', `lifecycle event ${event.eventId} already exists`);
    }
    if (this.#state.lifecycle.some((held) => held.idempotencyKey === event.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${event.idempotencyKey}" has already been used`,
      );
    }
    const terminal = this.#state.lifecycle.find((held) => held.flagKey === event.flagKey);
    if (terminal !== undefined) {
      return reject(
        'flag-terminated',
        `${event.flagKey} has already been ${terminalWord(terminal.kind)}. A second lifecycle ` +
          'event would rewrite when the feature actually stopped, which is the question an ' +
          'incident review asks first. Terminal means terminal',
      );
    }
    const sealed = sealLifecycleEvent(event);
    this.#state.lifecycle.push(sealed);
    this.#state.newLifecycle.push(sealed);
    return Promise.resolve();
  }
}

export function terminalWord(kind: LifecycleKind): string {
  return kind === 'kill' ? 'killed' : 'retired';
}
