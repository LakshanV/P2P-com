/**
 * M-07 Matching — climbing the ladder.
 *
 * The service is short because the interesting part is a decision, not an algorithm: **which rung to
 * try next, and when to stop**. Each rung is somebody else's implementation behind a port; what
 * happens here is the ordering, the sufficiency test, and the record of what was tried.
 *
 * Read `runLadder` with three questions in mind.
 *
 * **Why does it stop early?** Because a Need already answered by something on a shelf must not
 * become an RFQ. Broadcasting every request to every supplier is what makes marketplaces tiring:
 * suppliers learn to ignore RFQs, and the customer waits days for something they could have had
 * this afternoon. Stopping is the product.
 *
 * **Why is `unavailable` not `empty`?** A rung that could not run has established nothing about the
 * world. Conflating the two would let a broken supplier directory silently turn every Need into a
 * tender, and nobody would notice until the suppliers complained.
 *
 * **Why record the rungs that found nothing?** Because "we checked the catalogue and there was none,
 * and the two suppliers who stock it are out until Thursday" is what a customer is owed when their
 * Need becomes an RFQ. Without it the escalation is unexplained, and an unexplained escalation is
 * indistinguishable from laziness.
 *
 * Deterministic: every identifier and every instant comes from the caller.
 *
 * Owned by: M-07 Matching.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealCandidates, sealMatchRun, sealMatchRuns, sealRungAttempts } from './immutable.ts';
import { makeMatchRunEvent, makeMatchRunAction } from './outbox.ts';
import type { RungCandidate, SourcingQuery, SourcingRungPort } from './ports.ts';
import { FOREIGN_FIELDS, assertMatchingIdentifier, assertScore } from './registry.ts';
import type { MatchingRepository } from './repository.ts';
import {
  MatchingError,
  SOURCING_RUNGS,
  type MatchCandidate,
  type MatchRun,
  type RunOutcome,
  type RungAttempt,
  type RungOutcome,
  type SourcingRung,
} from './types.ts';
import { validateCandidate, validateMatchRun, validateRungAttempt } from './validate.ts';

/**
 * How good a candidate must be before the ladder stops.
 *
 * 700 per-mille. Set from what the two failure modes cost, which are not symmetric: stopping on a
 * poor match wastes the customer's attention and may lose the sale, while climbing one rung too far
 * costs a supplier an email. So the bar is deliberately high rather than merely positive — but it
 * is a **default**, and a deployment that knows its own supply better may set its own.
 */
export const DEFAULT_SUFFICIENCY_PER_MILLE = 700;

/** The rungs a deployment has wired. A rung with no port is `unavailable`, never `empty`. */
export type RungPorts = Partial<Record<SourcingRung, SourcingRungPort>>;

export interface RunLadderRequest {
  readonly runId: string;
  readonly requestId: string;
  readonly accountId: string;
  readonly interpretationId: string | null;
  /** M-03's structured reading. The words are deliberately not passed to a rung. */
  readonly structured: Readonly<Record<string, unknown>>;
  readonly confidencePerMille: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Overrides the default. A deployment that knows its supply may hold a different bar. */
  readonly sufficiencyPerMille?: number;
}

export interface RunLadderResult {
  readonly run: MatchRun;
  readonly attempts: readonly RungAttempt[];
  /** Every candidate found on the rung that ended the run, best first. Empty on an escalation. */
  readonly candidates: readonly MatchCandidate[];
  readonly replayed: boolean;
}

const LADDER_KEYS: readonly string[] = [
  'runId',
  'requestId',
  'accountId',
  'interpretationId',
  'structured',
  'confidencePerMille',
  'startedAt',
  'completedAt',
  'correlationId',
  'idempotencyKey',
  'sufficiencyPerMille',
];

export class MatchingService {
  readonly #repository: MatchingRepository;
  readonly #rungs: RungPorts;

  constructor(repository: MatchingRepository, rungs: RungPorts = {}) {
    this.#repository = repository;
    this.#rungs = rungs;
  }

