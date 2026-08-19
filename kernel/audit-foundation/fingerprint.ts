/**
 * K-09 Audit Foundation — the content fingerprint (FND-003c).
 *
 * SHA-256 over a record's logical content, computed once at append and recomputed on every read
 * that comes back from storage. It is what lets a reader check a record against itself without
 * trusting the row it arrived in.
 *
 * In its own module rather than in the service, because both the service (which computes it) and
 * the PostgreSQL adapter (which verifies it on decode) need it, and the adapter has no business
 * depending on the service.
 *
 * Owned by: K-09 Audit Foundation.
 */

import { createHash } from 'node:crypto';

import type { AuditRecord } from './types.ts';

/**
 * The canonical form, and the hash of it.
 *
 * Evidence keys are sorted, so how the evidence object was written cannot change the fingerprint —
 * two records with the same content are the same record however their JSON was ordered. Every part
 * is `JSON.stringify`d and joined with a delimiter that cannot appear unescaped in the output, so
 * no combination of field values can be rearranged into a different record with the same canonical
 * string.
 */
export function fingerprintRecord(record: Omit<AuditRecord, 'contentFingerprint'>): string {
  const evidence = Object.keys(record.evidence)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(record.evidence[key] ?? null)}`)
    .join(',');

  const canonical = [
    record.recordId,
    record.action,
    record.recordedAt,
    record.actor.kind,
    record.actor.id,
    record.actor.authentication,
    record.actor.sessionId ?? '',
    record.resource.owner,
    record.resource.type,
    record.resource.id,
    record.outcome,
    record.reason,
    record.correlationId,
    record.causationId ?? '',
    `{${evidence}}`,
    record.idempotencyKey,
  ]
    .map((part) => JSON.stringify(part))
    .join('|');

  return createHash('sha256').update(canonical).digest('hex');
}
