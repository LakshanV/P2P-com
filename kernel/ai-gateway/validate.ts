/**
 * K-13 AI Gateway — validation of complete records, wherever they came from.
 *
 * One function per record type, called by the service on the way in and by the PostgreSQL decoder
 * on the way out. There is no second list of rules to keep in step.
 *
 * Owned by: K-13 AI Gateway.
 */

import { formatInstant, InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertAssetTypeId, assertOpaqueIdentifier, assertTaskId } from './registry.ts';
import {
  AIGatewayError,
  AUTHORITY_LEVELS,
  AUTHORITY_MEANINGS,
  CAPABILITIES,
  PROVIDERS,
  RUN_STATUSES,
  type AICost,
  type AIDecision,
  type AIRun,
  type AuthorityLevel,
  type Capability,
  type ModelBinding,
  type Provider,
  type RunStatus,
  type TaskAuthority,
  type TaskDefinition,
} from './types.ts';

/** Where the record came from. Only affects the wording of a refusal. */
export type RecordSource = 'request' | 'stored row';

export const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real record';

export function validateTask(candidate: unknown, source: RecordSource): TaskDefinition {
  try {
    return checkTask(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof AIGatewayError)) throw error;
    throw new AIGatewayError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const TASK_FIELDS: readonly string[] = [
  'taskId',
  'taskName',
  'description',
  'inputSchema',
  'outputSchema',
  'capability',
  'createdAt',
  'idempotencyKey',
];

function checkTask(candidate: unknown, source: RecordSource): TaskDefinition {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `a task definition must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!TASK_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `a task definition carried the unrecognised field "${key}"; the permitted fields are ` +
          TASK_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    taskId: assertTaskId(fields.taskId, 'taskId'),
    taskName: assertNonEmptyText(fields.taskName, 'taskName'),
    description: assertNonEmptyText(fields.description, 'description'),
    inputSchema: assertJsonSchema(fields.inputSchema, 'inputSchema'),
    outputSchema: assertJsonSchema(fields.outputSchema, 'outputSchema'),
    capability: assertCapability(fields.capability, 'capability'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateBinding(candidate: unknown, source: RecordSource): ModelBinding {
  try {
    return checkBinding(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof AIGatewayError)) throw error;
    throw new AIGatewayError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const BINDING_FIELDS: readonly string[] = [
  'bindingId',
  'provider',
  'modelId',
  'capabilities',
  'costPer1KInput',
  'costPer1KOutput',
  'costAssetTypeId',
  'priority',
  'enabled',
  'createdAt',
  'idempotencyKey',
];

function checkBinding(candidate: unknown, source: RecordSource): ModelBinding {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `a model binding must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!BINDING_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `a model binding carried the unrecognised field "${key}"; the permitted fields are ` +
          BINDING_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    bindingId: assertOpaqueIdentifier(fields.bindingId, 'bindingId'),
    provider: assertProvider(fields.provider, 'provider'),
    modelId: assertNonEmptyText(fields.modelId, 'modelId'),
    capabilities: assertCapabilities(fields.capabilities, 'capabilities'),
    costPer1KInput: assertNonNegativeBigInt(fields.costPer1KInput, 'costPer1KInput'),
    costPer1KOutput: assertNonNegativeBigInt(fields.costPer1KOutput, 'costPer1KOutput'),
    costAssetTypeId: assertAssetTypeId(fields.costAssetTypeId, 'costAssetTypeId'),
    priority: assertInteger(fields.priority, 'priority'),
    enabled: assertBoolean(fields.enabled, 'enabled'),
    createdAt: checkInstant(fields.createdAt, 'createdAt', source),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateRun(candidate: unknown, source: RecordSource): AIRun {
  try {
    return checkRun(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof AIGatewayError)) throw error;
    throw new AIGatewayError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const RUN_FIELDS: readonly string[] = [
  'runId',
  'taskId',
  'bindingId',
  'input',
  'output',
  'status',
  'errorCode',
  'cost',
  'authorityLevel',
  'startedAt',
  'finishedAt',
  'correlationId',
  'idempotencyKey',
];

function checkRun(candidate: unknown, source: RecordSource): AIRun {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `an AI run must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!RUN_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `an AI run carried the unrecognised field "${key}"; the permitted fields are ` +
          RUN_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    runId: assertOpaqueIdentifier(fields.runId, 'runId'),
    taskId: assertTaskId(fields.taskId, 'taskId'),
    bindingId: assertOpaqueIdentifier(fields.bindingId, 'bindingId'),
    input: assertJsonObject(fields.input, 'input'),
    output: assertJsonObject(fields.output, 'output'),
    status: assertRunStatus(fields.status, 'status'),
    errorCode: assertOptionalNonEmptyText(fields.errorCode, 'errorCode'),
    cost: assertCost(fields.cost, 'cost'),
    authorityLevel: assertAuthorityLevel(fields.authorityLevel, 'authorityLevel'),
    startedAt: checkInstant(fields.startedAt, 'startedAt', source),
    finishedAt: checkInstant(fields.finishedAt, 'finishedAt', source),
    correlationId: assertOpaqueIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

export function validateDecision(candidate: unknown, source: RecordSource): AIDecision {
  try {
    return checkDecision(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof AIGatewayError)) throw error;
    throw new AIGatewayError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/** The request-level fields that executeTask must validate before it knows the binding or output. */
const EXECUTE_REQUEST_FIELDS: readonly string[] = [
  'runId',
  'taskId',
  'input',
  'startedAt',
  'finishedAt',
  'correlationId',
  'idempotencyKey',
  'requestedAuthority',
];

export function validateExecuteRequest(candidate: unknown): {
  readonly runId: string;
  readonly taskId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestedAuthority: AuthorityLevel;
} {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `an execute request must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!EXECUTE_REQUEST_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `an execute request carried the unrecognised field "${key}"; the permitted fields are ` +
          EXECUTE_REQUEST_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    runId: assertOpaqueIdentifier(fields.runId, 'runId'),
    taskId: assertTaskId(fields.taskId, 'taskId'),
    input: assertJsonObject(fields.input, 'input'),
    startedAt: checkInstant(fields.startedAt, 'startedAt', 'request'),
    finishedAt: checkInstant(fields.finishedAt, 'finishedAt', 'request'),
    correlationId: assertOpaqueIdentifier(fields.correlationId, 'correlationId'),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    requestedAuthority: assertAuthorityLevel(fields.requestedAuthority, 'requestedAuthority'),
  };
}

const DECISION_FIELDS: readonly string[] = [
  'decisionId',
  'taskId',
  'runId',
  'policyLevel',
  'approved',
  'explanation',
  'recordedAt',
  'idempotencyKey',
];

function checkDecision(candidate: unknown, source: RecordSource): AIDecision {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `an AI decision must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!DECISION_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `an AI decision carried the unrecognised field "${key}"; the permitted fields are ` +
          DECISION_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    decisionId: assertOpaqueIdentifier(fields.decisionId, 'decisionId'),
    taskId: assertTaskId(fields.taskId, 'taskId'),
    runId: assertOptionalOpaqueIdentifier(fields.runId, 'runId'),
    policyLevel: assertPolicyLevel(fields.policyLevel, 'policyLevel'),
    approved: assertBoolean(fields.approved, 'approved'),
    explanation: assertNonEmptyText(fields.explanation, 'explanation'),
    recordedAt: checkInstant(fields.recordedAt, 'recordedAt', source),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

function assertCapability(value: unknown, field: string): Capability {
  if (typeof value !== 'string' || !(CAPABILITIES as readonly string[]).includes(value)) {
    throw new AIGatewayError(
      'invalid-capability',
      `${field} is "${String(value)}"; expected one of ${CAPABILITIES.join(', ')}`,
    );
  }
  return value as Capability;
}

function assertProvider(value: unknown, field: string): Provider {
  if (typeof value !== 'string' || !(PROVIDERS as readonly string[]).includes(value)) {
    throw new AIGatewayError(
      'invalid-provider',
      `${field} is "${String(value)}"; expected one of ${PROVIDERS.join(', ')}`,
    );
  }
  return value as Provider;
}

function assertCapabilities(value: unknown, field: string): readonly Capability[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AIGatewayError(
      'invalid-capability',
      `${field} must be a non-empty array of capabilities`,
    );
  }
  return value.map((entry, index) => assertCapability(entry, `${field}[${index}]`));
}

function assertJsonSchema(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} must be a JSON object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text`,
    );
  }
  return value;
}

