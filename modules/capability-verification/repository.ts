/**
 * M-02 Capability & Verification — the persistence port.
 *
 * The service is written against this interface. The port exposes case lookup, creation and
 * lifecycle updates, evidence append-only storage, level-record append-only storage, and the outbox
 * insert every producing module must support.
 *
 * Owned by: M-02 Capability & Verification.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealEvidence,
  sealEvidences,
  sealLevelRecord,
  sealLevelRecords,
  sealVerificationCase,
  sealVerificationCases,
} from './immutable.ts';
import {
  CapabilityVerificationError,
  type Evidence,
  type LevelRecord,
  type VerificationCase,
} from './types.ts';

export interface CapabilityVerificationTransaction extends OutboxTransaction {
  /** Case lookup and creation. */
  findCaseById(caseId: string): Promise<VerificationCase | null>;
  findCaseByIdempotencyKey(idempotencyKey: string): Promise<VerificationCase | null>;
  findCasesByAccountId(accountId: string): Promise<readonly VerificationCase[]>;
  findOpenCaseByAccountAndPurpose(
    accountId: string,
    purpose: string,
  ): Promise<VerificationCase | null>;
  insertCase(verificationCase: VerificationCase): Promise<void>;
  updateCase(verificationCase: VerificationCase): Promise<void>;

  /** Evidence lookup and creation. */
  findEvidenceById(evidenceId: string): Promise<Evidence | null>;
  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<Evidence | null>;
  findEvidenceByCaseId(caseId: string): Promise<readonly Evidence[]>;
  insertEvidence(evidence: Evidence): Promise<void>;

  /** Level-record lookup and creation. */
  findLevelRecordById(recordId: string): Promise<LevelRecord | null>;
  findLevelRecordByIdempotencyKey(idempotencyKey: string): Promise<LevelRecord | null>;
  findLevelRecordsByCaseId(caseId: string): Promise<readonly LevelRecord[]>;
  findLevelRecordsByAccountId(accountId: string): Promise<readonly LevelRecord[]>;
  insertLevelRecord(record: LevelRecord): Promise<void>;
}

