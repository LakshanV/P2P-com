/**
 * K-04 Permissions — what gets decided, and why (FND-004d).
 *
 * The evaluation is the component. Everything else exists to make sure this suite is asking the
 * right question with the right inputs, so this is where the adversarial cases live: escalation
 * attempts, cross-account reads, staff acting without a purpose, conditions that do not hold,
 * grants that have expired or been revoked, and the deny that must beat every allow.
 *
 * Two properties are asserted throughout rather than in one place:
 *
 *   - **deny by default** — every case that is not explicitly allowed comes back `deny`, with a
 *     reason a person can act on;
 *   - **the explanation is deterministic** — the same inputs produce the same words, because a
 *     decision record nobody can reproduce is one nobody can appeal.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PermissionError, evaluate } from '../kernel/permissions/index.ts';

import {
  ACCOUNT,
  ADMIN_TOKEN,
  SUBJECT,
  authorizeRequest,
  build,
  grantRequest,
  policyRequest,
  withPolicy,
} from './helpers/permission-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

// ---------------------------------------------------------------------------
// Deny by default
// ---------------------------------------------------------------------------

test('with no grant at all, everything is denied and the reason says so', async () => {
  const harness = await withPolicy();
  const { decision } = await harness.service.authorize(authorizeRequest());

  assert.equal(decision.effect, 'deny');
  assert.equal(decision.reason, 'no-matching-grant');
  assert.equal(decision.decidingGrantId, null, 'a denial by default names no grant');
  assert.match(decision.explanation, /denied: nothing grants read on order/);
  assert.match(decision.explanation, /unless something explicitly allows it/);
  assert.equal(decision.subjectId, SUBJECT, 'the subject came from the session, not the request');
  assert.equal(harness.repository.decisions().length, 1, 'and the denial was recorded');
});

test('with no policy published, nothing can be authorised', async () => {
  const harness = build();
  await assert.rejects(harness.service.authorize(authorizeRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'no-such-policy');
    assert.match(
      (error as PermissionError).message,
      /the correct answer, not a configuration error/,
    );
    return true;
  });
});

test('an explicit allow permits exactly what it names, and nothing adjacent', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ action: 'read', resourceType: 'order' }));

  const allowed = await harness.service.authorize(
    authorizeRequest({ action: 'read', resourceType: 'order' }),
  );
  assert.equal(allowed.decision.effect, 'allow');
  assert.equal(allowed.decision.reason, 'explicit-allow');
  assert.ok(allowed.decision.decidingGrantId !== null, 'an allow always names its grant');

  // The neighbouring action, the neighbouring resource, and the same action in another account.
  for (const [why, overrides] of [
    ['a different action', { action: 'create', resourceType: 'order' }],
    ['a different resource type', { action: 'read', resourceType: 'account' }],
  ] as const) {
    const denied = await harness.service.authorize(authorizeRequest(overrides));
    assert.equal(denied.decision.effect, 'deny', `${why} must not be covered`);
    assert.equal(denied.decision.reason, 'no-matching-grant');
  }
});

test('a grant scoped to one resource does not cover its neighbours', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ resourceId: 'order_01HQZXONE0001' }));

  const allowed = await harness.service.authorize(
    authorizeRequest({ resourceId: 'order_01HQZXONE0001' }),
  );
  assert.equal(allowed.decision.effect, 'allow');

  const denied = await harness.service.authorize(
    authorizeRequest({ resourceId: 'order_01HQZXTWO0001' }),
  );
  assert.equal(denied.decision.effect, 'deny', 'least privilege is what the grant omits');
  assert.equal(denied.decision.reason, 'no-matching-grant');
});

test('a grant without a resource id covers the type inside the account, and no wider', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ resourceId: null }));

  for (const resourceId of ['order_01HQZXONE0001', 'order_01HQZXTWO0001', null]) {
    const decision = await harness.service.authorize(authorizeRequest({ resourceId }));
    assert.equal(decision.decision.effect, 'allow', `${String(resourceId)} is inside the scope`);
  }
});

// ---------------------------------------------------------------------------
// Deny precedence
// ---------------------------------------------------------------------------

test('a deny beats an allow, however specific the allow is', async () => {
  const harness = await withPolicy();

  // The most specific possible allow, and the broadest possible deny.
  await harness.service.grant(
    grantRequest({
      grantId: 'grant_01HQZXALLOW01',
      effect: 'allow',
      resourceId: 'order_01HQZXONE0001',
    }),
  );
  await harness.service.grant(
    grantRequest({ grantId: 'grant_01HQZXDENY001', effect: 'deny', resourceId: null }),
  );

  const decision = await harness.service.authorize(
    authorizeRequest({ resourceId: 'order_01HQZXONE0001' }),
  );
  assert.equal(decision.decision.effect, 'deny');
  assert.equal(decision.decision.reason, 'explicit-deny');
  assert.equal(decision.decision.decidingGrantId, 'grant_01HQZXDENY001');
  assert.match(decision.decision.explanation, /A deny outranks every allow/);
});

test('deny precedence does not depend on the order grants were written', async () => {
  // Written deny-first here, allow-first above. Same answer, and the same deciding grant.
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({ grantId: 'grant_01HQZXDENY001', effect: 'deny', resourceId: null }),
  );
  await harness.service.grant(
    grantRequest({
      grantId: 'grant_01HQZXALLOW01',
      effect: 'allow',
      resourceId: 'order_01HQZXONE0001',
    }),
  );

  const decision = await harness.service.authorize(
    authorizeRequest({ resourceId: 'order_01HQZXONE0001' }),
  );
  assert.equal(decision.decision.effect, 'deny');
  assert.equal(decision.decision.decidingGrantId, 'grant_01HQZXDENY001');
});

test('a deny may be recorded for more than the policy permits, and an allow may not', async () => {
  const harness = await withPolicy();

  // The fixture policy does not permit CUSTOMER to export an order.
  await assert.rejects(
    harness.service.grant(
      grantRequest({ effect: 'allow', action: 'export', resourceType: 'order' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-action');
      assert.match((error as PermissionError).message, /would exceed the policy it is made under/);
      return true;
    },
  );

  // A deny is always recordable: refusing it would let a policy change *widen* effective access.
  const denied = await harness.service.grant(
    grantRequest({ effect: 'deny', action: 'export', resourceType: 'order' }),
  );
  assert.equal(denied.grant.effect, 'deny');
});

// ---------------------------------------------------------------------------
// Account isolation
// ---------------------------------------------------------------------------

test('a subject cannot be authorised inside an account it does not hold', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());

  await assert.rejects(
    harness.service.authorize(authorizeRequest({ accountId: 'acct_01HQZXOTHER01' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'cross-account-access');
      assert.match((error as PermissionError).message, /Authority never spans accounts/);
      return true;
    },
  );
  assert.equal(
    harness.repository.decisions().length,
    0,
    'refused before evaluation, so nothing was decided',
  );
});

test('a grant in another account is invisible to this one', async () => {
  const harness = await withPolicy();
  // The same subject, granted in an account it does not hold. The evaluation must not see it.
  await harness.service.grant(grantRequest({ accountId: 'acct_01HQZXOTHER01' }));

  const decision = await harness.service.authorize(authorizeRequest());
  assert.equal(decision.decision.effect, 'deny');
  assert.equal(decision.decision.reason, 'no-matching-grant');
});

test('another subject’s grant does not authorise this one', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ subjectId: 'sub_01HQZXOTHER001' }));

  const decision = await harness.service.authorize(authorizeRequest());
  assert.equal(decision.decision.effect, 'deny', 'grants are per subject, not per account');
});

// ---------------------------------------------------------------------------
// Purpose limitation
// ---------------------------------------------------------------------------

test('a staff role must declare a purpose, and the right one', async () => {
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({
      role: 'SUPPORT',
      action: 'read',
      resourceType: 'conversation',
      purpose: 'support-request',
    }),
  );

  // No purpose at all.
  const undeclared = await harness.service.authorize(
    authorizeRequest({ action: 'read', resourceType: 'conversation' }),
  );
  assert.equal(undeclared.decision.effect, 'deny');
  assert.equal(undeclared.decision.reason, 'purpose-not-satisfied');
  assert.match(undeclared.decision.explanation, /no purpose was declared/);

  // The wrong purpose.
  const wrong = await harness.service.authorize(
    authorizeRequest({
      action: 'read',
      resourceType: 'conversation',
      purpose: 'fraud-investigation',
    }),
  );
  assert.equal(wrong.decision.effect, 'deny');
  assert.equal(wrong.decision.reason, 'purpose-not-satisfied');
  assert.match(wrong.decision.explanation, /not the purpose it was granted for/);

  // The declared one.
  const right = await harness.service.authorize(
    authorizeRequest({ action: 'read', resourceType: 'conversation', purpose: 'support-request' }),
  );
  assert.equal(right.decision.effect, 'allow');
  assert.equal(right.decision.purpose, 'support-request', 'and the purpose is on the record');
});

test('a staff grant with no purpose cannot be written, and a customer grant with one cannot either', async () => {
  const harness = await withPolicy();

  await assert.rejects(
    harness.service.grant(
      grantRequest({ role: 'SUPPORT', action: 'read', resourceType: 'conversation' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-purpose');
      assert.match((error as PermissionError).message, /role-based, purpose-based and audited/);
      return true;
    },
  );

  await assert.rejects(
    harness.service.grant(grantRequest({ role: 'CUSTOMER', purpose: 'support-request' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mismatched-purpose');
      assert.match((error as PermissionError).message, /a control that is not there/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Temporal validity and revocation
// ---------------------------------------------------------------------------

test('a grant outside its validity window does not apply', async () => {
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({ notBefore: '2026-04-01T13:00:00Z', expiresAt: '2026-04-01T14:00:00Z' }),
  );

  const tooEarly = await harness.service.authorize(authorizeRequest());
  assert.equal(tooEarly.decision.effect, 'deny');
  assert.equal(tooEarly.decision.reason, 'outside-validity-window');

  // The session's own window moves with the clock — a real one would have been rotated. Leaving it
  // behind would refuse for the *session's* expiry and prove nothing about the grant's.
  harness.clock.set('2026-04-01T13:30:00Z');
  harness.sessions.answerWith({ idleExpiresAt: '2026-04-01T23:00:00Z' });
  const inside = await harness.service.authorize(authorizeRequest());
  assert.equal(inside.decision.effect, 'allow');

  harness.clock.set('2026-04-01T14:00:00Z');
  const expired = await harness.service.authorize(authorizeRequest());
  assert.equal(expired.decision.effect, 'deny', 'the window is closed at its expiry, not after it');
  assert.equal(expired.decision.reason, 'outside-validity-window');
});

test('a revoked grant stops applying immediately, and the grant row is untouched', async () => {
  const harness = await withPolicy();
  const granted = await harness.service.grant(grantRequest());

  const before = await harness.service.authorize(authorizeRequest());
  assert.equal(before.decision.effect, 'allow');

  await harness.service.revoke({
    revocationId: 'rev_01HQZXREVOKE1',
    grantId: granted.grant.grantId,
    reason: 'access-no-longer-needed',
    presentedToken: ADMIN_TOKEN,
    administrationPurpose: 'system-maintenance',
    idempotencyKey: 'idem_01HQZXREVOKE1',
  });

  const after = await harness.service.authorize(authorizeRequest());
  assert.equal(after.decision.effect, 'deny');
  assert.equal(after.decision.reason, 'grant-revoked');
  assert.match(after.decision.explanation, /not a weaker grant; it is not a grant/);

  // Append-only: the grant is still there, exactly as written.
  const stored = await harness.service.findGrant(granted.grant.grantId);
  assert.deepEqual(stored, granted.grant, 'revocation appends; it does not edit');
  assert.equal(
    harness.repository.grants().length,
    2,
    'the administration grant and this one, both intact',
  );
  assert.equal(harness.repository.revocations().length, 1);
});

// ---------------------------------------------------------------------------
// ABAC
// ---------------------------------------------------------------------------

test('a typed predicate decides against the presented context', async () => {
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({
      condition: { kind: 'attribute-equals', attribute: 'region', value: 'region_north1' },
    }),
  );

  const matching = await harness.service.authorize(
    authorizeRequest({ context: { region: 'region_north1' } }),
  );
  assert.equal(matching.decision.effect, 'allow');

  const other = await harness.service.authorize(
    authorizeRequest({ context: { region: 'region_south1' } }),
  );
  assert.equal(other.decision.effect, 'deny');
  assert.equal(other.decision.reason, 'condition-unsatisfied');

  // An absent attribute makes the condition false rather than throwing: a grant conditioned on
  // something the caller did not supply does not apply.
  const absent = await harness.service.authorize(authorizeRequest());
  assert.equal(absent.decision.effect, 'deny');
  assert.equal(absent.decision.reason, 'condition-unsatisfied');
});

test('all, any and assurance predicates compose', async () => {
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({
      condition: {
        kind: 'all',
        of: [
          { kind: 'assurance-at-least', assurance: 'multi-factor' },
          {
            kind: 'any',
            of: [
              {
                kind: 'attribute-in',
                attribute: 'channel',
                values: ['channel_web01', 'channel_ios1'],
              },
              { kind: 'attribute-equals', attribute: 'risk-tier', value: 'tier_low0001' },
            ],
          },
        ],
      },
    }),
  );

  // Single-factor fails the assurance leg however good the channel is.
  const weak = await harness.service.authorize(
    authorizeRequest({ context: { channel: 'channel_web01' } }),
  );
  assert.equal(weak.decision.effect, 'deny');
  assert.equal(weak.decision.reason, 'condition-unsatisfied');

  harness.sessions.answerWith({ assurance: 'multi-factor' });
  const strong = await harness.service.authorize(
    authorizeRequest({ context: { channel: 'channel_web01' } }),
  );
  assert.equal(strong.decision.effect, 'allow');

  const alternative = await harness.service.authorize(
    authorizeRequest({ context: { 'risk-tier': 'tier_low0001' } }),
  );
  assert.equal(alternative.decision.effect, 'allow', 'the any leg is satisfied the other way');

  const neither = await harness.service.authorize(
    authorizeRequest({ context: { channel: 'channel_sms1' } }),
  );
  assert.equal(neither.decision.effect, 'deny');
});

test('a predicate over an undeclared attribute is refused when the grant is written', async () => {
  const harness = await withPolicy();
  await assert.rejects(
    harness.service.grant(
      grantRequest({
        condition: { kind: 'attribute-equals', attribute: 'favourite-colour', value: 'blue0001' },
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-predicate');
      assert.match((error as PermissionError).message, /silently never apply/);
      return true;
    },
  );

  for (const [why, condition] of [
    ['an unknown kind', { kind: 'sql-injection', query: 'DROP TABLE' }],
    ['an empty any', { kind: 'any', of: [] }],
    ['a non-object', 'always'],
    ['an unknown assurance', { kind: 'assurance-at-least', assurance: 'very-sure' }],
    ['a natural-key value', { kind: 'attribute-equals', attribute: 'region', value: 'a@b.com' }],
  ] as const) {
    await assert.rejects(
      harness.service.grant(grantRequest({ condition })),
      (error: unknown) =>
        codeOf(error) === 'unsupported-predicate' || codeOf(error) === 'natural-identifier',
      `${why} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// Policy versions
// ---------------------------------------------------------------------------

test('a grant cannot outlive the capability its policy version gave the role', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ action: 'read', resourceType: 'order' }));
  assert.equal((await harness.service.authorize(authorizeRequest())).decision.effect, 'allow');

  // A newer policy version that no longer permits CUSTOMER to read an order. The grant is not
  // edited or deleted — it simply stops being permitted, and the decision says which version said so.
  await harness.service.publishPolicy(
    policyRequest({
      version: 2,
      roles: [{ role: 'CUSTOMER', capabilities: [{ action: 'create', resourceType: 'order' }] }],
    }),
  );

  const decision = await harness.service.authorize(authorizeRequest());
  assert.equal(decision.decision.effect, 'deny');
  assert.equal(decision.decision.reason, 'not-permitted-by-policy');
  assert.match(decision.decision.explanation, /policy version 2 does not permit CUSTOMER/);
  assert.equal(
    harness.repository.grants().length,
    2,
    'and the grant rows are untouched — a policy change never edits a grant',
  );
});

test('the active policy version is the highest number, not the most recent write', async () => {
  const harness = await withPolicy();
  await harness.service.publishPolicy(policyRequest({ version: 5 }));
  await harness.service.publishPolicy(policyRequest({ version: 3 }));

  const active = await harness.service.activePolicy();
  assert.equal(active.version, 5, 'a lower version published later does not become active');
});

// ---------------------------------------------------------------------------
// The evaluation itself
// ---------------------------------------------------------------------------

test('evaluate is pure and deterministic for the same inputs', () => {
  const policy = {
    policyVersionId: 'pol_01HQZXPURE001',
    version: 1,
    roles: [
      { role: 'CUSTOMER' as const, capabilities: [{ action: 'read', resourceType: 'order' }] },
    ],
    publishedAt: '2026-04-01T12:00:00Z',
    publishedBy: { kind: 'human' as const, id: 'ops-alice-console' },
    bootstrap: false,
    idempotencyKey: 'idem_01HQZXPURE001',
    requestFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const grant = {
    grantId: 'grant_01HQZXPURE01',
    subjectId: SUBJECT,
    accountId: ACCOUNT,
    role: 'CUSTOMER' as const,
    effect: 'allow' as const,
    action: 'read',
    resourceType: 'order',
    resourceId: null,
    purpose: null,
    condition: null,
    policyVersionId: 'pol_01HQZXPURE001',
    grantedAt: '2026-04-01T12:00:00Z',
    notBefore: null,
    expiresAt: null,
    grantedBy: { kind: 'human' as const, id: 'ops-alice-console' },
    idempotencyKey: 'idem_01HQZXPURE002',
    requestFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const input = {
    subjectId: SUBJECT,
    accountId: ACCOUNT,
    action: 'read',
    resourceType: 'order',
    resourceId: null,
    purpose: null,
    context: {},
    assurance: 'single-factor' as const,
    now: '2026-04-01T12:00:00Z',
    policy,
    grants: [grant],
    revokedGrantIds: new Set<string>(),
  };

  const first = evaluate(input);
  const second = evaluate(input);
  assert.deepEqual(
    first,
    second,
    'the same inputs must produce the same explanation, word for word',
  );
  assert.equal(first.effect, 'allow');

  // And reversing the grant order changes nothing: ties break by grant id.
  const reversed = evaluate({
    ...input,
    grants: [grant, { ...grant, grantId: 'grant_01HQZXPURE02' }],
  });
  assert.equal(reversed.decidingGrantId, 'grant_01HQZXPURE01');
});
