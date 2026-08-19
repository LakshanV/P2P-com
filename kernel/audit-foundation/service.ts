/**
 * K-09 Audit Foundation — the service (FND-003c).
 *
 * Two operations: record something, and read back what was recorded. The interesting half of both
 * is what they refuse.
 *
 * **Record.** Validate against the registry, fingerprint the logical content, append. Everything is
 * checked before a transaction opens, so a malformed record never occupies one. A retry with the
 * same idempotency key returns the original — and two retries that overlap in time converge on the
 * winner rather than one of them failing, because a caller retrying after a timeout has not done
 * anything wrong and should be told what happened rather than handed a conflict.
 *
 * **Read.** Filtered, ordered by `(recordedAt, recordId)`, a page at a time. The compound order is
 * not decoration: audit records arrive in bursts and two can share an instant, so ordering by time
 * alone makes a paginated read skip or repeat rows depending on what the database returns first.
 *
 * There is deliberately **no third operation**. Nothing here amends, redacts, expires or removes a
 * record. A component that can rewrite its own history proves nothing about anybody else's.
 *
 * Deterministic by construction: the caller supplies `recordedAt`, the record id and the
 * idempotency key. This component reads no clock and generates no randomness.
 *
 * Owned by: K-09 Audit Foundation. No API, no UI — see CONTRACT.md for why.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { fingerprintRecord } from './fingerprint.ts';
import { sealRecord, sealRecords } from './immutable.ts';
import { assertValidEvidence, type AuditActionRegistry } from './registry.ts';
import type {
  AuditCursor,
  AuditPage,
  AuditQuery,
  AuditRepository,
  AuditTransaction,
} from './repository.ts';
import {
  AUDIT_OUTCOMES,
  AuditError,
  type AuditActor,
  type AuditEvidence,
  type AuditOutcome,
  type AuditRecord,
  type ResourceReference,
} from './types.ts';

/** Everything that identifies one logical recording. */
export interface RecordRequest {
  readonly recordId: string;
  readonly action: string;
  readonly recordedAt: string;
  readonly actor: AuditActor;
  readonly resource: ResourceReference;
  readonly outcome: AuditOutcome;
  readonly reason: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly evidence?: AuditEvidence;
  readonly idempotencyKey: string;
}

export interface RecordResult {
  readonly record: AuditRecord;
  /** True when this idempotency key had already produced this exact record. */
  readonly deduplicated: boolean;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;

export class AuditService {
  readonly #actions: AuditActionRegistry;
  readonly #repository: AuditRepository;

  constructor(actions: AuditActionRegistry, repository: AuditRepository) {
    this.#actions = actions;
    this.#repository = repository;
  }

