/**
 * K-05 Configuration — the persistence port (FND-003a, corrected).
 *
 * The service is written against this interface and never against a driver, for the same reason
 * the migration runner is: publication has to be all-or-nothing, and the interesting cases are
 * concurrent publication and partial failure. Both are trivial to provoke against an injected
 * fake and awkward, slow and flaky to provoke against a live server.
 *
 * **The operations are shaped by the unique index, not merely by the domain.** The migration
 * declares a partial unique index on `(config_key, scope_level, scope_id) WHERE status = 'active'`,
 * so at no instant — not even inside a transaction — may two rows for one key and scope both be
 * active. An earlier revision inserted the replacement already active and superseded the incumbent
 * afterwards, which violates that index the moment both rows exist. The port therefore offers
 * three separate operations, and the service uses them in the only order the index permits:
 *
 *   1. `insertDraft`            — a draft is outside the index entirely
 *   2. `supersedeActiveVersion` — the incumbent leaves the index
 *   3. `activateDraft`          — the replacement enters it
 *
 * Steps 2 and 3 are also the concurrency control: each is conditional on the row's current status,
 * so a competing publication that got there first makes one of them affect zero rows, and the
 * loser is refused rather than silently overwriting the winner.
 *
 * Owned by: K-05 Configuration.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import { compareInstants } from './instant.ts';
import { ConfigurationError, type ConfigurationVersion, type Scope, scopeKey } from './types.ts';

export interface ConfigurationTransaction extends OutboxTransaction {
  /** The exact version, whatever its status. Historical decisions resolve through this. */
  findVersionById(versionId: string): Promise<ConfigurationVersion | null>;

  /** A previous publication with this idempotency key, if one exists. */
  findByIdempotencyKey(idempotencyKey: string): Promise<ConfigurationVersion | null>;

  /** Every version for a key at the given scopes, whatever its status, oldest first. */
  findVersions(key: string, scopes: readonly Scope[]): Promise<readonly ConfigurationVersion[]>;

  /**
   * Append a draft. Must reject a version whose status is not `draft`, a duplicate id, and a
   * reused idempotency key — the last of those is what makes a retry detectable at all.
   */
  insertDraft(version: ConfigurationVersion): Promise<void>;

  /**
   * Move an active version to superseded, conditional on it still being active.
   *
   * Must fail if it is not: that is the lost-update check. It runs *before* activation, so the
   * partial unique index is never asked to hold two active rows.
   */
  supersedeActiveVersion(versionId: string, supersededAt: string): Promise<void>;

  /**
   * Move a draft to active, conditional on it still being a draft, stamping the publication
   * instant and the version it replaced.
   */
  activateDraft(
    draftId: string,
    publishedAt: string,
    previousVersionId: string | null,
  ): Promise<void>;
}

