/**
 * M-07 Matching — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder on
 * the way out.
 *
 * Owned by: M-07 Matching.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  assertCandidateKind,
  assertExplanation,
  assertMatchingIdentifier,
  assertRunOutcome,
  assertRungOutcome,
  assertScore,
  assertSourcingRung,
} from './registry.ts';
import {
  MatchingError,
  SOURCING_RUNGS,
  type MatchCandidate,
  type MatchRun,
  type RungAttempt,
} from './types.ts';

export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const RUN_FIELDS: readonly string[] = [
  'runId',
  'requestId',
  'accountId',
  'interpretationId',
  'outcome',
  'satisfiedBy',
  'sufficiencyPerMille',
  'startedAt',
  'completedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateMatchRun(candidate: unknown, source: RecordSource): MatchRun {
  try {
    const fields = asObject(candidate, 'a match run', RUN_FIELDS);
    const outcome = assertRunOutcome(fields.outcome, 'outcome');
    const satisfiedBy =
      fields.satisfiedBy === null || fields.satisfiedBy === undefined
        ? null
        : assertSourcingRung(fields.satisfiedBy, 'satisfiedBy');

    // A matched run names the rung that ended it, and an escalation names none. Either without the
    // other is a record that cannot say how the ladder finished, which is the only thing a run is
    // for.
    if ((outcome === 'matched') !== (satisfiedBy !== null)) {
      throw new MatchingError(
        'malformed-record',
        `a run with outcome "${outcome}" ${satisfiedBy === null ? 'names no rung' : `names ${satisfiedBy}`}. ` +
          'A match is satisfied by exactly one rung and an escalation by none',
      );
    }

    return {
      runId: assertMatchingIdentifier(fields.runId, 'runId'),
      requestId: assertMatchingIdentifier(fields.requestId, 'requestId'),
      accountId: assertMatchingIdentifier(fields.accountId, 'accountId'),
      interpretationId:
        fields.interpretationId === null || fields.interpretationId === undefined
          ? null
          : assertMatchingIdentifier(fields.interpretationId, 'interpretationId'),
      outcome,
      satisfiedBy,
      sufficiencyPerMille: assertScore(asNumber(fields.sufficiencyPerMille), 'sufficiencyPerMille'),
      startedAt: checkInstant(fields.startedAt, 'startedAt', source),
      completedAt: checkInstant(fields.completedAt, 'completedAt', source),
      correlationId: assertMatchingIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertMatchingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof MatchingError)) throw error;
    throw new MatchingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const ATTEMPT_FIELDS: readonly string[] = [
  'attemptId',
  'runId',
  'rung',
  'position',
  'outcome',
  'candidatesFound',
  'bestScorePerMille',
  'reason',
  'attemptedAt',
  'correlationId',
  'idempotencyKey',
];

export function validateRungAttempt(candidate: unknown, source: RecordSource): RungAttempt {
  try {
    const fields = asObject(candidate, 'a rung attempt', ATTEMPT_FIELDS);
    const rung = assertSourcingRung(fields.rung, 'rung');
    const position = assertNonNegativeInteger(fields.position, 'position');

    // The position is the rung's place in the ladder, not a free number. A record where they
    // disagree would make the sequence unreadable in exactly the way the sequence exists to prevent.
    const expected = SOURCING_RUNGS.indexOf(rung) + 1;
    if (position !== expected) {
      throw new MatchingError(
        'malformed-record',
        `the ${rung} rung is position ${String(expected)} in the ladder, not ` +
          `${String(position)}. The ladder order is the product decision, so a record that ` +
          'disagrees with it is not a record of this ladder',
      );
    }

    const outcome = assertRungOutcome(fields.outcome, 'outcome');
    const found = assertNonNegativeInteger(fields.candidatesFound, 'candidatesFound');
    const best =
      fields.bestScorePerMille === null || fields.bestScorePerMille === undefined
        ? null
        : assertScore(asNumber(fields.bestScorePerMille), 'bestScorePerMille');

    // A rung that found candidates has a best score, and one that found none has no best. The pair
    // is the evidence behind the outcome, so an inconsistent pair is worse than no record.
    if (found > 0 && best === null) {
      throw new MatchingError(
        'malformed-record',
        `the ${rung} rung reports ${String(found)} candidate(s) and no best score`,
      );
    }
    if (found === 0 && best !== null) {
      throw new MatchingError(
        'malformed-record',
        `the ${rung} rung reports no candidates and a best score of ${String(best)}`,
      );
    }

    return {
      attemptId: assertMatchingIdentifier(fields.attemptId, 'attemptId'),
      runId: assertMatchingIdentifier(fields.runId, 'runId'),
      rung,
      position,
      outcome,
      candidatesFound: found,
      bestScorePerMille: best,
      reason: assertExplanation(fields.reason, 'reason'),
      attemptedAt: checkInstant(fields.attemptedAt, 'attemptedAt', source),
      correlationId: assertMatchingIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertMatchingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof MatchingError)) throw error;
    throw new MatchingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const CANDIDATE_FIELDS: readonly string[] = [
  'candidateId',
  'runId',
  'rung',
  'kind',
  'listingId',
  'versionId',
  'supplierAccountId',
  'scorePerMille',
  'explanation',
  'evidence',
  'foundAt',
  'correlationId',
  'idempotencyKey',
];

export function validateCandidate(candidate: unknown, source: RecordSource): MatchCandidate {
  try {
    const fields = asObject(candidate, 'a match candidate', CANDIDATE_FIELDS);
    const kind = assertCandidateKind(fields.kind, 'kind');
    const listingId =
      fields.listingId === null || fields.listingId === undefined
        ? null
        : assertMatchingIdentifier(fields.listingId, 'listingId');
    const versionId =
      fields.versionId === null || fields.versionId === undefined
        ? null
        : assertMatchingIdentifier(fields.versionId, 'versionId');

    // A listing candidate is orderable, and an order pins a version — so naming one without the
    // other produces a candidate nobody can act on. A supplier candidate names neither: nobody has
    // offered anything yet.
    if (kind === 'listing' && (listingId === null || versionId === null)) {
      throw new MatchingError(
        'incoherent-candidate',
        'a listing candidate must name both the listing and the version it was scored on, because ' +
          'an order pins a version and a candidate that cannot be ordered is not a candidate',
      );
    }
    if (kind === 'supplier' && (listingId !== null || versionId !== null)) {
      throw new MatchingError(
        'incoherent-candidate',
        'a supplier candidate names no listing: nobody has offered anything yet, which is exactly ' +
          'what distinguishes it from a listing candidate',
      );
    }

    return {
      candidateId: assertMatchingIdentifier(fields.candidateId, 'candidateId'),
      runId: assertMatchingIdentifier(fields.runId, 'runId'),
      rung: assertSourcingRung(fields.rung, 'rung'),
      kind,
      listingId,
      versionId,
      supplierAccountId: assertMatchingIdentifier(fields.supplierAccountId, 'supplierAccountId'),
      scorePerMille: assertScore(asNumber(fields.scorePerMille), 'scorePerMille'),
      explanation: assertExplanation(fields.explanation, 'explanation'),
      evidence: assertJsonObject(fields.evidence, 'evidence'),
      foundAt: checkInstant(fields.foundAt, 'foundAt', source),
      correlationId: assertMatchingIdentifier(fields.correlationId, 'correlationId'),
      idempotencyKey: assertMatchingIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  } catch (error) {
    if (source === 'request' || !(error instanceof MatchingError)) throw error;
    throw new MatchingError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function asObject(
  candidate: unknown,
  what: string,
  permitted: readonly string[],
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new MatchingError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  for (const key of Object.keys(candidate)) {
    if (!permitted.includes(key)) {
      throw new MatchingError(
        'malformed-record',
        `${what} carried the unrecognised field "${key}"; the permitted fields are ` +
          permitted.join(', '),
      );
    }
  }
  return candidate as Record<string, unknown>;
}

/** PostgreSQL returns a smallint as a number; accepting a numeric string keeps one rule, not two. */
function asNumber(value: unknown): number {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return value as number;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  const parsed = asNumber(value);
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new MatchingError(
      'malformed-record',
      `${field} is ${String(value)}; expected a non-negative integer`,
    );
  }
  return parsed;
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MatchingError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new MatchingError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new MatchingError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form`,
      );
    }
    try {
      return formatInstant(parseInstant(value).epochMicros);
    } catch (error) {
      if (error instanceof InvalidInstantError) {
        throw new MatchingError('malformed-record', `${field}: ${error.message}`);
      }
      throw error;
    }
  }

  if (typeof value !== 'string') {
    throw new MatchingError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new MatchingError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
