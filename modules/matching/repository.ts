/**
 * M-07 Matching — the persistence port and its in-memory reference implementation.
 *
 * Every record here is append-only: a run, what each rung did, and what was found. Re-running the
 * ladder creates a new run rather than replacing the old one, because comparing two runs is how
 * anybody answers "why did this find nothing on Tuesday and something on Thursday".
 *
 * Owned by: M-07 Matching.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealCandidate,
  sealCandidates,
  sealMatchRun,
  sealMatchRuns,
  sealRungAttempt,
  sealRungAttempts,
} from './immutable.ts';
import { MatchingError, type MatchCandidate, type MatchRun, type RungAttempt } from './types.ts';

export interface MatchingTransaction extends OutboxTransaction {
  findRunById(runId: string): Promise<MatchRun | null>;
  findRunByIdempotencyKey(idempotencyKey: string): Promise<MatchRun | null>;
  findRunsByRequestId(requestId: string): Promise<readonly MatchRun[]>;
  insertRun(run: MatchRun): Promise<void>;

  findAttemptsByRunId(runId: string): Promise<readonly RungAttempt[]>;
  insertAttempt(attempt: RungAttempt): Promise<void>;

  findCandidatesByRunId(runId: string): Promise<readonly MatchCandidate[]>;
  insertCandidate(candidate: MatchCandidate): Promise<void>;
}

export interface MatchingRepository {
  withTransaction<T>(body: (tx: MatchingTransaction) => Promise<T>): Promise<T>;
}

interface Store {
  runs: MatchRun[];
  attempts: RungAttempt[];
  candidates: MatchCandidate[];
}

export class InMemoryMatchingRepository implements MatchingRepository {
  #store: Store = { runs: [], attempts: [], candidates: [] };
  readonly #outbox = new InMemoryOutboxStore('M-07', 'module_matching');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  runs(): readonly MatchRun[] {
    return sealMatchRuns(this.#store.runs);
  }

  attempts(): readonly RungAttempt[] {
    return sealRungAttempts(this.#store.attempts);
  }

  candidates(): readonly MatchCandidate[] {
    return sealCandidates(this.#store.candidates);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  seed(state: {
    readonly runs?: readonly MatchRun[];
    readonly attempts?: readonly RungAttempt[];
    readonly candidates?: readonly MatchCandidate[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#store = {
      runs: (state.runs ?? []).map(sealMatchRun),
      attempts: (state.attempts ?? []).map(sealRungAttempt),
      candidates: (state.candidates ?? []).map(sealCandidate),
    };
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: MatchingTransaction) => Promise<T>): Promise<T> {
    const working: Store = {
      runs: this.#store.runs.map(sealMatchRun),
      attempts: this.#store.attempts.map(sealRungAttempt),
      candidates: this.#store.candidates.map(sealCandidate),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const created = new Set<string>();
    const tx = new InMemoryMatchingTransaction(working, outboxWorking, created);

    try {
      const result = await body(tx);
      // Checked at commit against the **committed** store rather than the snapshot the transaction
      // read, because the snapshot is exactly what a concurrent transaction would not have been in.
      // An in-memory repository more forgiving than PostgreSQL is a test suite proving the wrong
      // thing.
      for (const run of working.runs) {
        if (!created.has(run.runId)) continue;
        if (this.#store.runs.some((held) => held.runId === run.runId)) {
          throw new MatchingError(
            'duplicate-run-id',
            `run ${run.runId} was created by another transaction while this one was open`,
          );
        }
        if (this.#store.runs.some((held) => held.idempotencyKey === run.idempotencyKey)) {
          throw new MatchingError(
            'idempotency-key-reuse',
            `idempotency key "${run.idempotencyKey}" was used by a run created while this ` +
              'transaction was open',
          );
        }
      }
      this.#store = working;
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }
}

class InMemoryMatchingTransaction implements MatchingTransaction {
  readonly #store: Store;
  readonly #outbox: InMemoryOutboxStore;
  readonly #created: Set<string>;

  constructor(store: Store, outbox: InMemoryOutboxStore, created: Set<string>) {
    this.#store = store;
    this.#outbox = outbox;
    this.#created = created;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findRunById(runId: string): Promise<MatchRun | null> {
    return Promise.resolve(this.#store.runs.find((one) => one.runId === runId) ?? null);
  }

  findRunByIdempotencyKey(idempotencyKey: string): Promise<MatchRun | null> {
    return Promise.resolve(
      this.#store.runs.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findRunsByRequestId(requestId: string): Promise<readonly MatchRun[]> {
    return Promise.resolve(
      sealMatchRuns(
        this.#store.runs
          .filter((one) => one.requestId === requestId)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      ),
    );
  }

  insertRun(run: MatchRun): Promise<void> {
    if (this.#store.runs.some((one) => one.runId === run.runId)) {
      return Promise.reject(
        new MatchingError('duplicate-run-id', `run ${run.runId} already exists`),
      );
    }
    if (this.#store.runs.some((one) => one.idempotencyKey === run.idempotencyKey)) {
      return Promise.reject(
        new MatchingError(
          'idempotency-key-reuse',
          `idempotency key "${run.idempotencyKey}" already belongs to another run`,
        ),
      );
    }
    this.#store.runs.push(sealMatchRun(run));
    this.#created.add(run.runId);
    return Promise.resolve();
  }

  findAttemptsByRunId(runId: string): Promise<readonly RungAttempt[]> {
    return Promise.resolve(
      sealRungAttempts(
        this.#store.attempts
          .filter((one) => one.runId === runId)
          .sort((a, b) => a.position - b.position),
      ),
    );
  }

  insertAttempt(attempt: RungAttempt): Promise<void> {
    if (this.#store.attempts.some((one) => one.attemptId === attempt.attemptId)) {
      return Promise.reject(
        new MatchingError('malformed-record', `attempt ${attempt.attemptId} already exists`),
      );
    }
    this.#store.attempts.push(sealRungAttempt(attempt));
    return Promise.resolve();
  }

  findCandidatesByRunId(runId: string): Promise<readonly MatchCandidate[]> {
    return Promise.resolve(
      sealCandidates(
        this.#store.candidates
          .filter((one) => one.runId === runId)
          // Best first, so a caller that takes the head takes the best rather than the first found.
          .sort(
            (a, b) =>
              b.scorePerMille - a.scorePerMille || a.candidateId.localeCompare(b.candidateId),
          ),
      ),
    );
  }

  insertCandidate(candidate: MatchCandidate): Promise<void> {
    if (this.#store.candidates.some((one) => one.candidateId === candidate.candidateId)) {
      return Promise.reject(
        new MatchingError(
          'duplicate-candidate-id',
          `candidate ${candidate.candidateId} already exists`,
        ),
      );
    }
    this.#store.candidates.push(sealCandidate(candidate));
    return Promise.resolve();
  }
}
