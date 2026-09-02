/**
 * M-48 — registering a trading party, and saying what they can do.
 *
 * **One account, one entry.** A party trades under a single directory record, enforced by a UNIQUE
 * and by this service. Two entries for one account would make "who supplies this" ambiguous for the
 * same party, and a buyer receiving two invitations from the same business is a platform that looks
 * like it does not know who its suppliers are.
 *
 * **Registration is not activation.** A new entry is `pending` and the sourcing rungs do not see it.
 * Somebody — a person, a verification step, a policy — has to open it. A platform where signing up
 * put you straight into the market would be one where the first tender goes to whoever registered
 * fastest.
 *
 * **Declaring a facet twice moves the row rather than adding one.** A supplier who withdraws a
 * category and later declares it again has one row with a history, not two rows disagreeing. That is
 * the same shape M-01 uses for capabilities, and for the same reason: a dispute about an order
 * placed in March is judged against what they said in March.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  sealDirectoryEvents,
  sealEntry,
  sealFacet,
  sealFacets,
  sealLocation,
  sealLocations,
  sealProfile,
} from './immutable.ts';
import { makeDirectoryAction, makeDirectoryEvent } from './outbox.ts';
import {
  FOREIGN_FIELDS,
  assertCapacity,
  assertCode,
  assertDirectoryIdentifier,
  assertFacetKind,
  assertReason,
} from './registry.ts';
import type { DirectoryRepository, DirectoryTransaction } from './repository.ts';
import {
  DIRECTORY_TRANSITIONS,
  DirectoryError,
  type DirectoryEntry,
  type DirectoryEvent,
  type DirectoryProfile,
  type DirectoryQuery,
  type DirectoryStatus,
  type SupplierFacet,
  type SupplierLocation,
} from './types.ts';
import {
  validateDirectoryEvent,
  validateEntry,
  validateFacet,
  validateLocation,
} from './validate.ts';

export interface RegisterRequest {
  readonly supplierId: string;
  readonly accountId: string;
  readonly kind: string;
  readonly displayName: string;
  readonly registeredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for the registration transition. */
  readonly eventId: string;
}

export interface EntryResult {
  readonly entry: DirectoryEntry;
  readonly replayed: boolean;
}

