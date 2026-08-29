/**
 * Shared fixtures for the K-13 AI Gateway suites.
 */

import {
  AIGatewayService,
  InMemoryAIGatewayRepository,
  MockAIProvider,
  type ExecuteTaskRequest,
  type GrantAuthorityRequest,
  type ModelBinding,
  type RecordDecisionRequest,
  type RegisterModelRequest,
  type RegisterTaskRequest,
  type TaskDefinition,
} from '../../kernel/ai-gateway/index.ts';

export interface Harness {
  readonly service: AIGatewayService;
  readonly repository: InMemoryAIGatewayRepository;
}

export function resolveMockProvider(provider: string): MockAIProvider {
  if (provider === 'mock') return new MockAIProvider();
  throw new Error(`provider ${provider} has no test adapter`);
}

export function build(): Harness {
  const repository = new InMemoryAIGatewayRepository();
  return { service: new AIGatewayService(repository, resolveMockProvider), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

export function registerTaskRequest(
  overrides: Partial<RegisterTaskRequest> = {},
): RegisterTaskRequest {
  const n = seq();
  return {
    taskId: `need.interpret_${n}`,
    taskName: 'Interpret Need',
    description: 'Turn a free-text need into structured attributes.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    capability: 'text',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_task_${n}`,
    ...overrides,
  };
}

export function taskRecord(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  const n = seq();
  return {
    taskId: `need.interpret_${n}`,
    taskName: 'Interpret Need',
    description: 'Turn a free-text need into structured attributes.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    capability: 'text',
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_task_${n}`,
    ...overrides,
  };
}

export function registerModelRequest(
  overrides: Partial<RegisterModelRequest> = {},
): RegisterModelRequest {
  const n = seq();
  return {
    bindingId: `bind_01HQZX${n}`,
    provider: 'mock',
    modelId: 'mock-model-v1',
    capabilities: ['text'],
    costPer1KInput: 5n,
    costPer1KOutput: 10n,
    costAssetTypeId: 'usd',
    priority: 1,
    enabled: true,
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_bind_${n}`,
    ...overrides,
  };
}

export function modelBinding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  const n = seq();
  return {
    bindingId: `bind_01HQZY${n}`,
    provider: 'mock',
    modelId: 'mock-model-v1',
    capabilities: ['text'],
    costPer1KInput: 5n,
    costPer1KOutput: 10n,
    costAssetTypeId: 'usd',
    priority: 1,
    enabled: true,
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_bind_${n}`,
    ...overrides,
  };
}

export function executeTaskRequest(
  overrides: Partial<ExecuteTaskRequest> = {},
): ExecuteTaskRequest {
  const n = seq();
  return {
    runId: `run_01HQZX${n}`,
    taskId: `need.interpret_${n}`,
    input: { text: 'I need a blue bicycle' },
    startedAt: '2026-04-01T12:00:00Z',
    finishedAt: '2026-04-01T12:00:01Z',
    correlationId: `corr_01HQZX${n}`,
    idempotencyKey: `idem_run_${n}`,
    requestedAuthority: 1,
    ...overrides,
  };
}

export function grantAuthorityRequest(
  overrides: Partial<GrantAuthorityRequest> = {},
): GrantAuthorityRequest {
  const n = seq();
  return {
    authorityId: `auth_01HQZX${n}`,
    taskId: `need.interpret_${n}`,
    maxAuthority: 4,
    suspended: false,
    rationale: 'Test fixture grant.',
    grantedBy: `operator_01HQZX${n}`,
    grantedAt: '2026-04-01T11:00:00Z',
    idempotencyKey: `idem_auth_${n}`,
    ...overrides,
  };
}

export function recordDecisionRequest(
  overrides: Partial<RecordDecisionRequest> = {},
): RecordDecisionRequest {
  const n = seq();
  return {
    decisionId: `dec_01HQZX${n}`,
    taskId: `need.interpret_${n}`,
    runId: null,
    policyLevel: 2,
    approved: true,
    explanation: 'Confidence is above threshold.',
    recordedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_dec_${n}`,
    ...overrides,
  };
}

export function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'need.interpret_testrow',
    task_name: 'Interpret Need',
    description: 'Turn a free-text need into structured attributes.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } } },
    output_schema: { type: 'object', properties: { result: { type: 'string' } } },
    capability: 'text',
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding_id: 'bind_01HQZXTESTROW',
    provider: 'mock',
    model_id: 'mock-model-v1',
    capabilities: ['text'],
    cost_per_1k_input: '5',
    cost_per_1k_output: '10',
    cost_asset_type_id: 'usd',
    priority: 1,
    enabled: true,
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_bind_01HQZXTESTROW',
    ...overrides,
  };
}

export function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run_01HQZXTESTROW',
    task_id: 'need.interpret_testrow',
    binding_id: 'bind_01HQZXTESTROW',
    input: { text: 'I need a blue bicycle' },
    output: { result: 'bicycle', colour: 'blue' },
    status: 'success',
    error_code: null,
    input_tokens: 5,
    output_tokens: 3,
    input_cost: '5',
    output_cost: '10',
    total_cost: '15',
    cost_asset_type_id: 'usd',
    authority_level: 1,
    started_at: '2026-04-01T12:00:00.000000Z',
    finished_at: '2026-04-01T12:00:01.000000Z',
    correlation_id: 'corr_01HQZXTESTROW',
    idempotency_key: 'idem_run_01HQZXTESTROW',
    ...overrides,
  };
}

export function authorityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    authority_id: 'auth_01HQZXTESTROW',
    task_id: 'need.interpret',
    max_authority: 2,
    suspended: false,
    rationale: 'Row fixture grant.',
    granted_by: 'operator_01HQZXROW',
    granted_at: '2026-04-01T11:00:00.000000Z',
    idempotency_key: 'idem_01HQZXAUTHROW',
    ...overrides,
  };
}

export function decisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: 'dec_01HQZXTESTROW',
    task_id: 'need.interpret_testrow',
    run_id: null,
    policy_level: 2,
    approved: true,
    explanation: 'Confidence is above threshold.',
    recorded_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_dec_01HQZXTESTROW',
    ...overrides,
  };
}
