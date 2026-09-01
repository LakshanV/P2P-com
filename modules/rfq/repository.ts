/**
 * M-09 RFQ — the persistence port and its in-memory reference implementation.
 *
 * Owned by: M-09 RFQ.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealInvitation,
  sealInvitations,
  sealRfq,
  sealRfqEvent,
  sealRfqEvents,
  sealRfqs,
} from './immutable.ts';
import { RfqError, type Rfq, type RfqEvent, type RfqInvitation } from './types.ts';

export interface RfqTransaction extends OutboxTransaction {
  findRfqById(rfqId: string): Promise<Rfq | null>;
  findRfqByIdempotencyKey(idempotencyKey: string): Promise<Rfq | null>;
  findRfqsForAccount(accountId: string): Promise<readonly Rfq[]>;
  findRfqsForRequest(requestId: string): Promise<readonly Rfq[]>;
  insertRfq(rfq: Rfq): Promise<void>;
  updateRfq(rfq: Rfq): Promise<void>;

  findInvitationsByRfqId(rfqId: string): Promise<readonly RfqInvitation[]>;
  /** Every open tender a supplier has been invited to. The supplier's inbox. */
  findInvitationsForSupplier(supplierAccountId: string): Promise<readonly RfqInvitation[]>;
  insertInvitation(invitation: RfqInvitation): Promise<void>;

  findEventsByRfqId(rfqId: string): Promise<readonly RfqEvent[]>;
  insertEvent(event: RfqEvent): Promise<void>;
}

export interface RfqRepository {
  withTransaction<T>(body: (tx: RfqTransaction) => Promise<T>): Promise<T>;
}

interface Store {
  rfqs: Rfq[];
  invitations: RfqInvitation[];
  events: RfqEvent[];
}

export class InMemoryRfqRepository implements RfqRepository {
  #store: Store = { rfqs: [], invitations: [], events: [] };
  readonly #outbox = new InMemoryOutboxStore('M-09', 'module_rfq');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  rfqs(): readonly Rfq[] {
    return sealRfqs(this.#store.rfqs);
  }