  /**
   * Try to solve a Need, cheapest rung first, and record everything that was tried.
   *
   * Returns `matched` with candidates when a rung satisfied, and `escalate-to-rfq` when none did.
   * It does **not** create an RFQ: that is M-09's, and a matching engine that could open tenders
   * would be two modules wearing one name.
   */
  async runLadder(request: RunLadderRequest): Promise<RunLadderResult> {
    assertNoForeignConcerns(request, LADDER_KEYS, 'runLadder');
    assertMatchingIdentifier(request.runId, 'runId');
    assertInstant(request.startedAt, 'startedAt');
    assertInstant(request.completedAt, 'completedAt');

    const sufficiency = assertScore(
      request.sufficiencyPerMille ?? DEFAULT_SUFFICIENCY_PER_MILLE,
      'sufficiencyPerMille',
    );

    // A replay answers from what was recorded rather than climbing again. Re-running would query
    // real suppliers a second time for a request the caller already has an answer to.
    const replayed = await this.#repository.withTransaction((tx) =>
      tx.findRunByIdempotencyKey(request.idempotencyKey),
    );
    if (replayed !== null) {
      return this.#assemble(replayed, true);
    }

    const query: SourcingQuery = {
      requestId: request.requestId,
      accountId: request.accountId,
      structured: request.structured,
      confidencePerMille: request.confidencePerMille,
      now: request.startedAt,
      correlationId: request.correlationId,
    };

    const attempts: RungAttempt[] = [];
    const candidates: MatchCandidate[] = [];
    let satisfiedBy: SourcingRung | null = null;