export interface ConfigurationRepository {
  /**
   * Run `body` inside one transaction. An exception must roll everything back — a caller that
   * sees a rejection must be able to assume nothing was written, including a half-completed
   * replacement in which the incumbent was superseded but the draft never activated.
   */
  withTransaction<T>(body: (tx: ConfigurationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * Not a test double bolted on afterwards: it is the reference implementation of the port's
 * contract, and it enforces the same invariants the database does — including the partial unique
 * index, so an ordering mistake fails here as loudly as it would against PostgreSQL.
 *
 * Transactions read a snapshot taken on entry and, on success, apply only the rows they wrote onto
 * the current store — refusing if those rows moved underneath them. That gives the same
 * all-or-nothing behaviour the SQL adapter gets from the database, and the same refusal when two
 * publications overlap, rather than letting the later commit quietly overwrite the earlier one.
 */
export class InMemoryConfigurationRepository implements ConfigurationRepository {
  #versions: ConfigurationVersion[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-05', 'kernel_configuration');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  snapshot(): readonly ConfigurationVersion[] {
    return this.#versions.map((version) => ({ ...version }));
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(versions: readonly ConfigurationVersion[]): void {
    this.#versions = versions.map((version) => ({ ...version }));
  }

  async withTransaction<T>(body: (tx: ConfigurationTransaction) => Promise<T>): Promise<T> {
    const base = this.#versions.map((version) => ({ ...version }));
    const working = base.map((version) => ({ ...version }));
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());
    const tx = new InMemoryTransaction(working, outboxWorking);
    try {
      const result = await body(tx);
      this.#versions = this.#merge(base, working, tx.touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Commit this transaction's writes onto whatever the store looks like *now*.
   *
   * A transaction reads a snapshot taken on entry, so two overlapping publications each believe
   * they found no active version. Swapping the working copy in wholesale — which is what the
   * previous revision did — would let the second commit overwrite the first and leave two active
   * rows behind with no error raised anywhere: the very state the partial unique index exists to
   * make impossible, reachable in the reference implementation but not in the database it stands
   * in for.
   *
   * So only the rows this transaction actually touched are applied, and applying them is refused
   * if the store moved underneath them or if the result would hold two active rows for one key
   * and scope. Both are races, and both are reported as `concurrent-modification` — the loser
   * keeps its draft and may retry against the winner.
   */
  #merge(
    base: readonly ConfigurationVersion[],
    working: readonly ConfigurationVersion[],
    touched: ReadonlySet<string>,
  ): ConfigurationVersion[] {
    const baseById = new Map(base.map((version) => [version.versionId, version]));
    const currentById = new Map(this.#versions.map((version) => [version.versionId, version]));
    const merged = this.#versions.map((version) => ({ ...version }));
    const indexById = new Map(merged.map((version, index) => [version.versionId, index]));

    for (const versionId of touched) {
      const written = working.find((version) => version.versionId === versionId);
      if (written === undefined) continue;

      const before = baseById.get(versionId);
      const now = currentById.get(versionId);

      if (before === undefined) {
        if (now !== undefined) {
          throw new ConfigurationError(
            'concurrent-modification',
            `version ${versionId} was inserted by another transaction while this one was open`,
          );
        }
        indexById.set(versionId, merged.length);
        merged.push({ ...written });
        continue;
      }

      if (now === undefined || !sameLifecycle(before, now)) {
        throw new ConfigurationError(
          'concurrent-modification',
          `version ${versionId} changed underneath this transaction — it was ` +
            `${before.status} when read and is ${now?.status ?? 'gone'} now. Re-read and retry`,
        );
      }

      merged[indexById.get(versionId) as number] = { ...written };
    }

    try {
      assertAtMostOneActivePerScope(merged);
    } catch {
      // Reached only across transactions: an ordering mistake inside one transaction is caught by
      // `activateDraft` when the statement runs, exactly as the database would catch it.
      throw new ConfigurationError(
        'concurrent-modification',
        'another publication activated a version for this key and scope first. The partial ' +
          'unique index permits one active row, so this one is refused rather than committed ' +
          'alongside it',
      );
    }
    return merged;
  }
}

/** Only lifecycle state moves, so only lifecycle state can be raced on. */
function sameLifecycle(a: ConfigurationVersion, b: ConfigurationVersion): boolean {
  return (
    a.status === b.status &&
    a.publishedAt === b.publishedAt &&
    a.supersededAt === b.supersededAt &&
    a.previousVersionId === b.previousVersionId
  );
}

/** The partial unique index, in code. A commit that would violate it is refused. */
function assertAtMostOneActivePerScope(versions: readonly ConfigurationVersion[]): void {
  const seen = new Set<string>();
  for (const version of versions) {
    if (version.status !== 'active') continue;
    const identity = `${version.key}|${scopeKey(version.scope)}`;
    if (seen.has(identity)) {
      throw new ConfigurationError(
        'ambiguous-active-version',
        `two active versions for ${identity} — the partial unique index would reject this commit`,
      );
    }
    seen.add(identity);
  }
}

class InMemoryTransaction implements ConfigurationTransaction {
  readonly #versions: ConfigurationVersion[];
  readonly #outbox: InMemoryOutboxStore;
  /** Every version this transaction wrote, so the commit applies those rows and only those. */
  readonly touched = new Set<string>();

  constructor(versions: ConfigurationVersion[], outbox: InMemoryOutboxStore) {
    this.#versions = versions;
    this.#outbox = outbox;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
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
            compareInstants(a.effectiveFrom, b.effectiveFrom) ||
            a.versionId.localeCompare(b.versionId),
        ),
    );
  }

  insertDraft(version: ConfigurationVersion): Promise<void> {
    if (version.status !== 'draft') {
      return Promise.reject(
        new ConfigurationError(
          'immutable-version',
          `insertDraft was given a ${version.status} version — a version is created as a draft and ` +
            'activated separately, never constructed already active',
        ),
      );
    }
    if (this.#versions.some((v) => v.versionId === version.versionId)) {
      return Promise.reject(
        new ConfigurationError('immutable-version', `version ${version.versionId} already exists`),
      );
    }
    if (this.#versions.some((v) => v.idempotencyKey === version.idempotencyKey)) {
      return Promise.reject(
        new ConfigurationError(
          'idempotency-key-reuse',
          `idempotency key ${version.idempotencyKey} has already been used`,
        ),
      );
    }
    this.#versions.push({ ...version });
    this.touched.add(version.versionId);
    return Promise.resolve();
  }

  supersedeActiveVersion(versionId: string, supersededAt: string): Promise<void> {
    const index = this.#versions.findIndex((v) => v.versionId === versionId);
    const existing = index === -1 ? undefined : this.#versions[index];
    if (existing === undefined) {
      return Promise.reject(
        new ConfigurationError('concurrent-modification', `version ${versionId} does not exist`),
      );
    }
    if (existing.status !== 'active') {
      return Promise.reject(
        new ConfigurationError(
          'concurrent-modification',
          `version ${versionId} is ${existing.status}, not active — it changed underneath this ` +
            'publication',
        ),
      );
    }
    this.#versions[index] = { ...existing, status: 'superseded', supersededAt };
    this.touched.add(versionId);
    return Promise.resolve();
  }

  activateDraft(
    draftId: string,
    publishedAt: string,
    previousVersionId: string | null,
  ): Promise<void> {
    const index = this.#versions.findIndex((v) => v.versionId === draftId);
    const existing = index === -1 ? undefined : this.#versions[index];
    if (existing === undefined) {
      return Promise.reject(
        new ConfigurationError('draft-not-found', `no version ${draftId} to activate`),
      );
    }
    if (existing.status !== 'draft') {
      return Promise.reject(
        new ConfigurationError(
          'concurrent-modification',
          `version ${draftId} is ${existing.status}, not a draft — it was activated by someone else`,
        ),
      );
    }
    this.#versions[index] = { ...existing, status: 'active', publishedAt, previousVersionId };
    // Checked here, not at commit: a unique index rejects the second active row the moment the
    // statement runs, so an ordering mistake must fail at the same point it would against
    // PostgreSQL rather than passing until the end of the transaction.
    try {
      assertAtMostOneActivePerScope(this.#versions);
    } catch (error) {
      this.#versions[index] = existing;
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.touched.add(draftId);
    return Promise.resolve();
  }
}
