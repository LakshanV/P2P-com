/**
 * K-11 Commerce Unit Registry — what an owner scope and an origin may carry (FND-005c).
 *
 * The two remaining nested records. `measures[]` was the first, and the fault is the same one:
 * both were read for the fields they declare and rebuilt from them, so anything else attached was
 * **dropped rather than refused**, which leaves no error, no row and nothing for the next reader to
 * find. What differs is what a smuggled field would be *about*.
 *
 * **An owner scope decides who may extend a category and who may retire one.** That is the
 * isolation rule, and it is `sameOwner` over `kind` and `tenantId` — nothing else. An `owner`
 * carrying `role`, `permissions`, `admin` or `creditLimit` is a caller describing **authority** to
 * a component that answers no authority question; K-04 does. Dropped silently, the caller believes
 * the registry accepted it, and the record every listing keys off says nothing of the kind.
 *
 * **An origin is who authored a record, permanently.** Registry history is append-only, so an
 * origin is never corrected — a credential, a session token or a display name attached to one
 * would be copied wherever the record goes and read by nobody. The one thing an origin must never
 * say is that an agent authored it (v3 §38), which is refused by name and stays refused here.
 *
 * Both are checked on **both paths**, because they arrive by different routes and only one of them
 * involves a caller:
 *
 *   - the **request path**, where `owner` comes from the injected `RegistrarAuthority` — the
 *     deployment's own configuration, and the one object in a publish that no request field can
 *     reach — and where an origin is built from that authority; and
 *   - the **persisted-record path**, where both arrive from the repository port and are judged by
 *     the same validators, as `'stored row'`.
 *
 * An origin is reached only through a record, never as a public function, so it is exercised the
 * way the component actually reaches it: through `validateUnitTypeVersion`, `validateActivation`
 * and `validateRetirement`. Nothing here widens the public surface to test it.
 *
 * And the fingerprint, once more. `canonicalVersionRequest` records an owner as `ownerKey(owner)` —
 * `platform`, or `tenant:<handle>` — and an author as the authority id. Anything else either
 * carried is invisible to it, so two publications differing *only* in smuggled nested data are one
 * question, and a retry on one idempotency key converged. That is the K-04 failure (§11.27),
 * reached through a nested object rather than through the key.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  CommerceUnitRegistryService,
  InMemoryCommerceUnitRepository,
  assertOwner,
  ownerKey,
  validateActivation,
  validateRetirement,
  validateUnitTypeVersion,
  type OwnerScope,
  type RegistrarAuthority,
  type UnitTypeVersion,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  AUTHORITY,
  FixedClock,
  PLATFORM_REGISTRAR,
  ROOT,
  StubConfiguration,
  StubPolicy,
  TENANT,
  build,
  nextId,
  publishRequest,
  tenantRegistrar,
} from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

const thrownBy = (body: () => unknown): unknown => {
  try {
    body();
  } catch (error: unknown) {
    return error;
  }
  return null;
};

const refuses = (body: () => unknown, why: string): CommerceUnitError => {
  const error = thrownBy(body);
  assert.ok(error !== null, `${why} was accepted; a dropped field is a field somebody believes in`);
  assert.equal(codeOf(error), 'malformed-record', why);
  return error as CommerceUnitError;
};

const PLATFORM = { kind: 'platform' } as const;
const TENANT_SCOPE = { kind: 'tenant', tenantId: TENANT } as const;
const SYSTEM = { kind: 'system', id: AUTHORITY } as const;

/** A type version record in the shape the validators judge, request side or stored side. */
const versionRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  typeVersionId: 'typever_01HQZXSCOPE1',
  typeKey: ROOT,
  version: 1,
  kind: 'new-product',
  owner: { ...PLATFORM },
  parentTypeKey: null,
  measures: [{ family: 'goods', unit: 'each' }],
  riskPolicyKey: null,
  effectiveFrom: null,
  effectiveUntil: null,
  publishedAt: '2026-04-01T12:00:00.123456Z',
  publishedBy: { ...SYSTEM },
  idempotencyKey: 'idem_01HQZXSCOPE02',
  requestFingerprint: 'a'.repeat(64),
  ...overrides,
});

const activationRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  activationId: 'act_01HQZXSCOPE003',
  typeKey: ROOT,
  typeVersionId: 'typever_01HQZXSCOPE1',
  supersedesVersionId: null,
  riskPolicyVersionId: null,
  activatedAt: '2026-04-01T12:00:00.654321Z',
  activatedBy: { ...SYSTEM },
  idempotencyKey: 'idem_01HQZXSCOPE04',
  requestFingerprint: 'b'.repeat(64),
  ...overrides,
});

const retirementRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  retirementId: 'ret_01HQZXSCOPE005',
  typeKey: ROOT,
  reason: 'the category was folded into the new taxonomy',
  retiredAt: '2026-04-01T12:00:00.000000Z',
  retiredBy: { ...SYSTEM },
  idempotencyKey: 'idem_01HQZXSCOPE06',
  requestFingerprint: 'c'.repeat(64),
  ...overrides,
});

/** An origin is only ever reached through a record, so that is how it is asked. */
const originRefuses = (origin: unknown, why: string): CommerceUnitError =>
  refuses(() => validateUnitTypeVersion(versionRecord({ publishedBy: origin }), 'request'), why);

const ownerRefuses = (owner: unknown, why: string): CommerceUnitError =>
  refuses(() => assertOwner(owner), why);

// ---------------------------------------------------------------------------
// A field neither record has a meaning for is refused, not quietly discarded
// ---------------------------------------------------------------------------

test('an owner scope carrying authority is refused', () => {
  // Every one of these is a claim about what somebody may do. K-11 answers none of them: the
  // isolation rule here is two fields compared, and authority is K-04's question entirely.
  for (const field of ['role', 'roles', 'permissions', 'admin', 'superAdmin', 'scopes', 'grant']) {
    ownerRefuses({ ...PLATFORM, [field]: 'anything' }, `platform owner + ${field}`);
    ownerRefuses({ ...TENANT_SCOPE, [field]: 'anything' }, `tenant owner + ${field}`);
  }
});

test('an owner scope carrying money, display text or a credential is refused', () => {
  for (const field of [
    'price',
    'currency',
    'balance',
    'creditLimit',
    'taxRate',
    'label',
    'displayName',
    'tenantName',
    'apiKey',
    'password',
    'token',
    'authorization',
  ]) {
    ownerRefuses({ ...TENANT_SCOPE, [field]: 'anything' }, `tenant owner + ${field}`);
  }
});

test('an origin carrying a credential, a session, display text or authority is refused', () => {
  for (const field of [
    'apiKey',
    'password',
    'token',
    'sessionId',
    'assertion',
    'authorization',
    'email',
    'displayName',
    'label',
    'role',
    'permissions',
    'price',
  ]) {
    originRefuses({ ...SYSTEM, [field]: 'anything' }, `origin + ${field}`);
  }
});

test('a field nobody has thought of yet is refused by the same rule', () => {
  // The point of the allowlist: none of these is on any denylist anybody would write.
  for (const field of ['meta', 'x', 'context', 'notes', 'flags']) {
    ownerRefuses({ ...PLATFORM, [field]: 1 }, `owner + ${field}`);
    originRefuses({ ...SYSTEM, [field]: 1 }, `origin + ${field}`);
  }
});

test('a misspelt field is refused as a field, not read as a missing one', () => {
  // `tennantId` is not "no tenant given" — it is a scope its author believes they narrowed, and
  // the scope it would otherwise have been read as is the platform: the widest one there is.
  ownerRefuses({ kind: 'tenant', tennantId: TENANT }, 'tenantId spelt wrong');
  ownerRefuses({ kind: 'tenant', tenantID: TENANT }, 'tenantId in the wrong case');
  ownerRefuses({ ...PLATFORM, Kind: 'tenant' }, 'kind in the wrong case');
  originRefuses({ kind: 'system', Id: AUTHORITY }, 'id shouted');
  originRefuses({ ...SYSTEM, idd: 'x' }, 'id spelt wrong');
});

test('the platform scope may not declare a tenant field at all, even an empty one', () => {
  // The field, not its value. "This is the platform" and "this is a tenant nobody named" are
  // different claims, and the second must not be able to read as the first.
  ownerRefuses({ kind: 'platform', tenantId: TENANT }, 'platform naming a tenant');
  ownerRefuses({ kind: 'platform', tenantId: undefined }, 'platform declaring an empty tenant');
});

// ---------------------------------------------------------------------------
// The ways of hiding a field that a printed record would not show
// ---------------------------------------------------------------------------

