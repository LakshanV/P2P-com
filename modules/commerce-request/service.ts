/**
 * M-03 Commerce Request — capturing a Need, and recording what the platform made of it.
 *
 * The front door of the whole product. Everything downstream begins here: search, matching, the
 * sourcing ladder, RFQ, an order. What this service is careful about is therefore not sophistication
 * but **fidelity** — keeping exactly what somebody said, separately from every guess about what they
 * meant.
 *
 * Four rules, and the first is the module.
 *
 * **The raw text is written once and never again.** `captureNeed` stores it; nothing else in this
 * file touches it. There is deliberately no `updateRawText`, no normalisation step and no
 * "corrected" field: a Need that could be edited after the fact is a Need with no evidential value,
 * and the whole reason to keep the words is that a dispute six months from now is judged against
 * what was actually asked for rather than against what the platform decided it meant.
 *
 * **Interpreting appends.** `interpret` writes a new interpretation and points the Need at it. The
 * previous ones stay exactly as they were, so the sequence is a record of how the understanding
 * changed and who changed it — which is the only way anybody ever diagnoses a wrong reading rather
 * than arguing about it.
 *
 * **A human correction is an interpretation like any other, and outranks the others by origin
 * rather than by overwriting them.** The customer saying "6mm, not 6cm" produces a `human` reading
 * at the next version. The model's reading is still there, still wrong, still visible.
 *
 * **Deterministic.** The caller supplies every identifier and every instant. This service reads no
 * clock and generates no randomness, which is what lets a retry converge and a test pin time.
 *
 * Owned by: M-03 Commerce Request.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  sealCommerceRequest,
  sealCommerceRequests,
  sealInterpretation,
  sealInterpretations,
  sealRequestEvents,
  sealRequestMedia,
  sealRequestMedias,
} from './immutable.ts';
import {
  makeInterpretedAction,
  makeInterpretedEvent,
  makeNeedCapturedAction,
  makeNeedCapturedEvent,
  makeStatusAction,
  makeStatusEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertCommerceRequestIdentifier } from './registry.ts';
import type { CommerceRequestRepository, CommerceRequestTransaction } from './repository.ts';
import {
  CommerceRequestError,
  REQUEST_TRANSITIONS,
  type CommerceRequest,
  type RequestEvent,
  type RequestInterpretation,
  type RequestMedia,
  type RequestStatus,
} from './types.ts';
import {
  validateCommerceRequest,
  validateInterpretation,
  validateRequestEvent,
  validateRequestMedia,
} from './validate.ts';

export interface CaptureNeedRequest {
  readonly requestId: string;
  readonly accountId: string;
  readonly channel: string;
  /** What the person said. Stored exactly as given. */
  readonly rawText: string;
  readonly conversationId?: string | null;
  readonly neededBy?: string | null;
  readonly capturedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface CaptureNeedResult {
  readonly request: CommerceRequest;
  readonly replayed: boolean;
}

export interface InterpretRequest {
  readonly requestId: string;
  readonly interpretationId: string;
  readonly origin: string;
  readonly confidencePerMille: number;
  readonly structured: Readonly<Record<string, unknown>>;
  readonly aiRunId?: string | null;
  readonly rationale: string;
  readonly interpretedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the transition fact this produces. */
  readonly eventId: string;
}

export interface InterpretResult {
  readonly request: CommerceRequest;
  readonly interpretation: RequestInterpretation;
  readonly replayed: boolean;
}