function assertOptionalNonEmptyText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value === '') {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected non-empty text or null`,
    );
  }
  return value;
}

function assertOptionalOpaqueIdentifier(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return assertOpaqueIdentifier(value, field);
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a boolean`,
    );
  }
  return value;
}

function assertInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected an integer`,
    );
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  const number = assertInteger(value, field);
  if (number < 0) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${number}; expected a non-negative integer`,
    );
  }
  return number;
}

function assertNonNegativeBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new AIGatewayError(
        'invalid-cost',
        `${field} is negative; expected a non-negative integer`,
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AIGatewayError('invalid-cost', `${field} is not a non-negative safe integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) {
      throw new AIGatewayError(
        'invalid-cost',
        `${field} "${value}" is not a non-negative integer string`,
      );
    }
    return BigInt(value);
  }
  throw new AIGatewayError(
    'invalid-cost',
    `${field} is ${value === null ? 'null' : typeof value}; expected a non-negative integer`,
  );
}

function assertCost(value: unknown, field: string): AICost {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} must be an object, got ${value === null ? 'null' : typeof value}`,
    );
  }
  const cost = value as Record<string, unknown>;
  const costFields = [
    'inputTokens',
    'outputTokens',
    'inputCost',
    'outputCost',
    'totalCost',
    'assetTypeId',
  ];
  for (const key of Object.keys(cost)) {
    if (!costFields.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `${field} carried the unrecognised field "${key}"`,
      );
    }
  }
  return {
    inputTokens: assertNonNegativeInteger(cost.inputTokens, `${field}.inputTokens`),
    outputTokens: assertNonNegativeInteger(cost.outputTokens, `${field}.outputTokens`),
    inputCost: assertNonNegativeBigInt(cost.inputCost, `${field}.inputCost`),
    outputCost: assertNonNegativeBigInt(cost.outputCost, `${field}.outputCost`),
    totalCost: assertNonNegativeBigInt(cost.totalCost, `${field}.totalCost`),
    assetTypeId: assertAssetTypeId(cost.assetTypeId, `${field}.assetTypeId`),
  };
}

