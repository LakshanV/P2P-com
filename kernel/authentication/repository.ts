/**
 * K-02 Authentication — the persistence port (FND-004c).
 *
 * Three record types, and the operations each is allowed:
 *
 *   - **Bindings** and **evidence** are append-only. No update, no delete. Evidence that can be
 *     edited is not evidence, and a binding that can be repointed transfers every session issued
 *     under it to a different party.
 *   - **Sessions** are the one thing here with a lifecycle, and it is deliberately tiny: rotate the
 *     secret, or revoke. Both are expressed as **guarded** updates that carry the state they expect
 *     to find, so a stale caller loses rather than clobbering. There is no general `updateSession`,
 *     because a general update is how a session acquires a longer absolute expiry.
 *
 * `rotateSession` and `revokeSession` return `false` rather than throwing when the guard does not
 * match. That is not a swallowed error: "somebody else got there first" is a normal outcome of a
 * race, and the service turns it into `stale-session-state` after re-reading to find out which race
 * it lost. A port that threw would make the two cases — lost a race, or the session never existed —
 * indistinguishable at the point where they most need telling apart.
 *
 * `assertionId` uniqueness is what makes replay detectable, so it is a repository-level constraint
 * rather than a service-level check: a check would be a read followed by a write, and two replays
 * of one assertion can both pass a read.
 *
 * Owned by: K-02 Authentication.
 */

import { sealBinding, sealBindings, sealEvidence, sealSession, sealSessions } from './immutable.ts';
import {
  AuthenticationError,
  type AuthenticationBinding,
  type AuthenticationEvidence,
  type AuthenticationSession,
  type RevocationReason,
} from './types.ts';

/** What a rotation replaces, and what it expects to find. */
export interface RotationCommand {
  readonly sessionId: string;
  /** The hash the caller's presented secret produced. The guard. */
  readonly expectedTokenHash: string;
  readonly nextTokenHash: string;
  readonly nextIdleExpiresAt: string;
  readonly nextRotationCount: number;
}

/** What a revocation records, and what it expects to find. */
export interface RevocationCommand {
  readonly sessionId: string;
  readonly revokedAt: string;
  readonly reason: RevocationReason;
}

export interface AuthenticationTransaction {
  findBindingById(bindingId: string): Promise<AuthenticationBinding | null>;
  /** The binding a verifier's reference points at, if any. Unique per `(provider, reference)`. */
  findBindingByReference(
    provider: string,
    providerReference: string,
  ): Promise<AuthenticationBinding | null>;
  findBindingByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationBinding | null>;
  listBindingsForSubject(subjectId: string): Promise<readonly AuthenticationBinding[]>;
  insertBinding(binding: AuthenticationBinding): Promise<void>;

  /** Whether this verifier assertion has already been consumed. */
  findEvidenceByAssertionId(
    provider: string,
    assertionId: string,
  ): Promise<AuthenticationEvidence | null>;
  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationEvidence | null>;
  insertEvidence(evidence: AuthenticationEvidence): Promise<void>;

  findSessionById(sessionId: string): Promise<AuthenticationSession | null>;
  /** Lookup by hash. There is no lookup by secret, because no secret is stored. */
  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null>;
  findSessionByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationSession | null>;
  insertSession(session: AuthenticationSession): Promise<void>;

  /**
   * Replace a session's secret, only if it still holds `expectedTokenHash` and is not revoked.
   *
   * Returns false when the guard did not match. Never moves the absolute expiry.
   */
  rotateSession(command: RotationCommand): Promise<boolean>;

  /** Revoke a session, only if it is not revoked already. Returns false when it already was. */
  revokeSession(command: RevocationCommand): Promise<boolean>;
}

