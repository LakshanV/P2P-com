/**
 * K-05 Configuration — the persistence port (FND-003a).
 *
 * The service is written against this interface and never against a driver, for the same reason
 * the migration runner is: publication has to be all-or-nothing, and the interesting cases are
 * concurrent publication and partial failure. Both are trivial to provoke against an injected
 * fake and awkward, slow and flaky to provoke against a live server.
 *
 * Every mutation goes through `withTransaction`. A publication writes the new version *and*
 * supersedes the one it replaces; a database that committed one without the other would have two
 * active versions for a key, which is precisely the ambiguity this component exists to prevent.
 *
 * Owned by: K-05 Configuration.
 */

import { ConfigurationError, type ConfigurationVersion, type Scope, scopeKey } from './types.ts';

export interface ConfigurationTransaction {
  /** The exact version, whatever its status. Historical decisions resolve through this. */
  findVersionById(versionId: string): Promise<ConfigurationVersion | null>;

  /** A previous publication with this idempotency key, if one exists. */
  findByIdempotencyKey(idempotencyKey: string): Promise<ConfigurationVersion | null>;

  /** Every version for a key at the given scopes, whatever its status, oldest first. */
  findVersions(key: string, scopes: readonly Scope[]): Promise<readonly ConfigurationVersion[]>;

  /** Append a version. Must fail rather than overwrite if the id already exists. */
  insertVersion(version: ConfigurationVersion): Promise<void>;

  /** Mark a version superseded at an instant. Must fail if it is not currently active. */
  supersedeVersion(versionId: string, supersededAt: string): Promise<void>;
}

export interface ConfigurationRepository {
  /**
   * Run `body` inside one transaction. An exception must roll everything back — a caller that
   * sees a rejection must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: ConfigurationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * Not a test double bolted on afterwards: it is the reference implementation of the port's
 * contract, and `tests/configuration-repository.test.ts` runs the same conformance suite against
 * this and against the PostgreSQL adapter, so the two cannot drift apart silently.
 *
 * Transactions are modelled by copying state on entry and swapping it in on success, which gives
 * the same all-or-nothing behaviour the SQL adapter gets from the database.
 */
export class InMemoryConfigurationRepository implements ConfigurationRepository {
  #versions: ConfigurationVersion[] = [];
  /** Publications attempted; used by tests to prove a rolled-back publication wrote nothing. */
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  snapshot(): readonly ConfigurationVersion[] {
    return this.#versions.map((version) => ({ ...version }));
  }

  async withTransaction<T>(body: (tx: ConfigurationTransaction) => Promise<T>): Promise<T> {
    const working = this.#versions.map((version) => ({ ...version }));
    const tx = new InMemoryTransaction(working);
    try {
      const result = await body(tx);
      this.#versions = working;
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }
}

class InMemoryTransaction implements ConfigurationTransaction {
  readonly #versions: ConfigurationVersion[];

  constructor(versions: ConfigurationVersion[]) {
    this.#versions = versions;
  }

  findVersionById(versionId: string): Promise<ConfigurationVersion | null> {
    return Promise.resolve(this.#versions.find((v) => v.versionId === versionId) ?? null);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<ConfigurationVersion | null> {
    return Promise.resolve(this.#versions.find((v) => v.idempotencyKey === idempotencyKey) ?? null);
  }

  findVersions(key: string, scopes: readonly Scope[]): Promise<readonly ConfigurationVersion[]> {
    const wanted = new Set(scopes.map(scopeKey));
    return Promise.resolve(
      this.#versions
        .filter((v) => v.key === key && wanted.has(scopeKey(v.scope)))
        .sort(
          (a, b) =>
            a.effectiveFrom.localeCompare(b.effectiveFrom) ||
            a.versionId.localeCompare(b.versionId),
        ),
    );
  }

  insertVersion(version: ConfigurationVersion): Promise<void> {
    if (this.#versions.some((v) => v.versionId === version.versionId)) {
      return Promise.reject(
        new ConfigurationError('immutable-version', `version ${version.versionId} already exists`),
      );
    }
    if (this.#versions.some((v) => v.idempotencyKey === version.idempotencyKey)) {
      return Promise.reject(
        new ConfigurationError(
          'concurrent-modification',
          `idempotency key ${version.idempotencyKey} has already been used`,
        ),
      );
    }
    this.#versions.push({ ...version });
    return Promise.resolve();
  }

  supersedeVersion(versionId: string, supersededAt: string): Promise<void> {
    const index = this.#versions.findIndex((v) => v.versionId === versionId);
    const existing = index === -1 ? undefined : this.#versions[index];
    if (existing === undefined) {
      return Promise.reject(
        new ConfigurationError('concurrent-modification', `version ${versionId} does not exist`),
      );
    }
    if (existing.status !== 'active') {
      // Someone else superseded it between our read and our write.
      return Promise.reject(
        new ConfigurationError(
          'concurrent-modification',
          `version ${versionId} is ${existing.status}, not active — it changed underneath this ` +
            'publication',
        ),
      );
    }
    this.#versions[index] = { ...existing, status: 'superseded', supersededAt };
    return Promise.resolve();
  }
}