function assertPolicyLevel(value: unknown, field: string): number {
  const level = assertInteger(value, field);
  if (level < 0 || level > 4) {
    throw new AIGatewayError(
      'invalid-policy-level',
      `${field} is ${level}; expected an integer between 0 and 4`,
    );
  }
  return level;
}

/**
 * An authority level.
 *
 * Deliberately not defaulted. A run whose authority nobody stated is a run nobody authorised, and
 * inferring one here would put the gateway's own guess into the audit record.
 */
function assertAuthorityLevel(value: unknown, field: string): AuthorityLevel {
  // The membership test owns the whole check rather than delegating the integer part. A caller who
  // passed 1.5 has misunderstood the scale, and should be told that, not that it wanted an integer.
  if (typeof value !== 'number' || !(AUTHORITY_LEVELS as readonly number[]).includes(value)) {
    throw new AIGatewayError(
      'invalid-authority-level',
      `${field} is ${JSON.stringify(value) ?? String(value)}; expected one of ` +
        AUTHORITY_LEVELS.map((l) => `${l} (${AUTHORITY_MEANINGS[l] ?? ''})`).join(', '),
    );
  }
  return value as AuthorityLevel;
}

export function validateAuthority(candidate: unknown, source: RecordSource): TaskAuthority {
  try {
    return checkAuthority(candidate, source);
  } catch (error) {
    if (source === 'request' || !(error instanceof AIGatewayError)) throw error;
    throw new AIGatewayError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

const AUTHORITY_FIELDS: readonly string[] = [
  'authorityId',
  'taskId',
  'maxAuthority',
  'suspended',
  'rationale',
  'grantedBy',
  'grantedAt',
  'idempotencyKey',
];

function checkAuthority(candidate: unknown, source: RecordSource): TaskAuthority {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new AIGatewayError(
      'malformed-record',
      `an authority grant must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!AUTHORITY_FIELDS.includes(key)) {
      throw new AIGatewayError(
        'malformed-record',
        `an authority grant carried the unrecognised field "${key}"; the permitted fields are ` +
          AUTHORITY_FIELDS.join(', '),
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  return {
    authorityId: assertOpaqueIdentifier(fields.authorityId, 'authorityId'),
    taskId: assertTaskId(fields.taskId, 'taskId'),
    maxAuthority: assertAuthorityLevel(fields.maxAuthority, 'maxAuthority'),
    suspended: assertBoolean(fields.suspended, 'suspended'),
    rationale: assertRationale(fields.rationale, 'rationale'),
    grantedBy: assertOpaqueIdentifier(fields.grantedBy, 'grantedBy'),
    grantedAt: checkInstant(fields.grantedAt, 'grantedAt', source),
    idempotencyKey: assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey'),
  };
}

/** A grant without a stated reason cannot be reviewed later, so an empty one is refused. */
function assertRationale(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected the reason this ceiling ` +
        'was set. A grant nobody explained is a grant nobody can review',
    );
  }
  return value;
}

function assertRunStatus(value: unknown, field: string): RunStatus {
  if (typeof value !== 'string' || !(RUN_STATUSES as readonly string[]).includes(value)) {
    throw new AIGatewayError(
      'malformed-record',
      `${field} is "${String(value)}"; expected one of ${RUN_STATUSES.join(', ')}`,
    );
  }
  return value as RunStatus;
}

/** The exact form PostgreSQL to_char(...) emits for a timestamptz. */
const STORED_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function checkInstant(value: unknown, field: string, source: RecordSource): string {
  if (source === 'stored row') {
    if (typeof value !== 'string') {
      throw new AIGatewayError(
        'malformed-record',
        `${field} came back as ${value instanceof Date ? 'a Date' : typeof value} rather than ` +
          'text. Timestamps are projected through to_char precisely so the driver never parses them',
      );
    }
    if (STORED_INSTANT.exec(value) === null) {
      throw new AIGatewayError(
        'malformed-record',
        `${field} holds "${value}", which is not a finite UTC timestamp in the projected form ` +
          'YYYY-MM-DDTHH:MM:SS.ffffffZ',
      );
    }
    return formatInstant(parseInstant(value).epochMicros);
  }

  if (typeof value !== 'string') {
    throw new AIGatewayError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new AIGatewayError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
