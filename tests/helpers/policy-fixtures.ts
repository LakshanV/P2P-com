/**
 * Shared fixtures for the K-06 suites (FND-005b).
 *
 * The running example is v3 §24's commission rule engine, because it is the case the guide is most
 * specific about: rules varying by seller, tier, category, geography and transaction amount, with
 * every transaction storing the exact version applied. A fixture built on anything vaguer would
 * make the precedence and pinning tests read as arbitrary.
 *
 * The three fakes stand in for what K-06 refuses to determine itself, and each can misbehave — a
 * configuration lookup that refuses, an authority that is absent, a clock a test moves by hand.
 * Those are the interesting cases: every default in this component fails closed, and a fixture that
 * could only behave well would prove none of it.
 */

import {
  InMemoryPolicyRepository,
  PolicyService,
  type Clock,
  type ConfigurationLookup,
  type Decimal,
  type DraftPolicyRequest,
  type PolicyAuthority,
  type PolicyVersion,
} from '../../kernel/policy-engine/index.ts';

export const POLICY = 'commerce.commission';
export const AUTHORITY = 'k06-policy-console';
export const NOW = '2026-04-01T12:00:00Z';

export const SELLER = 'sel_01HQZXPOLICY001';
export const TIER = 'tier_01HQZXGOLD01';
export const CATEGORY = 'cat_01HQZXELECTRO';
export const COUNTRY = 'country_gb0001';

/** `1.7500` — seventeen and a half percent, exactly. */
export const rate = (units: string, scale = 4): Decimal => ({ units, scale });

/** A clock a test moves by hand. */
export class FixedClock implements Clock {
  #now: string;

  constructor(now = NOW) {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }

  set(instant: string): void {
    this.#now = instant;
  }
}

export interface StubConfigurationOptions {
  readonly value?: unknown;
  readonly versionId?: string;
  readonly refuseWith?: Error;
}

/**
 * K-05 Configuration, as this component sees it: one method, a key, a scope and an instant.
 *
 * Records what it was asked, so a test can assert K-06 reads configuration only when a policy
 * declares a `configured` output — and pins whatever version id came back.
 */
export class StubConfiguration implements ConfigurationLookup {
  #options: StubConfigurationOptions;
  readonly asked: { key: string; at: string }[] = [];

  constructor(options: StubConfigurationOptions = {}) {
    this.#options = options;
  }

  answerWith(options: StubConfigurationOptions): void {
    this.#options = options;
  }

  resolve(request: {
    readonly key: string;
    readonly scope: { readonly level: string; readonly id: string };
    readonly at: string;
  }): Promise<{ readonly value: unknown; readonly versionId: string }> {
    this.asked.push({ key: request.key, at: request.at });
    if (this.#options.refuseWith !== undefined) return Promise.reject(this.#options.refuseWith);
    return Promise.resolve({
      value: this.#options.value ?? 'threshold_01HQZXCONF',
      versionId: this.#options.versionId ?? 'cfgver_01HQZXCONF01',
    });
  }
}

/** An authority that permits authoring. The default in `ports.ts` refuses. */
export const POLICY_CONSOLE: PolicyAuthority = Object.freeze({
  authorityId: AUTHORITY,
  permitsAuthoring: () => true,
});

export interface Harness {
  readonly service: PolicyService;
  readonly repository: InMemoryPolicyRepository;
  readonly clock: FixedClock;
  readonly configuration: StubConfiguration;
}

export function build(
  options: {
    readonly repository?: InMemoryPolicyRepository;
    readonly configuration?: StubConfiguration;
    readonly authority?: PolicyAuthority;
    readonly now?: string;
  } = {},
): Harness {
  const repository = options.repository ?? new InMemoryPolicyRepository();
  const clock = new FixedClock(options.now);
  const configuration = options.configuration ?? new StubConfiguration();
  const service = new PolicyService({
    repository,
    clock,
    configuration,
    authority: options.authority ?? POLICY_CONSOLE,
  });
  return { service, repository, clock, configuration };
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_01HQZXK06${String(counter).padStart(5, '0')}`;
}

/** A commission schema: one rate, one hold period. The shape v3 §20 and §24 both describe. */
export const COMMISSION_SCHEMA = {
  rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
  holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
} as const;

/** The global fallback rule: 10%, held 45 days — v3 §20's "approximately 45 days". */
export const GLOBAL_RULE = {
  ruleId: 'rule_01HQZXGLOBAL1',
  selector: {},
  condition: null,
  outputs: {
    rate: { kind: 'decimal', value: rate('1000') },
    holdSeconds: { kind: 'duration-seconds', value: 3_888_000 },
  },
} as const;

export function draftRequest(overrides: Partial<DraftPolicyRequest> = {}): DraftPolicyRequest {
  return {
    draftId: nextId('draft'),
    policyKey: POLICY,
    outputSchema: COMMISSION_SCHEMA,
    rules: [GLOBAL_RULE],
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

/**
 * Draft, publish and activate in one step, which is what "this policy is in force" means.
 *
 * Returns the version, because every test about pinning needs the id a caller would store.
 */
export async function withActivePolicy(
  harness: Harness = build(),
  overrides: Partial<DraftPolicyRequest> = {},
  window: { readonly effectiveFrom?: string | null; readonly effectiveUntil?: string | null } = {},
): Promise<{ readonly harness: Harness; readonly version: PolicyVersion }> {
  const drafted = await harness.service.draft(draftRequest(overrides));
  const published = await harness.service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    effectiveFrom: window.effectiveFrom ?? null,
    effectiveUntil: window.effectiveUntil ?? null,
    idempotencyKey: nextId('idem'),
  });
  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: published.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  return { harness, version: published.version };
}

/** A stored draft row as the adapter's projection returns it. */
export function draftRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: 'draft_01HQZXTESTROW',
    policy_key: POLICY,
    output_schema: COMMISSION_SCHEMA,
    rules: [GLOBAL_RULE],
    default_outputs: null,
    notes: '',
    drafted_at: '2026-04-01T12:00:00.000000Z',
    drafted_by_kind: 'system',
    drafted_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTROW',
    request_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

export function versionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_version_id: 'polver_01HQZXTESTRW',
    policy_key: POLICY,
    version: 1,
    draft_id: 'draft_01HQZXTESTROW',
    output_schema: COMMISSION_SCHEMA,
    rules: [GLOBAL_RULE],
    default_outputs: null,
    effective_from: null,
    effective_until: null,
    published_at: '2026-04-01T12:00:00.123456Z',
    published_by_kind: 'system',
    published_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTRW2',
    request_fingerprint: 'b'.repeat(64),
    ...overrides,
  };
}

export function activationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activation_id: 'act_01HQZXTESTROW1',
    policy_key: POLICY,
    policy_version_id: 'polver_01HQZXTESTRW',
    supersedes_version_id: null,
    activated_at: '2026-04-01T12:00:00.654321Z',
    activated_by_kind: 'system',
    activated_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTRW3',
    request_fingerprint: 'c'.repeat(64),
    ...overrides,
  };
}

export function retirementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    retirement_id: 'ret_01HQZXTESTROW1',
    policy_key: POLICY,
    reason: 'the commission model moved to the new tier structure',
    retired_at: '2026-04-01T12:00:00.000000Z',
    retired_by_kind: 'system',
    retired_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTRW4',
    request_fingerprint: 'd'.repeat(64),
    ...overrides,
  };
}
