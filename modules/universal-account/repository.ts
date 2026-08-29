/**
 * M-01 Universal Account — the persistence port.
 *
 * The service is written against this interface. The port exposes capability lookup, creation and
 * lifecycle updates, capability state append-only storage, and the outbox insert every producing
 * module must support.
 *
 * Owned by: M-01 Universal Account.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealAccountCapabilities,
  sealAccountCapability,
  sealCapabilityState,
  sealCapabilityStates,
} from './immutable.ts';
import { UniversalAccountError, type AccountCapability, type CapabilityState } from './types.ts';

export interface UniversalAccountTransaction extends OutboxTransaction {
  /** Capability lookup and creation. */
  findCapabilityById(capabilityId: string): Promise<AccountCapability | null>;
  findCapabilityByIdempotencyKey(idempotencyKey: string): Promise<AccountCapability | null>;
  findCapabilitiesByAccountId(accountId: string): Promise<readonly AccountCapability[]>;
  insertCapability(capability: AccountCapability): Promise<void>;
  updateCapability(capability: AccountCapability): Promise<void>;

  /** Capability state lookup and creation. */
  findStateById(stateId: string): Promise<CapabilityState | null>;
  findStateByIdempotencyKey(idempotencyKey: string): Promise<CapabilityState | null>;
  findStatesByCapabilityId(capabilityId: string): Promise<readonly CapabilityState[]>;
  insertState(state: CapabilityState): Promise<void>;
}