  invitations(): readonly RfqInvitation[] {
    return sealInvitations(this.#store.invitations);
  }

  events(): readonly RfqEvent[] {
    return sealRfqEvents(this.#store.events);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  seed(state: {
    readonly rfqs?: readonly Rfq[];
    readonly invitations?: readonly RfqInvitation[];
    readonly events?: readonly RfqEvent[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#store = {
      rfqs: (state.rfqs ?? []).map(sealRfq),
      invitations: (state.invitations ?? []).map(sealInvitation),
      events: (state.events ?? []).map(sealRfqEvent),
    };
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: RfqTransaction) => Promise<T>): Promise<T> {
    const working: Store = {
      rfqs: this.#store.rfqs.map(sealRfq),
      invitations: this.#store.invitations.map(sealInvitation),
      events: this.#store.events.map(sealRfqEvent),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const created = new Set<string>();
    const tx = new InMemoryRfqTransaction(working, outboxWorking, created);

    try {
      const result = await body(tx);
      // Checked at commit against the committed store, because the snapshot this transaction read
      // is exactly what a concurrent transaction would not have been in.
      for (const rfq of working.rfqs) {
        if (!created.has(rfq.rfqId)) continue;
        if (this.#store.rfqs.some((held) => held.rfqId === rfq.rfqId)) {
          throw new RfqError(
            'duplicate-rfq-id',
            `RFQ ${rfq.rfqId} was created by another transaction while this one was open`,
          );
        }
        if (this.#store.rfqs.some((held) => held.idempotencyKey === rfq.idempotencyKey)) {
          throw new RfqError(
            'idempotency-key-reuse',
            `idempotency key "${rfq.idempotencyKey}" was used by an RFQ created while this ` +
              'transaction was open',
          );
        }
      }
      this.#store = working;
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }
}

class InMemoryRfqTransaction implements RfqTransaction {
  readonly #store: Store;
  readonly #outbox: InMemoryOutboxStore;
  readonly #created: Set<string>;

  constructor(store: Store, outbox: InMemoryOutboxStore, created: Set<string>) {
    this.#store = store;
    this.#outbox = outbox;
    this.#created = created;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findRfqById(rfqId: string): Promise<Rfq | null> {
    return Promise.resolve(this.#store.rfqs.find((one) => one.rfqId === rfqId) ?? null);
  }

  findRfqByIdempotencyKey(idempotencyKey: string): Promise<Rfq | null> {
    return Promise.resolve(
      this.#store.rfqs.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findRfqsForAccount(accountId: string): Promise<readonly Rfq[]> {
    return Promise.resolve(
      sealRfqs(
        this.#store.rfqs
          .filter((one) => one.accountId === accountId)
          .sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
      ),
    );
  }

  findRfqsForRequest(requestId: string): Promise<readonly Rfq[]> {
    return Promise.resolve(
      sealRfqs(
        this.#store.rfqs
          .filter((one) => one.requestId === requestId)
          .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
      ),
    );
  }

  insertRfq(rfq: Rfq): Promise<void> {
    if (this.#store.rfqs.some((one) => one.rfqId === rfq.rfqId)) {
      return Promise.reject(new RfqError('duplicate-rfq-id', `RFQ ${rfq.rfqId} already exists`));
    }
    if (this.#store.rfqs.some((one) => one.idempotencyKey === rfq.idempotencyKey)) {
      return Promise.reject(
        new RfqError(
          'idempotency-key-reuse',
          `idempotency key "${rfq.idempotencyKey}" already belongs to another RFQ`,
        ),
      );
    }
    this.#store.rfqs.push(sealRfq(rfq));
    this.#created.add(rfq.rfqId);
    return Promise.resolve();
  }

  updateRfq(rfq: Rfq): Promise<void> {
    const index = this.#store.rfqs.findIndex((one) => one.rfqId === rfq.rfqId);
    if (index < 0) {
      return Promise.reject(new RfqError('rfq-not-found', `RFQ ${rfq.rfqId} does not exist`));
    }
    this.#store.rfqs[index] = sealRfq(rfq);
    return Promise.resolve();
  }

  findInvitationsByRfqId(rfqId: string): Promise<readonly RfqInvitation[]> {
    return Promise.resolve(
      sealInvitations(
        this.#store.invitations
          .filter((one) => one.rfqId === rfqId)
          .sort((a, b) => (b.scorePerMille ?? 0) - (a.scorePerMille ?? 0)),
      ),
    );
  }

  findInvitationsForSupplier(supplierAccountId: string): Promise<readonly RfqInvitation[]> {
    return Promise.resolve(
      sealInvitations(
        this.#store.invitations
          .filter((one) => one.supplierAccountId === supplierAccountId)
          .sort((a, b) => b.invitedAt.localeCompare(a.invitedAt)),
      ),
    );
  }

  insertInvitation(invitation: RfqInvitation): Promise<void> {
    // One invitation per supplier per tender. Inviting somebody twice is not a second invitation,
    // it is a duplicate email — and a platform that sends those is one people filter out.
    if (
      this.#store.invitations.some(
        (one) =>
          one.rfqId === invitation.rfqId && one.supplierAccountId === invitation.supplierAccountId,
      )
    ) {
      return Promise.reject(
        new RfqError(
          'duplicate-invitation',
          `supplier ${invitation.supplierAccountId} has already been invited to ${invitation.rfqId}`,
        ),
      );
    }
    this.#store.invitations.push(sealInvitation(invitation));
    return Promise.resolve();
  }

  findEventsByRfqId(rfqId: string): Promise<readonly RfqEvent[]> {
    return Promise.resolve(
      sealRfqEvents(
        this.#store.events
          .filter((one) => one.rfqId === rfqId)
          .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
      ),
    );
  }

  insertEvent(event: RfqEvent): Promise<void> {
    // A replayed transition writes the same row, and the log records what happened rather than how
    // many times somebody asked.
    if (this.#store.events.some((one) => one.eventId === event.eventId)) return Promise.resolve();
    this.#store.events.push(sealRfqEvent(event));
    return Promise.resolve();
  }
}
