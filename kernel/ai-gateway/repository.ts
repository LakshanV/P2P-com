/**
 * K-13 AI Gateway — the persistence port.
 *
 * The service is written against this interface. The port exposes task definitions, model bindings,
 * AI runs, AI decisions and the outbox insert every producing module must support.
 *
 * Owned by: K-13 AI Gateway.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealAuthorities,
  sealAuthority,
  sealBinding,
  sealBindings,
  sealDecision,
  sealDecisions,
  sealRun,
  sealRuns,
  sealTask,
  sealTasks,
} from './immutable.ts';
import {
  AIGatewayError,
  type AIDecision,
  type AIRun,
  type ModelBinding,
  type TaskAuthority,
  type TaskDefinition,
} from './types.ts';

export interface AIGatewayTransaction extends OutboxTransaction {
  /** Task definition lookup and creation. */
  findTaskById(taskId: string): Promise<TaskDefinition | null>;
  findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskDefinition | null>;
  insertTask(task: TaskDefinition): Promise<void>;

  /** Model binding lookup and creation. */
  findBindingById(bindingId: string): Promise<ModelBinding | null>;
  findBindingByIdempotencyKey(idempotencyKey: string): Promise<ModelBinding | null>;
  findBindingsByCapability(capability: string): Promise<readonly ModelBinding[]>;
  insertBinding(binding: ModelBinding): Promise<void>;

  /** AI run lookup and creation. */
  findRunById(runId: string): Promise<AIRun | null>;
  findRunByIdempotencyKey(idempotencyKey: string): Promise<AIRun | null>;
  insertRun(run: AIRun): Promise<void>;

  /** AI decision lookup and creation. */
  findDecisionById(decisionId: string): Promise<AIDecision | null>;
  findDecisionByIdempotencyKey(idempotencyKey: string): Promise<AIDecision | null>;
  insertDecision(decision: AIDecision): Promise<void>;

  /** Authority grant lookup and creation. Grants are append-only versions. */
  findAuthorityById(authorityId: string): Promise<TaskAuthority | null>;
  findAuthorityByIdempotencyKey(idempotencyKey: string): Promise<TaskAuthority | null>;
  /**
   * The grant in force for the task at an instant: the latest version granted at or before it.
   * Null when the task has never been granted anything.
   */
  findAuthorityInForce(taskId: string, at: string): Promise<TaskAuthority | null>;
  insertAuthority(authority: TaskAuthority): Promise<void>;
}

