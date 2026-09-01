/**
 * M-13 Financial Ledger — persistence port.
 *
 * The service is written against this interface. The in-memory implementation is the specification
 * the PostgreSQL adapter has to meet: it enforces the same uniqueness rules, checks them **at commit
 * against the store as it stands** rather than against the snapshot the transaction read, and models
 * the row lock a conditional `UPDATE` takes.
 *
 * Three uniqueness rules carry real weight:
 *
 *   * **One wallet per (owner, asset type, purpose).** Two spending wallets in rupees for the same
 *     party would split their money in half with nothing to say which half is theirs.
 *   * **One live plan per obligation.** Two committed plans against one order is the order paid
 *     twice, and it would look like two ordinary payments to everybody downstream.
 *   * **One record per idempotency key.** A retry converges rather than duplicating.
 *
 * Owned by: M-13 Financial Ledger.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealValueLeg,
  sealValueLegs,
  sealValuePlan,
  sealValuePlans,
  sealWallet,
  sealWalletState,
  sealWalletStates,
  sealWallets,
} from './immutable.ts';
import {
  FinancialLedgerError,
  type LegStatus,
  type PlanStatus,
  type ValueLeg,
  type ValuePlan,
  type Wallet,
  type WalletPurpose,
  type WalletStateRecord,
  type WalletStatus,
} from './types.ts';

export interface FinancialLedgerTransaction extends OutboxTransaction {
  /** Wallets. */
  findWalletById(walletId: string): Promise<Wallet | null>;
  findWalletByIdempotencyKey(idempotencyKey: string): Promise<Wallet | null>;
  /** The uniqueness that stops one party holding two wallets for the same money. */
  findWalletByPosition(
    ownerAccountId: string,
    assetTypeId: string,
    purpose: WalletPurpose,
  ): Promise<Wallet | null>;
  findWalletsByOwner(ownerAccountId: string): Promise<readonly Wallet[]>;
  insertWallet(wallet: Wallet): Promise<void>;
  /**
   * Update a wallet only while its stored status is still `expectedStatus`.
   *
   * A freeze racing a withdrawal is the case this exists for: both read the wallet as `open`, and
   * without the guard both commit — the freeze recorded and the money already gone.
   */
  updateWalletIfStatus(wallet: Wallet, expectedStatus: WalletStatus): Promise<boolean>;

  /** Wallet status history. Append-only. */
  findWalletStateByIdempotencyKey(idempotencyKey: string): Promise<WalletStateRecord | null>;
  findWalletStatesByWalletId(walletId: string): Promise<readonly WalletStateRecord[]>;
  insertWalletState(record: WalletStateRecord): Promise<void>;

  /** Plans. */
  findPlanById(planId: string): Promise<ValuePlan | null>;
  findPlanByIdempotencyKey(idempotencyKey: string): Promise<ValuePlan | null>;
  /** The one plan against this obligation that has not been cancelled, if there is one. */
  findLivePlanByObligation(obligationId: string): Promise<ValuePlan | null>;
  findPlansByObligation(obligationId: string): Promise<readonly ValuePlan[]>;
  findPlansByPayer(payerAccountId: string): Promise<readonly ValuePlan[]>;
  insertPlan(plan: ValuePlan): Promise<void>;
  /** Guarded, for the same reason M-12 guards a capture: a plan may be committed exactly once. */
  updatePlanIfStatus(plan: ValuePlan, expectedStatus: PlanStatus): Promise<boolean>;

  /** Legs. */
  findLegById(legId: string): Promise<ValueLeg | null>;
  findLegByIdempotencyKey(idempotencyKey: string): Promise<ValueLeg | null>;
  findLegsByPlanId(planId: string): Promise<readonly ValueLeg[]>;
  insertLeg(leg: ValueLeg): Promise<void>;
  /**
   * Update a leg only while its stored status is still `expectedStatus`.
   *
   * This is what stops one leg posting twice. A leg carries a K-10 transaction id once it posts, and
   * a second posting under a different transaction id would move the value again.
   */
  updateLegIfStatus(leg: ValueLeg, expectedStatus: LegStatus): Promise<boolean>;
}

