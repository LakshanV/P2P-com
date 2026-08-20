/**
 * Shared fixtures for the K-07 suites (FND-004e).
 *
 * The three fakes here stand in for the three things K-07 refuses to determine itself: a clock a
 * test moves by hand, a configuration lookup that can answer, refuse or throw, and an
 * administration authority that can be present or absent. Each is written so a test can make it
 * misbehave — those are the interesting cases, because every default in this component fails
 * closed and a fixture that could only behave well would prove none of it.
 */

import {
  FeatureFlagService,
  InMemoryFeatureFlagRepository,
  fingerprintVersionRequest,
  type Clock,
  type ConfigurationLookup,
  type FlagAdministrator,
  type FlagVersion,
  type PublishVersionRequest,
  type Scope,
} from '../../kernel/feature-flags/index.ts';

export const FLAG = 'commerce.autonomous-purchasing';
export const AUTHORITY = 'k07-release-console';
export const SALT = 'salt01HQZXFLAG01';
export const NOW = '2026-04-01T12:00:00Z';
export const SUBJECT_KEY = 'sub_01HQZXFLAG0001';

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
  /** What `platform.deployment.stage` resolves to, or undefined for "no value". */
  readonly stage?: unknown;
  /** Make K-05 throw, which must not become an internal deployment. */
  readonly refuseWith?: Error;
}

/**
 * K-05 Configuration, as this component sees it: one method, a key and a scope.
 *
 * Records what it was asked, so a test can assert K-07 reads exactly one registered key and asks
 * for it only when a version actually needs it.
 */
export class StubConfiguration implements ConfigurationLookup {
  #options: StubConfigurationOptions;
  readonly asked: { key: string; scope: Scope }[] = [];

  constructor(options: StubConfigurationOptions = {}) {
    this.#options = options;
  }

  answerWith(options: StubConfigurationOptions): void {
    this.#options = options;
  }

  resolve(request: {
    readonly key: string;
    readonly scope: Scope;
  }): Promise<{ readonly value: unknown } | null> {
    this.asked.push({ key: request.key, scope: request.scope });
    if (this.#options.refuseWith !== undefined) return Promise.reject(this.#options.refuseWith);
    if (this.#options.stage === undefined) return Promise.resolve(null);
    return Promise.resolve({ value: this.#options.stage });
  }
}

/** An authority that permits administration. The default in `ports.ts` refuses. */
export const RELEASE_CONSOLE: FlagAdministrator = Object.freeze({
  authorityId: AUTHORITY,
  permitsAdministration: () => true,
});

export interface Harness {
  readonly service: FeatureFlagService;
  readonly repository: InMemoryFeatureFlagRepository;
  readonly clock: FixedClock;
  readonly configuration: StubConfiguration;
}

export function build(
  options: {
    readonly repository?: InMemoryFeatureFlagRepository;
    readonly configuration?: StubConfiguration;
    readonly authority?: FlagAdministrator;
    readonly now?: string;
  } = {},
): Harness {
  const repository = options.repository ?? new InMemoryFeatureFlagRepository();
  const clock = new FixedClock(options.now);
  const configuration = options.configuration ?? new StubConfiguration();
  const service = new FeatureFlagService({
    repository,
    clock,
    configuration,
    authority: options.authority ?? RELEASE_CONSOLE,
  });
  return { service, repository, clock, configuration };
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_01HQZXK07${String(counter).padStart(5, '0')}`;
}

export function publishRequest(
  overrides: Partial<PublishVersionRequest> = {},
): PublishVersionRequest {
  return {
    flagVersionId: nextId('flagver'),
    flagKey: FLAG,
    state: 'on',
    supportedScopes: ['global'],
    rolloutSalt: SALT,
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

/** Publish a version and activate it, which is what "this flag is doing X" means. */
export async function withActiveFlag(
  harness: Harness = build(),
  overrides: Partial<PublishVersionRequest> = {},
): Promise<{ readonly harness: Harness; readonly version: FlagVersion }> {
  const published = await harness.service.publish(publishRequest(overrides));
  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: published.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  return { harness, version: published.version };
}

/** A stored version row as the adapter's projection returns it. */
export function versionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flag_version_id: 'flagver_01HQZXTESTROW',
    flag_key: FLAG,
    version: 1,
    state: 'on',
    supported_scopes: ['global'],
    rules: [],
    percentage: 0,
    rollout_salt: SALT,
    not_before: null,
    not_after: null,
    published_at: '2026-04-01T12:00:00.000000Z',
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
    flag_key: FLAG,
    flag_version_id: 'flagver_01HQZXTESTROW',
    supersedes_version_id: null,
    activated_at: '2026-04-01T12:00:00.000000Z',
    activated_by_kind: 'system',
    activated_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTROWA',
    request_fingerprint: 'b'.repeat(64),
    ...overrides,
  };
}

export function lifecycleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt_01HQZXTESTROW1',
    flag_key: FLAG,
    kind: 'kill',
    reason: 'the supplier feed started quoting in the wrong currency',
    recorded_at: '2026-04-01T12:00:00.000000Z',
    recorded_by_kind: 'system',
    recorded_by_id: AUTHORITY,
    idempotency_key: 'idem_01HQZXTESTROWL',
    request_fingerprint: 'c'.repeat(64),
    ...overrides,
  };
}

/** A complete stored version, for seeding the reference repository directly. */
export function storedVersion(overrides: Partial<FlagVersion> = {}): FlagVersion {
  return {
    flagVersionId: nextId('flagver'),
    flagKey: FLAG,
    version: 1,
    state: 'on',
    supportedScopes: ['global'],
    rules: [],
    percentage: 0,
    rolloutSalt: SALT,
    notBefore: null,
    notAfter: null,
    publishedAt: NOW,
    publishedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: nextId('idem'),
    requestFingerprint: fingerprintVersionRequest({
      flagVersionId: 'seeded',
      flagKey: FLAG,
      version: 1,
      state: 'on',
      supportedScopes: ['global'],
      rules: [],
      percentage: 0,
      rolloutSalt: SALT,
      notBefore: null,
      notAfter: null,
      authorityId: AUTHORITY,
    }),
    ...overrides,
  };
}
