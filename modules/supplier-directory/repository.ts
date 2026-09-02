/**
 * M-48 — the persistence port and its in-memory reference implementation.
 *
 * The interesting method is `findProfiles`, which is the directory query the sourcing rungs run.
 * Everything else is lookup and insertion.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealDirectoryEvents,
  sealEntries,
  sealEntry,
  sealFacet,
  sealFacets,
  sealLocation,
  sealLocations,
  sealProfiles,
} from './immutable.ts';
import {
  DirectoryError,
  type DirectoryEntry,
  type DirectoryEvent,
  type DirectoryProfile,
  type DirectoryQuery,
  type SupplierFacet,
  type SupplierLocation,
} from './types.ts';

export interface DirectoryTransaction extends OutboxTransaction {
  findEntryById(supplierId: string): Promise<DirectoryEntry | null>;
  findEntryByAccountId(accountId: string): Promise<DirectoryEntry | null>;
  findEntryByIdempotencyKey(idempotencyKey: string): Promise<DirectoryEntry | null>;
  insertEntry(entry: DirectoryEntry): Promise<void>;
  updateEntry(entry: DirectoryEntry): Promise<void>;

  findFacetById(facetId: string): Promise<SupplierFacet | null>;
  /** One facet per (supplier, kind, value), whatever its status. Declaring twice moves the row. */
  findFacet(supplierId: string, kind: string, value: string): Promise<SupplierFacet | null>;
  findFacetsBySupplier(supplierId: string): Promise<readonly SupplierFacet[]>;
  insertFacet(facet: SupplierFacet): Promise<void>;
  updateFacet(facet: SupplierFacet): Promise<void>;

  findLocationById(locationId: string): Promise<SupplierLocation | null>;
  findLocationsBySupplier(supplierId: string): Promise<readonly SupplierLocation[]>;
  insertLocation(location: SupplierLocation): Promise<void>;
  updateLocation(location: SupplierLocation): Promise<void>;

  findEventsBySupplier(supplierId: string): Promise<readonly DirectoryEvent[]>;
  insertEvent(event: DirectoryEvent): Promise<void>;

  /**
   * The directory query the sourcing rungs run.
   *
   * Returns whole profiles rather than entries, because a rung scores on the declared facets and a
   * caller fetching them per entry would make the rung cost a round trip per supplier — which is a
   * rung nobody will run.
   */
  findProfiles(query: DirectoryQuery): Promise<readonly DirectoryProfile[]>;
}

export interface DirectoryRepository {
  withTransaction<T>(body: (tx: DirectoryTransaction) => Promise<T>): Promise<T>;
}

interface Store {
  entries: DirectoryEntry[];
  facets: SupplierFacet[];
  locations: SupplierLocation[];
  events: DirectoryEvent[];
}

export class InMemoryDirectoryRepository implements DirectoryRepository {
  #store: Store = { entries: [], facets: [], locations: [], events: [] };
  readonly #outbox = new InMemoryOutboxStore('M-48', 'module_supplier_directory');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  entries(): readonly DirectoryEntry[] {
    return sealEntries(this.#store.entries);
  }

