/**
 * M-02 Capability & Verification — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Evidence rows and level records are append-only; the case row itself
 * is updated only through the service's lifecycle operations. The only defence against silent
 * mutation at the boundary is to make mutation throw.
 *
 * Owned by: M-02 Capability & Verification.
 */

import type { Evidence, LevelRecord, VerificationCase } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealRecord));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of a verification case. */
export function sealVerificationCase(verificationCase: VerificationCase): VerificationCase {
  return Object.freeze({
    caseId: verificationCase.caseId,
    accountId: verificationCase.accountId,
    purpose: verificationCase.purpose,
    status: verificationCase.status,
    requestedLevel: verificationCase.requestedLevel,
    achievedLevel: verificationCase.achievedLevel,
    openedAt: verificationCase.openedAt,
    decidedAt: verificationCase.decidedAt,
    attributes: sealRecord(verificationCase.attributes) as Readonly<Record<string, unknown>>,
    createdAt: verificationCase.createdAt,
    updatedAt: verificationCase.updatedAt,
    correlationId: verificationCase.correlationId,
    idempotencyKey: verificationCase.idempotencyKey,
  });
}

/** A deep, frozen copy of an evidence row. */
export function sealEvidence(evidence: Evidence): Evidence {
  return Object.freeze({ ...evidence });
}

/** A deep, frozen copy of a level record. */
export function sealLevelRecord(record: LevelRecord): LevelRecord {
  return Object.freeze({ ...record });
}

/** Frozen copies of a list of verification cases. */
export function sealVerificationCases(
  cases: readonly VerificationCase[],
): readonly VerificationCase[] {
  return Object.freeze(cases.map(sealVerificationCase));
}

/** Frozen copies of a list of evidence rows. */
export function sealEvidences(evidences: readonly Evidence[]): readonly Evidence[] {
  return Object.freeze(evidences.map(sealEvidence));
}

/** Frozen copies of a list of level records. */
export function sealLevelRecords(records: readonly LevelRecord[]): readonly LevelRecord[] {
  return Object.freeze(records.map(sealLevelRecord));
}

/** Is this verification case sealed all the way down? */
export function isVerificationCaseSealed(verificationCase: VerificationCase): boolean {
  return Object.isFrozen(verificationCase) && Object.isFrozen(verificationCase.attributes);
}

/** Is this evidence row sealed? */
export function isEvidenceSealed(evidence: Evidence): boolean {
  return Object.isFrozen(evidence);
}

/** Is this level record sealed? */
export function isLevelRecordSealed(record: LevelRecord): boolean {
  return Object.isFrozen(record);
}