export interface AuthenticationRepository {
  withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same uniqueness the database does — binding id, `(provider, reference)`, `(provider,
 * assertionId)`, session id, token hash and every idempotency key — and it checks them **at commit
 * against the store as it stands**, so two callers that overlap behave here as they would against a
 * server.
 *
 * The guarded updates are modelled the same way: a rotation re-reads at commit and refuses if the
 * hash it expected is no longer there. K-08 shipped without that parity and every concurrency
 * guarantee proved against it was worth less than it appeared (§11.15).
 */
export class InMemoryAuthenticationRepository implements AuthenticationRepository {
  #bindings: AuthenticationBinding[] = [];
  #evidence: AuthenticationEvidence[] = [];
  #sessions: AuthenticationSession[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  bindings(): readonly AuthenticationBinding[] {
    return sealBindings(this.#bindings);
  }

  evidence(): readonly AuthenticationEvidence[] {
    return Object.freeze(this.#evidence.map(sealEvidence));
  }

  sessions(): readonly AuthenticationSession[] {
    return sealSessions(this.#sessions);
  }

  seed(state: {
    readonly bindings?: readonly AuthenticationBinding[];
    readonly evidence?: readonly AuthenticationEvidence[];
    readonly sessions?: readonly AuthenticationSession[];
  }): void {
    // Sealed on the way in: a test that seeds an array and then edits it must not be editing the
    // store. A shallow copy would have shared every `factors` array.
    this.#bindings = (state.bindings ?? []).map(sealBinding);
    this.#evidence = (state.evidence ?? []).map(sealEvidence);
    this.#sessions = (state.sessions ?? []).map(sealSession);
  }

  async withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T> {
    const snapshot = {
      bindings: this.#bindings.map(sealBinding),
      evidence: this.#evidence.map(sealEvidence),
      sessions: this.#sessions.map(sealSession),
    };
    const working = new WorkingSet(snapshot);
    const tx = new InMemoryAuthenticationTransaction(working);

    try {
      const result = await body(tx);
      this.#commit(working);
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Apply this transaction's writes to the store as it stands now, or refuse.
   *
   * Conflicts are checked against the *current* store rather than the snapshot the transaction
   * read, which is what makes the races behave as they would against a server. Guarded updates are
   * re-evaluated here for the same reason: the hash a rotation expected may have been replaced
   * since it looked.
   */
  #commit(working: WorkingSet): void {
    for (const binding of working.newBindings) {
      if (this.#bindings.some((held) => held.bindingId === binding.bindingId)) {
        throw conflict('duplicate-binding', `binding ${binding.bindingId} already exists`);
      }
      if (
        this.#bindings.some(
          (held) =>
            held.provider === binding.provider &&
            held.providerReference === binding.providerReference,
        )
      ) {
        throw conflict(
          'duplicate-binding',
          `provider ${binding.provider} already has a binding for that reference`,
        );
      }
      if (this.#bindings.some((held) => held.idempotencyKey === binding.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${binding.idempotencyKey}" was used by another binding`,
        );
      }
    }

    for (const evidence of working.newEvidence) {
      if (this.#evidence.some((held) => held.evidenceId === evidence.evidenceId)) {
        throw conflict('malformed-record', `evidence ${evidence.evidenceId} already exists`);
      }
      if (
        this.#evidence.some(
          (held) =>
            held.provider === evidence.provider && held.assertionId === evidence.assertionId,
        )
      ) {
        throw conflict(
          'assertion-replayed',
          `assertion ${evidence.assertionId} from ${evidence.provider} has already been consumed`,
        );
      }
      if (this.#evidence.some((held) => held.idempotencyKey === evidence.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${evidence.idempotencyKey}" was used by another authentication`,
        );
      }
    }

    for (const session of working.newSessions) {
      if (this.#sessions.some((held) => held.sessionId === session.sessionId)) {
        throw conflict('malformed-record', `session ${session.sessionId} already exists`);
      }
      if (this.#sessions.some((held) => held.tokenHash === session.tokenHash)) {
        throw conflict(
          'insufficient-entropy',
          'two sessions produced the same token hash. The entropy source is repeating itself',
        );
      }
      if (this.#sessions.some((held) => held.idempotencyKey === session.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${session.idempotencyKey}" was used by another session`,
        );
      }
    }