test('a field inherited through a prototype is refused on both records', () => {
  const owner = Object.create({ role: 'admin', creditLimit: 1_000_000 }) as Record<string, unknown>;
  owner.kind = 'tenant';
  owner.tenantId = TENANT;
  assert.deepEqual(Object.keys(owner), ['kind', 'tenantId'], 'the fixture must look innocent');
  assert.equal(JSON.stringify(owner), `{"kind":"tenant","tenantId":"${TENANT}"}`);
  assert.equal(owner.role, 'admin', 'and the value must genuinely be readable through it');
  ownerRefuses(owner, 'an owner inheriting a role');

  const origin = Object.create({ apiKey: 'sk-000000000000000000' }) as Record<string, unknown>;
  origin.kind = 'system';
  origin.id = AUTHORITY;
  originRefuses(origin, 'an origin inheriting a credential');
});

test('a class instance is refused, however canonical its own fields look', () => {
  class Scope {
    readonly kind = 'platform';
    get permissions(): readonly string[] {
      return ['retire-anything'];
    }
  }
  ownerRefuses(new Scope(), 'an owner that is an instance of something');

  class Author {
    readonly kind = 'system';
    readonly id = AUTHORITY;
  }
  originRefuses(new Author(), 'an origin that is an instance of something');
});

test('an accessor-backed field is refused, and the accessor is never called', () => {
  // A getter can answer `platform` to the check and `tenant` to whatever stores the record, so the
  // scope recorded need not be the scope authorised. The counter proves the ordering the
  // correction is really about: the shape is judged before any field is read.
  const shifty: Record<string, unknown> = {};
  let reads = 0;
  Object.defineProperty(shifty, 'kind', {
    get: () => (++reads === 1 ? 'platform' : 'tenant'),
    enumerable: true,
    configurable: true,
  });
  ownerRefuses(shifty, 'an owner whose kind is a getter');
  assert.equal(reads, 0, 'the getter was called: the shape must be judged before any read');

  const origin = { ...SYSTEM } as Record<string, unknown>;
  Object.defineProperty(origin, 'role', {
    get: () => 'admin',
    enumerable: true,
    configurable: true,
  });
  originRefuses(origin, 'an origin whose role is a getter');
});

test('a symbol-keyed field is refused on both records', () => {
  const owner = { ...TENANT_SCOPE, [Symbol.for('role')]: 'admin' } as Record<string, unknown>;
  assert.deepEqual(Object.keys(owner), ['kind', 'tenantId'], 'the fixture must look innocent');
  ownerRefuses(owner, 'an owner with a symbol-keyed role');

  const origin = { ...SYSTEM, [Symbol.for('apiKey')]: 'sk-0' } as Record<string, unknown>;
  originRefuses(origin, 'an origin with a symbol-keyed credential');
});

test('a non-enumerable field is refused on both records', () => {
  const owner = { ...TENANT_SCOPE } as Record<string, unknown>;
  Object.defineProperty(owner, 'permissions', { value: ['retire-anything'], enumerable: false });
  assert.deepEqual(Object.keys(owner), ['kind', 'tenantId'], 'the fixture must look innocent');
  ownerRefuses(owner, 'an owner with non-enumerable permissions');

  const origin = { ...SYSTEM } as Record<string, unknown>;
  Object.defineProperty(origin, 'password', { value: 'hunter2', enumerable: false });
  originRefuses(origin, 'an origin with a non-enumerable password');
});

test('an array is refused, even one carrying the right fields', () => {
  const owner = [] as unknown as Record<string, unknown>;
  owner.kind = 'platform';
  ownerRefuses(owner, 'an owner that is an array');
});

// ---------------------------------------------------------------------------
// The persisted-record path: the same rule, on the way back in
// ---------------------------------------------------------------------------

test('a stored version whose owner smuggles authority is refused as a stored row', () => {
  const error = refuses(
    () =>
      validateUnitTypeVersion(
        versionRecord({ owner: { ...PLATFORM, role: 'admin' } }),
        'stored row',
      ),
    'a stored owner carrying a role',
  );
  assert.match(error.message, /carries the field "role"/);
  assert.match(
    error.message,
    /was not written by this component/,
    'a stored-row refusal must say the row came from the database',
  );
});

test('a stored version whose author smuggles a credential is refused as a stored row', () => {
  const error = refuses(
    () =>
      validateUnitTypeVersion(
        versionRecord({ publishedBy: { ...SYSTEM, apiKey: 'sk-000000000000000000' } }),
        'stored row',
      ),
    'a stored publishedBy carrying a credential',
  );
  assert.match(error.message, /carries the field "apiKey"/);
  assert.match(error.message, /was not written by this component/);
});

