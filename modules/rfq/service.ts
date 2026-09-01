/**
 * M-09 RFQ — opening a tender, inviting the right people, and closing it once.
 *
 * The module that **executes** what M-07 decided. That separation is deliberate and is worth
 * restating: the ladder decides a Need cannot be solved without asking the market, and this module
 * does the asking. A matching engine that could open tenders would be two modules wearing one name,
 * and the half that opens tenders would be the half nobody reviewed.
 *
 * Three rules carry the service.
 *
 * **The specification is built by the caller and checked here.** M-03's raw text is never a
 * parameter of any method on this class — there is nowhere to pass it — and every string a supplier
 * will read is run past the private-text guard. The structural defence is that the specification has
 * no free-text field wide enough for a Need; the guard is what catches the accidental paste.
 *
 * **An invitation names a supplier and says why.** No method invites "everybody in a category":
 * deciding who to ask is the ladder's work, and throwing it away here would make the ladder
 * pointless.
 *
 * **A tender closes once.** An award cannot be made twice, a cancelled tender cannot be reopened,
 * and neither can happen after the other. Each of those is somebody's money or somebody's afternoon.
 *
 * Owned by: M-09 RFQ.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { sealInvitation, sealInvitations, sealRfq, sealRfqEvents, sealRfqs } from './immutable.ts';
import {
  makeInvitationAction,
  makeInvitationEvent,
  makeRfqAction,
  makeRfqEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertRfqIdentifier } from './registry.ts';
import type { RfqRepository, RfqTransaction } from './repository.ts';
import {
  RFQ_TRANSITIONS,
  RfqError,
  type Rfq,
  type RfqEvent,
  type RfqInvitation,
  type RfqSpecification,
  type RfqStatus,
} from './types.ts';
import { validateInvitation, validateRfq, validateRfqEvent } from './validate.ts';

export interface OpenRfqRequest {
  readonly rfqId: string;
  readonly requestId: string;
  readonly accountId: string;
  /** The M-07 run that justified this. Null only when a buyer opened a tender directly. */
  readonly matchRunId?: string | null;
  readonly visibility: string;
  /** Already structured. There is deliberately no parameter through which prose could arrive. */
  readonly specification: unknown;
  readonly closesAt: string;
  readonly openedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface OpenRfqResult {
  readonly rfq: Rfq;
  readonly replayed: boolean;
}