export interface FinancialLedgerRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T>;
}

/** Everything one transaction can see and change, before it commits. */
interface WorkingSet {
  wallets: Wallet[];
  walletStates: WalletStateRecord[];
  plans: ValuePlan[];
  legs: ValueLeg[];
}

/** What a transaction touched, so the commit can check for conflicts. */
class Touched {
  readonly wallets = new Set<string>();
  readonly walletKeys = new Set<string>();
  readonly walletPositions = new Set<string>();
  readonly walletUpdates = new Set<string>();
  readonly walletGuards = new Map<string, WalletStatus>();
  readonly walletStates = new Set<string>();
  readonly walletStateKeys = new Set<string>();
  readonly plans = new Set<string>();
  readonly planKeys = new Set<string>();
  readonly planObligations = new Set<string>();
  readonly planUpdates = new Set<string>();
  readonly planGuards = new Map<string, PlanStatus>();
  readonly legs = new Set<string>();
  readonly legKeys = new Set<string>();
  readonly legUpdates = new Set<string>();
  readonly legGuards = new Map<string, LegStatus>();
}

const positionKey = (owner: string, assetTypeId: string, purpose: string): string =>
  `${owner} ${assetTypeId} ${purpose}`;

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract.
 */
export class InMemoryFinancialLedgerRepository implements FinancialLedgerRepository {
  #wallets: Wallet[] = [];
  #walletStates: WalletStateRecord[] = [];
  #plans: ValuePlan[] = [];
  #legs: ValueLeg[] = [];
  readonly #outbox = new InMemoryOutboxStore('M-13', 'module_financial_ledger');
  /**
   * One queue per guarded entity, modelling the row lock a conditional `UPDATE` takes in PostgreSQL.
   *
   * Without it this implementation is *less* safe than the database it stands in for: a second
   * transaction would pass its guard against pre-conflict state and only lose at commit, taking
   * everything else it wrote down with it. Under PostgreSQL that transaction blocks on the row,
   * re-evaluates the `WHERE` clause, updates nothing, and still commits its other writes.
   */
  readonly #locks = new Map<string, Promise<void>>();
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  wallets(): readonly Wallet[] {
    return sealWallets(this.#wallets);
  }

  walletStates(): readonly WalletStateRecord[] {
    return sealWalletStates(this.#walletStates);
  }

  plans(): readonly ValuePlan[] {
    return sealValuePlans(this.#plans);
  }

  legs(): readonly ValueLeg[] {
    return sealValueLegs(this.#legs);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly wallets?: readonly Wallet[];
    readonly walletStates?: readonly WalletStateRecord[];
    readonly plans?: readonly ValuePlan[];
    readonly legs?: readonly ValueLeg[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#wallets = (state.wallets ?? []).map(sealWallet);
    this.#walletStates = (state.walletStates ?? []).map(sealWalletState);
    this.#plans = (state.plans ?? []).map(sealValuePlan);
    this.#legs = (state.legs ?? []).map(sealValueLeg);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: FinancialLedgerTransaction) => Promise<T>): Promise<T> {
    const working: WorkingSet = {
      wallets: this.#wallets.map(sealWallet),
      walletStates: this.#walletStates.map(sealWalletState),
      plans: this.#plans.map(sealValuePlan),
      legs: this.#legs.map(sealValueLeg),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const held: (() => void)[] = [];
    const locked = new Set<string>();

    const tx = new InMemoryFinancialLedgerTransaction(
      working,
      outboxWorking,
      touched,
      {
        wallets: () => this.#wallets,
        plans: () => this.#plans,
        legs: () => this.#legs,
      },
      async (key) => {
        // Re-entrant within one transaction: a second guarded update on the same row would
        // otherwise wait for a lock this very transaction holds, and wait for ever.
        if (locked.has(key)) return;
        locked.add(key);
        held.push(await this.#lock(key));
      },
    );

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    } finally {
      // Released whichever way the transaction ended: a lock a rolled-back transaction kept would
      // hold every later operation on that row for ever.
      for (const release of held) release();
    }
  }

  #lock(key: string): Promise<() => void> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(
      key,
      previous.then(() => current),
    );
    return previous.then(() => release);
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Guarded updates first: the row must still be as the transaction read it.
    for (const [walletId, expected] of touched.walletGuards) {
      const held = this.#wallets.find((candidate) => candidate.walletId === walletId);
      if (held !== undefined && held.status !== expected) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `wallet ${walletId} moved from ${expected} to ${held.status} in another transaction`,
        );
      }
    }
    for (const [planId, expected] of touched.planGuards) {
      const held = this.#plans.find((candidate) => candidate.planId === planId);
      if (held !== undefined && held.status !== expected) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `plan ${planId} moved from ${expected} to ${held.status} in another transaction`,
        );
      }
    }
    for (const [legId, expected] of touched.legGuards) {
      const held = this.#legs.find((candidate) => candidate.legId === legId);
      if (held !== undefined && held.status !== expected) {
        throw new FinancialLedgerError(
          'illegal-transition',
          `leg ${legId} moved from ${expected} to ${held.status} in another transaction`,
        );
      }
    }

    for (const wallet of working.wallets) {
      if (!touched.wallets.has(wallet.walletId)) continue;
      if (this.#wallets.some((held) => held.walletId === wallet.walletId)) {
        throw new FinancialLedgerError(
          'duplicate-wallet-id',
          `wallet ${wallet.walletId} was created by another transaction while this one was open`,
        );
      }
      if (this.#wallets.some((held) => held.idempotencyKey === wallet.idempotencyKey)) {
        throw new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${wallet.idempotencyKey}" was used by another transaction`,
        );
      }
      if (
        this.#wallets.some(
          (held) =>
            held.ownerAccountId === wallet.ownerAccountId &&
            held.assetTypeId === wallet.assetTypeId &&
            held.purpose === wallet.purpose,
        )
      ) {
        throw new FinancialLedgerError(
          'wallet-exists',
          `${wallet.ownerAccountId} already holds a ${wallet.purpose} wallet in ` +
            `${wallet.assetTypeId}. Two would split their money in half with nothing to say which ` +
            'half is theirs',
        );
      }
    }

    for (const record of working.walletStates) {
      if (!touched.walletStates.has(record.stateId)) continue;
      if (this.#walletStates.some((held) => held.stateId === record.stateId)) {
        throw new FinancialLedgerError(
          'malformed-record',
          `wallet state ${record.stateId} was created by another transaction`,
        );
      }
      if (this.#walletStates.some((held) => held.idempotencyKey === record.idempotencyKey)) {
        throw new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${record.idempotencyKey}" was used by another transaction`,
        );
      }
    }

    for (const plan of working.plans) {
      if (!touched.plans.has(plan.planId)) continue;
      if (this.#plans.some((held) => held.planId === plan.planId)) {
        throw new FinancialLedgerError(
          'duplicate-plan-id',
          `plan ${plan.planId} was created by another transaction while this one was open`,
        );
      }
      if (this.#plans.some((held) => held.idempotencyKey === plan.idempotencyKey)) {
        throw new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${plan.idempotencyKey}" was used by another transaction`,
        );
      }
      if (
        this.#plans.some(
          (held) => held.obligationId === plan.obligationId && held.status !== 'cancelled',
        )
      ) {
        throw new FinancialLedgerError(
          'duplicate-plan-id',
          `obligation ${plan.obligationId} already has a live plan. Two would be the same thing ` +
            'paid for twice, and downstream it would look like two ordinary payments',
        );
      }
    }

    for (const leg of working.legs) {
      if (!touched.legs.has(leg.legId)) continue;
      if (this.#legs.some((held) => held.legId === leg.legId)) {
        throw new FinancialLedgerError(
          'duplicate-leg-id',
          `leg ${leg.legId} was created by another transaction while this one was open`,
        );
      }
      if (this.#legs.some((held) => held.idempotencyKey === leg.idempotencyKey)) {
        throw new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${leg.idempotencyKey}" was used by another transaction`,
        );
      }
    }

    this.#wallets = [
      ...this.#wallets.map((held) => {
        if (!touched.walletUpdates.has(held.walletId)) return held;
        const updated = working.wallets.find((candidate) => candidate.walletId === held.walletId);
        return updated === undefined ? held : sealWallet(updated);
      }),
      ...working.wallets.filter((w) => touched.wallets.has(w.walletId)).map(sealWallet),
    ];

    this.#walletStates = [
      ...this.#walletStates,
      ...working.walletStates
        .filter((record) => touched.walletStates.has(record.stateId))
        .map(sealWalletState),
    ];

    this.#plans = [
      ...this.#plans.map((held) => {
        if (!touched.planUpdates.has(held.planId)) return held;
        const updated = working.plans.find((candidate) => candidate.planId === held.planId);
        return updated === undefined ? held : sealValuePlan(updated);
      }),
      ...working.plans.filter((p) => touched.plans.has(p.planId)).map(sealValuePlan),
    ];

    this.#legs = [
      ...this.#legs.map((held) => {
        if (!touched.legUpdates.has(held.legId)) return held;
        const updated = working.legs.find((candidate) => candidate.legId === held.legId);
        return updated === undefined ? held : sealValueLeg(updated);
      }),
      ...working.legs.filter((l) => touched.legs.has(l.legId)).map(sealValueLeg),
    ];
  }
}

