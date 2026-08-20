/**
 * Shared fixtures for the K-11 suites (FND-005c).
 *
 * The running example is a small slice of a real catalogue — `goods`, `goods.electronics`,
 * `goods.electronics.mobile-phone` — because the hierarchy tests only mean something against a
 * lineage somebody might actually publish. A fixture built on `a → b → c` would make the
 * cross-tenant and missing-parent cases read as arbitrary.
 *
 * The four fakes stand in for what K-11 refuses to determine itself, and each can misbehave: a
 * configuration lookup that permits nothing, a policy port that refuses, a registrar that is absent
 * or belongs to another tenant, and a clock a test moves by hand. Those are the interesting cases —
 * every default in this component fails closed, and a fixture that could only behave well would
 * prove none of it.
 */

import {
  CommerceUnitRegistryService,
  InMemoryCommerceUnitRepository,
  UNIT_KINDS,
  type Clock,
  type ConfigurationLookup,
  type PolicyProvenance,
  type PublishTypeRequest,
  type RegistrarAuthority,
  type UnitTypeVersion,
} from '../../kernel/commerce-unit-registry/index.ts';

export const ROOT = 'goods';
export const BRANCH = 'goods.electronics';
export const LEAF = 'goods.electronics.mobile-phone';
export const AUTHORITY = 'k11-registry-console';
export const TENANT = 'tnt_01HQZXTENANT01';
export const OTHER_TENANT = 'tnt_01HQZXTENANT02';
export const RISK_POLICY = 'commerce.risk-pack';
export const NOW = '2026-04-01T12:00:00Z';

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
  /**
   * Which kinds this deployment permits. Defaults to all of v3 §11's.
   *
   * Typed `unknown` and not `readonly string[]`, because the cases worth having are the ones where
   * K-05 answers with something that is not a list of kinds at all — a string, a number, an object,
   * `null`. K-11 must refuse each of those rather than guess a vocabulary, and a fixture that could
   * only hand back a well-formed list could not ask it to.
   */
  readonly permitted?: unknown;
  readonly refuseWith?: Error;
}

/** K-05 Configuration, as this component sees it: one key, one scope, one instant. */
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
      value: this.#options.permitted ?? [...UNIT_KINDS],
      versionId: 'cfgver_01HQZXKINDS1',
    });
  }
}

export interface StubPolicyOptions {
  readonly policyVersionId?: string;
  readonly refuseWith?: Error;
}

/** K-06 Policy Engine, used for provenance only: K-11 takes the version id and nothing else. */
export class StubPolicy implements PolicyProvenance {
  #options: StubPolicyOptions;
  readonly asked: { policyKey: string; at: string | undefined }[] = [];

  constructor(options: StubPolicyOptions = {}) {
    this.#options = options;
  }

  answerWith(options: StubPolicyOptions): void {
    this.#options = options;
  }