    // Guarded updates, re-evaluated against the current store. A rotation whose expected hash has
    // been replaced since it looked has lost the race, and losing must not overwrite the winner.
    const applied: AuthenticationSession[] = [];
    for (const update of working.updates) {
      const index = this.#sessions.findIndex((held) => held.sessionId === update.next.sessionId);
      const current = index === -1 ? undefined : this.#sessions[index];
      if (current === undefined) continue;
      if (!update.guard(current)) continue;
      this.#sessions[index] = sealSession(update.next);
      applied.push(update.next);
    }
    working.recordApplied(applied);

    this.#bindings = [...this.#bindings, ...working.newBindings.map(sealBinding)];
    this.#evidence = [...this.#evidence, ...working.newEvidence.map(sealEvidence)];
    this.#sessions = [...this.#sessions, ...working.newSessions.map(sealSession)];
  }
}

function conflict(code: AuthenticationError['code'], message: string): AuthenticationError {
  return new AuthenticationError(
    code,
    `${message}, written by another transaction while this one was open`,
  );
}

interface GuardedUpdate {
  readonly guard: (current: AuthenticationSession) => boolean;
  readonly next: AuthenticationSession;
}

class WorkingSet {
  bindings: AuthenticationBinding[];
  evidence: AuthenticationEvidence[];
  sessions: AuthenticationSession[];
  readonly newBindings: AuthenticationBinding[] = [];
  readonly newEvidence: AuthenticationEvidence[] = [];
  readonly newSessions: AuthenticationSession[] = [];
  readonly updates: GuardedUpdate[] = [];
  #appliedIds = new Set<string>();

  constructor(snapshot: {
    bindings: AuthenticationBinding[];
    evidence: AuthenticationEvidence[];
    sessions: AuthenticationSession[];
  }) {
    this.bindings = snapshot.bindings;
    this.evidence = snapshot.evidence;
    this.sessions = snapshot.sessions;
  }

  recordApplied(applied: readonly AuthenticationSession[]): void {
    this.#appliedIds = new Set(applied.map((session) => session.sessionId));
  }

  wasApplied(sessionId: string): boolean {
    return this.#appliedIds.has(sessionId);
  }
}

class InMemoryAuthenticationTransaction implements AuthenticationTransaction {
  readonly #state: WorkingSet;

  constructor(state: WorkingSet) {
    this.#state = state;
  }

  findBindingById(bindingId: string): Promise<AuthenticationBinding | null> {
    return one(this.#state.bindings.find((entry) => entry.bindingId === bindingId), sealBinding);
  }

  findBindingByReference(
    provider: string,
    providerReference: string,
  ): Promise<AuthenticationBinding | null> {
    return one(
      this.#state.bindings.find(
        (entry) => entry.provider === provider && entry.providerReference === providerReference,
      ),
      sealBinding,
    );
  }

  findBindingByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationBinding | null> {
    return one(
      this.#state.bindings.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealBinding,
    );
  }

  listBindingsForSubject(subjectId: string): Promise<readonly AuthenticationBinding[]> {
    return Promise.resolve(
      sealBindings(
        this.#state.bindings
          .filter((entry) => entry.subjectId === subjectId)
          .sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
      ),
    );
  }

  insertBinding(binding: AuthenticationBinding): Promise<void> {
    if (this.#state.bindings.some((held) => held.bindingId === binding.bindingId)) {
      return reject('duplicate-binding', `binding ${binding.bindingId} already exists`);
    }
    if (
      this.#state.bindings.some(
        (held) =>
          held.provider === binding.provider &&
          held.providerReference === binding.providerReference,
      )
    ) {
      return reject(
        'duplicate-binding',
        `provider ${binding.provider} already has a binding for that reference. One reference ` +
          'authenticates one subject; a second would let two parties share a login',
      );
    }
    if (this.#state.bindings.some((held) => held.idempotencyKey === binding.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${binding.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealBinding(binding);
    this.#state.bindings.push(sealed);
    this.#state.newBindings.push(sealed);
    return Promise.resolve();
  }

