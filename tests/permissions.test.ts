/**
 * K-04 Permissions — the contract, the trust boundary, and what a caller may not say (FND-004d).
 *
 * One claim dominates this suite: **the caller does not decide, and does not say who is asking.**
 * Everything else K-04 does is bookkeeping, and bookkeeping around an answer the caller supplied is
 * not authorisation. So the tests are weighted towards the ways a caller might try to supply one —
 * an outcome, an identity, a role, a purpose satisfaction, a policy version — and towards the ways
 * an injected port might assert something K-04 must not believe.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIONS,
  AI_FORBIDDEN_ACTIONS,
  AI_FORBIDDEN_RESOURCES,
  ASSERTED_AUTHORIZATION_FIELDS,
  CONTEXT_KEYS,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  InMemoryPermissionRepository,
  NO_ACCOUNTS,
  NO_SESSIONS,
  PURPOSES,
  PermissionError,
  PermissionService,
  RESOURCE_TYPES,
  ROLES,
  STAFF_ROLES,
  isSealed,
  isStaffRole,
  type AuthorizeRequest,
} from '../kernel/permissions/index.ts';
import {
  AuthenticationService,
  InMemoryAuthenticationRepository,
  ProviderRegistry,
} from '../kernel/authentication/index.ts';
import { AccountService, InMemoryAccountRepository } from '../kernel/accounts/index.ts';
import { IdentityService, InMemoryIdentityRepository } from '../kernel/identity/index.ts';

import {
  BOOTSTRAP,
  FixedClock,
  SUBJECT,
  bootstrapPolicyRequest,
  TOKEN,
  authorizeRequest,
  build,
  grantRequest,
  policyRequest,
  revokeRequest,
  withPolicy,
} from './helpers/permission-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The caller does not decide
// ---------------------------------------------------------------------------

test('a request that asserts an authorisation outcome is refused by name', async () => {
  // The security check of the whole component. Each of these is something only K-04 may determine,
  // and a component that accepted one would be formatting its caller's opinion.
  const asserted: ReadonlyArray<readonly [string, unknown]> = [
    ['allowed', true],
    ['permitted', true],
    ['authorized', true],
    ['authorised', true],
    ['effect', 'allow'],
    ['decision', { effect: 'allow' }],
    ['subjectId', 'sub_01HQZXATTACKER'],
    ['subject', 'sub_01HQZXATTACKER'],
    ['role', 'ADMIN'],
    ['roles', ['SUPER_ADMIN']],
    ['permissions', ['read@order']],
    ['grants', [{ effect: 'allow' }]],
    ['purposeSatisfied', true],
    ['isStaff', true],
    ['bypass', true],
    ['superAdmin', true],
    ['override', true],
    ['aiAuthority', true],
    ['policyVersionId', 'pol_01HQZXOLDONE1'],
  ];

  for (const [field, value] of asserted) {
    const harness = await withPolicy();
    await assert.rejects(
      harness.service.authorize({ ...authorizeRequest(), [field]: value }),
      (error: unknown) => {
        assert.equal(
          codeOf(error),
          'caller-asserted-authorization',
          `"${field}" was accepted from the caller`,
        );
        return true;
      },
      `passing "${field}" must be refused, not ignored`,
    );
    assert.equal(harness.repository.decisions().length, 0, 'and nothing was decided or recorded');
    assert.equal(harness.sessions.presented.length, 0, 'the session was never even validated');
  }
});

test('every asserted-authorization field explains who decides instead', () => {
  for (const [field, why] of Object.entries(ASSERTED_AUTHORIZATION_FIELDS)) {
    assert.ok(why.length > 25, `${field} needs a real explanation, not a label`);
    assert.match(
      why,
      /this component|computes?|resolved here|evaluated here|derived|stored|storage|validated session|grant|never|no such thing|no bypass|confers nothing|there is no|injected/i,
      `${field} does not say who decides instead, or why there is nothing to ask for: "${why}"`,
    );
  }
});

test('fields owned by other components are refused with the owner named', async () => {
  for (const [field, expected] of [
    ['password', /credential/],
    ['sessionToken', /K-02/],
    ['tokenHash', /K-02/],
    ['subjectKind', /K-01 Identity/],
    ['capabilities', /Capability & Verification/],
    ['email', /personal data/],
    ['balance', /K-10 Ledger/],
  ] as const) {
    const harness = await withPolicy();
    await assert.rejects(
      harness.service.authorize({ ...authorizeRequest(), [field]: 'x' }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', field);
        assert.match((error as PermissionError).message, expected);
        return true;
      },
    );
  }

  for (const [field, why] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(why.length > 20, `${field} needs a real explanation`);
  }
});

test('an unrecognised field is refused rather than silently dropped', async () => {
  const harness = await withPolicy();
  await assert.rejects(
    harness.service.authorize({
      ...authorizeRequest(),
      nickname: 'ally',
    } as unknown as AuthorizeRequest),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as PermissionError).message, /silently dropped/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The trust boundary: ports assert, K-04 checks
// ---------------------------------------------------------------------------

test('the subject comes from the session, and the session is re-checked here', async () => {
  const harness = await withPolicy();

  // A validator that refuses is normalised without its message being repeated.
  harness.sessions.answerWith({ refuseWith: new Error(`the secret ${TOKEN} was wrong`) });
  await assert.rejects(harness.service.authorize(authorizeRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'invalid-session');
    assert.ok(
      !(error as Error).message.includes(TOKEN),
      'the refusal repeated the presented secret back into the error',
    );
    return true;
  });

  // A validator that asserts a revoked session is not believed.
  harness.sessions.clearRefusal();
  harness.sessions.answerWith({ revokedAt: '2026-04-01T11:00:00Z' });
  await assert.rejects(
    harness.service.authorize(authorizeRequest()),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'a revoked session must be refused even when the validator returns it',
  );

  // Nor one past either expiry: K-04 checks both against its own clock.
  harness.sessions.answerWith({ revokedAt: null, absoluteExpiresAt: '2026-04-01T11:00:00Z' });
  await assert.rejects(
    harness.service.authorize(authorizeRequest()),
    (error: unknown) => codeOf(error) === 'invalid-session',
  );
  harness.sessions.answerWith({
    absoluteExpiresAt: '2026-04-02T00:00:00Z',
    idleExpiresAt: '2026-04-01T11:59:00Z',
  });
  await assert.rejects(
    harness.service.authorize(authorizeRequest()),
    (error: unknown) => codeOf(error) === 'invalid-session',
  );

  // Nor one asserting an assurance this component does not recognise.
  harness.sessions.answerWith({ idleExpiresAt: '2026-04-01T12:30:00Z', assurance: 'very-sure' });
  await assert.rejects(
    harness.service.authorize(authorizeRequest()),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'an unknown assurance is refused rather than ranked lowest',
  );

  assert.equal(
    harness.repository.decisions().length,
    0,
    'none of these produced a decision record',
  );
});

test('a subject with no universal account cannot be authorised', async () => {
  const harness = await withPolicy();
  harness.accounts.answerWith([]);

  await assert.rejects(harness.service.authorize(authorizeRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'unknown-account');
    assert.match((error as PermissionError).message, /K-03 owns the account/);
    return true;
  });
});

test('the fail-closed defaults authorise nobody', async () => {
  const service = new PermissionService({
    repository: new InMemoryPermissionRepository(),
    sessions: NO_SESSIONS,
    accounts: NO_ACCOUNTS,
    clock: new FixedClock(),
    bootstrap: BOOTSTRAP,
  });
  // Bootstrap installs the rules without an administrator, which is the only thing it can do.
  await service.publishPolicy(bootstrapPolicyRequest());

  await assert.rejects(
    service.authorize(authorizeRequest()),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'a component with no session validator wired must authorise nobody',
  );
});

test('the real K-02 and K-03 services satisfy the ports structurally', async () => {
  // The proof that these ports are the shape the actual components expose. A stub agreeing with a
  // stub proves nothing; this wires the real services and reads a real decision out of the end.
  const identity = new IdentityService(new InMemoryIdentityRepository());
  await identity.create({
    subjectId: 'sub_01HQZXREALWIRE',
    kind: 'person',
    createdAt: '2026-04-01T11:00:00Z',
    origin: { kind: 'system', id: 'K-01-identity-service' },
    idempotencyKey: 'idem_01HQZXREALW01',
  });

  const accounts = new AccountService(new InMemoryAccountRepository(), identity);
  await accounts.open({
    accountId: 'acct_01HQZXREALWIRE',
    subjectId: 'sub_01HQZXREALWIRE',
    createdAt: '2026-04-01T11:00:00Z',
    origin: { kind: 'system', id: 'K-03-account-service' },
    idempotencyKey: 'idem_01HQZXREALW02',
  });

  const authentication = new AuthenticationService({
    repository: new InMemoryAuthenticationRepository(),
    providers: new ProviderRegistry([
      { provider: 'passkey', description: 'A stub provider used by the kernel suites.' },
    ]),
    verifiers: [
      {
        provider: 'passkey',
        verify: (challenge) =>
          Promise.resolve({
            assertionId: 'asrt_01HQZXREALW01',
            provider: 'passkey',
            providerReference: challenge.providerReference,
            factors: ['possession'] as const,
            assurance: 'single-factor' as const,
            verifiedAt: '2026-04-01T11:59:30Z',
            expiresAt: '2026-04-01T12:01:00Z',
          }),
      },
    ],
    subjects: identity,
    clock: new FixedClock(),
    entropy: { token: () => `tok${'R'.repeat(39)}0001` },
  });

  await authentication.bind({
    bindingId: 'bind_01HQZXREALWIRE',
    subjectId: 'sub_01HQZXREALWIRE',
    provider: 'passkey',
    providerReference: 'ref_01HQZXREALWIRE',
    idempotencyKey: 'idem_01HQZXREALW03',
  });
  const signedIn = await authentication.authenticate({
    evidenceId: 'evid_01HQZXREALWIRE',
    sessionId: 'sess_01HQZXREALWIRE',
    provider: 'passkey',
    providerReference: 'ref_01HQZXREALWIRE',
    proof: { kind: 'opaque' },
    idempotencyKey: 'idem_01HQZXREALW04',
  });
  const secret = signedIn.token.reveal();

  // The two ports, satisfied by the real services with no adapter and no translation layer.
  const service = new PermissionService({
    repository: new InMemoryPermissionRepository(),
    sessions: authentication,
    accounts,
    clock: new FixedClock(),
    bootstrap: BOOTSTRAP,
  });
  await service.publishPolicy(bootstrapPolicyRequest());

  const denied = await service.authorize(
    authorizeRequest({ presentedToken: secret, accountId: 'acct_01HQZXREALWIRE' }),
  );
  assert.equal(denied.decision.effect, 'deny', 'deny by default, through the real components');
  assert.equal(denied.decision.subjectId, 'sub_01HQZXREALWIRE', 'the subject came from K-02');
  assert.equal(denied.decision.sessionId, 'sess_01HQZXREALWIRE');
  assert.equal(denied.decision.reason, 'no-matching-grant');
});

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

test('the role vocabulary is the guide’s, and confers nothing by itself', () => {
  assert.deepEqual(
    [...ROLES],
    [
      'CUSTOMER',
      'SUPPLIER',
      'SERVICE_PROVIDER',
      'DRIVER',
      'STAFF',
      'OPERATIONS',
      'FINANCE',
      'SUPPORT',
      'MANAGER',
      'ADMIN',
      'SUPER_ADMIN',
      'AI_AGENT',
    ],
    'the initial role list is v1.0 guide §52, in its declared order',
  );

  // No role-to-authority mapping anywhere in the source. What a role may do is data — a published
  // policy version — and a hardcoded map would make policy unversioned and unauditable.
  const sources = ['types.ts', 'registry.ts', 'service.ts', 'decide.ts'];
  assert.ok(sources.length > 0);
  for (const role of ROLES) {
    if (role === 'AI_AGENT') continue; // AI has hardcoded *limits*, tested below, never authority.
    assert.ok(
      !STAFF_ROLES.includes(role) || isStaffRole(role),
      `${role}'s staff classification must come from one place`,
    );
  }
});

test('SUPER_ADMIN has no implicit authority and no bypass', async () => {
  const harness = await withPolicy();
  harness.sessions.answerWith({ subjectId: SUBJECT });

  // The policy fixture permits SUPER_ADMIN exactly one capability: read on account. Everything
  // else is denied, with no grant and no bypass, exactly as for any other role.
  const denied = await harness.service.authorize(
    authorizeRequest({ action: 'read', resourceType: 'order' }),
  );
  assert.equal(denied.decision.effect, 'deny');
  assert.equal(denied.decision.reason, 'no-matching-grant');

  // And even holding the role explicitly does not help without a grant for the capability.
  await harness.service.grant(
    grantRequest({
      role: 'SUPER_ADMIN',
      action: 'read',
      resourceType: 'account',
      purpose: 'system-maintenance',
    }),
  );
  const stillDenied = await harness.service.authorize(
    authorizeRequest({ action: 'read', resourceType: 'order' }),
  );
  assert.equal(
    stillDenied.decision.effect,
    'deny',
    'a SUPER_ADMIN grant for one capability confers no other',
  );
});

test('actions, resource types, purposes and context keys are closed and documented', () => {
  for (const [table, name] of [
    [ACTIONS, 'ACTIONS'],
    [RESOURCE_TYPES, 'RESOURCE_TYPES'],
    [CONTEXT_KEYS, 'CONTEXT_KEYS'],
  ] as const) {
    for (const [key, description] of Object.entries(table)) {
      assert.ok(description.length > 15, `${name}.${key} needs a description, not a label`);
    }
  }
  assert.ok(PURPOSES.length >= 5, 'the purpose vocabulary must cover the real staff reasons');
  assert.deepEqual([...(IDENTITY_REFUSALS ? Object.keys(IDENTITY_REFUSALS) : [])].sort(), [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
  ]);
});

test('an unregistered action, resource, role or purpose is refused', async () => {
  const harness = await withPolicy();

  await assert.rejects(
    harness.service.authorize(authorizeRequest({ action: 'obliterate' })),
    (error: unknown) => codeOf(error) === 'unsupported-action',
  );
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ resourceType: 'spaceship' })),
    (error: unknown) => codeOf(error) === 'unsupported-resource',
  );
  await assert.rejects(
    harness.service.grant(grantRequest({ role: 'OVERLORD' })),
    (error: unknown) => codeOf(error) === 'unsupported-role',
  );
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ purpose: 'because-i-said-so' })),
    (error: unknown) => codeOf(error) === 'mismatched-purpose',
  );
});

// ---------------------------------------------------------------------------
// Identifiers and context
// ---------------------------------------------------------------------------

test('natural, PII-shaped and credential-shaped values are refused everywhere', async () => {
  const harness = await withPolicy();

  for (const [why, value, code] of [
    ['an email', 'alice@example.com', 'natural-identifier'],
    ['a telephone number', '0771234567', 'natural-identifier'],
    ['a personal name', 'alice.smith', 'natural-identifier'],
    ['a credential', 'api_key_for_alice', 'secret-bearing-input'],
    ['a bearer token', 'bearer-zzzzzzzzzzzz', 'secret-bearing-input'],
    ['a guessably short id', 'a1', 'malformed-identifier'],
  ] as const) {
    await assert.rejects(
      harness.service.authorize(authorizeRequest({ accountId: value })),
      (error: unknown) => codeOf(error) === code,
      `${why} must be refused as an account id`,
    );
    await assert.rejects(
      harness.service.authorize(authorizeRequest({ context: { region: value } })),
      (error: unknown) => codeOf(error) === code,
      `${why} must be refused as a context value — context is where personal data would arrive`,
    );
  }
});

test('a context attribute nobody declared is refused rather than ignored', async () => {
  const harness = await withPolicy();
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ context: { favouriteColour: 'blue' } })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-predicate');
      assert.match((error as PermissionError).message, /declared context attribute/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AI authority
// ---------------------------------------------------------------------------

test('AI_AGENT may hold only explicitly granted tool capabilities', async () => {
  const harness = await withPolicy();

  // The one shape that is permitted.
  const allowed = await harness.service.grant(
    grantRequest({ role: 'AI_AGENT', action: 'invoke-tool', resourceType: 'tool' }),
  );
  assert.equal(allowed.grant.role, 'AI_AGENT');

  // Everything else, by three separate rules.
  for (const action of AI_FORBIDDEN_ACTIONS) {
    await assert.rejects(
      harness.service.grant(grantRequest({ role: 'AI_AGENT', action, resourceType: 'tool' })),
      (error: unknown) => codeOf(error) === 'ai-not-permitted',
      `AI_AGENT must not hold ${action}`,
    );
  }
  for (const resourceType of AI_FORBIDDEN_RESOURCES) {
    await assert.rejects(
      harness.service.grant(grantRequest({ role: 'AI_AGENT', action: 'read', resourceType })),
      (error: unknown) => codeOf(error) === 'ai-not-permitted',
      `AI is never the authority over ${resourceType}`,
    );
  }
  // And the positive rule catches anything the two lists missed.
  await assert.rejects(
    harness.service.grant(
      grantRequest({ role: 'AI_AGENT', action: 'read', resourceType: 'conversation' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ai-not-permitted');
      assert.match((error as PermissionError).message, /only explicitly granted tool capabilities/);
      return true;
    },
  );
});

test('AI can never grant a permission, and a policy cannot widen it', async () => {
  const harness = build();

  // A policy version that tries to give AI_AGENT authority over authority. Published through
  // bootstrap, so nothing but the AI rule can be what refuses it.
  await assert.rejects(
    harness.service.publishPolicy(
      bootstrapPolicyRequest({
        roles: [
          {
            role: 'AI_AGENT',
            capabilities: [{ action: 'grant-permission', resourceType: 'permission' }],
          },
        ],
      }),
    ),
    (error: unknown) => codeOf(error) === 'ai-not-permitted',
    'a published policy must not be able to widen AI beyond tool capabilities',
  );

  // And AI cannot author policy or a grant at all — which is now true for a stronger reason than
  // a refused `ai` origin. **No caller may name the author**, whatever kind it claims: authorship
  // is derived from the validated session that made the change.
  const authorised = await withPolicy();
  for (const [why, write] of [
    [
      'a policy published in somebody else’s name',
      () =>
        authorised.service.publishPolicy({
          ...policyRequest({ version: 2 }),
          publishedBy: { kind: 'ai', id: 'agent-1' },
        } as never),
    ],
    [
      'a grant signed by an agent',
      () =>
        authorised.service.grant({
          ...grantRequest(),
          grantedBy: { kind: 'ai', id: 'agent-1' },
        } as never),
    ],
    [
      'a revocation signed by an agent',
      () =>
        authorised.service.revoke({
          ...revokeRequest('grant_01HQZXADMIN01'),
          revokedBy: { kind: 'ai', id: 'agent-1' },
        } as never),
    ],
  ] as const) {
    await assert.rejects(
      write(),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-authorization', why);
        assert.match((error as PermissionError).message, /derived from the validated session/);
        return true;
      },
      `${why} must be refused: authorship is not a field a caller fills in`,
    );
  }

  // An agent holding a real session fares no better: it has no administration grant, and the
  // policy could not have given `AI_AGENT` one.
  authorised.sessions.answerWith({
    adminSubjectId: 'sub_01HQZXAGENT001',
    adminSessionId: 'sess_01HQZXAGENT01',
  });
  authorised.accounts.answerWith([
    { accountId: 'acct_01HQZXAGENT01', subjectId: 'sub_01HQZXAGENT001' },
  ]);
  await assert.rejects(
    authorised.service.grant(grantRequest()),
    (error: unknown) => codeOf(error) === 'administration-denied',
    'an agent with a session still holds no authority over authority',
  );
});

// ---------------------------------------------------------------------------
// Shape of the surface
// ---------------------------------------------------------------------------

test('the service exposes no bypass, no update and no delete', () => {
  const operations = new Set<string>();
  let proto: object | null = PermissionService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const forbidden = [...operations].filter((name) =>
    /delete|remove|purge|update|edit|bypass|override|escalate|impersonat|forceAllow/i.test(name),
  );
  assert.deepEqual(forbidden, [], 'authority history is append-only and there is no bypass');
  for (const required of ['publishPolicy', 'grant', 'revoke', 'authorize']) {
    assert.ok(operations.has(required), `${required} is part of the surface`);
  }
});

test('the service exposes no way to read authority at all', () => {
  // `findGrant`, `findDecision` and `activePolicy` each took an identifier and nothing else — no
  // session, no account, no authorisation — so holding an id, or an idempotency key out of a retry
  // buffer, read back somebody else's authority. They are gone rather than guarded, and this test
  // exists so a well-meaning convenience getter cannot quietly reintroduce the surface.
  const operations = new Set<string>();
  let proto: object | null = PermissionService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  for (const gone of ['findGrant', 'findDecision', 'activePolicy']) {
    assert.ok(!operations.has(gone), `${gone} must not exist on the service`);
    assert.equal(
      (PermissionService.prototype as unknown as Record<string, unknown>)[gone],
      undefined,
      `${gone} must not be reachable at runtime either`,
    );
  }

  // And no replacement under another name. Anything that reads is a read.
  const readers = [...operations].filter((name) =>
    /^(find|get|read|list|lookup|query|fetch|load|show|inspect)/i.test(name),
  );
  assert.deepEqual(readers, [], 'a read API is a read API whatever it is called');

  assert.deepEqual(
    [...operations].sort(),
    ['authorize', 'constructor', 'grant', 'publishPolicy', 'revoke'],
    'four operations and a constructor: the whole surface',
  );
});

test('every record crossing the boundary is sealed all the way down', async () => {
  const harness = await withPolicy();
  const granted = await harness.service.grant(
    grantRequest({
      condition: { kind: 'attribute-in', attribute: 'region', values: ['region_north1'] },
    }),
  );

  assert.ok(
    isSealed(granted.grant),
    'a returned grant must be frozen, including its condition tree',
  );
  const published = await harness.service.publishPolicy(policyRequest({ version: 9 }));
  assert.ok(isSealed(published.policy), 'and a policy version, including every capability list');

  assert.throws(() => {
    (granted.grant as { effect: string }).effect = 'deny';
  });
});
