/**
 * M-49 — the persistence port and its in-memory reference implementation.
 *
 * The commit-time checks are the interesting part, and each one stands for a race a real database
 * would refuse with a constraint: a second organisation on one account, a second membership for one
 * person in one organisation, and a reused idempotency key. The reference implementation refuses
 * exactly what PostgreSQL refuses, so a suite that passes here is not passing because it ran alone.
 *
 * Owned by: M-49 Organisations.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealMembership,
  sealMembershipEvents,
  sealMemberships,
  sealOrganisation,
  sealOrganisationEvents,
  sealOrganisations,
} from './immutable.ts';
import {
  OrganisationError,
  type MembershipEvent,
  type Organisation,
  type OrganisationEvent,
  type OrganisationMembership,
} from './types.ts';

export interface OrganisationTransaction extends OutboxTransaction {
  findOrganisationById(organisationId: string): Promise<Organisation | null>;
  findOrganisationByAccountId(accountId: string): Promise<Organisation | null>;
  findOrganisationByIdempotencyKey(idempotencyKey: string): Promise<Organisation | null>;
  insertOrganisation(organisation: Organisation): Promise<void>;
  updateOrganisation(organisation: Organisation): Promise<void>;

  findMembershipById(membershipId: string): Promise<OrganisationMembership | null>;
  /** One person, one organisation, one membership — whatever its status. */
  findMembership(
    organisationId: string,
    personSubjectId: string,
  ): Promise<OrganisationMembership | null>;
  findMembershipByIdempotencyKey(idempotencyKey: string): Promise<OrganisationMembership | null>;
  findMembershipsForOrganisation(
    organisationId: string,
  ): Promise<readonly OrganisationMembership[]>;
  findMembershipsForPerson(personSubjectId: string): Promise<readonly OrganisationMembership[]>;
  insertMembership(membership: OrganisationMembership): Promise<void>;
  updateMembership(membership: OrganisationMembership): Promise<void>;

  findMembershipEvents(membershipId: string): Promise<readonly MembershipEvent[]>;
  insertMembershipEvent(event: MembershipEvent): Promise<void>;

  findOrganisationEvents(organisationId: string): Promise<readonly OrganisationEvent[]>;
  insertOrganisationEvent(event: OrganisationEvent): Promise<void>;
}

export interface OrganisationRepository {
  withTransaction<T>(body: (tx: OrganisationTransaction) => Promise<T>): Promise<T>;
}

interface Store {
  organisations: Organisation[];
  memberships: OrganisationMembership[];
  membershipEvents: MembershipEvent[];
  organisationEvents: OrganisationEvent[];
}