export interface TransitionRequest {
  readonly supplierId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface AvailabilityRequest {
  readonly supplierId: string;
  readonly acceptsOrders: boolean;
  readonly dailyCapacity?: unknown;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface DeclareFacetRequest {
  readonly facetId: string;
  readonly supplierId: string;
  readonly kind: string;
  readonly value: string;
  readonly declaredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface FacetResult {
  readonly facet: SupplierFacet;
  readonly replayed: boolean;
}

export interface WithdrawFacetRequest {
  readonly supplierId: string;
  readonly kind: string;
  readonly value: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AddLocationRequest {
  readonly locationId: string;
  readonly supplierId: string;
  readonly name: string;
  readonly district: string;
  readonly primary?: boolean;
  readonly openedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface LocationResult {
  readonly location: SupplierLocation;
  readonly replayed: boolean;
}

export interface CloseLocationRequest {
  readonly locationId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

const REGISTER_KEYS: readonly string[] = [
  'supplierId',
  'accountId',
  'kind',
  'displayName',
  'registeredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const TRANSITION_KEYS: readonly string[] = [
  'supplierId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const AVAILABILITY_KEYS: readonly string[] = [
  'supplierId',
  'acceptsOrders',
  'dailyCapacity',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const DECLARE_KEYS: readonly string[] = [
  'facetId',
  'supplierId',
  'kind',
  'value',
  'declaredAt',
  'correlationId',
  'idempotencyKey',
];

const WITHDRAW_KEYS: readonly string[] = [
  'supplierId',
  'kind',
  'value',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

const LOCATION_KEYS: readonly string[] = [
  'locationId',
  'supplierId',
  'name',
  'district',
  'primary',
  'openedAt',
  'correlationId',
  'idempotencyKey',
];

const CLOSE_LOCATION_KEYS: readonly string[] = [
  'locationId',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
];

export class DirectoryService {
  readonly #repository: DirectoryRepository;

  constructor(repository: DirectoryRepository) {
    this.#repository = repository;
  }

  /** Register a party to trade. They start `pending`, and the rungs do not see them. */
  async registerSupplier(request: RegisterRequest): Promise<EntryResult> {
    assertNoForeignConcerns(request, REGISTER_KEYS, 'registerSupplier');

    const candidate = validateEntry(
      {
        supplierId: request.supplierId,
        accountId: request.accountId,
        kind: request.kind,
        displayName: request.displayName,
        status: 'pending' as DirectoryStatus,
        // Registered and not yet open. Both halves are false until somebody decides otherwise.
        acceptsOrders: false,
        dailyCapacity: null,
        registeredAt: request.registeredAt,
        updatedAt: request.registeredAt,
        closedAt: null,
        closureReason: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findEntryByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) {
          if (!entryEquals(byKey, candidate)) {
            throw new DirectoryError(
              'idempotency-key-reuse',
              `idempotency key "${candidate.idempotencyKey}" has already been used for a ` +
                'different registration',
            );
          }
          return { entry: sealEntry(byKey), replayed: true };
        }

        const byAccount = await tx.findEntryByAccountId(candidate.accountId);
        if (byAccount !== null) {
          throw new DirectoryError(
            'already-registered',
            `account ${candidate.accountId} already trades as ${byAccount.supplierId}. One ` +
              'account trades under one entry: a buyer receiving two invitations from the same ' +
              'business is a platform that does not know who its suppliers are',
          );
        }

        await tx.insertEntry(candidate);
        await tx.insertEvent(
          validateDirectoryEvent(
            {
              eventId: request.eventId,
              supplierId: candidate.supplierId,
              fromStatus: null,
              toStatus: 'pending',
              reason: 'registered to trade on the platform',
              occurredAt: candidate.registeredAt,
              correlationId: candidate.correlationId,
              idempotencyKey: candidate.idempotencyKey,
            },
            'request',
          ),
        );
        await tx.insertOutbox(makeDirectoryEvent(candidate, request.eventId));
        await tx.insertOutbox(
          makeDirectoryAction(candidate, 'registered to trade on the platform', request.eventId),
        );
        return { entry: sealEntry(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findEntryByIdempotencyKey(candidate.idempotencyKey);
        if (byKey === null || !entryEquals(byKey, candidate)) return null;
        return { entry: sealEntry(byKey), replayed: true };
      },
    );
  }

  /** Open for business. Until this, the sourcing rungs do not consider them. */
  activateSupplier(request: TransitionRequest): Promise<EntryResult> {
    return this.#transition(request, 'active');
  }

  /** Temporarily not open. Reversible, and distinct from closing. */
  suspendSupplier(request: TransitionRequest): Promise<EntryResult> {
    return this.#transition(request, 'suspended');
  }

  /** Stopped trading. Terminal, and the record stays: orders still name them. */
  closeSupplier(request: TransitionRequest): Promise<EntryResult> {
    return this.#transition(request, 'closed');
  }

  /**
   * Say whether they are open today, and how much they can take.
   *
   * Two facts rather than one, because "closed for the week" and "capacity zero" are different
   * answers to a buyer asking why they were not invited.
   */
  async setAvailability(request: AvailabilityRequest): Promise<EntryResult> {
    assertNoForeignConcerns(request, AVAILABILITY_KEYS, 'setAvailability');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');
    const capacity = assertCapacity(request.dailyCapacity, 'dailyCapacity');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireEntry(tx, request.supplierId);
      if (before.status === 'closed') {
        throw new DirectoryError(
          'supplier-closed',
          `supplier ${before.supplierId} has closed; its availability is not a thing that changes`,
        );
      }

      const after = validateEntry(
        {
          ...before,
          acceptsOrders: request.acceptsOrders,
          dailyCapacity: capacity,
          updatedAt: occurredAt,
        },
        'request',
      );
      await tx.updateEntry(after);
      return { entry: sealEntry(after), replayed: false };
    });
  }

  /**
   * Declare something the supplier can do.
   *
   * Declaring what they already have active converges. Declaring what they once withdrew moves that
   * row back, so the history is one row's story rather than two rows disagreeing.
   */
  async declareFacet(request: DeclareFacetRequest): Promise<FacetResult> {
    assertNoForeignConcerns(request, DECLARE_KEYS, 'declareFacet');
    const kind = assertFacetKind(request.kind, 'kind');
    const value = assertCode(request.value, 'value');
    const declaredAt = assertInstant(request.declaredAt, 'declaredAt');

    return this.#repository.withTransaction(async (tx) => {
      const entry = await requireEntry(tx, request.supplierId);
      if (entry.status === 'closed') {
        throw new DirectoryError(
          'supplier-closed',
          `supplier ${entry.supplierId} has closed and declares nothing further`,
        );
      }

      const held = await tx.findFacet(entry.supplierId, kind, value);
      if (held !== null) {
        if (held.status === 'active') return { facet: sealFacet(held), replayed: true };

        const revived = validateFacet(
          { ...held, status: 'active', declaredAt, withdrawnAt: null },
          'request',
        );
        await tx.updateFacet(revived);
        return { facet: sealFacet(revived), replayed: false };
      }

      const facet = validateFacet(
        {
          facetId: request.facetId,
          supplierId: entry.supplierId,
          kind,
          value,
          status: 'active',
          declaredAt,
          withdrawnAt: null,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      );
      await tx.insertFacet(facet);
      return { facet: sealFacet(facet), replayed: false };
    });
  }

  /** Stop claiming something. The row stays, so what they said in March is still readable. */
  async withdrawFacet(request: WithdrawFacetRequest): Promise<FacetResult> {
    assertNoForeignConcerns(request, WITHDRAW_KEYS, 'withdrawFacet');
    const kind = assertFacetKind(request.kind, 'kind');
    const value = assertCode(request.value, 'value');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const held = await tx.findFacet(request.supplierId, kind, value);
      if (held === null) {
        throw new DirectoryError(
          'facet-not-found',
          `supplier ${request.supplierId} has not declared ${kind} "${value}"`,
        );
      }
      if (held.status === 'withdrawn') return { facet: sealFacet(held), replayed: true };

      const withdrawn = validateFacet(
        { ...held, status: 'withdrawn', withdrawnAt: occurredAt },
        'request',
      );
      await tx.updateFacet(withdrawn);
      return { facet: sealFacet(withdrawn), replayed: false };
    });
  }

  /** Add a place they trade from, or a merchant's branch. */
  async addLocation(request: AddLocationRequest): Promise<LocationResult> {
    assertNoForeignConcerns(request, LOCATION_KEYS, 'addLocation');

    const location = validateLocation(
      {
        locationId: request.locationId,
        supplierId: request.supplierId,
        name: request.name,
        district: request.district,
        primary: request.primary ?? false,
        status: 'active',
        openedAt: request.openedAt,
        closedAt: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    return this.#repository.withTransaction(async (tx) => {
      const entry = await requireEntry(tx, location.supplierId);
      if (entry.status === 'closed') {
        throw new DirectoryError(
          'supplier-closed',
          `supplier ${entry.supplierId} has closed and opens no further locations`,
        );
      }

      const held = await tx.findLocationById(location.locationId);
      if (held !== null) return { location: sealLocation(held), replayed: true };

      await tx.insertLocation(location);
      return { location: sealLocation(location), replayed: false };
    });
  }

  /** Close a branch. The row stays: an order fulfilled from it still names it. */
  async closeLocation(request: CloseLocationRequest): Promise<LocationResult> {
    assertNoForeignConcerns(request, CLOSE_LOCATION_KEYS, 'closeLocation');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const held = await tx.findLocationById(request.locationId);
      if (held === null) {
        throw new DirectoryError('location-not-found', `no location with id ${request.locationId}`);
      }
      if (held.status === 'withdrawn') return { location: sealLocation(held), replayed: true };

      const closed = validateLocation(
        { ...held, status: 'withdrawn', closedAt: occurredAt, primary: false },
        'request',
      );
      await tx.updateLocation(closed);
      return { location: sealLocation(closed), replayed: false };
    });
  }

  async getSupplier(supplierId: string): Promise<DirectoryEntry | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findEntryById(supplierId));
    return held === null ? null : sealEntry(held);
  }