    for (const [index, rung] of SOURCING_RUNGS.entries()) {
      const position = index + 1;

      if (satisfiedBy !== null) {
        // Recorded rather than omitted, so the run reads as a sequence rather than as a set of
        // unexplained gaps. Somebody reviewing it should be able to see that rung 4 was never tried
        // *because* rung 1 answered, not wonder whether it failed silently.
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'skipped',
            candidatesFound: 0,
            bestScorePerMille: null,
            reason: `not tried: the ${satisfiedBy} rung already answered this Need`,
          }),
        );
        continue;
      }

      // The RFQ rung is a recommendation, never a search. Reaching it means every way of solving
      // the Need without troubling the market has been tried and none worked.
      if (rung === 'rfq') {
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'insufficient',
            candidatesFound: 0,
            bestScorePerMille: null,
            reason:
              'no rung above this one produced a good enough match, so asking the market is now ' +
              'the right thing to do rather than the first thing',
          }),
        );
        continue;
      }

      const port = this.#rungs[rung];
      if (port === undefined) {
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'unavailable',
            candidatesFound: 0,
            bestScorePerMille: null,
            reason: `no adapter is wired for the ${rung} rung, so nothing was searched there`,
          }),
        );
        continue;
      }

      let found: readonly RungCandidate[];
      try {
        found = await port.find(query);
      } catch (error) {
        // A rung that could not look has established nothing. Recorded as `unavailable` with the
        // reason, so a broken directory shows up as a broken directory rather than as an absence of
        // suppliers.
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'unavailable',
            candidatesFound: 0,
            bestScorePerMille: null,
            reason:
              `the ${rung} rung could not be searched: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          }),
        );
        continue;
      }

      const scored = found
        .map((candidate, order) => this.#candidate(request, rung, candidate, order))
        .sort((a, b) => b.scorePerMille - a.scorePerMille);
      const best = scored[0] ?? null;

      if (best === null) {
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'empty',
            candidatesFound: 0,
            bestScorePerMille: null,
            reason: `nothing on the ${rung} rung matches this Need at all`,
          }),
        );
        continue;
      }

      if (best.scorePerMille < sufficiency) {
        // Found something, but not good enough. Distinct from `empty` because "there is some and it
        // is wrong" and "there is none" lead a human to different next steps — the first is worth
        // showing the customer anyway, the second is not.
        attempts.push(
          this.#attempt(request, rung, position, {
            outcome: 'insufficient',
            candidatesFound: scored.length,
            bestScorePerMille: best.scorePerMille,
            reason:
              `the best of ${String(scored.length)} candidate(s) on the ${rung} rung scored ` +
              `${String(best.scorePerMille)}, below the ${String(sufficiency)} this run required`,
          }),
        );
        continue;
      }

      satisfiedBy = rung;
      candidates.push(...scored.filter((one) => one.scorePerMille >= sufficiency));
      attempts.push(
        this.#attempt(request, rung, position, {
          outcome: 'satisfied',
          candidatesFound: scored.length,
          bestScorePerMille: best.scorePerMille,
          reason:
            `the ${rung} rung answered this Need: ${String(candidates.length)} candidate(s) at or ` +
            `above ${String(sufficiency)}, the best scoring ${String(best.scorePerMille)}`,
        }),
      );
    }

    const outcome: RunOutcome = satisfiedBy === null ? 'escalate-to-rfq' : 'matched';
    const run = validateMatchRun(
      {
        runId: request.runId,
        requestId: request.requestId,
        accountId: request.accountId,
        interpretationId: request.interpretationId,
        outcome,
        satisfiedBy,
        sufficiencyPerMille: sufficiency,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    await this.#repository.withTransaction(async (tx) => {
      await tx.insertRun(run);
      for (const attempt of attempts) await tx.insertAttempt(attempt);
      for (const candidate of candidates) await tx.insertCandidate(candidate);
      await tx.insertOutbox(makeMatchRunEvent(run, attempts.length, candidates.length));
      await tx.insertOutbox(makeMatchRunAction(run, attempts.length, candidates.length));
    });

    return {
      run: sealMatchRun(run),
      attempts: sealRungAttempts(attempts),
      candidates: sealCandidates(candidates),
      replayed: false,
    };
  }

  async getRun(runId: string): Promise<MatchRun | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findRunById(runId));
    return held === null ? null : sealMatchRun(held);
  }

  /**
   * Every run against a Need, oldest first.
   *
   * Plural on purpose. Re-running after a correction, or a week later when supply has changed,
   * creates a new run — and comparing two is how anybody answers "why did this find nothing on
   * Tuesday and something on Thursday".
   */
  async listRunsForRequest(requestId: string): Promise<readonly MatchRun[]> {
    return sealMatchRuns(
      await this.#repository.withTransaction((tx) => tx.findRunsByRequestId(requestId)),
    );
  }

  /** What was tried, in ladder order, including the rungs that found nothing. */
  async listAttempts(runId: string): Promise<readonly RungAttempt[]> {
    return sealRungAttempts(
      await this.#repository.withTransaction((tx) => tx.findAttemptsByRunId(runId)),
    );
  }

  async listCandidates(runId: string): Promise<readonly MatchCandidate[]> {
    return sealCandidates(
      await this.#repository.withTransaction((tx) => tx.findCandidatesByRunId(runId)),
    );
  }

  async #assemble(run: MatchRun, replayed: boolean): Promise<RunLadderResult> {
    const [attempts, candidates] = await this.#repository.withTransaction((tx) =>
      Promise.all([tx.findAttemptsByRunId(run.runId), tx.findCandidatesByRunId(run.runId)]),
    );
    return {
      run: sealMatchRun(run),
      attempts: sealRungAttempts(attempts),
      candidates: sealCandidates(candidates),
      replayed,
    };
  }

  #attempt(
    request: RunLadderRequest,
    rung: SourcingRung,
    position: number,
    facts: {
      readonly outcome: RungOutcome;
      readonly candidatesFound: number;
      readonly bestScorePerMille: number | null;
      readonly reason: string;
    },
  ): RungAttempt {
    return validateRungAttempt(
      {
        // Derived from the run and the rung, so a replay produces the same identifiers and the
        // caller never has to mint five of them.
        attemptId: `${request.runId}:${rung}`,
        runId: request.runId,
        rung,
        position,
        outcome: facts.outcome,
        candidatesFound: facts.candidatesFound,
        bestScorePerMille: facts.bestScorePerMille,
        reason: facts.reason,
        attemptedAt: request.startedAt,
        correlationId: request.correlationId,
        idempotencyKey: `${request.idempotencyKey}:${rung}`,
      },
      'request',
    );
  }

  #candidate(
    request: RunLadderRequest,
    rung: SourcingRung,
    candidate: RungCandidate,
    order: number,
  ): MatchCandidate {
    return validateCandidate(
      {
        candidateId: `${request.runId}:${rung}:${String(order)}`,
        runId: request.runId,
        rung,
        kind: candidate.kind,
        listingId: candidate.listingId,
        versionId: candidate.versionId,
        supplierAccountId: candidate.supplierAccountId,
        scorePerMille: candidate.scorePerMille,
        explanation: candidate.explanation,
        evidence: candidate.evidence,
        foundAt: request.startedAt,
        correlationId: request.correlationId,
        idempotencyKey: `${request.idempotencyKey}:${rung}:${String(order)}`,
      },
      'request',
    );
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new MatchingError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new MatchingError(
        'foreign-concern',
        `${operation} refuses "${key}"; the permitted fields are ${permitted.join(', ')}`,
      );
    }
  }
}

function assertInstant(value: string, field: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new MatchingError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