  /**
   * Append an audit record.
   *
   * Validation happens before the transaction opens; a record that cannot be written never occupies
   * a connection.
   */
  async record(request: RecordRequest): Promise<RecordResult> {
    const definition = this.#actions.require(request.action);

    if (request.actor.kind === 'ai') {
      // AI may propose that an action was taken. It may not attest to one: an audit record is the
      // evidence a later investigation relies on, and a fabricated record is indistinguishable
      // from a real one to everyone downstream. Both kinds of registered action are authoritative
      // by definition, so this is a flat refusal rather than a per-action rule.
      throw new AuditError(
        'ai-not-permitted',
        `actor "${request.actor.id}" is AI and may not author an audit record. ${definition.action} ` +
          `is ${definition.authority}; AI may prompt a human or a deterministic system to record ` +
          'it, and that actor owns the record',
      );
    }

    if (request.resource.owner !== definition.owner) {
      throw new AuditError(
        'resource-not-owned',
        `${definition.action} is owned by ${definition.owner} but names a resource owned by ` +
          `${request.resource.owner}. A unit that could record actions against another's resources ` +
          "could fabricate that unit's history",
      );
    }
    if (
      definition.resourceTypes.length > 0 &&
      !definition.resourceTypes.includes(request.resource.type)
    ) {
      throw new AuditError(
        'resource-not-owned',
        `${definition.action} does not declare resource type "${request.resource.type}"; ` +
          `declared: ${definition.resourceTypes.join(', ')}`,
      );
    }
    if (!RESOURCE_TYPE.test(request.resource.type)) {
      throw new AuditError(
        'malformed-record',
        `resource type "${request.resource.type}" is not lower_snake_case`,
      );
    }
    if (!AUDIT_OUTCOMES.includes(request.outcome)) {
      throw new AuditError(
        'malformed-record',
        `outcome "${request.outcome}" is not one of ${AUDIT_OUTCOMES.join(', ')}`,
      );
    }

    assertIdentifier(request.recordId, 'recordId');
    assertIdentifier(request.correlationId, 'correlationId');
    assertIdentifier(request.idempotencyKey, 'idempotencyKey');
    assertIdentifier(request.actor.id, 'actor.id');
    assertIdentifier(request.resource.id, 'resource.id');
    if (request.causationId !== undefined && request.causationId !== null) {
      assertIdentifier(request.causationId, 'causationId');
    }
    if (request.actor.sessionId !== null) {
      // K-02 does not exist, so nothing can have established a session. A record claiming one
      // would be asserting a verification that never happened.
      throw new AuditError(
        'actor-not-permitted',
        `actor.sessionId is "${request.actor.sessionId}", but K-02 Authentication does not exist, ` +
          'so no session can have been established. Record null and say so honestly',
      );
    }
    if (request.actor.authentication !== 'unauthenticated') {
      throw new AuditError(
        'actor-not-permitted',
        `actor.authentication is "${request.actor.authentication}", but nothing authenticates ` +
          'anybody yet. A record that claims a verified actor before K-02 exists is a record that ' +
          'lies to whoever reads it later',
      );
    }
    if (request.reason.trim() === '') {
      throw new AuditError(
        'malformed-record',
        'reason is empty. A record with no reason explains nothing to the person reading it during ' +
          'an incident, which is the only time anybody reads one',
      );
    }

    const recordedAt = assertRecordInstant(request.recordedAt, 'recordedAt');
    const evidence = Object.freeze({ ...(request.evidence ?? {}) });
    assertValidEvidence(definition, evidence);

    const draft: Omit<AuditRecord, 'contentFingerprint'> = {
      recordId: request.recordId,
      action: request.action,
      recordedAt,
      actor: { ...request.actor },
      resource: { ...request.resource },
      outcome: request.outcome,
      reason: request.reason,
      correlationId: request.correlationId,
      causationId: request.causationId ?? null,
      evidence,
      idempotencyKey: request.idempotencyKey,
    };
    // Sealed before it is stored *and* before it is returned: the same boundary in both
    // directions. A caller that keeps its request object cannot reach into the log through the
    // actor or resource it passed, because those were copied here.
    const record: AuditRecord = sealRecord({
      ...draft,
      contentFingerprint: fingerprintRecord(draft),
    });

    try {
      return await this.#append(record);
    } catch (error) {
      // Two retries of one recording that overlap in time each read a store with no such key, so
      // both try to append and one loses. The loser has not failed — the recording it was retrying
      // succeeded — so it re-reads and converges, checking the content as the sequential path does.
      // A key genuinely reused for a different record still fails closed.
      const conflicted =
        error instanceof AuditError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-record-id');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findRecordByIdempotencyKey(record.idempotencyKey),
      );
      if (winner === null) throw error;

      assertSameLogicalRecord(winner, record);
      return { record: sealRecord(winner), deduplicated: true };
    }
  }

  async #append(record: AuditRecord): Promise<RecordResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findRecordByIdempotencyKey(record.idempotencyKey);
      if (existing !== null) {
        assertSameLogicalRecord(existing, record);
        return { record: sealRecord(existing), deduplicated: true };
      }