export interface AttachMediaRequest {
  readonly mediaId: string;
  readonly requestId: string;
  readonly kind: string;
  readonly reference: string;
  readonly position: number;
  readonly caption: string;
  readonly addedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AttachMediaResult {
  readonly media: RequestMedia;
  readonly replayed: boolean;
}

export interface TransitionRequest {
  readonly requestId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface TransitionResult {
  readonly request: CommerceRequest;
  readonly replayed: boolean;
}

const CAPTURE_KEYS: readonly string[] = [
  'requestId',
  'accountId',
  'channel',
  'rawText',
  'conversationId',
  'neededBy',
  'capturedAt',
  'correlationId',
  'idempotencyKey',
];

const INTERPRET_KEYS: readonly string[] = [
  'requestId',
  'interpretationId',
  'origin',
  'confidencePerMille',
  'structured',
  'aiRunId',
  'rationale',
  'interpretedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const MEDIA_KEYS: readonly string[] = [
  'mediaId',
  'requestId',
  'kind',
  'reference',
  'position',
  'caption',
  'addedAt',
  'correlationId',
  'idempotencyKey',
];

const TRANSITION_KEYS: readonly string[] = [
  'requestId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

export class CommerceRequestService {
  readonly #repository: CommerceRequestRepository;

  constructor(repository: CommerceRequestRepository) {
    this.#repository = repository;
  }

  /**
   * Record what somebody wants, in their words.
   *
   * The only operation that ever writes `rawText`, and it writes it once. A Need arrives at
   * `captured`, which is a usable state: a person can read it, and a Need nobody has interpreted is
   * still better than no Need at all.
   */
  async captureNeed(request: CaptureNeedRequest): Promise<CaptureNeedResult> {
    assertNoForeignConcerns(request, CAPTURE_KEYS, 'captureNeed');

    const candidate = validateCommerceRequest(
      {
        requestId: request.requestId,
        accountId: request.accountId,
        channel: request.channel,
        rawText: request.rawText,
        conversationId: request.conversationId ?? null,
        status: 'captured' as RequestStatus,
        currentInterpretationId: null,
        capturedAt: request.capturedAt,
        updatedAt: request.capturedAt,
        neededBy: request.neededBy ?? null,
        closedAt: null,
        closureReason: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findRequestByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) {
          if (!requestEquals(byKey, candidate)) {
            throw new CommerceRequestError(
              'idempotency-key-reuse',
              `idempotency key "${candidate.idempotencyKey}" has already been used for a ` +
                'different Need',
            );
          }
          return { request: sealCommerceRequest(byKey), replayed: true };
        }

        await tx.insertRequest(candidate);
        await tx.insertEvent(
          validateRequestEvent(
            {
              eventId: `${candidate.requestId}:captured`,
              requestId: candidate.requestId,
              fromStatus: null,
              toStatus: 'captured',
              reason: 'the Need was captured',
              occurredAt: candidate.capturedAt,
              correlationId: candidate.correlationId,
              idempotencyKey: candidate.idempotencyKey,
            },
            'request',
          ),
        );
        await tx.insertOutbox(makeNeedCapturedEvent(candidate, false));
        await tx.insertOutbox(makeNeedCapturedAction(candidate, false));
        return { request: sealCommerceRequest(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findRequestByIdempotencyKey(candidate.idempotencyKey);
        if (byKey === null || !requestEquals(byKey, candidate)) return null;
        return { request: sealCommerceRequest(byKey), replayed: true };
      },
    );
  }

  /**
   * Record a reading of a Need.
   *
   * Appends. The Need's `currentInterpretationId` moves to the new reading and its status becomes
   * `interpreted`, but nothing that was written before is touched — so the history reads as a
   * sequence of understandings rather than as one that was quietly improved.
   *
   * A Need that has ended refuses this. Interpreting a cancelled Need would be work nobody asked
   * for, and interpreting a fulfilled one would change what the order was placed against.
   */
  async interpret(request: InterpretRequest): Promise<InterpretResult> {
    assertNoForeignConcerns(request, INTERPRET_KEYS, 'interpret');

    return this.#converge(
      async (tx) => {
        const existing = await tx.findInterpretationByIdempotencyKey(request.idempotencyKey);
        if (existing !== null) {
          const held = await requireRequest(tx, existing.requestId);
          return {
            request: sealCommerceRequest(held),
            interpretation: sealInterpretation(existing),
            replayed: true,
          };
        }

        const before = await requireRequest(tx, request.requestId);
        assertOpen(before, 'interpret');

        const prior = await tx.findInterpretationsByRequestId(before.requestId);
        const latest = prior.at(-1) ?? null;

        const interpretation = validateInterpretation(
          {
            interpretationId: request.interpretationId,
            requestId: before.requestId,
            version: (latest?.version ?? 0) + 1,
            origin: request.origin,
            confidencePerMille: request.confidencePerMille,
            structured: request.structured,
            aiRunId: request.aiRunId ?? null,
            rationale: request.rationale,
            // A reading always supersedes the one before it, if there was one. Recorded explicitly
            // rather than inferred from the version, so the chain survives a gap.
            supersedesInterpretationId: latest?.interpretationId ?? null,
            interpretedAt: request.interpretedAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        );

        await tx.insertInterpretation(interpretation);

        // `ready` is not demoted by a new reading: a Need somebody has already accepted as sourceable
        // stays sourceable while a better understanding is recorded alongside.
        const nextStatus: RequestStatus =
          before.status === 'captured' ? 'interpreted' : before.status;
        const after = validateCommerceRequest(
          {
            ...before,
            status: nextStatus,
            currentInterpretationId: interpretation.interpretationId,
            updatedAt: request.interpretedAt,
          },
          'request',
        );
        await tx.updateRequest(after);

        if (nextStatus !== before.status) {
          await tx.insertEvent(
            validateRequestEvent(
              {
                eventId: request.eventId,
                requestId: after.requestId,
                fromStatus: before.status,
                toStatus: nextStatus,
                reason: request.rationale,
                occurredAt: request.interpretedAt,
                correlationId: request.correlationId,
                idempotencyKey: request.idempotencyKey,
              },
              'request',
            ),
          );
        }

        await tx.insertOutbox(makeInterpretedEvent(interpretation));
        await tx.insertOutbox(makeInterpretedAction(after.accountId, interpretation));

        return {
          request: sealCommerceRequest(after),
          interpretation: sealInterpretation(interpretation),
          replayed: false,
        };
      },
      async (tx) => {
        const existing = await tx.findInterpretationByIdempotencyKey(request.idempotencyKey);
        if (existing === null) return null;
        const held = await tx.findRequestById(existing.requestId);
        if (held === null) return null;
        return {
          request: sealCommerceRequest(held),
          interpretation: sealInterpretation(existing),
          replayed: true,
        };
      },
    );
  }

  /** Attach an artefact by opaque reference. M-03 never stores the artefact itself. */
  async attachMedia(request: AttachMediaRequest): Promise<AttachMediaResult> {
    assertNoForeignConcerns(request, MEDIA_KEYS, 'attachMedia');

    const candidate = validateRequestMedia({ ...request }, 'request');

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findMediaByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) {
          if (!mediaEquals(byKey, candidate)) {
            throw new CommerceRequestError(
              'idempotency-key-reuse',
              `idempotency key "${candidate.idempotencyKey}" has already been used for different ` +
                'media',
            );
          }
          return { media: sealRequestMedia(byKey), replayed: true };
        }

        const held = await requireRequest(tx, candidate.requestId);
        assertOpen(held, 'attachMedia');
        await tx.insertMedia(candidate);
        return { media: sealRequestMedia(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findMediaByIdempotencyKey(candidate.idempotencyKey);
        if (byKey === null || !mediaEquals(byKey, candidate)) return null;
        return { media: sealRequestMedia(byKey), replayed: true };
      },
    );
  }

  /** Accept the current understanding as good enough to source against. */
  markReady(request: TransitionRequest): Promise<TransitionResult> {
    return this.#transition(request, 'ready', 'markReady');
  }

  /** The ladder has started: matching, RFQ, offers. */
  startSourcing(request: TransitionRequest): Promise<TransitionResult> {
    return this.#transition(request, 'sourcing', 'startSourcing');
  }

  /** An order was placed against it. Terminal. */
  markFulfilled(request: TransitionRequest): Promise<TransitionResult> {
    return this.#transition(request, 'fulfilled', 'markFulfilled');
  }

  /** The person no longer wants it. Permitted from every live state, because minds change. */
  cancelNeed(request: TransitionRequest): Promise<TransitionResult> {
    return this.#transition(request, 'cancelled', 'cancelNeed');
  }

  /**
   * Nobody acted in time.
   *
   * Distinct from cancellation on purpose: "they changed their mind" and "we were too slow" are
   * different failures, and only one of them is the platform's. Collapsing them would hide the
   * second inside the first, which is the direction that flatters us.
   */
  expireNeed(request: TransitionRequest): Promise<TransitionResult> {
    return this.#transition(request, 'expired', 'expireNeed');
  }

  async getNeed(requestId: string): Promise<CommerceRequest | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findRequestById(requestId));
    return held === null ? null : sealCommerceRequest(held);
  }