test('a stored activation and a stored retirement are judged the same way', () => {
  refuses(
    () =>
      validateActivation(
        activationRecord({ activatedBy: { ...SYSTEM, role: 'admin' } }),
        'stored row',
      ),
    'a stored activatedBy carrying a role',
  );
  refuses(
    () =>
      validateRetirement(
        retirementRecord({ retiredBy: { ...SYSTEM, sessionId: 'sess-1' } }),
        'stored row',
      ),
    'a stored retiredBy carrying a session',
  );
  // And the hidden forms, on the same path.
  const inherited = Object.create({ token: 'x' }) as Record<string, unknown>;
  inherited.kind = 'system';
  inherited.id = AUTHORITY;
  refuses(
    () => validateActivation(activationRecord({ activatedBy: inherited }), 'stored row'),
    'a stored activatedBy inheriting a token',
  );
});

test('a seeded store whose owner carries authority refuses the read rather than answering', async () => {
  // End to end, through the in-force index: a repository holding a version whose owner smuggles a
  // permission is a store the service must refuse to resolve from, not one it reads two fields out
  // of and ignores the rest.
  const clean = new InMemoryCommerceUnitRepository();
  const seeding = build({ repository: clean });
  const published = await seeding.service.publish(publishRequest());
  await seeding.service.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  // The honest store answers, so the refusal below is about the tampering and nothing else.
  assert.equal((await build({ repository: clean }).service.resolve({ typeKey: ROOT })).version, 1);

  const tampered = new InMemoryCommerceUnitRepository();
  tampered.seed({
    versions: [
      {
        ...published.version,
        owner: { kind: 'platform', permissions: ['retire-anything'] } as unknown as OwnerScope,
      } satisfies UnitTypeVersion,
    ],
    activations: clean.activations(),
  });

  await assert.rejects(
    build({ repository: tampered }).service.resolve({ typeKey: ROOT }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

// ---------------------------------------------------------------------------
// Idempotency: a retry may not converge across smuggled nested data
// ---------------------------------------------------------------------------

/** A registrar whose owner scope carries something extra. The deployment's own configuration. */
const registrarWith = (owner: unknown): RegistrarAuthority =>
  ({
    authorityId: AUTHORITY,
    owner,
    permitsRegistration: () => true,
  }) as RegistrarAuthority;

const serviceOn = (
  repository: InMemoryCommerceUnitRepository,
  registrar: RegistrarAuthority,
): CommerceUnitRegistryService =>
  new CommerceUnitRegistryService({
    repository,
    clock: new FixedClock(),
    configuration: new StubConfiguration(),
    policy: new StubPolicy(),
    registrar,
  });

test('the fingerprint cannot see a smuggled owner field, which is why one may not get through', () => {
  // The mechanism, stated directly. `ownerKey` is the whole of what the canonical request records
  // about an owner, so if a smuggled field ever reached it, two different requests would be one
  // question. Refusing at the boundary is what keeps this property safe rather than dangerous.
  const honest = { kind: 'tenant', tenantId: TENANT } as const;
  const smuggled = { kind: 'tenant', tenantId: TENANT, role: 'admin' } as unknown as OwnerScope;
  assert.equal(ownerKey(smuggled), ownerKey(honest));
});

test('a retry whose registrar smuggles owner data is refused rather than converged', async () => {
  // Publish under an honest platform registrar, then retry the same idempotency key under one
  // whose owner scope carries a permission. `ownerKey` renders both as "platform", so the
  // fingerprints are identical: before this boundary the service answered `deduplicated: true`
  // and handed back a type version registered from a different configuration.
  const repository = new InMemoryCommerceUnitRepository();
  const request = publishRequest();
  const first = await serviceOn(repository, PLATFORM_REGISTRAR).publish(request);
  assert.equal(first.deduplicated, false);

  const smuggler = registrarWith({ kind: 'platform', permissions: ['retire-anything'] });
  await assert.rejects(
    serviceOn(repository, smuggler).publish(request),
    (error: unknown) => codeOf(error) === 'malformed-record',
    'a retry carrying smuggled owner data converged instead of being refused',
  );

  assert.equal(repository.versions().length, 1, 'the honest publication, and only it');
});

test('an initial request smuggling owner data leaves no key for a later retry to converge on', async () => {
  const repository = new InMemoryCommerceUnitRepository();
  const request = publishRequest();
  const smuggler = registrarWith({ kind: 'tenant', tenantId: TENANT, creditLimit: 1_000_000 });

  await assert.rejects(
    serviceOn(repository, smuggler).publish(request),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
  assert.equal(repository.versions().length, 0);

  // The key is untouched, so an honest publication on it is a first one and says so.
  const honest = await serviceOn(repository, tenantRegistrar()).publish(request);
  assert.equal(honest.deduplicated, false, 'the refused request became a decision to converge on');
  assert.deepEqual({ ...honest.version.owner }, { kind: 'tenant', tenantId: TENANT });
});

// ---------------------------------------------------------------------------
// What the boundary must not have broken
// ---------------------------------------------------------------------------

test('both owner scopes and both origin kinds still validate', () => {
  assert.deepEqual({ ...assertOwner(PLATFORM) }, { kind: 'platform' });
  assert.deepEqual({ ...assertOwner(TENANT_SCOPE) }, { kind: 'tenant', tenantId: TENANT });

  for (const kind of ['human', 'system'] as const) {
    const version = validateUnitTypeVersion(
      versionRecord({ publishedBy: { kind, id: AUTHORITY } }),
      'request',
    );
    assert.deepEqual({ ...version.publishedBy }, { kind, id: AUTHORITY });
  }

  for (const scope of [PLATFORM, TENANT_SCOPE]) {
    assert.ok(Object.isFrozen(assertOwner(scope)), 'a validated scope crosses the boundary sealed');
  }
});

test('a record with no prototype at all is accepted', () => {
  const owner = Object.create(null) as Record<string, unknown>;
  owner.kind = 'tenant';
  owner.tenantId = TENANT;
  assert.deepEqual({ ...assertOwner(owner) }, { kind: 'tenant', tenantId: TENANT });

  const origin = Object.create(null) as Record<string, unknown>;
  origin.kind = 'human';
  origin.id = AUTHORITY;
  const version = validateUnitTypeVersion(versionRecord({ publishedBy: origin }), 'request');
  assert.deepEqual({ ...version.publishedBy }, { kind: 'human', id: AUTHORITY });
});

test('a sealed record still validates, which is what every stored row hands back', () => {
  // Stored records are frozen on the way out and re-validated on the way back in. A shape check
  // that rejected a frozen record would refuse the whole catalogue on the first read.
  assert.deepEqual({ ...assertOwner(Object.freeze({ ...TENANT_SCOPE })) }, { ...TENANT_SCOPE });
  const version = validateUnitTypeVersion(
    versionRecord({
      owner: Object.freeze({ ...PLATFORM }),
      publishedBy: Object.freeze({ ...SYSTEM }),
    }),
    'stored row',
  );
  assert.deepEqual({ ...version.publishedBy }, { ...SYSTEM });
});

test('an agent is still refused by name, on the request path and the stored one', () => {
  for (const source of ['request', 'stored row'] as const) {
    const error = refuses(
      () =>
        validateUnitTypeVersion(
          versionRecord({ publishedBy: { kind: 'ai', id: 'agent-01' } }),
          source,
        ),
      `an agent as the author of a ${source}`,
    );
    assert.match(error.message, /No agent registers a commerce unit type/);
  }
});

test('the scope refusals that existed before still say what they said', () => {
  for (const [why, owner, code] of [
    ['a kind nobody registered', { kind: 'department' }, 'malformed-record'],
    ['no kind at all', {}, 'malformed-record'],
    // Not `malformed-record`: a tenant scope with no handle fails on the handle, and the
    // identifier rules are the ones that say so. The new shape check must not have moved it.
    ['a tenant with no handle', { kind: 'tenant' }, 'malformed-identifier'],
  ] as const) {
    assert.equal(codeOf(thrownBy(() => assertOwner(owner))), code, why);
  }
  originRefuses({ kind: 'robot', id: AUTHORITY }, 'an origin kind nobody registered');
  assert.equal(codeOf(thrownBy(() => assertOwner(null))), 'malformed-record');
  originRefuses('system', 'an origin that is not a record');
});

test('a tenant registrar still publishes and a platform one still does, unchanged', async () => {
  const platform = build();
  const published = await platform.service.publish(publishRequest());
  assert.deepEqual({ ...published.version.owner }, { kind: 'platform' });
  assert.deepEqual({ ...published.version.publishedBy }, { kind: 'system', id: AUTHORITY });

  const tenant = build({ registrar: tenantRegistrar() });
  const byTenant = await tenant.service.publish(publishRequest());
  assert.deepEqual({ ...byTenant.version.owner }, { kind: 'tenant', tenantId: TENANT });
});