interface CommittedView {
  readonly wallets: () => readonly Wallet[];
  readonly plans: () => readonly ValuePlan[];
  readonly legs: () => readonly ValueLeg[];
}

class InMemoryFinancialLedgerTransaction implements FinancialLedgerTransaction {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;
  readonly #committed: CommittedView;
  readonly #lock: (key: string) => Promise<void>;

  constructor(
    state: WorkingSet,
    outbox: InMemoryOutboxStore,
    touched: Touched,
    committed: CommittedView,
    lock: (key: string) => Promise<void>,
  ) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
    this.#committed = committed;
    this.#lock = lock;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Wallets
  // -------------------------------------------------------------------------

  findWalletById(walletId: string): Promise<Wallet | null> {
    const found = this.#state.wallets.find((w) => w.walletId === walletId);
    return Promise.resolve(found === undefined ? null : sealWallet(found));
  }

  findWalletByIdempotencyKey(idempotencyKey: string): Promise<Wallet | null> {
    const found = this.#state.wallets.find((w) => w.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealWallet(found));
  }

  findWalletByPosition(
    ownerAccountId: string,
    assetTypeId: string,
    purpose: WalletPurpose,
  ): Promise<Wallet | null> {
    const found = this.#state.wallets.find(
      (w) =>
        w.ownerAccountId === ownerAccountId &&
        w.assetTypeId === assetTypeId &&
        w.purpose === purpose,
    );
    return Promise.resolve(found === undefined ? null : sealWallet(found));
  }

  findWalletsByOwner(ownerAccountId: string): Promise<readonly Wallet[]> {
    const found = this.#state.wallets
      .filter((w) => w.ownerAccountId === ownerAccountId)
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.walletId.localeCompare(b.walletId),
      );
    return Promise.resolve(sealWallets(found));
  }

  insertWallet(wallet: Wallet): Promise<void> {
    if (this.#state.wallets.some((held) => held.walletId === wallet.walletId)) {
      return Promise.reject(
        new FinancialLedgerError('duplicate-wallet-id', `wallet ${wallet.walletId} already exists`),
      );
    }
    if (this.#state.wallets.some((held) => held.idempotencyKey === wallet.idempotencyKey)) {
      return Promise.reject(
        new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${wallet.idempotencyKey}" has already been used for a wallet`,
        ),
      );
    }
    if (
      this.#state.wallets.some(
        (held) =>
          held.ownerAccountId === wallet.ownerAccountId &&
          held.assetTypeId === wallet.assetTypeId &&
          held.purpose === wallet.purpose,
      )
    ) {
      return Promise.reject(
        new FinancialLedgerError(
          'wallet-exists',
          `${wallet.ownerAccountId} already holds a ${wallet.purpose} wallet in ${wallet.assetTypeId}`,
        ),
      );
    }
    this.#state.wallets.push(sealWallet(wallet));
    this.#touched.wallets.add(wallet.walletId);
    this.#touched.walletKeys.add(wallet.idempotencyKey);
    this.#touched.walletPositions.add(
      positionKey(wallet.ownerAccountId, wallet.assetTypeId, wallet.purpose),
    );
    return Promise.resolve();
  }

  async updateWalletIfStatus(wallet: Wallet, expectedStatus: WalletStatus): Promise<boolean> {
    await this.#lock(`wallet:${wallet.walletId}`);

    const committed = this.#committed.wallets().find((h) => h.walletId === wallet.walletId);
    if (committed === undefined) {
      throw new FinancialLedgerError(
        'wallet-not-found',
        `wallet ${wallet.walletId} does not exist`,
      );
    }
    if (committed.status !== expectedStatus) return false;

    const index = this.#state.wallets.findIndex((held) => held.walletId === wallet.walletId);
    if (index !== -1) this.#state.wallets[index] = sealWallet(wallet);
    this.#touched.walletUpdates.add(wallet.walletId);
    this.#touched.walletGuards.set(wallet.walletId, expectedStatus);
    return true;
  }

  findWalletStateByIdempotencyKey(idempotencyKey: string): Promise<WalletStateRecord | null> {
    const found = this.#state.walletStates.find((r) => r.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealWalletState(found));
  }

  findWalletStatesByWalletId(walletId: string): Promise<readonly WalletStateRecord[]> {
    const found = this.#state.walletStates
      .filter((r) => r.walletId === walletId)
      .sort(
        (a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.stateId.localeCompare(b.stateId),
      );
    return Promise.resolve(sealWalletStates(found));
  }

  insertWalletState(record: WalletStateRecord): Promise<void> {
    if (this.#state.walletStates.some((held) => held.stateId === record.stateId)) {
      return Promise.reject(
        new FinancialLedgerError(
          'malformed-record',
          `wallet state ${record.stateId} already exists`,
        ),
      );
    }
    if (this.#state.walletStates.some((held) => held.idempotencyKey === record.idempotencyKey)) {
      return Promise.reject(
        new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${record.idempotencyKey}" has already been used for a wallet state`,
        ),
      );
    }
    this.#state.walletStates.push(sealWalletState(record));
    this.#touched.walletStates.add(record.stateId);
    this.#touched.walletStateKeys.add(record.idempotencyKey);
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  findPlanById(planId: string): Promise<ValuePlan | null> {
    const found = this.#state.plans.find((p) => p.planId === planId);
    return Promise.resolve(found === undefined ? null : sealValuePlan(found));
  }

  findPlanByIdempotencyKey(idempotencyKey: string): Promise<ValuePlan | null> {
    const found = this.#state.plans.find((p) => p.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealValuePlan(found));
  }

  findLivePlanByObligation(obligationId: string): Promise<ValuePlan | null> {
    const found = this.#state.plans.find(
      (p) => p.obligationId === obligationId && p.status !== 'cancelled',
    );
    return Promise.resolve(found === undefined ? null : sealValuePlan(found));
  }

  findPlansByObligation(obligationId: string): Promise<readonly ValuePlan[]> {
    const found = this.#state.plans
      .filter((p) => p.obligationId === obligationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
    return Promise.resolve(sealValuePlans(found));
  }

  findPlansByPayer(payerAccountId: string): Promise<readonly ValuePlan[]> {
    const found = this.#state.plans
      .filter((p) => p.payerAccountId === payerAccountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId));
    return Promise.resolve(sealValuePlans(found));
  }

  insertPlan(plan: ValuePlan): Promise<void> {
    if (this.#state.plans.some((held) => held.planId === plan.planId)) {
      return Promise.reject(
        new FinancialLedgerError('duplicate-plan-id', `plan ${plan.planId} already exists`),
      );
    }
    if (this.#state.plans.some((held) => held.idempotencyKey === plan.idempotencyKey)) {
      return Promise.reject(
        new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${plan.idempotencyKey}" has already been used for a plan`,
        ),
      );
    }
    if (
      this.#state.plans.some(
        (held) => held.obligationId === plan.obligationId && held.status !== 'cancelled',
      )
    ) {
      return Promise.reject(
        new FinancialLedgerError(
          'duplicate-plan-id',
          `obligation ${plan.obligationId} already has a live plan`,
        ),
      );
    }
    this.#state.plans.push(sealValuePlan(plan));
    this.#touched.plans.add(plan.planId);
    this.#touched.planKeys.add(plan.idempotencyKey);
    this.#touched.planObligations.add(plan.obligationId);
    return Promise.resolve();
  }

  async updatePlanIfStatus(plan: ValuePlan, expectedStatus: PlanStatus): Promise<boolean> {
    await this.#lock(`plan:${plan.planId}`);

    const committed = this.#committed.plans().find((h) => h.planId === plan.planId);
    if (committed === undefined) {
      throw new FinancialLedgerError('plan-not-found', `plan ${plan.planId} does not exist`);
    }
    if (committed.status !== expectedStatus) return false;

    const index = this.#state.plans.findIndex((held) => held.planId === plan.planId);
    if (index !== -1) this.#state.plans[index] = sealValuePlan(plan);
    this.#touched.planUpdates.add(plan.planId);
    this.#touched.planGuards.set(plan.planId, expectedStatus);
    return true;
  }

  // -------------------------------------------------------------------------
  // Legs
  // -------------------------------------------------------------------------

  findLegById(legId: string): Promise<ValueLeg | null> {
    const found = this.#state.legs.find((l) => l.legId === legId);
    return Promise.resolve(found === undefined ? null : sealValueLeg(found));
  }

  findLegByIdempotencyKey(idempotencyKey: string): Promise<ValueLeg | null> {
    const found = this.#state.legs.find((l) => l.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealValueLeg(found));
  }

  findLegsByPlanId(planId: string): Promise<readonly ValueLeg[]> {
    const found = this.#state.legs
      .filter((l) => l.planId === planId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.legId.localeCompare(b.legId));
    return Promise.resolve(sealValueLegs(found));
  }

  insertLeg(leg: ValueLeg): Promise<void> {
    if (this.#state.legs.some((held) => held.legId === leg.legId)) {
      return Promise.reject(
        new FinancialLedgerError('duplicate-leg-id', `leg ${leg.legId} already exists`),
      );
    }
    if (this.#state.legs.some((held) => held.idempotencyKey === leg.idempotencyKey)) {
      return Promise.reject(
        new FinancialLedgerError(
          'idempotency-key-reuse',
          `idempotency key "${leg.idempotencyKey}" has already been used for a leg`,
        ),
      );
    }
    this.#state.legs.push(sealValueLeg(leg));
    this.#touched.legs.add(leg.legId);
    this.#touched.legKeys.add(leg.idempotencyKey);
    return Promise.resolve();
  }

  async updateLegIfStatus(leg: ValueLeg, expectedStatus: LegStatus): Promise<boolean> {
    await this.#lock(`leg:${leg.legId}`);

    const committed = this.#committed.legs().find((h) => h.legId === leg.legId);
    if (committed === undefined) {
      throw new FinancialLedgerError('leg-not-found', `leg ${leg.legId} does not exist`);
    }
    if (committed.status !== expectedStatus) return false;

    const index = this.#state.legs.findIndex((held) => held.legId === leg.legId);
    if (index !== -1) this.#state.legs[index] = sealValueLeg(leg);
    this.#touched.legUpdates.add(leg.legId);
    this.#touched.legGuards.set(leg.legId, expectedStatus);
    return true;
  }
}
