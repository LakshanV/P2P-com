/**
 * M-02 Capability & Verification — the service.
 *
 * Five operations:
 *
 *   `startVerification`   — open a case at `achievedLevel: 'none'`, append the first level record and
 *                           emit an event and audit record.
 *   `submitEvidence`      — append an evidence row with status `submitted` against an open case,
 *                           move it to `under-review`, and emit.
 *   `evaluateLevel`       — record a level reached, append a level record, approve when the requested
 *                           level is reached, and emit.
 *   `rejectVerification`  — close a case as rejected, emitting `verification.rejected` and its audit
 *                           record. No level record: the level reached is still true.
 *   reads                 — sealed, deterministically ordered lookups of cases, evidence and level
 *                           history, plus the account's current level.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-02 Capability & Verification.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  makeEvidenceSubmittedAction,
  makeEvidenceSubmittedEvent,
  makeLevelChangedAction,
  makeLevelChangedEvent,
  makeSellerVerifiedAction,
  makeSellerVerifiedEvent,
  makeVerificationRejectedAction,
  makeVerificationRejectedEvent,
  makeVerificationStartedAction,
  makeVerificationStartedEvent,
} from './outbox.ts';
import {
  FOREIGN_FIELDS,
  assertCapabilityVerificationIdentifier,
  assertVerificationLevel,
} from './registry.ts';
import type {
  CapabilityVerificationRepository,
  CapabilityVerificationTransaction,
} from './repository.ts';
import {
  sealEvidence,
  sealEvidences,
  sealLevelRecord,
  sealLevelRecords,
  sealVerificationCase,
  sealVerificationCases,
} from './immutable.ts';
import { validateEvidence, validateLevelRecord, validateVerificationCase } from './validate.ts';
import {
  CapabilityVerificationError,
  compareVerificationLevels,
  type Evidence,
  type LevelRecord,
  type VerificationCase,
  type VerificationLevel,
} from './types.ts';

export interface StartVerificationRequest {
  readonly caseId: string;
  readonly accountId: string;
  readonly purpose: string;
  readonly requestedLevel: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly openedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly recordId: string;
  readonly reason: string;
}

export interface StartVerificationResult {
  readonly verificationCase: VerificationCase;
  readonly record: LevelRecord | null;
  readonly replayed: boolean;
}

export interface SubmitEvidenceRequest {
  readonly evidenceId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly reference: string;
  readonly note: string;
  readonly submittedAt: string;
  readonly caseUpdatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface SubmitEvidenceResult {
  readonly evidence: Evidence;
  readonly verificationCase: VerificationCase;
  readonly replayed: boolean;
}

export interface EvaluateLevelRequest {
  readonly caseId: string;
  readonly level: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly decidedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly recordId: string;
}

export interface EvaluateLevelResult {
  readonly verificationCase: VerificationCase;
  readonly record: LevelRecord | null;
  readonly replayed: boolean;
}

export interface RejectVerificationRequest {
  readonly caseId: string;
  readonly decidedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /**
   * The decision's own opaque id. A rejection appends no level record, so this is not a row id — it
   * is what the outbox entries are keyed by, and it is required for the same reason a level record
   * id is: an id derived from the case alone would collide if a case were ever decided twice.
   */
  readonly recordId: string;
  readonly reason: string;
}

export interface RejectVerificationResult {
  readonly verificationCase: VerificationCase;
  readonly record: LevelRecord | null;
  readonly replayed: boolean;
}

const START_VERIFICATION_KEYS: readonly string[] = [
  'caseId',
  'accountId',
  'purpose',
  'requestedLevel',
  'attributes',
  'openedAt',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
  'reason',
];

const SUBMIT_EVIDENCE_KEYS: readonly string[] = [
  'evidenceId',
  'caseId',
  'kind',
  'reference',
  'note',
  'submittedAt',
  'caseUpdatedAt',
  'correlationId',
  'idempotencyKey',
];

