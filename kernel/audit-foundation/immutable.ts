/**
 * K-09 Audit Foundation — the immutability boundary (FND-003c correction).
 *
 * The first revision froze the evidence map and shallow-copied the rest. That is two mistakes in
 * one:
 *
 *   - **`actor` and `resource` were reachable and writable.** `result.record.actor.id = 'someone
 *     else'` succeeded silently. The record a caller held was the record the log held, and the two
 *     nested objects that say *who did it* and *what to* were the ones left open.
 *   - **A shallow copy shares its children.** `{ ...record }` gives a new top level whose `actor`
 *     and `resource` are the *same* objects. Storing a caller's record and then letting the caller
 *     edit its actor changed what was stored, after the fact, with nothing to see.
 *
 * So there is one function, and every path that hands a record across a boundary goes through it:
 * the service's results, every in-memory seed, read, write and query, and the PostgreSQL decoder.
 * One boundary rather than a freeze at each site, because a rule applied in six places is a rule
 * that will be applied in five after the next change.
 *
 * `sealRecord` both **clones and freezes**. Cloning severs the caller's reference so a later edit
 * cannot reach stored state; freezing makes the edit throw rather than fail silently, which is the
 * difference between a caller learning it did something wrong and a caller believing it worked.
 *
 * Owned by: K-09 Audit Foundation.
 */

import type { AuditActor, AuditEvidence, AuditRecord, ResourceReference } from './types.ts';

/**
 * A deep, frozen copy of a complete record.
 *
 * Every nested object is copied and frozen: the actor, the resource reference and the evidence map.
 * Evidence values are scalars by contract, so there is nothing below them to recurse into — and if
 * that ever changes, `assertValidEvidence` refuses the record long before it reaches here.
 *
 * Idempotent: sealing a sealed record produces an equal record. Callers may seal defensively
 * without thinking about whether somebody already did.
 */
export function sealRecord(record: AuditRecord): AuditRecord {
  return Object.freeze({
    ...record,
    actor: sealActor(record.actor),
    resource: sealResource(record.resource),
    evidence: sealEvidence(record.evidence),
  });
}

/** The same for a list, which is what every query path returns. */
export function sealRecords(records: readonly AuditRecord[]): readonly AuditRecord[] {
  return Object.freeze(records.map(sealRecord));
}

export function sealActor(actor: AuditActor): AuditActor {
  return Object.freeze({ ...actor });
}

export function sealResource(resource: ResourceReference): ResourceReference {
  return Object.freeze({ ...resource });
}

export function sealEvidence(evidence: AuditEvidence): AuditEvidence {
  return Object.freeze({ ...evidence });
}

/**
 * Is this record sealed all the way down?
 *
 * Exported so a test can assert the property directly rather than by attempting a mutation and
 * hoping the attempt was representative.
 */
export function isSealed(record: AuditRecord): boolean {
  return (
    Object.isFrozen(record) &&
    Object.isFrozen(record.actor) &&
    Object.isFrozen(record.resource) &&
    Object.isFrozen(record.evidence)
  );
}
