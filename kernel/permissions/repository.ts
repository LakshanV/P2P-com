/**
 * K-04 Permissions — the persistence port (FND-004d).
 *
 * Four record types and one rule that runs through all of them: **authority history is
 * append-only**. There is no update and no delete anywhere in this port — not for a policy
 * version, not for a grant, not for a revocation, not for a decision.
 *
 * That is stronger than the write-once rules in K-01, K-03 and K-09, and it is stronger on
 * purpose. A grant that could be edited is a grant whose history lies: the question an auditor
 * asks is not "who may do this" but "who *could* have done this, in March, and who said so". An
 * edited grant answers the first and destroys the second. Withdrawal is expressed by appending a
 * revocation, which is a fact with a time and a reason, rather than by removing a row, which is
 * the absence of a fact.
 *
 * Uniqueness is what makes idempotency and replay-safety real, so it is enforced here rather than
 * by a read-then-write in the service: policy version number, every record id, and every
 * idempotency key. Two identical concurrent grants can both pass a read; they cannot both pass a
 * constraint.
 *
 * Owned by: K-04 Permissions.
 */

import {
  sealDecision,
  sealDecisions,
  sealGrant,
  sealGrants,
  sealPolicyVersion,
  sealRevocation,
  sealRevocations,
} from './immutable.ts';
import {
  PermissionError,
  type Decision,
  type Grant,
  type PolicyVersion,
  type Revocation,
} from './types.ts';

export interface PermissionTransaction {
  /** The highest published policy version, or null when none has been published. */
  findActivePolicy(): Promise<PolicyVersion | null>;
  findPolicyById(policyVersionId: string): Promise<PolicyVersion | null>;
  findPolicyByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null>;
  insertPolicyVersion(policy: PolicyVersion): Promise<void>;

  findGrantById(grantId: string): Promise<Grant | null>;
  findGrantByIdempotencyKey(idempotencyKey: string): Promise<Grant | null>;
  /** Every grant recorded for this subject in this account, revoked or not. */
  listGrantsForSubject(subjectId: string, accountId: string): Promise<readonly Grant[]>;
  insertGrant(grant: Grant): Promise<void>;

  findRevocationByGrantId(grantId: string): Promise<Revocation | null>;
  findRevocationByIdempotencyKey(idempotencyKey: string): Promise<Revocation | null>;
  /** Revocations for a set of grants, so a decision needs one round trip rather than N. */
  listRevocationsForGrants(grantIds: readonly string[]): Promise<readonly Revocation[]>;
  insertRevocation(revocation: Revocation): Promise<void>;

  findDecisionById(decisionId: string): Promise<Decision | null>;
  findDecisionByIdempotencyKey(idempotencyKey: string): Promise<Decision | null>;
  insertDecision(decision: Decision): Promise<void>;
}

