/**
 * K-13 AI Gateway — the PostgreSQL adapter.
 *
 * Implements the persistence port against `kernel_ai_gateway`. It knows SQL and nothing else: no
 * validation, no routing, no cost arithmetic. Those live in the service, where they can be tested
 * without a server.
 *
 * Every `timestamptz` is projected as UTC text. Costs are stored as `bigint` and read as strings from
 * the driver, then converted back to `bigint` so the service never sees a floating-point value.
 *
 * No statement names another unit's schema, and there is no foreign key out of `kernel_ai_gateway`.
 * The module's outbox table lives in the same schema.
 *
 * Owned by: K-13 AI Gateway.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import { sealAuthority, sealBinding, sealDecision, sealRun, sealTask } from './immutable.ts';
import type { AIGatewayRepository, AIGatewayTransaction } from './repository.ts';
import {
  validateAuthority,
  validateBinding,
  validateDecision,
  validateRun,
  validateTask,
} from './validate.ts';
import {
  AIGatewayError,
  type AIGatewayErrorCode,
  type AIDecision,
  type AIRun,
  type ModelBinding,
  type TaskDefinition,
  type TaskAuthority,
} from './types.ts';

export const AI_GATEWAY_SCHEMA = 'kernel_ai_gateway';
export const TASK_TABLE = `${AI_GATEWAY_SCHEMA}.task_definition`;
export const BINDING_TABLE = `${AI_GATEWAY_SCHEMA}.model_binding`;
export const RUN_TABLE = `${AI_GATEWAY_SCHEMA}.ai_run`;
export const DECISION_TABLE = `${AI_GATEWAY_SCHEMA}.ai_decision`;
export const AUTHORITY_TABLE = `${AI_GATEWAY_SCHEMA}.task_authority`;
export const OUTBOX_TABLE = `${AI_GATEWAY_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const AUTHORITY_CONSTRAINTS: Readonly<
  Record<string, { readonly code: AIGatewayErrorCode; readonly explanation: string }>
> = {
  task_authority_pkey: {
    code: 'duplicate-authority-id',
    explanation:
      'an authority grant with this id already exists; a grant is a version, not an edit',
  },
  task_authority_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for an authority grant',
  },
};

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: AIGatewayErrorCode; readonly explanation: string }>
> = {
  ...AUTHORITY_CONSTRAINTS,
  task_definition_pkey: {
    code: 'duplicate-task-id',
    explanation: 'a task with this id already exists, and a task is never overwritten',
  },
  task_definition_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a task',
  },
  model_binding_pkey: {
    code: 'duplicate-binding-id',
    explanation: 'a binding with this id already exists, and a binding is never overwritten',
  },
  model_binding_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a binding',
  },
  ai_run_pkey: {
    code: 'duplicate-run-id',
    explanation: 'a run with this id already exists, and a run is never overwritten',
  },
  ai_run_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a run',
  },
  ai_decision_pkey: {
    code: 'duplicate-decision-id',
    explanation: 'a decision with this id already exists, and a decision is never overwritten',
  },
  ai_decision_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already been used for a decision',
  },
};

function normalizeDatabaseError(error: unknown, operation: string): unknown {
  if (error instanceof AIGatewayError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new AIGatewayError(meaning.code, `${operation} was refused: ${meaning.explanation}`);
}

const TASK_COLUMNS = [
  'task_id',
  'task_name',
  'description',
  'input_schema',
  'output_schema',
  'capability',
  'created_at',
  'idempotency_key',
] as const;

const BINDING_COLUMNS = [
  'binding_id',
  'provider',
  'model_id',
  'capabilities',
  'cost_per_1k_input',
  'cost_per_1k_output',
  'cost_asset_type_id',
  'priority',
  'enabled',
  'created_at',
  'idempotency_key',
] as const;

const RUN_COLUMNS = [
  'run_id',
  'task_id',
  'binding_id',
  'input',
  'output',
  'status',
  'error_code',
  'input_tokens',
  'output_tokens',
  'input_cost',
  'output_cost',
  'total_cost',
  'cost_asset_type_id',
  'authority_level',
  'started_at',
  'finished_at',
  'correlation_id',
  'idempotency_key',
] as const;

const AUTHORITY_COLUMNS = [
  'authority_id',
  'task_id',
  'max_authority',
  'suspended',
  'rationale',
  'granted_by',
  'granted_at',
  'idempotency_key',
] as const;

const DECISION_COLUMNS = [
  'decision_id',
  'task_id',
  'run_id',
  'policy_level',
  'approved',
  'explanation',
  'recorded_at',
  'idempotency_key',
] as const;

const TASK_PROJECTION = [
  'task_id',
  'task_name',
  'description',
  'input_schema',
  'output_schema',
  'capability',
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
  'idempotency_key',
].join(', ');

const BINDING_PROJECTION = [
  'binding_id',
  'provider',
  'model_id',
  'capabilities',
  'cost_per_1k_input::text AS cost_per_1k_input',
  'cost_per_1k_output::text AS cost_per_1k_output',
  'cost_asset_type_id',
  'priority',
  'enabled',
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
  'idempotency_key',
].join(', ');

const RUN_PROJECTION = [
  'run_id',
  'task_id',
  'binding_id',
  'input',
  'output',
  'status',
  'error_code',
  'input_tokens',
  'output_tokens',
  'input_cost::text AS input_cost',
  'output_cost::text AS output_cost',
  'total_cost::text AS total_cost',
  'cost_asset_type_id',
  'authority_level',
  `to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at`,
  `to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at`,
  'correlation_id',
  'idempotency_key',
].join(', ');

const DECISION_PROJECTION = [
  'decision_id',
  'task_id',
  'run_id',
  'policy_level',
  'approved',
  'explanation',
  `to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`,
  'idempotency_key',
].join(', ');

const AUTHORITY_PROJECTION = [
  'authority_id',
  'task_id',
  'max_authority',
  'suspended',
  'rationale',
  'granted_by',
  `to_char(granted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS granted_at`,
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMN_NAMES = [
  'outbox_id',
  'idempotency_key',
  'kind',
  'payload',
  'recorded_at',
  'producer',
  'correlation_id',
  'processed_at',
  'retry_count',
  'last_error',
] as const;
const OUTBOX_COLUMNS = OUTBOX_COLUMN_NAMES.join(', ');

function text(value: unknown, column: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AIGatewayError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function optionalText(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-record',
      `${column} is ${typeof value}; expected text or null`,
    );
  }
  return value === '' ? null : value;
}

function booleanFrom(value: unknown, column: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) {
    throw new AIGatewayError('malformed-record', `${column} is null; expected a boolean`);
  }
  throw new AIGatewayError('malformed-record', `${column} is ${typeof value}; expected a boolean`);
}

function integer(value: unknown, column: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new AIGatewayError('malformed-record', `${column} is not an integer`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (String(parsed) !== value) {
      throw new AIGatewayError('malformed-record', `${column} "${value}" is not a valid integer`);
    }
    return parsed;
  }
  throw new AIGatewayError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected an integer`,
  );
}

function amount(value: unknown, column: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new AIGatewayError(
        'malformed-record',
        `${column} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AIGatewayError('malformed-record', `${column} is not a non-negative safe integer`);
    }
    return BigInt(value);
  }
  throw new AIGatewayError(
    'malformed-record',
    `${column} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function textArray(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected an array of text`,
    );
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new AIGatewayError(
        'malformed-record',
        `${column}[${index}] is ${typeof entry}; expected text`,
      );
    }
    return entry;
  });
}

function jsonObject(value: unknown, column: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${column} is ${value === null ? 'null' : typeof value}; expected a JSON object`,
    );
  }
  return value as Record<string, unknown>;
}

export function toTask(row: Record<string, unknown>): TaskDefinition {
  return sealTask(
    validateTask(
      {
        taskId: text(row.task_id, 'task_id'),
        taskName: text(row.task_name, 'task_name'),
        description: text(row.description, 'description'),
        inputSchema: jsonObject(row.input_schema, 'input_schema'),
        outputSchema: jsonObject(row.output_schema, 'output_schema'),
        capability: text(row.capability, 'capability'),
        createdAt: row.created_at,
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toBinding(row: Record<string, unknown>): ModelBinding {
  return sealBinding(
    validateBinding(
      {
        bindingId: text(row.binding_id, 'binding_id'),
        provider: text(row.provider, 'provider'),
        modelId: text(row.model_id, 'model_id'),
        capabilities: textArray(row.capabilities, 'capabilities'),
        costPer1KInput: row.cost_per_1k_input,
        costPer1KOutput: row.cost_per_1k_output,
        costAssetTypeId: text(row.cost_asset_type_id, 'cost_asset_type_id'),
        priority: integer(row.priority, 'priority'),
        enabled: booleanFrom(row.enabled, 'enabled'),
        createdAt: row.created_at,
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toRun(row: Record<string, unknown>): AIRun {
  return sealRun(
    validateRun(
      {
        runId: text(row.run_id, 'run_id'),
        taskId: text(row.task_id, 'task_id'),
        bindingId: text(row.binding_id, 'binding_id'),
        input: jsonObject(row.input, 'input'),
        output: jsonObject(row.output, 'output'),
        status: text(row.status, 'status'),
        errorCode: optionalText(row.error_code, 'error_code'),
        cost: {
          inputTokens: integer(row.input_tokens, 'input_tokens'),
          outputTokens: integer(row.output_tokens, 'output_tokens'),
          inputCost: amount(row.input_cost, 'input_cost'),
          outputCost: amount(row.output_cost, 'output_cost'),
          totalCost: amount(row.total_cost, 'total_cost'),
          assetTypeId: text(row.cost_asset_type_id, 'cost_asset_type_id'),
        },
        authorityLevel: integer(row.authority_level, 'authority_level'),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        correlationId: text(row.correlation_id, 'correlation_id'),
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toAuthority(row: Record<string, unknown>): TaskAuthority {
  return sealAuthority(
    validateAuthority(
      {
        authorityId: text(row.authority_id, 'authority_id'),
        taskId: text(row.task_id, 'task_id'),
        maxAuthority: integer(row.max_authority, 'max_authority'),
        suspended: booleanFrom(row.suspended, 'suspended'),
        rationale: text(row.rationale, 'rationale'),
        grantedBy: text(row.granted_by, 'granted_by'),
        grantedAt: row.granted_at,
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

export function toDecision(row: Record<string, unknown>): AIDecision {
  return sealDecision(
    validateDecision(
      {
        decisionId: text(row.decision_id, 'decision_id'),
        taskId: text(row.task_id, 'task_id'),
        runId: optionalText(row.run_id, 'run_id'),
        policyLevel: integer(row.policy_level, 'policy_level'),
        approved: booleanFrom(row.approved, 'approved'),
        explanation: text(row.explanation, 'explanation'),
        recordedAt: row.recorded_at,
        idempotencyKey: text(row.idempotency_key, 'idempotency_key'),
      },
      'stored row',
    ),
  );
}

const TRANSACTION_CONTROL =
  /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

export function enlistedClient(client: DatabaseClient): DatabaseClient {
  return {
    query<QueryRow = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      if (TRANSACTION_CONTROL.test(sql)) {
        return Promise.reject(
          new AIGatewayError(
            'nested-transaction',
            `an enlisted AI gateway write may not issue "${sql.trim().split(/\s+/, 2).join(' ')}". ` +
              'The transaction belongs to the caller',
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export class EnlistedAIGatewayRepository implements AIGatewayRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: AIGatewayTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresAIGatewayTransaction(this.#client));
  }
}

export class PostgresAIGatewayRepository implements AIGatewayRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): AIGatewayRepository {
    return new EnlistedAIGatewayRepository(client);
  }

  async withTransaction<T>(body: (tx: AIGatewayTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresAIGatewayTransaction(client));
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

export const TIMESTAMP_COLUMNS = [
  'created_at',
  'started_at',
  'finished_at',
  'recorded_at',
] as const;

class PostgresAIGatewayTransaction implements AIGatewayTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${OUTBOX_TABLE} (${OUTBOX_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        entry.outboxId,
        entry.idempotencyKey,
        entry.kind,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.producer,
        entry.correlationId,
        entry.processedAt,
        entry.retryCount,
        entry.lastError,
      ],
    );
  }

  async findTaskById(taskId: string): Promise<TaskDefinition | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${TASK_PROJECTION} FROM ${TASK_TABLE} WHERE task_id = $1;`,
      [taskId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTask(row);
  }

  async findTaskByIdempotencyKey(idempotencyKey: string): Promise<TaskDefinition | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${TASK_PROJECTION} FROM ${TASK_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTask(row);
  }

  async insertTask(task: TaskDefinition): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${TASK_TABLE} (${TASK_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          task.taskId,
          task.taskName,
          task.description,
          JSON.stringify(task.inputSchema),
          JSON.stringify(task.outputSchema),
          task.capability,
          task.createdAt,
          task.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertTask');
    }
  }

  async findBindingById(bindingId: string): Promise<ModelBinding | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE} WHERE binding_id = $1;`,
      [bindingId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBinding(row);
  }

  async findBindingByIdempotencyKey(idempotencyKey: string): Promise<ModelBinding | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toBinding(row);
  }

  async findBindingsByCapability(capability: string): Promise<readonly ModelBinding[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${BINDING_PROJECTION} FROM ${BINDING_TABLE}
       WHERE $1 = ANY(capabilities) AND enabled = true
       ORDER BY priority ASC, binding_id ASC;`,
      [capability],
    );
    return Object.freeze(result.rows.map(toBinding));
  }

  async insertBinding(binding: ModelBinding): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${BINDING_TABLE} (${BINDING_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          binding.bindingId,
          binding.provider,
          binding.modelId,
          binding.capabilities,
          binding.costPer1KInput,
          binding.costPer1KOutput,
          binding.costAssetTypeId,
          binding.priority,
          binding.enabled,
          binding.createdAt,
          binding.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertBinding');
    }
  }

  async findRunById(runId: string): Promise<AIRun | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RUN_PROJECTION} FROM ${RUN_TABLE} WHERE run_id = $1;`,
      [runId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRun(row);
  }

  async findRunByIdempotencyKey(idempotencyKey: string): Promise<AIRun | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${RUN_PROJECTION} FROM ${RUN_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRun(row);
  }

  async insertRun(run: AIRun): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${RUN_TABLE} (${RUN_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18);`,
        [
          run.runId,
          run.taskId,
          run.bindingId,
          JSON.stringify(run.input),
          JSON.stringify(run.output),
          run.status,
          run.errorCode,
          run.cost.inputTokens,
          run.cost.outputTokens,
          run.cost.inputCost,
          run.cost.outputCost,
          run.cost.totalCost,
          run.cost.assetTypeId,
          run.authorityLevel,
          run.startedAt,
          run.finishedAt,
          run.correlationId,
          run.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertRun');
    }
  }

  async findDecisionById(decisionId: string): Promise<AIDecision | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DECISION_PROJECTION} FROM ${DECISION_TABLE} WHERE decision_id = $1;`,
      [decisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecision(row);
  }

  async findDecisionByIdempotencyKey(idempotencyKey: string): Promise<AIDecision | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${DECISION_PROJECTION} FROM ${DECISION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDecision(row);
  }

  async insertDecision(decision: AIDecision): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${DECISION_TABLE} (${DECISION_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          decision.decisionId,
          decision.taskId,
          decision.runId,
          decision.policyLevel,
          decision.approved,
          decision.explanation,
          decision.recordedAt,
          decision.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertDecision');
    }
  }

  async findAuthorityById(authorityId: string): Promise<TaskAuthority | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${AUTHORITY_PROJECTION} FROM ${AUTHORITY_TABLE} WHERE authority_id = $1;`,
      [authorityId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAuthority(row);
  }

  async findAuthorityByIdempotencyKey(idempotencyKey: string): Promise<TaskAuthority | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${AUTHORITY_PROJECTION} FROM ${AUTHORITY_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAuthority(row);
  }

  async findAuthorityInForce(taskId: string, at: string): Promise<TaskAuthority | null> {
    // Latest grant at or before the instant. The authority_id tiebreak matches the in-memory
    // reference implementation, so two grants sharing an instant resolve identically in both.
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${AUTHORITY_PROJECTION} FROM ${AUTHORITY_TABLE}
        WHERE task_id = $1 AND granted_at <= $2
        ORDER BY granted_at DESC, authority_id DESC
        LIMIT 1;`,
      [taskId, at],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAuthority(row);
  }

  async insertAuthority(authority: TaskAuthority): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${AUTHORITY_TABLE} (${AUTHORITY_COLUMNS.join(', ')})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          authority.authorityId,
          authority.taskId,
          authority.maxAuthority,
          authority.suspended,
          authority.rationale,
          authority.grantedBy,
          authority.grantedAt,
          authority.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error, 'insertAuthority');
    }
  }
}