  async listNeedsForAccount(accountId: string): Promise<readonly CommerceRequest[]> {
    return sealCommerceRequests(
      await this.#repository.withTransaction((tx) => tx.findRequestsByAccountId(accountId)),
    );
  }

  /**
   * Every reading of a Need, oldest first.
   *
   * The whole history, not just the current one. A caller asking "what did we think it meant, and
   * when did that change" is asking the question this module exists to be able to answer.
   */
  async listInterpretations(requestId: string): Promise<readonly RequestInterpretation[]> {
    return sealInterpretations(
      await this.#repository.withTransaction((tx) => tx.findInterpretationsByRequestId(requestId)),
    );
  }

  async listMedia(requestId: string): Promise<readonly RequestMedia[]> {
    return sealRequestMedias(
      await this.#repository.withTransaction((tx) => tx.findMediaByRequestId(requestId)),
    );
  }

  async listHistory(requestId: string): Promise<readonly RequestEvent[]> {
    return sealRequestEvents(
      await this.#repository.withTransaction((tx) => tx.findEventsByRequestId(requestId)),
    );
  }

  async #transition(
    request: TransitionRequest,
    to: RequestStatus,
    operation: string,
  ): Promise<TransitionResult> {
    assertNoForeignConcerns(request, TRANSITION_KEYS, operation);
    assertCommerceRequestIdentifier(request.eventId, 'eventId');
    assertInstant(request.occurredAt, 'occurredAt');

    return this.#converge(
      async (tx) => {
        const before = await requireRequest(tx, request.requestId);

        // A repeat of a move already made is the answer, not a refusal. A caller retrying a
        // cancellation it is not sure landed must not be told the Need is already cancelled as
        // though that were a problem.
        if (before.status === to) {
          return { request: sealCommerceRequest(before), replayed: true };
        }

        const permitted = REQUEST_TRANSITIONS[before.status];
        if (!permitted.includes(to)) {
          throw new CommerceRequestError(
            permitted.length === 0 ? 'request-closed' : 'illegal-transition',
            `a Need that is ${before.status} cannot become ${to}` +
              (permitted.length === 0
                ? '. It has ended, and an ending is a fact rather than a state to be moved out of'
                : `; from ${before.status} it may become ${permitted.join(', ')}`),
          );
        }

        const terminal = REQUEST_TRANSITIONS[to].length === 0;
        const after = validateCommerceRequest(
          {
            ...before,
            status: to,
            updatedAt: request.occurredAt,
            closedAt: terminal ? request.occurredAt : before.closedAt,
            closureReason: terminal ? request.reason : before.closureReason,
          },
          'request',
        );

        await tx.updateRequest(after);
        await tx.insertEvent(
          validateRequestEvent(
            {
              eventId: request.eventId,
              requestId: after.requestId,
              fromStatus: before.status,
              toStatus: to,
              reason: request.reason,
              occurredAt: request.occurredAt,
              correlationId: request.correlationId,
              idempotencyKey: request.idempotencyKey,
            },
            'request',
          ),
        );

        const media = await tx.findMediaByRequestId(after.requestId);
        await tx.insertOutbox(
          makeStatusEvent(after, request.eventId, request.occurredAt, media.length > 0),
        );
        await tx.insertOutbox(
          makeStatusAction(after, request.eventId, request.occurredAt, media.length > 0),
        );

        return { request: sealCommerceRequest(after), replayed: false };
      },
      async (tx) => {
        const held = await tx.findRequestById(request.requestId);
        if (held === null || held.status !== to) return null;
        return { request: sealCommerceRequest(held), replayed: true };
      },
    );
  }

  /**
   * Run the operation; if it lost a race to a concurrent transaction, answer from what won.
   *
   * The recovery is a **read**, not a retry of the write. Retrying would run the operation twice
   * against a store that already holds the result, which for an append-only history means two rows
   * describing one thing. The recovery asks whether the winner is the same request converged on by
   * somebody else, and returns it when it is.
   */
  async #converge<T>(
    operation: (tx: CommerceRequestTransaction) => Promise<T>,
    recover: (tx: CommerceRequestTransaction) => Promise<T | null>,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(operation);
    } catch (error) {
      const conflicted =
        error instanceof CommerceRequestError &&
        (error.code === 'idempotency-key-reuse' ||
          error.code === 'duplicate-request-id' ||
          error.code === 'duplicate-interpretation-id' ||
          error.code === 'duplicate-media-id');
      if (!conflicted) throw error;

      const recovered = await this.#repository.withTransaction(recover);
      if (recovered === null) throw error;
      return recovered;
    }
  }
}