export interface CapabilityVerificationRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written case, evidence or
   * level record.
   */
  withTransaction<T>(body: (tx: CapabilityVerificationTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against
 * the snapshot the transaction read.
 */
export class InMemoryCapabilityVerificationRepository implements CapabilityVerificationRepository {
  #cases: VerificationCase[] = [];
  #evidences: Evidence[] = [];
  #records: LevelRecord[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-02', 'module_capability_verification');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  cases(): readonly VerificationCase[] {
    return sealVerificationCases(this.#cases);
  }

  evidences(): readonly Evidence[] {
    return sealEvidences(this.#evidences);
  }

  records(): readonly LevelRecord[] {
    return sealLevelRecords(this.#records);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly cases?: readonly VerificationCase[];
    readonly evidences?: readonly Evidence[];
    readonly records?: readonly LevelRecord[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#cases = (state.cases ?? []).map(sealVerificationCase);
    this.#evidences = (state.evidences ?? []).map(sealEvidence);
    this.#records = (state.records ?? []).map(sealLevelRecord);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(
    body: (tx: CapabilityVerificationTransaction) => Promise<T>,
  ): Promise<T> {
    const working = {
      cases: this.#cases.map(sealVerificationCase),
      evidences: this.#evidences.map(sealEvidence),
      records: this.#records.map(sealLevelRecord),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryCapabilityVerificationTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Cases: idempotency-key conflicts come first, then case-id conflicts, then the open-case rule.
    for (const verificationCase of working.cases) {
      if (touched.caseKeys.has(verificationCase.idempotencyKey)) {
        const holder = this.#cases.find(
          (held) => held.idempotencyKey === verificationCase.idempotencyKey,
        );
        if (holder !== undefined && holder.caseId !== verificationCase.caseId) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${verificationCase.idempotencyKey}" was used by case ` +
              `${holder.caseId}, created by another transaction while this one was open`,
          );
        }
      }
      if (touched.cases.has(verificationCase.caseId)) {
        if (this.#cases.some((held) => held.caseId === verificationCase.caseId)) {
          throw new CapabilityVerificationError(
            'duplicate-case-id',
            `case ${verificationCase.caseId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
    }

    for (const verificationCase of working.cases) {
      if (isOpenCase(verificationCase.status) && touched.caseTouches.has(verificationCase.caseId)) {
        const conflict = working.cases.find(
          (other) =>
            other.caseId !== verificationCase.caseId &&
            other.accountId === verificationCase.accountId &&
            other.purpose === verificationCase.purpose &&
            isOpenCase(other.status),
        );
        if (conflict !== undefined) {
          throw new CapabilityVerificationError(
            'case-already-open',
            `account ${verificationCase.accountId} already has an open case for ` +
              `${verificationCase.purpose}: ${conflict.caseId}`,
          );
        }
        const committedConflict = this.#cases.find(
          (held) =>
            held.caseId !== verificationCase.caseId &&
            held.accountId === verificationCase.accountId &&
            held.purpose === verificationCase.purpose &&
            isOpenCase(held.status),
        );
        if (committedConflict !== undefined) {
          throw new CapabilityVerificationError(
            'case-already-open',
            `account ${verificationCase.accountId} already has an open case for ` +
              `${verificationCase.purpose}: ${committedConflict.caseId}`,
          );
        }
      }
    }

    // Case updates: a touched case id may already exist in the store.
    for (const verificationCase of working.cases) {
      if (touched.caseUpdates.has(verificationCase.caseId)) {
        this.#cases = this.#cases.map((held) =>
          held.caseId === verificationCase.caseId ? sealVerificationCase(verificationCase) : held,
        );
      }
    }

    this.#cases = [...this.#cases, ...working.cases.filter((c) => touched.cases.has(c.caseId))];

    // Evidence is append-only.
    for (const evidence of working.evidences) {
      if (touched.evidences.has(evidence.evidenceId)) {
        if (this.#evidences.some((held) => held.evidenceId === evidence.evidenceId)) {
          throw new CapabilityVerificationError(
            'duplicate-evidence-id',
            `evidence ${evidence.evidenceId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.evidenceKeys.has(evidence.idempotencyKey)) {
        const holder = this.#evidences.find(
          (held) => held.idempotencyKey === evidence.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${evidence.idempotencyKey}" was used by evidence ${holder.evidenceId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#evidences = [
      ...this.#evidences,
      ...working.evidences.filter((e) => touched.evidences.has(e.evidenceId)).map(sealEvidence),
    ];

    // Level records are append-only.
    for (const record of working.records) {
      if (touched.records.has(record.recordId)) {
        if (this.#records.some((held) => held.recordId === record.recordId)) {
          throw new CapabilityVerificationError(
            'duplicate-record-id',
            `level record ${record.recordId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.recordKeys.has(record.idempotencyKey)) {
        const holder = this.#records.find((held) => held.idempotencyKey === record.idempotencyKey);
        if (holder !== undefined) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${record.idempotencyKey}" was used by level record ${holder.recordId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#records = [
      ...this.#records,
      ...working.records.filter((r) => touched.records.has(r.recordId)).map(sealLevelRecord),
    ];
  }
}

class WorkingSet {
  cases: VerificationCase[];
  evidences: Evidence[];
  records: LevelRecord[];

  constructor(snapshot: {
    cases: VerificationCase[];
    evidences: Evidence[];
    records: LevelRecord[];
  }) {
    this.cases = snapshot.cases;
    this.evidences = snapshot.evidences;
    this.records = snapshot.records;
  }
}

class Touched {
  readonly cases = new Set<string>();
  readonly caseKeys = new Set<string>();
  readonly caseUpdates = new Set<string>();
  readonly caseTouches = new Set<string>();
  readonly evidences = new Set<string>();
  readonly evidenceKeys = new Set<string>();
  readonly records = new Set<string>();
  readonly recordKeys = new Set<string>();
}

function isOpenCase(status: string): boolean {
  return status !== 'approved' && status !== 'rejected' && status !== 'withdrawn';
}

class InMemoryCapabilityVerificationTransaction implements CapabilityVerificationTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findCaseById(caseId: string): Promise<VerificationCase | null> {
    const found = this.#state.cases.find((c) => c.caseId === caseId);
    return Promise.resolve(found === undefined ? null : sealVerificationCase(found));
  }

  findCaseByIdempotencyKey(idempotencyKey: string): Promise<VerificationCase | null> {
    const found = this.#state.cases.find((c) => c.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealVerificationCase(found));
  }

  findCasesByAccountId(accountId: string): Promise<readonly VerificationCase[]> {
    const found = this.#state.cases
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.caseId.localeCompare(b.caseId));
    return Promise.resolve(sealVerificationCases(found));
  }

  findOpenCaseByAccountAndPurpose(
    accountId: string,
    purpose: string,
  ): Promise<VerificationCase | null> {
    const found = this.#state.cases.find(
      (c) => c.accountId === accountId && c.purpose === purpose && isOpenCase(c.status),
    );
    return Promise.resolve(found === undefined ? null : sealVerificationCase(found));
  }

  insertCase(verificationCase: VerificationCase): Promise<void> {
    if (this.#state.cases.some((held) => held.caseId === verificationCase.caseId)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'duplicate-case-id',
          `case ${verificationCase.caseId} already exists. A case is created once and ` +
            'its lifecycle is updated through the service',
        ),
      );
    }
    if (this.#state.cases.some((held) => held.idempotencyKey === verificationCase.idempotencyKey)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'idempotency-key-reuse',
          `idempotency key "${verificationCase.idempotencyKey}" has already been used`,
        ),
      );
    }
    if (isOpenCase(verificationCase.status)) {
      const open = this.#state.cases.find(
        (held) =>
          held.caseId !== verificationCase.caseId &&
          held.accountId === verificationCase.accountId &&
          held.purpose === verificationCase.purpose &&
          isOpenCase(held.status),
      );
      if (open !== undefined) {
        return Promise.reject(
          new CapabilityVerificationError(
            'case-already-open',
            `account ${verificationCase.accountId} already has an open case for ` +
              `${verificationCase.purpose}: ${open.caseId}`,
          ),
        );
      }
    }
    this.#state.cases.push(sealVerificationCase(verificationCase));
    this.#touched.cases.add(verificationCase.caseId);
    this.#touched.caseKeys.add(verificationCase.idempotencyKey);
    this.#touched.caseTouches.add(verificationCase.caseId);
    return Promise.resolve();
  }

  updateCase(verificationCase: VerificationCase): Promise<void> {
    const index = this.#state.cases.findIndex((held) => held.caseId === verificationCase.caseId);
    if (index === -1) {
      return Promise.reject(
        new CapabilityVerificationError(
          'case-not-found',
          `case ${verificationCase.caseId} does not exist`,
        ),
      );
    }
    this.#state.cases[index] = sealVerificationCase(verificationCase);
    this.#touched.caseUpdates.add(verificationCase.caseId);
    this.#touched.caseTouches.add(verificationCase.caseId);
    return Promise.resolve();
  }

  findEvidenceById(evidenceId: string): Promise<Evidence | null> {
    const found = this.#state.evidences.find((e) => e.evidenceId === evidenceId);
    return Promise.resolve(found === undefined ? null : sealEvidence(found));
  }

  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<Evidence | null> {
    const found = this.#state.evidences.find((e) => e.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealEvidence(found));
  }

  findEvidenceByCaseId(caseId: string): Promise<readonly Evidence[]> {
    const found = this.#state.evidences
      .filter((e) => e.caseId === caseId)
      .sort(
        (a, b) =>
          a.submittedAt.localeCompare(b.submittedAt) || a.evidenceId.localeCompare(b.evidenceId),
      );
    return Promise.resolve(sealEvidences(found));
  }

  insertEvidence(evidence: Evidence): Promise<void> {
    if (this.#state.evidences.some((held) => held.evidenceId === evidence.evidenceId)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'duplicate-evidence-id',
          `evidence ${evidence.evidenceId} already exists. An evidence row is created once and ` +
            'never rewritten',
        ),
      );
    }
    if (this.#state.evidences.some((held) => held.idempotencyKey === evidence.idempotencyKey)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'idempotency-key-reuse',
          `idempotency key "${evidence.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.evidences.push(sealEvidence(evidence));
    this.#touched.evidences.add(evidence.evidenceId);
    this.#touched.evidenceKeys.add(evidence.idempotencyKey);
    return Promise.resolve();
  }

  findLevelRecordById(recordId: string): Promise<LevelRecord | null> {
    const found = this.#state.records.find((r) => r.recordId === recordId);
    return Promise.resolve(found === undefined ? null : sealLevelRecord(found));
  }

  findLevelRecordByIdempotencyKey(idempotencyKey: string): Promise<LevelRecord | null> {
    const found = this.#state.records.find((r) => r.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealLevelRecord(found));
  }

  findLevelRecordsByCaseId(caseId: string): Promise<readonly LevelRecord[]> {
    const found = this.#state.records
      .filter((r) => r.caseId === caseId)
      .sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.recordId.localeCompare(b.recordId),
      );
    return Promise.resolve(sealLevelRecords(found));
  }

  findLevelRecordsByAccountId(accountId: string): Promise<readonly LevelRecord[]> {
    const found = this.#state.records
      .filter((r) => r.accountId === accountId)
      .sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.recordId.localeCompare(b.recordId),
      );
    return Promise.resolve(sealLevelRecords(found));
  }

  insertLevelRecord(record: LevelRecord): Promise<void> {
    if (this.#state.records.some((held) => held.recordId === record.recordId)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'duplicate-record-id',
          `level record ${record.recordId} already exists. A level record is created once and ` +
            'never rewritten',
        ),
      );
    }
    if (this.#state.records.some((held) => held.idempotencyKey === record.idempotencyKey)) {
      return Promise.reject(
        new CapabilityVerificationError(
          'idempotency-key-reuse',
          `idempotency key "${record.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.records.push(sealLevelRecord(record));
    this.#touched.records.add(record.recordId);
    this.#touched.recordKeys.add(record.idempotencyKey);
    return Promise.resolve();
  }
}