export interface InviteSupplierRequest {
  readonly invitationId: string;
  readonly rfqId: string;
  readonly supplierAccountId: string;
  readonly sourceRung?: string | null;
  readonly reason: string;
  readonly scorePerMille?: number | null;
  readonly invitedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface InviteSupplierResult {
  readonly invitation: RfqInvitation;
  readonly replayed: boolean;
}

export interface CloseRfqRequest {
  readonly rfqId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface AwardRfqRequest extends CloseRfqRequest {
  /** The M-10 quote that won. Opaque: M-10 owns it and this module never reads one. */
  readonly quoteId: string;
}

export interface RfqTransitionResult {
  readonly rfq: Rfq;
  readonly replayed: boolean;
}

const OPEN_KEYS: readonly string[] = [
  'rfqId',
  'requestId',
  'accountId',
  'matchRunId',
  'visibility',
  'specification',
  'closesAt',
  'openedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const INVITE_KEYS: readonly string[] = [
  'invitationId',
  'rfqId',
  'supplierAccountId',
  'sourceRung',
  'reason',
  'scorePerMille',
  'invitedAt',
  'correlationId',
  'idempotencyKey',
];

const CLOSE_KEYS: readonly string[] = [
  'rfqId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const AWARD_KEYS: readonly string[] = [...CLOSE_KEYS, 'quoteId'];

export class RfqService {
  readonly #repository: RfqRepository;

  constructor(repository: RfqRepository) {
    this.#repository = repository;
  }

  /** Open a tender. */
  async openRfq(request: OpenRfqRequest): Promise<OpenRfqResult> {
    assertNoForeignConcerns(request, OPEN_KEYS, 'openRfq');

    const candidate = validateRfq(
      {
        rfqId: request.rfqId,
        requestId: request.requestId,
        accountId: request.accountId,
        matchRunId: request.matchRunId ?? null,
        status: 'open' as RfqStatus,
        visibility: request.visibility,
        specification: request.specification,
        closesAt: request.closesAt,
        openedAt: request.openedAt,
        updatedAt: request.openedAt,
        closedAt: null,
        awardedQuoteId: null,
        closureReason: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    // A tender that closes before it opens is not a tender; it is a form nobody could fill in.
    if (
      parseInstant(candidate.closesAt).epochMicros <= parseInstant(candidate.openedAt).epochMicros
    ) {
      throw new RfqError(
        'malformed-record',
        'an RFQ must close after it opens. A window nobody could quote in is worse than no ' +
          'tender at all, because suppliers see it and learn the platform wastes their time',
      );
    }

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findRfqByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) return { rfq: sealRfq(byKey), replayed: true };

        await tx.insertRfq(candidate);
        await tx.insertEvent(
          validateRfqEvent(
            {
              eventId: request.eventId,
              rfqId: candidate.rfqId,
              fromStatus: null,
              toStatus: 'open',
              reason: 'the sourcing ladder could not solve this Need without asking the market',
              occurredAt: candidate.openedAt,
              correlationId: candidate.correlationId,
              idempotencyKey: candidate.idempotencyKey,
            },
            'request',
          ),
        );
        await tx.insertOutbox(makeRfqEvent(candidate, request.eventId, 0));
        await tx.insertOutbox(makeRfqAction(candidate, request.eventId, 0));
        return { rfq: sealRfq(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findRfqByIdempotencyKey(candidate.idempotencyKey);
        return byKey === null ? null : { rfq: sealRfq(byKey), replayed: true };
      },
    );
  }

  /**
   * Ask one named supplier to quote.
   *
   * One at a time, and each with its own reason. There is deliberately no "invite everybody in the
   * category": that decision belongs to the sourcing ladder, which has already made it on evidence,
   * and a bulk method here would be the shortcut somebody reaches for when the ladder is
   * inconvenient.
   */
  async inviteSupplier(request: InviteSupplierRequest): Promise<InviteSupplierResult> {
    assertNoForeignConcerns(request, INVITE_KEYS, 'inviteSupplier');

    const candidate = validateInvitation(
      {
        invitationId: request.invitationId,
        rfqId: request.rfqId,
        supplierAccountId: request.supplierAccountId,
        sourceRung: request.sourceRung ?? null,
        reason: request.reason,
        scorePerMille: request.scorePerMille ?? null,
        invitedAt: request.invitedAt,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    return this.#converge(
      async (tx) => {
        const rfq = await requireRfq(tx, candidate.rfqId);

        // Inviting somebody to a tender that has closed wastes their time and cannot lead to an
        // offer, because an offer after closing is refused.
        if (rfq.status !== 'open') {
          throw new RfqError(
            'rfq-closed',
            `RFQ ${rfq.rfqId} is ${rfq.status}. Inviting a supplier to a tender they cannot quote ` +
              'for is how a platform teaches people to ignore it',
          );
        }

        const held = await tx.findInvitationsByRfqId(candidate.rfqId);
        const already = held.find((one) => one.supplierAccountId === candidate.supplierAccountId);
        if (already !== undefined) {
          return { invitation: sealInvitation(already), replayed: true };
        }

        await tx.insertInvitation(candidate);
        await tx.insertOutbox(makeInvitationEvent(candidate));
        await tx.insertOutbox(makeInvitationAction(candidate, rfq.accountId));
        return { invitation: sealInvitation(candidate), replayed: false };
      },
      async (tx) => {
        const held = await tx.findInvitationsByRfqId(candidate.rfqId);
        const already = held.find((one) => one.supplierAccountId === candidate.supplierAccountId);
        return already === null || already === undefined
          ? null
          : { invitation: sealInvitation(already), replayed: true };
      },
    );
  }

  /** End the quoting window. Offers already made stand. */
  closeRfq(request: CloseRfqRequest): Promise<RfqTransitionResult> {
    return this.#transition(request, 'closed', null, 'closeRfq', CLOSE_KEYS);
  }

  /** Choose the winning offer. Terminal. */
  awardRfq(request: AwardRfqRequest): Promise<RfqTransitionResult> {
    assertRfqIdentifier(request.quoteId, 'quoteId');
    return this.#transition(request, 'awarded', request.quoteId, 'awardRfq', AWARD_KEYS);
  }

  /**
   * Withdraw the tender.
   *
   * Distinct from closing, and suppliers who quoted are owed the difference: "somebody else won" and
   * "it is not happening" are different outcomes, and a supplier who cannot tell them apart cannot
   * tell whether quoting here is worth their time.
   */
  cancelRfq(request: CloseRfqRequest): Promise<RfqTransitionResult> {
    return this.#transition(request, 'cancelled', null, 'cancelRfq', CLOSE_KEYS);
  }

  async getRfq(rfqId: string): Promise<Rfq | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findRfqById(rfqId));
    return held === null ? null : sealRfq(held);
  }

  async listRfqsForAccount(accountId: string): Promise<readonly Rfq[]> {
    return sealRfqs(
      await this.#repository.withTransaction((tx) => tx.findRfqsForAccount(accountId)),
    );
  }

  async listRfqsForRequest(requestId: string): Promise<readonly Rfq[]> {
    return sealRfqs(
      await this.#repository.withTransaction((tx) => tx.findRfqsForRequest(requestId)),
    );
  }

  async listInvitations(rfqId: string): Promise<readonly RfqInvitation[]> {
    return sealInvitations(
      await this.#repository.withTransaction((tx) => tx.findInvitationsByRfqId(rfqId)),
    );
  }

  /** The tenders one supplier has been asked to quote for. Their inbox. */
  async listInvitationsForSupplier(supplierAccountId: string): Promise<readonly RfqInvitation[]> {
    return sealInvitations(
      await this.#repository.withTransaction((tx) =>
        tx.findInvitationsForSupplier(supplierAccountId),
      ),
    );
  }

  /** Whether this supplier may see and quote for this tender. */
  async isInvited(rfqId: string, supplierAccountId: string): Promise<boolean> {
    const held = await this.#repository.withTransaction((tx) => tx.findInvitationsByRfqId(rfqId));
    return held.some((one) => one.supplierAccountId === supplierAccountId);
  }

  async listHistory(rfqId: string): Promise<readonly RfqEvent[]> {
    return sealRfqEvents(
      await this.#repository.withTransaction((tx) => tx.findEventsByRfqId(rfqId)),
    );
  }

  async #transition(
    request: CloseRfqRequest,
    to: RfqStatus,
    awardedQuoteId: string | null,
    operation: string,
    permitted: readonly string[],
  ): Promise<RfqTransitionResult> {
    assertNoForeignConcerns(request, permitted, operation);
    assertRfqIdentifier(request.eventId, 'eventId');
    assertInstant(request.occurredAt, 'occurredAt');

    return this.#converge(
      async (tx) => {
        const before = await requireRfq(tx, request.rfqId);

        // A repeat of a move already made is the answer, not a refusal: a caller retrying a
        // cancellation it is unsure landed must not be told the tender is already cancelled as
        // though that were a problem.
        //
        // **Except when the repeat would name a different winner.** Awarding an already-awarded
        // tender to somebody else is not a retry, it is a second decision — and the losing
        // suppliers have already been told. Treating it as idempotent would let the winner change
        // silently after everybody was informed, which is the one thing an award must not do.
        if (before.status === to) {
          if (to === 'awarded' && before.awardedQuoteId !== awardedQuoteId) {
            throw new RfqError(
              'illegal-transition',
              `RFQ ${before.rfqId} was already awarded to quote ${String(before.awardedQuoteId)}. ` +
                'Awarding it again to a different offer is a second decision, not a retry, and the ' +
                'suppliers who lost have already been told',
            );
          }
          return { rfq: sealRfq(before), replayed: true };
        }

        const allowed = RFQ_TRANSITIONS[before.status];
        if (!allowed.includes(to)) {
          throw new RfqError(
            allowed.length === 0 ? 'rfq-closed' : 'illegal-transition',
            `an RFQ that is ${before.status} cannot become ${to}` +
              (allowed.length === 0
                ? '. It has ended, and suppliers have been told; reopening it would make that a lie'
                : `; from ${before.status} it may become ${allowed.join(', ')}`),
          );
        }

        const terminal = RFQ_TRANSITIONS[to].length === 0;
        const after = validateRfq(
          {
            ...before,
            status: to,
            updatedAt: request.occurredAt,
            closedAt: request.occurredAt,
            closureReason: request.reason,
            awardedQuoteId,
          },
          'request',
        );
        void terminal;

        await tx.updateRfq(after);
        await tx.insertEvent(
          validateRfqEvent(
            {
              eventId: request.eventId,
              rfqId: after.rfqId,
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

        const invited = await tx.findInvitationsByRfqId(after.rfqId);
        await tx.insertOutbox(makeRfqEvent(after, request.eventId, invited.length));
        await tx.insertOutbox(makeRfqAction(after, request.eventId, invited.length));

        return { rfq: sealRfq(after), replayed: false };
      },
      async (tx) => {
        const held = await tx.findRfqById(request.rfqId);
        if (held === null || held.status !== to) return null;
        return { rfq: sealRfq(held), replayed: true };
      },
    );
  }

  async #converge<T>(
    operation: (tx: RfqTransaction) => Promise<T>,
    recover: (tx: RfqTransaction) => Promise<T | null>,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(operation);
    } catch (error) {
      const conflicted =
        error instanceof RfqError &&
        (error.code === 'idempotency-key-reuse' ||
          error.code === 'duplicate-rfq-id' ||
          error.code === 'duplicate-invitation');
      if (!conflicted) throw error;

      const recovered = await this.#repository.withTransaction(recover);
      if (recovered === null) throw error;
      return recovered;
    }
  }
}

async function requireRfq(tx: RfqTransaction, rfqId: string): Promise<Rfq> {
  const held = await tx.findRfqById(rfqId);
  if (held === null) throw new RfqError('rfq-not-found', `no RFQ with id ${rfqId}`);
  return held;
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new RfqError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new RfqError(
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
      throw new RfqError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

export type { RfqSpecification };