export interface UniversalAccountRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written capability or state
   * row.
   */
  withTransaction<T>(body: (tx: UniversalAccountTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such capability" must not both win.
 */
export class InMemoryUniversalAccountRepository implements UniversalAccountRepository {
  #capabilities: AccountCapability[] = [];
  #states: CapabilityState[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-01', 'module_universal_account');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  capabilities(): readonly AccountCapability[] {
    return sealAccountCapabilities(this.#capabilities);
  }

  states(): readonly CapabilityState[] {
    return sealCapabilityStates(this.#states);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly capabilities?: readonly AccountCapability[];
    readonly states?: readonly CapabilityState[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#capabilities = (state.capabilities ?? []).map(sealAccountCapability);
    this.#states = (state.states ?? []).map(sealCapabilityState);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: UniversalAccountTransaction) => Promise<T>): Promise<T> {
    const working = {
      capabilities: this.#capabilities.map(sealAccountCapability),
      states: this.#states.map(sealCapabilityState),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryUniversalAccountTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Capabilities: idempotency-key conflicts come first, then capability-id conflicts.
    for (const capability of working.capabilities) {
      if (touched.capabilityKeys.has(capability.idempotencyKey)) {
        const holder = this.#capabilities.find(
          (held) => held.idempotencyKey === capability.idempotencyKey,
        );
        if (holder !== undefined && holder.capabilityId !== capability.capabilityId) {
          throw new UniversalAccountError(
            'idempotency-key-reuse',
            `idempotency key "${capability.idempotencyKey}" was used by capability ` +
              `${holder.capabilityId}, created by another transaction while this one was open`,
          );
        }
      }
      if (touched.capabilities.has(capability.capabilityId)) {
        if (this.#capabilities.some((held) => held.capabilityId === capability.capabilityId)) {
          throw new UniversalAccountError(
            'duplicate-capability-id',
            `capability ${capability.capabilityId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
    }

    // Capability updates: a touched capability id may already exist in the store.
    for (const capability of working.capabilities) {
      if (touched.capabilityUpdates.has(capability.capabilityId)) {
        this.#capabilities = this.#capabilities.map((held) =>
          held.capabilityId === capability.capabilityId ? sealAccountCapability(capability) : held,
        );
      }
    }

    this.#capabilities = [
      ...this.#capabilities,
      ...working.capabilities.filter((c) => touched.capabilities.has(c.capabilityId)),
    ];

    // Capability states are append-only.
    for (const state of working.states) {
      if (touched.states.has(state.stateId)) {
        if (this.#states.some((held) => held.stateId === state.stateId)) {
          throw new UniversalAccountError(
            'duplicate-state-id',
            `capability state ${state.stateId} was created by another transaction while ` +
              'this one was open',
          );
        }
      }
      if (touched.stateKeys.has(state.idempotencyKey)) {
        const holder = this.#states.find((held) => held.idempotencyKey === state.idempotencyKey);
        if (holder !== undefined) {
          throw new UniversalAccountError(
            'idempotency-key-reuse',
            `idempotency key "${state.idempotencyKey}" was used by state ${holder.stateId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    this.#states = [
      ...this.#states,
      ...working.states.filter((s) => touched.states.has(s.stateId)).map(sealCapabilityState),
    ];
  }
}

class WorkingSet {
  capabilities: AccountCapability[];
  states: CapabilityState[];

  constructor(snapshot: { capabilities: AccountCapability[]; states: CapabilityState[] }) {
    this.capabilities = snapshot.capabilities;
    this.states = snapshot.states;
  }
}

class Touched {
  readonly capabilities = new Set<string>();
  readonly capabilityKeys = new Set<string>();
  readonly capabilityUpdates = new Set<string>();
  readonly states = new Set<string>();
  readonly stateKeys = new Set<string>();
}

class InMemoryUniversalAccountTransaction implements UniversalAccountTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findCapabilityById(capabilityId: string): Promise<AccountCapability | null> {
    const found = this.#state.capabilities.find((c) => c.capabilityId === capabilityId);
    return Promise.resolve(found === undefined ? null : sealAccountCapability(found));
  }

  findCapabilityByIdempotencyKey(idempotencyKey: string): Promise<AccountCapability | null> {
    const found = this.#state.capabilities.find((c) => c.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealAccountCapability(found));
  }

  findCapabilitiesByAccountId(accountId: string): Promise<readonly AccountCapability[]> {
    const found = this.#state.capabilities
      .filter((c) => c.accountId === accountId)
      .sort((a, b) => a.capability.localeCompare(b.capability));
    return Promise.resolve(sealAccountCapabilities(found));
  }

  insertCapability(capability: AccountCapability): Promise<void> {
    if (this.#state.capabilities.some((held) => held.capabilityId === capability.capabilityId)) {
      return Promise.reject(
        new UniversalAccountError(
          'duplicate-capability-id',
          `capability ${capability.capabilityId} already exists. A capability is created once and ` +
            'its lifecycle is updated through the service',
        ),
      );
    }
    if (
      this.#state.capabilities.some((held) => held.idempotencyKey === capability.idempotencyKey)
    ) {
      return Promise.reject(
        new UniversalAccountError(
          'idempotency-key-reuse',
          `idempotency key "${capability.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.capabilities.push(sealAccountCapability(capability));
    this.#touched.capabilities.add(capability.capabilityId);
    this.#touched.capabilityKeys.add(capability.idempotencyKey);
    return Promise.resolve();
  }

  updateCapability(capability: AccountCapability): Promise<void> {
    const index = this.#state.capabilities.findIndex(
      (held) => held.capabilityId === capability.capabilityId,
    );
    if (index === -1) {
      return Promise.reject(
        new UniversalAccountError(
          'capability-not-found',
          `capability ${capability.capabilityId} does not exist`,
        ),
      );
    }
    this.#state.capabilities[index] = sealAccountCapability(capability);
    this.#touched.capabilityUpdates.add(capability.capabilityId);
    return Promise.resolve();
  }

  findStateById(stateId: string): Promise<CapabilityState | null> {
    const found = this.#state.states.find((s) => s.stateId === stateId);
    return Promise.resolve(found === undefined ? null : sealCapabilityState(found));
  }

  findStateByIdempotencyKey(idempotencyKey: string): Promise<CapabilityState | null> {
    const found = this.#state.states.find((s) => s.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealCapabilityState(found));
  }

  findStatesByCapabilityId(capabilityId: string): Promise<readonly CapabilityState[]> {
    const found = this.#state.states
      .filter((s) => s.capabilityId === capabilityId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return Promise.resolve(sealCapabilityStates(found));
  }

  insertState(state: CapabilityState): Promise<void> {
    if (this.#state.states.some((held) => held.stateId === state.stateId)) {
      return Promise.reject(
        new UniversalAccountError(
          'duplicate-state-id',
          `capability state ${state.stateId} already exists. A state row is created once and never ` +
            'rewritten',
        ),
      );
    }
    if (this.#state.states.some((held) => held.idempotencyKey === state.idempotencyKey)) {
      return Promise.reject(
        new UniversalAccountError(
          'idempotency-key-reuse',
          `idempotency key "${state.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.states.push(sealCapabilityState(state));
    this.#touched.states.add(state.stateId);
    this.#touched.stateKeys.add(state.idempotencyKey);
    return Promise.resolve();
  }
}