export interface AIGatewayRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-written run or decision.
   */
  withTransaction<T>(body: (tx: AIGatewayTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such binding" must not both win.
 */
export class InMemoryAIGatewayRepository implements AIGatewayRepository {
  #tasks: TaskDefinition[] = [];
  #bindings: ModelBinding[] = [];
  #runs: AIRun[] = [];
  #decisions: AIDecision[] = [];
  #authorities: TaskAuthority[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-13', 'kernel_ai_gateway');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  tasks(): readonly TaskDefinition[] {
    return sealTasks(this.#tasks);
  }

  bindings(): readonly ModelBinding[] {
    return sealBindings(this.#bindings);
  }

  runs(): readonly AIRun[] {
    return sealRuns(this.#runs);
  }

  decisions(): readonly AIDecision[] {
    return sealDecisions(this.#decisions);
  }

  authorities(): readonly TaskAuthority[] {
    return sealAuthorities(this.#authorities);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly tasks?: readonly TaskDefinition[];
    readonly bindings?: readonly ModelBinding[];
    readonly runs?: readonly AIRun[];
    readonly decisions?: readonly AIDecision[];
    readonly authorities?: readonly TaskAuthority[];
    readonly outbox?: readonly OutboxEntry[];
  }): void {
    this.#tasks = (state.tasks ?? []).map(sealTask);
    this.#bindings = (state.bindings ?? []).map(sealBinding);
    this.#runs = (state.runs ?? []).map(sealRun);
    this.#decisions = (state.decisions ?? []).map(sealDecision);
    this.#authorities = (state.authorities ?? []).map(sealAuthority);
    this.#outbox.seed(state.outbox ?? []);
  }

  async withTransaction<T>(body: (tx: AIGatewayTransaction) => Promise<T>): Promise<T> {
    const working = {
      tasks: this.#tasks.map(sealTask),
      bindings: this.#bindings.map(sealBinding),
      runs: this.#runs.map(sealRun),
      decisions: this.#decisions.map(sealDecision),
      authorities: this.#authorities.map(sealAuthority),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryAIGatewayTransaction(working, outboxWorking, touched);

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
    // Tasks
    for (const task of working.tasks) {
      if (touched.tasks.has(task.taskId)) {
        if (this.#tasks.some((held) => held.taskId === task.taskId)) {
          throw new AIGatewayError(
            'duplicate-task-id',
            `task ${task.taskId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.taskKeys.has(task.idempotencyKey)) {
        const holder = this.#tasks.find((held) => held.idempotencyKey === task.idempotencyKey);
        if (holder !== undefined) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${task.idempotencyKey}" was used by task ${holder.taskId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    // Bindings
    for (const binding of working.bindings) {
      if (touched.bindings.has(binding.bindingId)) {
        if (this.#bindings.some((held) => held.bindingId === binding.bindingId)) {
          throw new AIGatewayError(
            'duplicate-binding-id',
            `binding ${binding.bindingId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.bindingKeys.has(binding.idempotencyKey)) {
        const holder = this.#bindings.find(
          (held) => held.idempotencyKey === binding.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${binding.idempotencyKey}" was used by binding ${holder.bindingId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    // Runs
    for (const run of working.runs) {
      if (touched.runs.has(run.runId)) {
        if (this.#runs.some((held) => held.runId === run.runId)) {
          throw new AIGatewayError(
            'duplicate-run-id',
            `run ${run.runId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.runKeys.has(run.idempotencyKey)) {
        const holder = this.#runs.find((held) => held.idempotencyKey === run.idempotencyKey);
        if (holder !== undefined) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${run.idempotencyKey}" was used by run ${holder.runId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    // Decisions
    for (const decision of working.decisions) {
      if (touched.decisions.has(decision.decisionId)) {
        if (this.#decisions.some((held) => held.decisionId === decision.decisionId)) {
          throw new AIGatewayError(
            'duplicate-decision-id',
            `decision ${decision.decisionId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.decisionKeys.has(decision.idempotencyKey)) {
        const holder = this.#decisions.find(
          (held) => held.idempotencyKey === decision.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${decision.idempotencyKey}" was used by decision ` +
              `${holder.decisionId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    // Authority grants
    for (const authority of working.authorities) {
      if (touched.authorities.has(authority.authorityId)) {
        if (this.#authorities.some((held) => held.authorityId === authority.authorityId)) {
          throw new AIGatewayError(
            'duplicate-authority-id',
            `authority ${authority.authorityId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.authorityKeys.has(authority.idempotencyKey)) {
        const holder = this.#authorities.find(
          (held) => held.idempotencyKey === authority.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new AIGatewayError(
            'idempotency-key-reuse',
            `idempotency key "${authority.idempotencyKey}" was used by authority ` +
              `${holder.authorityId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    this.#tasks = [...this.#tasks, ...working.tasks.filter((t) => touched.tasks.has(t.taskId))];
    this.#bindings = [
      ...this.#bindings,
      ...working.bindings.filter((b) => touched.bindings.has(b.bindingId)),
    ];
    this.#runs = [...this.#runs, ...working.runs.filter((r) => touched.runs.has(r.runId))];
    this.#decisions = [
      ...this.#decisions,
      ...working.decisions.filter((d) => touched.decisions.has(d.decisionId)),
    ];
    this.#authorities = [
      ...this.#authorities,
      ...working.authorities.filter((a) => touched.authorities.has(a.authorityId)),
    ];
  }
}

class WorkingSet {
  tasks: TaskDefinition[];
  bindings: ModelBinding[];
  runs: AIRun[];
  decisions: AIDecision[];
  authorities: TaskAuthority[];

  constructor(snapshot: {
    tasks: TaskDefinition[];
    bindings: ModelBinding[];
    runs: AIRun[];
    decisions: AIDecision[];
    authorities: TaskAuthority[];
  }) {
    this.tasks = snapshot.tasks;
    this.bindings = snapshot.bindings;
    this.runs = snapshot.runs;
    this.decisions = snapshot.decisions;
    this.authorities = snapshot.authorities;
  }
}

class Touched {
  readonly tasks = new Set<string>();
  readonly taskKeys = new Set<string>();
  readonly bindings = new Set<string>();
  readonly bindingKeys = new Set<string>();
  readonly runs = new Set<string>();
  readonly runKeys = new Set<string>();
  readonly decisions = new Set<string>();
  readonly decisionKeys = new Set<string>();
  readonly authorities = new Set<string>();
  readonly authorityKeys = new Set<string>();
}

class InMemoryAIGatewayTransaction implements AIGatewayTransaction {
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

  findTaskById(taskId: string): Promise<TaskDefinition | null> {
    const found = this.#state.tasks.find((t) => t.taskId === taskId);
    return Promise.resolve(found === undefined ? null : sealTask(found));
  }

  findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskDefinition | null> {
    const found = this.#state.tasks.find((t) => t.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealTask(found));
  }

  insertTask(task: TaskDefinition): Promise<void> {
    if (this.#state.tasks.some((held) => held.taskId === task.taskId)) {
      return Promise.reject(
        new AIGatewayError(
          'duplicate-task-id',
          `task ${task.taskId} already exists. A task is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.tasks.some((held) => held.idempotencyKey === task.idempotencyKey)) {
      return Promise.reject(
        new AIGatewayError(
          'idempotency-key-reuse',
          `idempotency key "${task.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.tasks.push(sealTask(task));
    this.#touched.tasks.add(task.taskId);
    this.#touched.taskKeys.add(task.idempotencyKey);
    return Promise.resolve();
  }

  findBindingById(bindingId: string): Promise<ModelBinding | null> {
    const found = this.#state.bindings.find((b) => b.bindingId === bindingId);
    return Promise.resolve(found === undefined ? null : sealBinding(found));
  }

  findBindingByIdempotencyKey(idempotencyKey: string): Promise<ModelBinding | null> {
    const found = this.#state.bindings.find((b) => b.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealBinding(found));
  }

  findBindingsByCapability(capability: string): Promise<readonly ModelBinding[]> {
    const found = this.#state.bindings
      .filter((b) => b.capabilities.includes(capability as TaskDefinition['capability']))
      .sort((a, b) => a.priority - b.priority || a.bindingId.localeCompare(b.bindingId));
    return Promise.resolve(Object.freeze(found.map(sealBinding)));
  }

  insertBinding(binding: ModelBinding): Promise<void> {
    if (this.#state.bindings.some((held) => held.bindingId === binding.bindingId)) {
      return Promise.reject(
        new AIGatewayError(
          'duplicate-binding-id',
          `binding ${binding.bindingId} already exists. A binding is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.bindings.some((held) => held.idempotencyKey === binding.idempotencyKey)) {
      return Promise.reject(
        new AIGatewayError(
          'idempotency-key-reuse',
          `idempotency key "${binding.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.bindings.push(sealBinding(binding));
    this.#touched.bindings.add(binding.bindingId);
    this.#touched.bindingKeys.add(binding.idempotencyKey);
    return Promise.resolve();
  }

  findRunById(runId: string): Promise<AIRun | null> {
    const found = this.#state.runs.find((r) => r.runId === runId);
    return Promise.resolve(found === undefined ? null : sealRun(found));
  }

  findRunByIdempotencyKey(idempotencyKey: string): Promise<AIRun | null> {
    const found = this.#state.runs.find((r) => r.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealRun(found));
  }

  insertRun(run: AIRun): Promise<void> {
    if (this.#state.runs.some((held) => held.runId === run.runId)) {
      return Promise.reject(
        new AIGatewayError(
          'duplicate-run-id',
          `run ${run.runId} already exists. A run is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.runs.some((held) => held.idempotencyKey === run.idempotencyKey)) {
      return Promise.reject(
        new AIGatewayError(
          'idempotency-key-reuse',
          `idempotency key "${run.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.runs.push(sealRun(run));
    this.#touched.runs.add(run.runId);
    this.#touched.runKeys.add(run.idempotencyKey);
    return Promise.resolve();
  }

  findDecisionById(decisionId: string): Promise<AIDecision | null> {
    const found = this.#state.decisions.find((d) => d.decisionId === decisionId);
    return Promise.resolve(found === undefined ? null : sealDecision(found));
  }

  findDecisionByIdempotencyKey(idempotencyKey: string): Promise<AIDecision | null> {
    const found = this.#state.decisions.find((d) => d.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealDecision(found));
  }

  insertDecision(decision: AIDecision): Promise<void> {
    if (this.#state.decisions.some((held) => held.decisionId === decision.decisionId)) {
      return Promise.reject(
        new AIGatewayError(
          'duplicate-decision-id',
          `decision ${decision.decisionId} already exists. A decision is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.decisions.some((held) => held.idempotencyKey === decision.idempotencyKey)) {
      return Promise.reject(
        new AIGatewayError(
          'idempotency-key-reuse',
          `idempotency key "${decision.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.decisions.push(sealDecision(decision));
    this.#touched.decisions.add(decision.decisionId);
    this.#touched.decisionKeys.add(decision.idempotencyKey);
    return Promise.resolve();
  }

  findAuthorityById(authorityId: string): Promise<TaskAuthority | null> {
    const found = this.#state.authorities.find((a) => a.authorityId === authorityId);
    return Promise.resolve(found === undefined ? null : sealAuthority(found));
  }

  findAuthorityByIdempotencyKey(idempotencyKey: string): Promise<TaskAuthority | null> {
    const found = this.#state.authorities.find((a) => a.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealAuthority(found));
  }

  findAuthorityInForce(taskId: string, at: string): Promise<TaskAuthority | null> {
    // Latest grant at or before the instant. Ties are broken by authorityId so two grants sharing
    // an instant resolve the same way here as they do in SQL, rather than by insertion order.
    const candidates = this.#state.authorities
      .filter((a) => a.taskId === taskId && a.grantedAt <= at)
      .sort((a, b) => {
        const byInstant = b.grantedAt.localeCompare(a.grantedAt);
        return byInstant !== 0 ? byInstant : b.authorityId.localeCompare(a.authorityId);
      });
    const winner = candidates[0];
    return Promise.resolve(winner === undefined ? null : sealAuthority(winner));
  }

  insertAuthority(authority: TaskAuthority): Promise<void> {
    if (this.#state.authorities.some((held) => held.authorityId === authority.authorityId)) {
      return Promise.reject(
        new AIGatewayError(
          'duplicate-authority-id',
          `authority ${authority.authorityId} already exists. A grant is a new version, never an edit`,
        ),
      );
    }
    if (this.#state.authorities.some((held) => held.idempotencyKey === authority.idempotencyKey)) {
      return Promise.reject(
        new AIGatewayError(
          'idempotency-key-reuse',
          `idempotency key "${authority.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.authorities.push(sealAuthority(authority));
    this.#touched.authorities.add(authority.authorityId);
    this.#touched.authorityKeys.add(authority.idempotencyKey);
    return Promise.resolve();
  }
}