      await tx.insertRecord(record);
      return { record: sealRecord(record), deduplicated: false };
    });
  }

  /** One record, by id. The only way to see one; nothing here changes one. */
  async recordById(recordId: string): Promise<AuditRecord> {
    const record = await this.#repository.withTransaction((tx: AuditTransaction) =>
      tx.findRecordById(recordId),
    );
    if (record === null) throw new AuditError('no-such-record', `no audit record ${recordId}`);
    return sealRecord(record);
  }

  /**
   * A page of records, filtered and ordered deterministically.
   *
   * The limit is bounded. An unbounded audit query is how one investigation takes a database down.
   */
  async query(query: Partial<AuditQuery> = {}): Promise<AuditPage> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new AuditError(
        'invalid-query',
        `limit must be a whole number between 1 and ${MAX_PAGE_LIMIT}, got ${String(limit)}`,
      );
    }
    if (query.action !== undefined) this.#actions.require(query.action);
    if (query.from !== undefined) assertRecordInstant(query.from, 'from');
    if (query.before !== undefined) assertRecordInstant(query.before, 'before');
    if (query.after !== undefined) {
      assertRecordInstant(query.after.recordedAt, 'after.recordedAt');
      assertIdentifier(query.after.recordId, 'after.recordId');
    }
    if (query.outcome !== undefined && !AUDIT_OUTCOMES.includes(query.outcome as AuditOutcome)) {
      throw new AuditError('invalid-query', `outcome "${query.outcome}" is not a known outcome`);
    }

    const page = await this.#repository.withTransaction((tx) =>
      tx.queryRecords({ ...query, limit }),
    );
    return { records: sealRecords(page.records), next: page.next };
  }

  /** Every page, for a caller that genuinely wants the whole result. Bounded by `maxRecords`. */
  async queryAll(
    query: Partial<AuditQuery> = {},
    maxRecords = MAX_PAGE_LIMIT,
  ): Promise<readonly AuditRecord[]> {
    const collected: AuditRecord[] = [];
    let after: AuditCursor | undefined = query.after;

    while (collected.length < maxRecords) {
      const page: AuditPage = await this.query({
        ...query,
        ...(after === undefined ? {} : { after }),
        limit: Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, maxRecords - collected.length),
      });
      collected.push(...page.records);
      if (page.next === null) break;
      after = page.next;
    }

    return sealRecords(collected);
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new AuditError(
      'malformed-record',
      `${field} "${value}" is not a valid identifier. Expected 1-128 characters of ` +
        '[A-Za-z0-9._:-] starting alphanumeric',
    );
  }
}

/** Instants are validated in this component's own vocabulary, not the platform utility's. */
function assertRecordInstant(value: string, field: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AuditError('malformed-record', `${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * A retry must be a retry of *this* recording.
 *
 * Compared by fingerprint rather than field by field, because the fingerprint already covers every
 * field of the logical content — and a comparison that drifted out of step with it would let a
 * changed record through under an old key.
 */
function assertSameLogicalRecord(existing: AuditRecord, incoming: AuditRecord): void {
  if (existing.contentFingerprint === incoming.contentFingerprint) return;

  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      differences.push(`${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
    }
  };

  compare('recordId', existing.recordId, incoming.recordId);
  compare('action', existing.action, incoming.action);
  compare('recordedAt', existing.recordedAt, incoming.recordedAt);
  compare('actor', existing.actor, incoming.actor);
  compare('resource', existing.resource, incoming.resource);
  compare('outcome', existing.outcome, incoming.outcome);
  compare('reason', existing.reason, incoming.reason);
  compare('correlationId', existing.correlationId, incoming.correlationId);
  compare('causationId', existing.causationId, incoming.causationId);
  compare('evidence', existing.evidence, incoming.evidence);

  throw new AuditError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different record ` +
      `(${differences.join('; ') || 'the content differs'}). Returning the earlier record would ` +
      'attest to something that was never recorded',
  );
}