  facets(): readonly SupplierFacet[] {
    return sealFacets(this.#store.facets);
  }

  locations(): readonly SupplierLocation[] {
    return sealLocations(this.#store.locations);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  seed(state: Partial<Store> & { readonly outbox?: readonly OutboxEntry[] }): void {
    this.#store = {
      entries: (state.entries ?? []).map(sealEntry),
      facets: (state.facets ?? []).map(sealFacet),
      locations: (state.locations ?? []).map(sealLocation),
      events: [...(state.events ?? [])],
    };
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: DirectoryTransaction) => Promise<T>): Promise<T> {
    const working: Store = {
      entries: this.#store.entries.map(sealEntry),
      facets: this.#store.facets.map(sealFacet),
      locations: this.#store.locations.map(sealLocation),
      events: [...this.#store.events],
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const created = new Set<string>();
    const tx = new InMemoryDirectoryTransaction(working, outboxWorking, created);

    try {
      const result = await body(tx);

      // Against the committed store, because that is what a concurrent transaction would have
      // written into — the snapshot this one read is precisely what it would not have been in.
      for (const entry of working.entries) {
        if (!created.has(entry.supplierId)) continue;
        if (this.#store.entries.some((held) => held.supplierId === entry.supplierId)) {
          throw new DirectoryError(
            'duplicate-supplier-id',
            `supplier ${entry.supplierId} was created by another transaction while this one was open`,
          );
        }
        if (this.#store.entries.some((held) => held.accountId === entry.accountId)) {
          throw new DirectoryError(
            'already-registered',
            `account ${entry.accountId} was registered by another transaction while this one was ` +
              'open. One account trades under one directory entry',
          );
        }
        if (this.#store.entries.some((held) => held.idempotencyKey === entry.idempotencyKey)) {
          throw new DirectoryError(
            'idempotency-key-reuse',
            `idempotency key "${entry.idempotencyKey}" was used by an entry created while this ` +
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

class InMemoryDirectoryTransaction implements DirectoryTransaction {
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

  findEntryById(supplierId: string): Promise<DirectoryEntry | null> {
    return Promise.resolve(
      this.#store.entries.find((one) => one.supplierId === supplierId) ?? null,
    );
  }

  findEntryByAccountId(accountId: string): Promise<DirectoryEntry | null> {
    return Promise.resolve(this.#store.entries.find((one) => one.accountId === accountId) ?? null);
  }

  findEntryByIdempotencyKey(idempotencyKey: string): Promise<DirectoryEntry | null> {
    return Promise.resolve(
      this.#store.entries.find((one) => one.idempotencyKey === idempotencyKey) ?? null,
    );
  }

  insertEntry(entry: DirectoryEntry): Promise<void> {
    if (this.#store.entries.some((one) => one.supplierId === entry.supplierId)) {
      return Promise.reject(
        new DirectoryError('duplicate-supplier-id', `supplier ${entry.supplierId} already exists`),
      );
    }
    if (this.#store.entries.some((one) => one.accountId === entry.accountId)) {
      return Promise.reject(
        new DirectoryError(
          'already-registered',
          `account ${entry.accountId} already trades under a directory entry. One account, one ` +
            'entry: two would make "who supplies this" ambiguous for the same party',
        ),
      );
    }
    if (this.#store.entries.some((one) => one.idempotencyKey === entry.idempotencyKey)) {
      return Promise.reject(
        new DirectoryError(
          'idempotency-key-reuse',
          `idempotency key "${entry.idempotencyKey}" already belongs to another entry`,
        ),
      );
    }
    this.#store.entries.push(sealEntry(entry));
    this.#created.add(entry.supplierId);
    return Promise.resolve();
  }

  updateEntry(entry: DirectoryEntry): Promise<void> {
    const index = this.#store.entries.findIndex((one) => one.supplierId === entry.supplierId);
    if (index < 0) {
      return Promise.reject(
        new DirectoryError('supplier-not-found', `supplier ${entry.supplierId} does not exist`),
      );
    }
    this.#store.entries[index] = sealEntry(entry);
    return Promise.resolve();
  }

  findFacetById(facetId: string): Promise<SupplierFacet | null> {
    return Promise.resolve(this.#store.facets.find((one) => one.facetId === facetId) ?? null);
  }

  findFacet(supplierId: string, kind: string, value: string): Promise<SupplierFacet | null> {
    return Promise.resolve(
      this.#store.facets.find(
        (one) => one.supplierId === supplierId && one.kind === kind && one.value === value,
      ) ?? null,
    );
  }

  findFacetsBySupplier(supplierId: string): Promise<readonly SupplierFacet[]> {
    return Promise.resolve(
      sealFacets(
        this.#store.facets
          .filter((one) => one.supplierId === supplierId)
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value)),
      ),
    );
  }

  insertFacet(facet: SupplierFacet): Promise<void> {
    if (this.#store.facets.some((one) => one.facetId === facet.facetId)) {
      return Promise.reject(
        new DirectoryError('duplicate-facet-id', `facet ${facet.facetId} already exists`),
      );
    }
    if (
      this.#store.facets.some(
        (one) =>
          one.supplierId === facet.supplierId &&
          one.kind === facet.kind &&
          one.value === facet.value,
      )
    ) {
      return Promise.reject(
        new DirectoryError(
          'duplicate-facet-id',
          `supplier ${facet.supplierId} already has a ${facet.kind} row for "${facet.value}". ` +
            'Declaring it again moves that row rather than adding a second',
        ),
      );
    }
    this.#store.facets.push(sealFacet(facet));
    return Promise.resolve();
  }

  updateFacet(facet: SupplierFacet): Promise<void> {
    const index = this.#store.facets.findIndex((one) => one.facetId === facet.facetId);
    if (index < 0) {
      return Promise.reject(
        new DirectoryError('facet-not-found', `facet ${facet.facetId} does not exist`),
      );
    }
    this.#store.facets[index] = sealFacet(facet);
    return Promise.resolve();
  }

  findLocationById(locationId: string): Promise<SupplierLocation | null> {
    return Promise.resolve(
      this.#store.locations.find((one) => one.locationId === locationId) ?? null,
    );
  }

  findLocationsBySupplier(supplierId: string): Promise<readonly SupplierLocation[]> {
    return Promise.resolve(
      sealLocations(
        this.#store.locations
          .filter((one) => one.supplierId === supplierId)
          .sort(
            (a, b) =>
              Number(b.primary) - Number(a.primary) || a.locationId.localeCompare(b.locationId),
          ),
      ),
    );
  }

  insertLocation(location: SupplierLocation): Promise<void> {
    if (this.#store.locations.some((one) => one.locationId === location.locationId)) {
      return Promise.reject(
        new DirectoryError(
          'duplicate-location-id',
          `location ${location.locationId} already exists`,
        ),
      );
    }
    if (
      location.primary &&
      this.#store.locations.some(
        (one) => one.supplierId === location.supplierId && one.primary && one.status === 'active',
      )
    ) {
      return Promise.reject(
        new DirectoryError(
          'primary-location-exists',
          `supplier ${location.supplierId} already has a primary location. Two would make "show ` +
            'the buyer the main one" a question with no answer',
        ),
      );
    }
    this.#store.locations.push(sealLocation(location));
    return Promise.resolve();
  }

  updateLocation(location: SupplierLocation): Promise<void> {
    const index = this.#store.locations.findIndex((one) => one.locationId === location.locationId);
    if (index < 0) {
      return Promise.reject(
        new DirectoryError('location-not-found', `location ${location.locationId} does not exist`),
      );
    }
    this.#store.locations[index] = sealLocation(location);
    return Promise.resolve();
  }

  findEventsBySupplier(supplierId: string): Promise<readonly DirectoryEvent[]> {
    return Promise.resolve(
      sealDirectoryEvents(
        this.#store.events
          .filter((one) => one.supplierId === supplierId)
          .sort(
            (a, b) =>
              a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId),
          ),
      ),
    );
  }

  insertEvent(event: DirectoryEvent): Promise<void> {
    // A replayed transition writes the same row, and the log records what happened rather than how
    // many times somebody asked.
    if (this.#store.events.some((one) => one.eventId === event.eventId)) return Promise.resolve();
    this.#store.events.push(event);
    return Promise.resolve();
  }

  findProfiles(query: DirectoryQuery): Promise<readonly DirectoryProfile[]> {
    const status = query.status ?? 'active';
    const openOnly = query.openOnly ?? true;
    const wantedDistricts = new Set(query.districts ?? []);

    const profiles: DirectoryProfile[] = [];
    for (const entry of this.#store.entries) {
      if (entry.status !== status) continue;
      if (openOnly && !entry.acceptsOrders) continue;
      if (query.kind !== undefined && entry.kind !== query.kind) continue;

      const active = this.#store.facets.filter(
        (one) => one.supplierId === entry.supplierId && one.status === 'active',
      );
      const of = (kind: string): string[] =>
        active.filter((one) => one.kind === kind).map((one) => one.value);

      const categories = of('category');
      // The gate. A supplier with no category in common is not a weak match; they are not a match.
      if (!query.categories.some((wanted) => categories.includes(wanted))) continue;

      const districts = of('district');
      // An empty district list means they have not said where they serve, which is not the same as
      // nowhere — so they stay in, and the rung scores geography rather than excluding on it.
      if (
        wantedDistricts.size > 0 &&
        districts.length > 0 &&
        !districts.some((one) => wantedDistricts.has(one))
      ) {
        continue;
      }

      profiles.push({
        entry: sealEntry(entry),
        categories,
        brands: of('brand'),
        capabilities: of('capability'),
        districts,
      });
    }

    profiles.sort((a, b) => a.entry.supplierId.localeCompare(b.entry.supplierId));
    return Promise.resolve(sealProfiles(profiles.slice(0, query.limit ?? 200)));
  }
}