  evaluate(request: {
    readonly policyKey: string;
    readonly at?: string;
  }): Promise<{ readonly policyVersionId: string }> {
    this.asked.push({ policyKey: request.policyKey, at: request.at });
    if (this.#options.refuseWith !== undefined) return Promise.reject(this.#options.refuseWith);
    return Promise.resolve({
      policyVersionId: this.#options.policyVersionId ?? 'polver_01HQZXRISK01',
    });
  }
}

/** A registrar for the shared platform vocabulary. The default in `ports.ts` refuses. */
export const PLATFORM_REGISTRAR: RegistrarAuthority = Object.freeze({
  authorityId: AUTHORITY,
  owner: Object.freeze({ kind: 'platform' as const }),
  permitsRegistration: () => true,
});

/** A registrar for one tenant, which may extend the platform vocabulary and nothing else. */
export const tenantRegistrar = (tenantId = TENANT): RegistrarAuthority =>
  Object.freeze({
    authorityId: `k11-tenant-console-${tenantId.slice(-2)}`,
    owner: Object.freeze({ kind: 'tenant' as const, tenantId }),
    permitsRegistration: () => true,
  });

export interface Harness {
  readonly service: CommerceUnitRegistryService;
  readonly repository: InMemoryCommerceUnitRepository;
  readonly clock: FixedClock;
  readonly configuration: StubConfiguration;
  readonly policy: StubPolicy;
}

export function build(
  options: {
    readonly repository?: InMemoryCommerceUnitRepository;
    readonly configuration?: StubConfiguration;
    readonly policy?: StubPolicy;
    readonly registrar?: RegistrarAuthority;
    readonly now?: string;
  } = {},
): Harness {
  const repository = options.repository ?? new InMemoryCommerceUnitRepository();
  const clock = new FixedClock(options.now);
  const configuration = options.configuration ?? new StubConfiguration();
  const policy = options.policy ?? new StubPolicy();
  const service = new CommerceUnitRegistryService({
    repository,
    clock,
    configuration,
    policy,
    registrar: options.registrar ?? PLATFORM_REGISTRAR,
  });
  return { service, repository, clock, configuration, policy };
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_01HQZXK11${String(counter).padStart(5, '0')}`;
}

/** The measures a goods type is priced in — v3 §12's goods family. */
export const GOODS_MEASURES = [
  { family: 'goods', unit: 'each' },
  { family: 'goods', unit: 'kilogram' },
] as const;

export function publishRequest(overrides: Partial<PublishTypeRequest> = {}): PublishTypeRequest {
  return {
    typeVersionId: nextId('typever'),
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

/** Publish and activate one type, which is what "this category is in force" means. */
export async function withActiveType(
  harness: Harness = build(),
  overrides: Partial<PublishTypeRequest> = {},
): Promise<{ readonly harness: Harness; readonly version: UnitTypeVersion }> {
  const published = await harness.service.publish(publishRequest(overrides));
  await harness.service.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  return { harness, version: published.version };
}

/**
 * The three-level lineage every hierarchy test starts from: goods → electronics → mobile phone.
 *
 * Built through the real service, so the ancestry under test is one the component actually
 * accepted rather than one a fixture asserted into the store.
 */
export async function withLineage(
  harness: Harness = build(),
): Promise<{ readonly harness: Harness; readonly keys: readonly string[] }> {
  for (const [typeKey, parentTypeKey] of [
    [ROOT, null],
    [BRANCH, ROOT],
    [LEAF, BRANCH],
  ] as const) {
    await withActiveType(harness, { typeKey, parentTypeKey });
  }
  return { harness, keys: [ROOT, BRANCH, LEAF] };
}

/** A stored version row as the adapter's projection returns it. */
export function versionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type_version_id: 'typever_01HQZXTESTR',
    type_key: ROOT,
    version: 1,
    kind: 'new-product',
    owner_kind: 'platform',
    owner_tenant_id: null,
    parent_type_key: null,
    measures: GOODS_MEASURES,
    risk_policy_key: null,
    effective_from: null,
    effective_until: null,
    published_at: '2026-04-01T12:00:00.123456Z',
    published_by_kind: 'system',
    published_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTROW',
    request_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

export function activationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activation_id: 'act_01HQZXTESTROW1',
    type_key: ROOT,
    type_version_id: 'typever_01HQZXTESTR',
    supersedes_version_id: null,
    risk_policy_version_id: null,
    activated_at: '2026-04-01T12:00:00.654321Z',
    activated_by_kind: 'system',
    activated_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTRW2',
    request_fingerprint: 'b'.repeat(64),
    ...overrides,
  };
}

export function retirementRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    retirement_id: 'ret_01HQZXTESTROW1',
    type_key: ROOT,
    reason: 'the category was folded into the new taxonomy',
    retired_at: '2026-04-01T12:00:00.000000Z',
    retired_by_kind: 'system',
    retired_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTRW3',
    request_fingerprint: 'c'.repeat(64),
    ...overrides,
  };
}