  async getSupplierForAccount(accountId: string): Promise<DirectoryEntry | null> {
    const held = await this.#repository.withTransaction((tx) => tx.findEntryByAccountId(accountId));
    return held === null ? null : sealEntry(held);
  }

  async listFacets(supplierId: string): Promise<readonly SupplierFacet[]> {
    return sealFacets(
      await this.#repository.withTransaction((tx) => tx.findFacetsBySupplier(supplierId)),
    );
  }

  async listLocations(supplierId: string): Promise<readonly SupplierLocation[]> {
    return sealLocations(
      await this.#repository.withTransaction((tx) => tx.findLocationsBySupplier(supplierId)),
    );
  }

  async listHistory(supplierId: string): Promise<readonly DirectoryEvent[]> {
    return sealDirectoryEvents(
      await this.#repository.withTransaction((tx) => tx.findEventsBySupplier(supplierId)),
    );
  }

  /** One entry with everything it has declared. */
  async getProfile(supplierId: string): Promise<DirectoryProfile | null> {
    return this.#repository.withTransaction(async (tx) => {
      const entry = await tx.findEntryById(supplierId);
      if (entry === null) return null;
      const facets = await tx.findFacetsBySupplier(supplierId);
      const active = facets.filter((one) => one.status === 'active');
      const of = (kind: string): readonly string[] =>
        active.filter((one) => one.kind === kind).map((one) => one.value);
      return sealProfile({
        entry,
        categories: of('category'),
        brands: of('brand'),
        capabilities: of('capability'),
        districts: of('district'),
      });
    });
  }

  /**
   * The directory query the sourcing rungs run.
   *
   * **A query with no category is refused rather than answered.** Returning every supplier would be
   * a broadcast wearing a lookup's clothes, and a rung built on it would ask a cement supplier about
   * laptops — which is the single behaviour that teaches people to ignore a platform.
   */
  async findSuppliers(query: DirectoryQuery): Promise<readonly DirectoryProfile[]> {
    if (query.categories.length === 0) {
      throw new DirectoryError(
        'ungated-query',
        'a directory search names at least one category. A search with none returns every ' +
          'supplier, which is a broadcast rather than a lookup',
      );
    }
    for (const category of query.categories) assertCode(category, 'categories');
    for (const district of query.districts ?? []) assertCode(district, 'districts');

    return this.#repository.withTransaction((tx) => tx.findProfiles(query));
  }

  async #transition(request: TransitionRequest, to: DirectoryStatus): Promise<EntryResult> {
    assertNoForeignConcerns(request, TRANSITION_KEYS, `${to} transition`);
    const reason = assertReason(request.reason, 'reason');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireEntry(tx, request.supplierId);
      if (before.status === to) return { entry: sealEntry(before), replayed: true };

      const allowed = DIRECTORY_TRANSITIONS[before.status];
      if (!allowed.includes(to)) {
        throw new DirectoryError(
          allowed.length === 0 ? 'supplier-closed' : 'illegal-transition',
          `a ${before.status} entry cannot become ${to}` +
            (allowed.length === 0
              ? '. It has closed, and the orders it filled still name it'
              : `; from ${before.status} it may become ${allowed.join(', ')}`),
        );
      }

      const after = validateEntry(
        {
          ...before,
          status: to,
          // Closing shuts the door as well as ending the entry. A closed party that still says it
          // accepts orders is a contradiction a reader has to resolve for themselves.
          acceptsOrders: to === 'active' ? before.acceptsOrders : false,
          updatedAt: occurredAt,
          closedAt: to === 'closed' ? occurredAt : null,
          closureReason: to === 'closed' ? reason : null,
        },
        'request',
      );

      await tx.updateEntry(after);
      await tx.insertEvent(
        validateDirectoryEvent(
          {
            eventId: request.eventId,
            supplierId: after.supplierId,
            fromStatus: before.status,
            toStatus: to,
            reason,
            occurredAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );
      await tx.insertOutbox(makeDirectoryEvent(after, request.eventId));
      await tx.insertOutbox(makeDirectoryAction(after, reason, request.eventId));
      return { entry: sealEntry(after), replayed: false };
    });
  }

  async #converge<T>(
    operation: (tx: DirectoryTransaction) => Promise<T>,
    recover: (tx: DirectoryTransaction) => Promise<T | null>,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(operation);
    } catch (error) {
      const conflicted =
        error instanceof DirectoryError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-supplier-id');
      if (!conflicted) throw error;

      const recovered = await this.#repository.withTransaction(recover);
      if (recovered === null) throw error;
      return recovered;
    }
  }
}

async function requireEntry(tx: DirectoryTransaction, supplierId: string): Promise<DirectoryEntry> {
  assertDirectoryIdentifier(supplierId, 'supplierId');
  const entry = await tx.findEntryById(supplierId);
  if (entry === null) {
    throw new DirectoryError('supplier-not-found', `no directory entry with id ${supplierId}`);
  }
  return entry;
}

/**
 * Is this the same registration, arriving twice?
 *
 * **Neither `correlationId` nor `registeredAt` is compared.** A retry arrives later and carries a
 * fresh correlation id by definition, and comparing either would report every honest retry as key
 * reuse — advice that makes the caller send a new key and register twice.
 */
function entryEquals(a: DirectoryEntry, b: DirectoryEntry): boolean {
  return (
    a.supplierId === b.supplierId &&
    a.accountId === b.accountId &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.idempotencyKey === b.idempotencyKey
  );
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new DirectoryError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new DirectoryError(
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
      throw new DirectoryError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