export interface PermissionRepository {
  withTransaction<T>(body: (tx: PermissionTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same uniqueness the database does — every id, every idempotency key, the policy version number,
 * and one revocation per grant — and it checks them **at commit against the store as it stands**,
 * so two callers that overlap behave here as they would against a server. K-08 shipped without
 * that parity and every concurrency guarantee proved against it was worth less than it appeared
 * (CURRENT_IMPLEMENTATION_STATUS §11.15).
 */
export class InMemoryPermissionRepository implements PermissionRepository {
  #policies: PolicyVersion[] = [];
  #grants: Grant[] = [];
  #revocations: Revocation[] = [];
  #decisions: Decision[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  policies(): readonly PolicyVersion[] {
    return Object.freeze(this.#policies.map(sealPolicyVersion));
  }

  grants(): readonly Grant[] {
    return sealGrants(this.#grants);
  }

  revocations(): readonly Revocation[] {
    return sealRevocations(this.#revocations);
  }

  decisions(): readonly Decision[] {
    return sealDecisions(this.#decisions);
  }

  seed(state: {
    readonly policies?: readonly PolicyVersion[];
    readonly grants?: readonly Grant[];
    readonly revocations?: readonly Revocation[];
    readonly decisions?: readonly Decision[];
  }): void {
    // Sealed on the way in: a test that seeds a grant and then edits its condition must not be
    // editing the store. A shallow copy would have shared every predicate tree.
    this.#policies = (state.policies ?? []).map(sealPolicyVersion);
    this.#grants = (state.grants ?? []).map(sealGrant);
    this.#revocations = (state.revocations ?? []).map(sealRevocation);
    this.#decisions = (state.decisions ?? []).map(sealDecision);
  }

  async withTransaction<T>(body: (tx: PermissionTransaction) => Promise<T>): Promise<T> {
    const working = new WorkingSet({
      policies: this.#policies.map(sealPolicyVersion),
      grants: this.#grants.map(sealGrant),
      revocations: this.#revocations.map(sealRevocation),
      decisions: this.#decisions.map(sealDecision),
    });

    try {
      const result = await body(new InMemoryPermissionTransaction(working));
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
   * published until every check has passed, so a refused transaction leaves no partial authority
   * behind — half a grant is a grant.
   */
  #commit(working: WorkingSet): void {
    for (const policy of working.newPolicies) {
      if (this.#policies.some((held) => held.policyVersionId === policy.policyVersionId)) {
        throw conflict('malformed-record', `policy version ${policy.policyVersionId} already exists`);
      }
      if (this.#policies.some((held) => held.version === policy.version)) {
        throw conflict('duplicate-policy-version', `policy version number ${policy.version} is taken`);
      }
      if (this.#policies.some((held) => held.idempotencyKey === policy.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${policy.idempotencyKey}" was used by another policy version`,
        );
      }
    }

    for (const grant of working.newGrants) {
      if (this.#grants.some((held) => held.grantId === grant.grantId)) {
        throw conflict('duplicate-grant', `grant ${grant.grantId} already exists`);
      }
      if (this.#grants.some((held) => held.idempotencyKey === grant.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${grant.idempotencyKey}" was used by another grant`,
        );
      }
    }

    for (const revocation of working.newRevocations) {
      if (this.#revocations.some((held) => held.revocationId === revocation.revocationId)) {
        throw conflict('malformed-record', `revocation ${revocation.revocationId} already exists`);
      }
      // One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
      // authority actually ended.
      if (this.#revocations.some((held) => held.grantId === revocation.grantId)) {
        throw conflict('stale-revocation', `grant ${revocation.grantId} has already been revoked`);
      }
      if (this.#revocations.some((held) => held.idempotencyKey === revocation.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${revocation.idempotencyKey}" was used by another revocation`,
        );
      }
    }

    for (const decision of working.newDecisions) {
      if (this.#decisions.some((held) => held.decisionId === decision.decisionId)) {
        throw conflict('malformed-record', `decision ${decision.decisionId} already exists`);
      }
      if (this.#decisions.some((held) => held.idempotencyKey === decision.idempotencyKey)) {
        throw conflict(
          'idempotency-key-reuse',
          `idempotency key "${decision.idempotencyKey}" was used by another decision`,
        );
      }
    }

    // Published only now: every uniqueness check has won.
    this.#policies = [...this.#policies, ...working.newPolicies.map(sealPolicyVersion)];
    this.#grants = [...this.#grants, ...working.newGrants.map(sealGrant)];
    this.#revocations = [...this.#revocations, ...working.newRevocations.map(sealRevocation)];
    this.#decisions = [...this.#decisions, ...working.newDecisions.map(sealDecision)];
  }
}

function conflict(code: PermissionError['code'], message: string): PermissionError {
  return new PermissionError(
    code,
    `${message}, written by another transaction while this one was open`,
  );
}

class WorkingSet {
  policies: PolicyVersion[];
  grants: Grant[];
  revocations: Revocation[];
  decisions: Decision[];
  readonly newPolicies: PolicyVersion[] = [];
  readonly newGrants: Grant[] = [];
  readonly newRevocations: Revocation[] = [];
  readonly newDecisions: Decision[] = [];

  constructor(snapshot: {
    policies: PolicyVersion[];
    grants: Grant[];
    revocations: Revocation[];
    decisions: Decision[];
  }) {
    this.policies = snapshot.policies;
    this.grants = snapshot.grants;
    this.revocations = snapshot.revocations;
    this.decisions = snapshot.decisions;
  }
}

class InMemoryPermissionTransaction implements PermissionTransaction {
  readonly #state: WorkingSet;

  constructor(state: WorkingSet) {
    this.#state = state;
  }

  findActivePolicy(): Promise<PolicyVersion | null> {
    // Highest version wins, not most recently written: a version number is the ordering, and a
    // clock is not, because two publications can share an instant.
    const active = [...this.#state.policies].sort((a, b) => b.version - a.version)[0];
    return one(active, sealPolicyVersion);
  }

  findPolicyById(policyVersionId: string): Promise<PolicyVersion | null> {
    return one(
      this.#state.policies.find((entry) => entry.policyVersionId === policyVersionId),
      sealPolicyVersion,
    );
  }

  findPolicyByIdempotencyKey(idempotencyKey: string): Promise<PolicyVersion | null> {
    return one(
      this.#state.policies.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealPolicyVersion,
    );
  }

  insertPolicyVersion(policy: PolicyVersion): Promise<void> {
    if (this.#state.policies.some((held) => held.policyVersionId === policy.policyVersionId)) {
      return reject('malformed-record', `policy version ${policy.policyVersionId} already exists`);
    }
    if (this.#state.policies.some((held) => held.version === policy.version)) {
      return reject(
        'duplicate-policy-version',
        `policy version number ${policy.version} has already been published. Versions are numbered ` +
          'so a decision can be replayed against the policy that was active when it was taken',
      );
    }
    if (this.#state.policies.some((held) => held.idempotencyKey === policy.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${policy.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealPolicyVersion(policy);
    this.#state.policies.push(sealed);
    this.#state.newPolicies.push(sealed);
    return Promise.resolve();
  }

  findGrantById(grantId: string): Promise<Grant | null> {
    return one(this.#state.grants.find((entry) => entry.grantId === grantId), sealGrant);
  }

  findGrantByIdempotencyKey(idempotencyKey: string): Promise<Grant | null> {
    return one(
      this.#state.grants.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealGrant,
    );
  }

  listGrantsForSubject(subjectId: string, accountId: string): Promise<readonly Grant[]> {
    return Promise.resolve(
      sealGrants(
        this.#state.grants
          .filter((entry) => entry.subjectId === subjectId && entry.accountId === accountId)
          .sort((a, b) => a.grantId.localeCompare(b.grantId)),
      ),
    );
  }

  insertGrant(grant: Grant): Promise<void> {
    if (this.#state.grants.some((held) => held.grantId === grant.grantId)) {
      return reject('duplicate-grant', `grant ${grant.grantId} already exists`);
    }
    if (this.#state.grants.some((held) => held.idempotencyKey === grant.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${grant.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealGrant(grant);
    this.#state.grants.push(sealed);
    this.#state.newGrants.push(sealed);
    return Promise.resolve();
  }

  findRevocationByGrantId(grantId: string): Promise<Revocation | null> {
    return one(this.#state.revocations.find((entry) => entry.grantId === grantId), sealRevocation);
  }

  findRevocationByIdempotencyKey(idempotencyKey: string): Promise<Revocation | null> {
    return one(
      this.#state.revocations.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealRevocation,
    );
  }

  listRevocationsForGrants(grantIds: readonly string[]): Promise<readonly Revocation[]> {
    return Promise.resolve(
      sealRevocations(
        this.#state.revocations
          .filter((entry) => grantIds.includes(entry.grantId))
          .sort((a, b) => a.revocationId.localeCompare(b.revocationId)),
      ),
    );
  }

  insertRevocation(revocation: Revocation): Promise<void> {
    if (this.#state.revocations.some((held) => held.revocationId === revocation.revocationId)) {
      return reject('malformed-record', `revocation ${revocation.revocationId} already exists`);
    }
    if (this.#state.revocations.some((held) => held.grantId === revocation.grantId)) {
      return reject(
        'stale-revocation',
        `grant ${revocation.grantId} has already been revoked. A second revocation would rewrite ` +
          'when authority actually ended, and the first one is the one that counts',
      );
    }
    if (this.#state.revocations.some((held) => held.idempotencyKey === revocation.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${revocation.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealRevocation(revocation);
    this.#state.revocations.push(sealed);
    this.#state.newRevocations.push(sealed);
    return Promise.resolve();
  }

  findDecisionById(decisionId: string): Promise<Decision | null> {
    return one(this.#state.decisions.find((entry) => entry.decisionId === decisionId), sealDecision);
  }

  findDecisionByIdempotencyKey(idempotencyKey: string): Promise<Decision | null> {
    return one(
      this.#state.decisions.find((entry) => entry.idempotencyKey === idempotencyKey),
      sealDecision,
    );
  }

  insertDecision(decision: Decision): Promise<void> {
    if (this.#state.decisions.some((held) => held.decisionId === decision.decisionId)) {
      return reject('malformed-record', `decision ${decision.decisionId} already exists`);
    }
    if (this.#state.decisions.some((held) => held.idempotencyKey === decision.idempotencyKey)) {
      return reject(
        'idempotency-key-reuse',
        `idempotency key "${decision.idempotencyKey}" has already been used`,
      );
    }
    const sealed = sealDecision(decision);
    this.#state.decisions.push(sealed);
    this.#state.newDecisions.push(sealed);
    return Promise.resolve();
  }
}

function one<T>(found: T | undefined, seal: (value: T) => T): Promise<T | null> {
  return Promise.resolve(found === undefined ? null : seal(found));
}

function reject(code: PermissionError['code'], message: string): Promise<never> {
  return Promise.reject(new PermissionError(code, message));
}