export class InMemoryOrganisationRepository implements OrganisationRepository {
  #store: Store = {
    organisations: [],
    memberships: [],
    membershipEvents: [],
    organisationEvents: [],
  };
  readonly #outbox = new InMemoryOutboxStore('M-49', 'module_organisations');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  organisations(): readonly Organisation[] {
    return sealOrganisations(this.#store.organisations);
  }

  memberships(): readonly OrganisationMembership[] {
    return sealMemberships(this.#store.memberships);
  }

  membershipEvents(): readonly MembershipEvent[] {
    return sealMembershipEvents(this.#store.membershipEvents);
  }

  organisationEvents(): readonly OrganisationEvent[] {
    return sealOrganisationEvents(this.#store.organisationEvents);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  seed(state: Partial<Store> & { readonly outbox?: readonly OutboxEntry[] }): void {
    this.#store = {
      organisations: (state.organisations ?? []).map(sealOrganisation),
      memberships: (state.memberships ?? []).map(sealMembership),
      membershipEvents: [...(state.membershipEvents ?? [])],
      organisationEvents: [...(state.organisationEvents ?? [])],
    };
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: OrganisationTransaction) => Promise<T>): Promise<T> {
    const working: Store = {
      organisations: this.#store.organisations.map(sealOrganisation),
      memberships: this.#store.memberships.map(sealMembership),
      membershipEvents: [...this.#store.membershipEvents],
      organisationEvents: [...this.#store.organisationEvents],
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const createdOrganisations = new Set<string>();
    const createdMemberships = new Set<string>();
    const tx = new InMemoryOrganisationTransaction(
      working,
      outboxWorking,
      createdOrganisations,
      createdMemberships,
    );

    try {
      const result = await body(tx);

      // Checked against the **committed** store, because that is what a concurrent transaction
      // would have written into. The snapshot this one read is precisely what it would not have
      // been in.
      for (const organisation of working.organisations) {
        if (!createdOrganisations.has(organisation.organisationId)) continue;
        if (
          this.#store.organisations.some(
            (held) => held.organisationId === organisation.organisationId,
          )
        ) {
          throw new OrganisationError(
            'duplicate-organisation-id',
            `organisation ${organisation.organisationId} was created by another transaction`,
          );
        }
        if (this.#store.organisations.some((held) => held.accountId === organisation.accountId)) {
          throw new OrganisationError(
            'account-already-organisation',
            `account ${organisation.accountId} already trades as an organisation. One account, ` +
              'one business: two would be two sets of books nobody could tell apart',
          );
        }
        if (
          this.#store.organisations.some(
            (held) => held.idempotencyKey === organisation.idempotencyKey,
          )
        ) {
          throw new OrganisationError(
            'idempotency-key-reuse',
            `idempotency key "${organisation.idempotencyKey}" was used by an organisation created ` +
              'while this transaction was open',
          );
        }
      }

      for (const membership of working.memberships) {
        if (!createdMemberships.has(membership.membershipId)) continue;
        if (this.#store.memberships.some((held) => held.membershipId === membership.membershipId)) {
          throw new OrganisationError(
            'duplicate-membership-id',
            `membership ${membership.membershipId} was created by another transaction`,
          );
        }
        if (
          this.#store.memberships.some(
            (held) =>
              held.organisationId === membership.organisationId &&
              held.personSubjectId === membership.personSubjectId,
          )
        ) {
          throw new OrganisationError(
            'already-a-member',
            'that person was given a place in this organisation by another transaction while this ' +
              'one was open. One person holds one membership per business, so that two people ' +
              'cannot be given different authority under the same name',
          );
        }
        if (
          this.#store.memberships.some((held) => held.idempotencyKey === membership.idempotencyKey)
        ) {
          throw new OrganisationError(
            'idempotency-key-reuse',
            `idempotency key "${membership.idempotencyKey}" was used by a membership created while ` +
              'this transaction was open',
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

class InMemoryOrganisationTransaction implements OrganisationTransaction {
  readonly #store: Store;
  readonly #outbox: InMemoryOutboxStore;
  readonly #createdOrganisations: Set<string>;
  readonly #createdMemberships: Set<string>;

  constructor(
    store: Store,
    outbox: InMemoryOutboxStore,
    createdOrganisations: Set<string>,
    createdMemberships: Set<string>,
  ) {
    this.#store = store;
    this.#outbox = outbox;
    this.#createdOrganisations = createdOrganisations;
    this.#createdMemberships = createdMemberships;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findOrganisationById(organisationId: string): Promise<Organisation | null> {
    return Promise.resolve(
      this.#store.organisations.find((one) => one.organisationId === organisationId) ?? null,
    );
  }

  findOrganisationByAccountId(accountId: string): Promise<Organisation | null> {
    return Promise.resolve(
      this.#store.organisations.find((one) => one.accountId === accountId) ?? null,
    );
  }

  findOrganisationByIdempotencyKey(idempotencyKey: string): Promise<Organisation | null> {
    return Promise.resolve(
      this.#store.organisations.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  insertOrganisation(organisation: Organisation): Promise<void> {
    if (this.#store.organisations.some((one) => one.organisationId === organisation.organisationId))
      throw new OrganisationError(
        'duplicate-organisation-id',
        `organisation ${organisation.organisationId} already exists`,
      );
    if (this.#store.organisations.some((one) => one.accountId === organisation.accountId))
      throw new OrganisationError(
        'account-already-organisation',
        `account ${organisation.accountId} already trades as an organisation`,
      );
    if (this.#store.organisations.some((one) => one.idempotencyKey === organisation.idempotencyKey))
      throw new OrganisationError(
        'idempotency-key-reuse',
        `idempotency key "${organisation.idempotencyKey}" already created an organisation`,
      );

    this.#store.organisations.push(sealOrganisation(organisation));
    this.#createdOrganisations.add(organisation.organisationId);
    return Promise.resolve();
  }

  updateOrganisation(organisation: Organisation): Promise<void> {
    const index = this.#store.organisations.findIndex(
      (one) => one.organisationId === organisation.organisationId,
    );
    if (index === -1) {
      throw new OrganisationError(
        'organisation-not-found',
        `organisation ${organisation.organisationId} does not exist`,
      );
    }
    this.#store.organisations[index] = sealOrganisation(organisation);
    return Promise.resolve();
  }

  findMembershipById(membershipId: string): Promise<OrganisationMembership | null> {
    return Promise.resolve(
      this.#store.memberships.find((one) => one.membershipId === membershipId) ?? null,
    );
  }

  findMembership(
    organisationId: string,
    personSubjectId: string,
  ): Promise<OrganisationMembership | null> {
    return Promise.resolve(
      this.#store.memberships.find(
        (one) => one.organisationId === organisationId && one.personSubjectId === personSubjectId,
      ) ?? null,
    );
  }

  findMembershipByIdempotencyKey(idempotencyKey: string): Promise<OrganisationMembership | null> {
    return Promise.resolve(
      this.#store.memberships.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  findMembershipsForOrganisation(
    organisationId: string,
  ): Promise<readonly OrganisationMembership[]> {
    return Promise.resolve(
      sealMemberships(
        this.#store.memberships.filter((one) => one.organisationId === organisationId),
      ),
    );
  }

  findMembershipsForPerson(personSubjectId: string): Promise<readonly OrganisationMembership[]> {
    return Promise.resolve(
      sealMemberships(
        this.#store.memberships.filter((one) => one.personSubjectId === personSubjectId),
      ),
    );
  }

  insertMembership(membership: OrganisationMembership): Promise<void> {
    if (this.#store.memberships.some((one) => one.membershipId === membership.membershipId))
      throw new OrganisationError(
        'duplicate-membership-id',
        `membership ${membership.membershipId} already exists`,
      );
    if (
      this.#store.memberships.some(
        (one) =>
          one.organisationId === membership.organisationId &&
          one.personSubjectId === membership.personSubjectId,
      )
    )
      throw new OrganisationError(
        'already-a-member',
        'that person already holds a place in this organisation',
      );
    if (this.#store.memberships.some((one) => one.idempotencyKey === membership.idempotencyKey))
      throw new OrganisationError(
        'idempotency-key-reuse',
        `idempotency key "${membership.idempotencyKey}" already created a membership`,
      );

    this.#store.memberships.push(sealMembership(membership));
    this.#createdMemberships.add(membership.membershipId);
    return Promise.resolve();
  }

  updateMembership(membership: OrganisationMembership): Promise<void> {
    const index = this.#store.memberships.findIndex(
      (one) => one.membershipId === membership.membershipId,
    );
    if (index === -1) {
      throw new OrganisationError(
        'membership-not-found',
        `membership ${membership.membershipId} does not exist`,
      );
    }
    this.#store.memberships[index] = sealMembership(membership);
    return Promise.resolve();
  }

  findMembershipEvents(membershipId: string): Promise<readonly MembershipEvent[]> {
    return Promise.resolve(
      sealMembershipEvents(
        this.#store.membershipEvents.filter((one) => one.membershipId === membershipId),
      ),
    );
  }

  insertMembershipEvent(event: MembershipEvent): Promise<void> {
    if (this.#store.membershipEvents.some((one) => one.eventId === event.eventId)) {
      throw new OrganisationError(
        'malformed-record',
        `membership event ${event.eventId} already exists`,
      );
    }
    this.#store.membershipEvents.push(event);
    return Promise.resolve();
  }

  findOrganisationEvents(organisationId: string): Promise<readonly OrganisationEvent[]> {
    return Promise.resolve(
      sealOrganisationEvents(
        this.#store.organisationEvents.filter((one) => one.organisationId === organisationId),
      ),
    );
  }

  insertOrganisationEvent(event: OrganisationEvent): Promise<void> {
    if (this.#store.organisationEvents.some((one) => one.eventId === event.eventId)) {
      throw new OrganisationError(
        'malformed-record',
        `organisation event ${event.eventId} already exists`,
      );
    }
    this.#store.organisationEvents.push(event);
    return Promise.resolve();
  }
}