  findEvidenceByAssertionId(
    provider: string,
    assertionId: string,
  ): Promise<AuthenticationEvidence | null> {
    return one(
      this.#state.evidence.find(
        (entry) => entry.provider === provider && entry.assertionId === assertionId,
      ),
      sealEvidence,
    );
  }

  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationEvidence | null> {
    return one(
      this.#state.evidence.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealEvidence,
    );
  }

  insertEvidence(evidence: AuthenticationEvidence): Promise<void> {
    if (this.#state.evidence.some((held) => held.evidenceId === evidence.evidenceId)) {
      return reject('malformed-record', `evidence ${evidence.evidenceId} already exists`);
    }
    if (
      this.#state.evidence.some(
        (held) => held.provider === evidence.provider && held.assertionId === evidence.assertionId,
      )
    ) {
      return reject(
        'assertion-replayed',
        `assertion ${evidence.assertionId} from ${evidence.provider} has already been consumed. ` +
          'A verifier assertion authenticates once; presenting it again is a replay whether or ' +
          'not the presenter meant it as one',
      );
    }
    if (this.#state.evidence.some((held) => held.idempotencyKey === evidence.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${evidence.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealEvidence(evidence);
    this.#state.evidence.push(sealed);
    this.#state.newEvidence.push(sealed);
    return Promise.resolve();
  }

  findSessionById(sessionId: string): Promise<AuthenticationSession | null> {
    return one(this.#state.sessions.find((entry) => entry.sessionId === sessionId), sealSession);
  }

  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    return one(this.#state.sessions.find((entry) => entry.tokenHash === tokenHash), sealSession);
  }

  findSessionByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationSession | null> {
    return one(
      this.#state.sessions.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealSession,
    );
  }

  insertSession(session: AuthenticationSession): Promise<void> {
    if (this.#state.sessions.some((held) => held.sessionId === session.sessionId)) {
      return reject('malformed-record', `session ${session.sessionId} already exists`);
    }
    if (this.#state.sessions.some((held) => held.tokenHash === session.tokenHash)) {
      return reject(
        'insufficient-entropy',
        'two sessions produced the same token hash. The entropy source is repeating itself, and ' +
          'issuing the second session would mean two parties holding one secret',
      );
    }
    if (this.#state.sessions.some((held) => held.idempotencyKey === session.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${session.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealSession(session);
    this.#state.sessions.push(sealed);
    this.#state.newSessions.push(sealed);
    return Promise.resolve();
  }

  rotateSession(command: RotationCommand): Promise<boolean> {
    const index = this.#state.sessions.findIndex(
      (entry) => entry.sessionId === command.sessionId,
    );
    const current = index === -1 ? undefined : this.#state.sessions[index];
    if (
      current === undefined ||
      current.tokenHash !== command.expectedTokenHash ||
      current.revokedAt !== null
    ) {
      return Promise.resolve(false);
    }

    const next = sealSession({
      ...current,
      tokenHash: command.nextTokenHash,
      idleExpiresAt: command.nextIdleExpiresAt,
      rotationCount: command.nextRotationCount,
    });
    this.#state.sessions[index] = next;
    this.#state.updates.push({
      guard: (live) => live.tokenHash === command.expectedTokenHash && live.revokedAt === null,
      next,
    });
    return Promise.resolve(true);
  }

  revokeSession(command: RevocationCommand): Promise<boolean> {
    const index = this.#state.sessions.findIndex(
      (entry) => entry.sessionId === command.sessionId,
    );
    const current = index === -1 ? undefined : this.#state.sessions[index];
    if (current === undefined || current.revokedAt !== null) return Promise.resolve(false);

    const next = sealSession({
      ...current,
      revokedAt: command.revokedAt,
      revocationReason: command.reason,
    });
    this.#state.sessions[index] = next;
    this.#state.updates.push({ guard: (live) => live.revokedAt === null, next });
    return Promise.resolve(true);
  }

  /** Whether a guarded update this transaction made actually survived commit. */
  applied(sessionId: string): boolean {
    return this.#state.wasApplied(sessionId);
  }
}

function one<T>(found: T | undefined, seal: (value: T) => T): Promise<T | null> {
  return Promise.resolve(found === undefined ? null : seal(found));
}

function reject(code: AuthenticationError['code'], message: string): Promise<never> {
  return Promise.reject(new AuthenticationError(code, message));
}