async function requireRequest(
  tx: CommerceRequestTransaction,
  requestId: string,
): Promise<CommerceRequest> {
  const held = await tx.findRequestById(requestId);
  if (held === null) {
    throw new CommerceRequestError('request-not-found', `no Need with id ${requestId}`);
  }
  return held;
}

/** Refuse an operation on a Need that has ended. */
function assertOpen(request: CommerceRequest, operation: string): void {
  if (REQUEST_TRANSITIONS[request.status].length === 0) {
    throw new CommerceRequestError(
      'request-closed',
      `${operation} refuses a Need that is ${request.status}. Interpreting a cancelled Need is ` +
        'work nobody asked for, and reinterpreting a fulfilled one would change what the order ' +
        'was placed against',
    );
  }
}

/**
 * Refuse a request carrying a field that belongs to another component.
 *
 * By name, with the owner said, because a caller sending `matchedListingId` on a Need is modelling
 * the thing wrongly rather than making a typo — and a message that only said "unexpected field"
 * would send them looking for the typo.
 */
function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new CommerceRequestError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new CommerceRequestError(
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
      throw new CommerceRequestError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Whether two Needs are the same request, for idempotency.
 *
 * **Neither `correlationId` nor an instant is compared.** A retry is a different request that means
 * the same thing: it arrives later and carries a fresh correlation id by definition. M-11, M-12,
 * M-13 and M-04 each shipped a version of this comparing one or both, and each had it corrected
 * after a client retrying a timed-out request was told it had reused its key — advice which, if
 * followed, creates a second record.
 */
function requestEquals(a: CommerceRequest, b: CommerceRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.accountId === b.accountId &&
    a.channel === b.channel &&
    a.rawText === b.rawText &&
    a.conversationId === b.conversationId &&
    a.neededBy === b.neededBy &&
    a.idempotencyKey === b.idempotencyKey
  );
}

function mediaEquals(a: RequestMedia, b: RequestMedia): boolean {
  return (
    a.mediaId === b.mediaId &&
    a.requestId === b.requestId &&
    a.kind === b.kind &&
    a.reference === b.reference &&
    a.position === b.position &&
    a.caption === b.caption &&
    a.idempotencyKey === b.idempotencyKey
  );
}