const EVALUATE_LEVEL_KEYS: readonly string[] = [
  'caseId',
  'level',
  'reason',
  'occurredAt',
  'decidedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
];

const REJECT_VERIFICATION_KEYS: readonly string[] = [
  'caseId',
  'decidedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'recordId',
  'reason',
];

export class CapabilityVerificationService {
  readonly #repository: CapabilityVerificationRepository;

  constructor(repository: CapabilityVerificationRepository) {
    this.#repository = repository;
  }

  /**
   * Open a verification case.
   *
   * Creates the case at `achievedLevel: 'none'` and `status: 'open'`, appends the first level record,
   * and emits an event and audit record. Refuses `case-already-open` when the account already has an
   * open case for the same purpose under a different id. Idempotent by key.
   */
  async startVerification(request: StartVerificationRequest): Promise<StartVerificationResult> {
    assertNoForeignConcerns(request, START_VERIFICATION_KEYS, 'startVerification');
    const verificationCase = sealVerificationCase(
      validateVerificationCase(
        {
          caseId: request.caseId,
          accountId: request.accountId,
          purpose: request.purpose,
          status: 'open',
          requestedLevel: request.requestedLevel,
          achievedLevel: 'none',
          openedAt: request.openedAt,
          decidedAt: null,
          attributes: request.attributes,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#start(verificationCase, request.recordId, request.reason);
    } catch (error) {
      const conflicted =
        error instanceof CapabilityVerificationError &&
        (error.code === 'duplicate-case-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findCaseByIdempotencyKey(verificationCase.idempotencyKey),
      );
      if (winner === null || !caseEquals(winner, verificationCase)) throw error;
      return { verificationCase: sealVerificationCase(winner), record: null, replayed: true };
    }
  }

  async #start(
    verificationCase: VerificationCase,
    recordId: string,
    reason: string,
  ): Promise<StartVerificationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findCaseByIdempotencyKey(verificationCase.idempotencyKey);
      if (existingKey !== null) {
        if (!caseEquals(existingKey, verificationCase)) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${verificationCase.idempotencyKey}" has already been used for a different case`,
          );
        }
        return {
          verificationCase: sealVerificationCase(existingKey),
          record: null,
          replayed: true,
        };
      }

      const existingId = await tx.findCaseById(verificationCase.caseId);
      if (existingId !== null) {
        if (!caseEquals(existingId, verificationCase)) {
          throw new CapabilityVerificationError(
            'duplicate-case-id',
            `case ${verificationCase.caseId} already exists. A case is created once and ` +
              'its lifecycle is updated through the service',
          );
        }
        return { verificationCase: sealVerificationCase(existingId), record: null, replayed: true };
      }

      const openCase = await tx.findOpenCaseByAccountAndPurpose(
        verificationCase.accountId,
        verificationCase.purpose,
      );
      if (openCase !== null && openCase.caseId !== verificationCase.caseId) {
        throw new CapabilityVerificationError(
          'case-already-open',
          `account ${verificationCase.accountId} already has an open case for ` +
            `${verificationCase.purpose}: ${openCase.caseId}`,
        );
      }

      const record = sealLevelRecord(
        validateLevelRecord(
          {
            recordId,
            caseId: verificationCase.caseId,
            accountId: verificationCase.accountId,
            fromLevel: null,
            toLevel: 'none',
            reason,
            occurredAt: verificationCase.openedAt,
            correlationId: verificationCase.correlationId,
            idempotencyKey: verificationCase.idempotencyKey,
          },
          'request',
        ),
      );

      await tx.insertCase(verificationCase);
      await tx.insertLevelRecord(record);
      await this.#emitStarted(verificationCase, record, tx);
      return { verificationCase, record, replayed: false };
    });
  }

  /**
   * Submit evidence against an open case.
   *
   * Appends an evidence row with status `submitted`, moves the case to `under-review`, and emits an
   * event and audit record. Refuses `case-not-found` and `case-not-open`.
   */
  async submitEvidence(request: SubmitEvidenceRequest): Promise<SubmitEvidenceResult> {
    assertNoForeignConcerns(request, SUBMIT_EVIDENCE_KEYS, 'submitEvidence');
    assertCapabilityVerificationIdentifier(request.evidenceId, 'evidenceId');
    assertCapabilityVerificationIdentifier(request.caseId, 'caseId');
    assertCapabilityVerificationIdentifier(request.correlationId, 'correlationId');
    assertCapabilityVerificationIdentifier(request.idempotencyKey, 'idempotencyKey');
    const submittedAt = parseAndCheckInstant(request.submittedAt, 'submittedAt');
    const caseUpdatedAt = parseAndCheckInstant(request.caseUpdatedAt, 'caseUpdatedAt');

    try {
      return await this.#submit(
        request.evidenceId,
        request.caseId,
        request.kind,
        request.reference,
        request.note,
        submittedAt,
        caseUpdatedAt,
        request.correlationId,
        request.idempotencyKey,
      );
    } catch (error) {
      const conflicted =
        error instanceof CapabilityVerificationError &&
        (error.code === 'duplicate-evidence-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findEvidence(request.evidenceId, request.idempotencyKey);
      if (winner === null) throw error;

      const verificationCase = await this.#repository.withTransaction((tx) =>
        tx.findCaseById(winner.caseId),
      );
      if (verificationCase === null) throw error;

      const expected = buildEvidence(
        winner.evidenceId,
        winner.caseId,
        winner.accountId,
        request.kind,
        request.reference,
        request.note,
        submittedAt,
        request.correlationId,
        request.idempotencyKey,
      );
      if (!evidenceEquals(winner, expected)) throw error;
      return {
        evidence: sealEvidence(winner),
        verificationCase: sealVerificationCase(verificationCase),
        replayed: true,
      };
    }
  }

  async #submit(
    evidenceId: string,
    caseId: string,
    kind: string,
    reference: string,
    note: string,
    submittedAt: string,
    caseUpdatedAt: string,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<SubmitEvidenceResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingId = await tx.findEvidenceById(evidenceId);
      if (existingId !== null) {
        const expected = buildEvidence(
          existingId.evidenceId,
          existingId.caseId,
          existingId.accountId,
          kind,
          reference,
          note,
          submittedAt,
          correlationId,
          idempotencyKey,
        );
        if (!evidenceEquals(existingId, expected)) {
          throw new CapabilityVerificationError(
            'duplicate-evidence-id',
            `evidence ${evidenceId} already exists with different content`,
          );
        }
        const verificationCase = await requireCase(tx, existingId.caseId);
        return { evidence: existingId, verificationCase, replayed: true };
      }

      const existingKey = await tx.findEvidenceByIdempotencyKey(idempotencyKey);
      if (existingKey !== null) {
        const expected = buildEvidence(
          existingKey.evidenceId,
          existingKey.caseId,
          existingKey.accountId,
          kind,
          reference,
          note,
          submittedAt,
          correlationId,
          idempotencyKey,
        );
        if (!evidenceEquals(existingKey, expected)) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${idempotencyKey}" has already been used for a different evidence`,
          );
        }
        const verificationCase = await requireCase(tx, existingKey.caseId);
        return { evidence: existingKey, verificationCase, replayed: true };
      }

      const verificationCase = await requireOpenCase(tx, caseId);
      const evidence = sealEvidence(
        validateEvidence(
          {
            evidenceId,
            caseId: verificationCase.caseId,
            accountId: verificationCase.accountId,
            kind,
            status: 'submitted',
            reference,
            note,
            submittedAt,
            correlationId,
            idempotencyKey,
          },
          'request',
        ),
      );
      const updated = sealVerificationCase({
        ...verificationCase,
        status: 'under-review',
        updatedAt: caseUpdatedAt,
      });

      await tx.insertEvidence(evidence);
      await tx.updateCase(updated);
      await this.#emitEvidenceSubmitted(evidence, tx);
      return { evidence, verificationCase: updated, replayed: false };
    });
  }

  async #findEvidence(evidenceId: string, idempotencyKey: string): Promise<Evidence | null> {
    const byId = await this.#repository.withTransaction((tx) => tx.findEvidenceById(evidenceId));
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) =>
      tx.findEvidenceByIdempotencyKey(idempotencyKey),
    );
  }

  /**
   * Record the level reached by a case.
   *
   * Appends a level record and updates `achievedLevel`. When the new level reaches or exceeds
   * `requestedLevel`, the case is approved and `decidedAt` is set. Refuses `level-regression` when
   * the new level is below the current one, and `case-not-found` / `case-not-open`.
   */
  async evaluateLevel(request: EvaluateLevelRequest): Promise<EvaluateLevelResult> {
    assertNoForeignConcerns(request, EVALUATE_LEVEL_KEYS, 'evaluateLevel');
    assertCapabilityVerificationIdentifier(request.caseId, 'caseId');
    assertCapabilityVerificationIdentifier(request.recordId, 'recordId');
    assertCapabilityVerificationIdentifier(request.correlationId, 'correlationId');
    assertCapabilityVerificationIdentifier(request.idempotencyKey, 'idempotencyKey');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');
    const decidedAt = parseAndCheckInstant(request.decidedAt, 'decidedAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    try {
      return await this.#evaluate(
        request.caseId,
        request.level,
        request.reason,
        occurredAt,
        decidedAt,
        updatedAt,
        request.correlationId,
        request.idempotencyKey,
        request.recordId,
      );
    } catch (error) {
      const conflicted =
        error instanceof CapabilityVerificationError &&
        (error.code === 'duplicate-record-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findLevelRecord(request.recordId, request.idempotencyKey);
      if (winner === null) throw error;

      const verificationCase = await this.#repository.withTransaction((tx) =>
        tx.findCaseById(winner.caseId),
      );
      if (verificationCase === null) throw error;

      const expected = buildLevelRecord(
        winner.recordId,
        winner.caseId,
        winner.accountId,
        winner.fromLevel,
        winner.toLevel,
        request.reason,
        occurredAt,
        request.correlationId,
        request.idempotencyKey,
      );
      if (!recordEquals(winner, expected)) throw error;
      return {
        verificationCase: sealVerificationCase(verificationCase),
        record: winner,
        replayed: true,
      };
    }
  }

  async #evaluate(
    caseId: string,
    level: string,
    reason: string,
    occurredAt: string,
    decidedAt: string,
    updatedAt: string,
    correlationId: string,
    idempotencyKey: string,
    recordId: string,
  ): Promise<EvaluateLevelResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingId = await tx.findLevelRecordById(recordId);
      if (existingId !== null) {
        const expected = buildLevelRecord(
          existingId.recordId,
          existingId.caseId,
          existingId.accountId,
          existingId.fromLevel,
          existingId.toLevel,
          reason,
          occurredAt,
          correlationId,
          idempotencyKey,
        );
        if (!recordEquals(existingId, expected)) {
          throw new CapabilityVerificationError(
            'duplicate-record-id',
            `level record ${recordId} already exists with different content`,
          );
        }
        const verificationCase = await requireCase(tx, existingId.caseId);
        return { verificationCase, record: existingId, replayed: true };
      }

      const existingKey = await tx.findLevelRecordByIdempotencyKey(idempotencyKey);
      if (existingKey !== null) {
        const expected = buildLevelRecord(
          existingKey.recordId,
          existingKey.caseId,
          existingKey.accountId,
          existingKey.fromLevel,
          existingKey.toLevel,
          reason,
          occurredAt,
          correlationId,
          idempotencyKey,
        );
        if (!recordEquals(existingKey, expected)) {
          throw new CapabilityVerificationError(
            'idempotency-key-reuse',
            `idempotency key "${idempotencyKey}" has already been used for a different level record`,
          );
        }
        const verificationCase = await requireCase(tx, existingKey.caseId);
        return { verificationCase, record: existingKey, replayed: true };
      }

      const verificationCase = await requireOpenCase(tx, caseId);
      const newLevel = assertVerificationLevel(level, 'level');
      if (compareVerificationLevels(newLevel, verificationCase.achievedLevel) < 0) {
        throw new CapabilityVerificationError(
          'level-regression',
          `level ${newLevel} is below the level already reached (${verificationCase.achievedLevel})`,
        );
      }

      const record = sealLevelRecord(
        validateLevelRecord(
          {
            recordId,
            caseId: verificationCase.caseId,
            accountId: verificationCase.accountId,
            fromLevel: verificationCase.achievedLevel,
            toLevel: newLevel,
            reason,
            occurredAt,
            correlationId,
            idempotencyKey,
          },
          'request',
        ),
      );

      const approved = compareVerificationLevels(newLevel, verificationCase.requestedLevel) >= 0;
      const updated = sealVerificationCase({
        ...verificationCase,
        achievedLevel: newLevel,
        status: approved ? 'approved' : verificationCase.status,
        decidedAt: approved ? decidedAt : verificationCase.decidedAt,
        updatedAt,
      });

      await tx.insertLevelRecord(record);
      await tx.updateCase(updated);
      await this.#emitLevelChanged(record, tx);
      if (
        approved &&
        verificationCase.purpose === 'seller-onboarding' &&
        compareVerificationLevels(newLevel, 'standard') >= 0
      ) {
        await this.#emitSellerVerified(updated, record, tx);
      }
      return { verificationCase: updated, record, replayed: false };
    });
  }

  async #findLevelRecord(recordId: string, idempotencyKey: string): Promise<LevelRecord | null> {
    const byId = await this.#repository.withTransaction((tx) => tx.findLevelRecordById(recordId));
    if (byId !== null) return byId;
    return this.#repository.withTransaction((tx) =>
      tx.findLevelRecordByIdempotencyKey(idempotencyKey),
    );
  }

  /**
   * Reject a verification case.
   *
   * Sets the status to `rejected` and records `decidedAt`, then emits `verification.rejected` and
   * its audit record. No level record is appended: the level the case reached is still true, and
   * what changed is that the case is over.
   *
   * Idempotent by content rather than by a stored key, because rejection writes no append-only row
   * to hold one. A retry naming a case already rejected at the same instant is the same decision
   * arriving twice, and returns `replayed: true`; a retry naming one rejected at a *different*
   * instant is a second decision on a closed case, and is refused as `case-not-open`.
   */
  async rejectVerification(request: RejectVerificationRequest): Promise<RejectVerificationResult> {
    assertNoForeignConcerns(request, REJECT_VERIFICATION_KEYS, 'rejectVerification');
    assertCapabilityVerificationIdentifier(request.caseId, 'caseId');
    assertCapabilityVerificationIdentifier(request.recordId, 'recordId');
    assertCapabilityVerificationIdentifier(request.correlationId, 'correlationId');
    assertCapabilityVerificationIdentifier(request.idempotencyKey, 'idempotencyKey');
    const decidedAt = parseAndCheckInstant(request.decidedAt, 'decidedAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');

    try {
      return await this.#reject(
        request.caseId,
        request.recordId,
        request.reason,
        decidedAt,
        updatedAt,
        request.correlationId,
        request.idempotencyKey,
      );
    } catch (error) {
      const conflicted =
        error instanceof CapabilityVerificationError &&
        (error.code === 'case-not-open' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findCaseById(request.caseId),
      );
      if (winner === null || winner.status !== 'rejected' || winner.decidedAt !== decidedAt) {
        throw error;
      }
      return { verificationCase: sealVerificationCase(winner), record: null, replayed: true };
    }
  }

  async #reject(
    caseId: string,
    recordId: string,
    reason: string,
    decidedAt: string,
    updatedAt: string,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<RejectVerificationResult> {
    return this.#repository.withTransaction(async (tx) => {
      const verificationCase = await requireOpenCase(tx, caseId);

      // Rejection closes the case without changing the level it reached, so it appends no level
      // record: `level_record_changes_level` in migration 0025 refuses a row whose from and to are
      // the same, and it is right to. The level the account got to is still true; what changed is
      // that the case is over.
      //
      // That is exactly why rejection carries its own event. A refusal is the most consequential
      // thing that can happen to a case, and reporting it through `verification.level_changed`
      // would be impossible — so without `verification.rejected` a rejection would be silent, and
      // the only trace of it would be a status column nobody is subscribed to.
      const updated = sealVerificationCase({
        ...verificationCase,
        status: 'rejected',
        decidedAt,
        updatedAt,
      });

      await tx.updateCase(updated);
      await this.#emitRejected(updated, recordId, reason, correlationId, idempotencyKey, tx);
      return { verificationCase: updated, record: null, replayed: false };
    });
  }

  /** Return one case by id, sealed. */
  async getCase(caseId: string): Promise<VerificationCase | null> {
    assertCapabilityVerificationIdentifier(caseId, 'caseId');
    const verificationCase = await this.#repository.withTransaction((tx) =>
      tx.findCaseById(caseId),
    );
    return verificationCase === null ? null : sealVerificationCase(verificationCase);
  }

  /** Every case for the account, oldest first. */
  async listCases(accountId: string): Promise<readonly VerificationCase[]> {
    assertCapabilityVerificationIdentifier(accountId, 'accountId');
    const cases = await this.#repository.withTransaction((tx) =>
      tx.findCasesByAccountId(accountId),
    );
    return sealVerificationCases(cases);
  }

  /** Every evidence row for the case, oldest first. */
  async listEvidence(caseId: string): Promise<readonly Evidence[]> {
    assertCapabilityVerificationIdentifier(caseId, 'caseId');
    const evidences = await this.#repository.withTransaction((tx) =>
      tx.findEvidenceByCaseId(caseId),
    );
    return sealEvidences(evidences);
  }

  /** The append-only level history for one case, oldest first. */
  async getLevelHistory(caseId: string): Promise<readonly LevelRecord[]> {
    assertCapabilityVerificationIdentifier(caseId, 'caseId');
    const records = await this.#repository.withTransaction((tx) =>
      tx.findLevelRecordsByCaseId(caseId),
    );
    return sealLevelRecords(records);
  }

  /**
   * The highest verification level the account has reached across all approved cases, or `none`.
   */
  async currentLevel(accountId: string): Promise<VerificationLevel> {
    assertCapabilityVerificationIdentifier(accountId, 'accountId');
    const cases = await this.#repository.withTransaction((tx) =>
      tx.findCasesByAccountId(accountId),
    );
    let highest: VerificationLevel = 'none';
    for (const verificationCase of cases) {
      if (verificationCase.status !== 'approved') continue;
      if (compareVerificationLevels(verificationCase.achievedLevel, highest) > 0) {
        highest = verificationCase.achievedLevel;
      }
    }
    return highest;
  }

  async #emitStarted(
    verificationCase: VerificationCase,
    record: LevelRecord,
    tx: CapabilityVerificationTransaction,
  ): Promise<void> {
    const correlationId = record.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(
      makeVerificationStartedEvent(verificationCase, record, correlationId, causationId),
    );
    await tx.insertOutbox(
      makeVerificationStartedAction(verificationCase, record, correlationId, causationId),
    );
  }

  async #emitEvidenceSubmitted(
    evidence: Evidence,
    tx: CapabilityVerificationTransaction,
  ): Promise<void> {
    const correlationId = evidence.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeEvidenceSubmittedEvent(evidence, correlationId, causationId));
    await tx.insertOutbox(makeEvidenceSubmittedAction(evidence, correlationId, causationId));
  }

  async #emitLevelChanged(
    record: LevelRecord,
    tx: CapabilityVerificationTransaction,
  ): Promise<void> {
    const correlationId = record.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeLevelChangedEvent(record, correlationId, causationId));
    await tx.insertOutbox(makeLevelChangedAction(record, correlationId, causationId));
  }

  async #emitSellerVerified(
    verificationCase: VerificationCase,
    record: LevelRecord,
    tx: CapabilityVerificationTransaction,
  ): Promise<void> {
    const correlationId = record.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(
      makeSellerVerifiedEvent(verificationCase, record, correlationId, causationId),
    );
    await tx.insertOutbox(
      makeSellerVerifiedAction(verificationCase, record, correlationId, causationId),
    );
  }

  async #emitRejected(
    verificationCase: VerificationCase,
    decisionId: string,
    reason: string,
    correlationId: string,
    idempotencyKey: string,
    tx: CapabilityVerificationTransaction,
  ): Promise<void> {
    const causationId: string | null = null;
    await tx.insertOutbox(
      makeVerificationRejectedEvent(
        verificationCase,
        decisionId,
        reason,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
    await tx.insertOutbox(
      makeVerificationRejectedAction(
        verificationCase,
        decisionId,
        reason,
        correlationId,
        causationId,
        idempotencyKey,
      ),
    );
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new CapabilityVerificationError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new CapabilityVerificationError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A verification record carries only what M-02 owns`,
      );
    }
    throw new CapabilityVerificationError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CapabilityVerificationError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new CapabilityVerificationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

async function requireCase(
  tx: CapabilityVerificationTransaction,
  caseId: string,
): Promise<VerificationCase> {
  const verificationCase = await tx.findCaseById(caseId);
  if (verificationCase === null) {
    throw new CapabilityVerificationError('case-not-found', `case ${caseId} does not exist`);
  }
  return verificationCase;
}

async function requireOpenCase(
  tx: CapabilityVerificationTransaction,
  caseId: string,
): Promise<VerificationCase> {
  const verificationCase = await requireCase(tx, caseId);
  if (
    verificationCase.status === 'approved' ||
    verificationCase.status === 'rejected' ||
    verificationCase.status === 'withdrawn'
  ) {
    throw new CapabilityVerificationError(
      'case-not-open',
      `case ${caseId} is ${verificationCase.status}; evidence and level evaluation require an open case`,
    );
  }
  return verificationCase;
}

function caseEquals(a: VerificationCase, b: VerificationCase): boolean {
  return (
    a.caseId === b.caseId &&
    a.accountId === b.accountId &&
    a.purpose === b.purpose &&
    a.requestedLevel === b.requestedLevel &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
    a.createdAt === b.createdAt
  );
}

function evidenceEquals(a: Evidence, b: Evidence): boolean {
  return (
    a.evidenceId === b.evidenceId &&
    a.caseId === b.caseId &&
    a.accountId === b.accountId &&
    a.kind === b.kind &&
    a.reference === b.reference &&
    a.note === b.note &&
    a.submittedAt === b.submittedAt
  );
}

function recordEquals(a: LevelRecord, b: LevelRecord): boolean {
  return (
    a.recordId === b.recordId &&
    a.caseId === b.caseId &&
    a.accountId === b.accountId &&
    a.fromLevel === b.fromLevel &&
    a.toLevel === b.toLevel &&
    a.reason === b.reason &&
    a.occurredAt === b.occurredAt
  );
}

function buildEvidence(
  evidenceId: string,
  caseId: string,
  accountId: string,
  kind: string,
  reference: string,
  note: string,
  submittedAt: string,
  correlationId: string,
  idempotencyKey: string,
): Evidence {
  return {
    evidenceId,
    caseId,
    accountId,
    kind: kind as Evidence['kind'],
    status: 'submitted',
    reference,
    note,
    submittedAt,
    correlationId,
    idempotencyKey,
  };
}

function buildLevelRecord(
  recordId: string,
  caseId: string,
  accountId: string,
  fromLevel: VerificationLevel | null,
  toLevel: VerificationLevel,
  reason: string,
  occurredAt: string,
  correlationId: string,
  idempotencyKey: string,
): LevelRecord {
  return {
    recordId,
    caseId,
    accountId,
    fromLevel,
    toLevel,
    reason,
    occurredAt,
    correlationId,
    idempotencyKey,
  };
}
