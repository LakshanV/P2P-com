/**
 * K-04 Permissions — what an idempotency key may and may not buy (FND-004d correction).
 *
 * An idempotency key is a claim about the identity of an intent. On its own it is also a **bearer
 * token for an answer**, and the first revision of `authorize` treated it as one: the stored
 * decision was looked up *before* the presented session was validated, and compared on six of the
 * nine facts the decision actually depended on.
 *
 * That is two defects wearing one coat:
 *
 *   - **the lookup came first**, so presenting somebody else's key with any garbage token returned
 *     their `allow` without the thief ever holding a session;
 *   - **the comparison was partial**, so even with a valid session of their own, a caller could
 *     change the ABAC context — the thing a condition was evaluated against — and be handed an
 *     answer computed under different circumstances.
 *
 * The correction is one ordering change and one stored fingerprint. This suite is the adversary's
 * half of it: every case here is somebody trying to get an answer they did not earn, and the
 * genuine retries are here too, because a check that refused those would have broken the feature
 * instead of securing it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PermissionError,
  canonicalDecisionRequest,
  fingerprintDecisionRequest,
} from '../kernel/permissions/index.ts';

import {
  ACCOUNT,
  ADMIN_ACCOUNT,
  ADMIN_SUBJECT,
  SUBJECT,
  installFirstAdministrator,
  authorizeRequest,
  grantRequest,
  policyRequest,
  revokeRequest,
  storedActivePolicy,
  withPolicy,
} from './helpers/permission-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

// ---------------------------------------------------------------------------
// A stolen key buys nothing
// ---------------------------------------------------------------------------

test('a stolen decision key with no working session is refused, not answered', async () => {
  // The hole this correction closes, stated as the attack: hold the key, hold nothing else.
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());

  const key = 'idem_01HQZXSTOLEN1';
  const owner = await harness.service.authorize(authorizeRequest({ idempotencyKey: key }));
  assert.equal(owner.decision.effect, 'allow');

  harness.sessions.answerWith({ refuseWith: new Error('not a session anybody issued') });
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'a retry must validate the presented session before anything is read from storage',
  );

  assert.equal(harness.repository.decisions().length, 1, 'and no second decision was recorded');
});

test('a stolen decision key presented from another valid session is refused', async () => {
  // The thief has a working session and an account of their own, so nothing about the request is
  // malformed. What stops it is that the stored decision was computed for somebody else.
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: 'acct_01HQZXTHIEF01', subjectId: 'sub_01HQZXTHIEF001' },
  ]);

  const key = 'idem_01HQZXSTOLEN2';
  const decisionId = 'dec_01HQZXSTOLEN2';
  assert.equal(
    (await harness.service.authorize(authorizeRequest({ decisionId, idempotencyKey: key })))
      .decision.effect,
    'allow',
  );

  harness.sessions.answerWith({
    subjectId: 'sub_01HQZXTHIEF001',
    sessionId: 'sess_01HQZXTHIEF01',
  });
  await assert.rejects(
    harness.service.authorize(
      authorizeRequest({ decisionId, idempotencyKey: key, accountId: 'acct_01HQZXTHIEF01' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as PermissionError).message, /the authenticated subject/);
      assert.match((error as PermissionError).message, /stolen idempotency key/);
      return true;
    },
    'the fingerprint binds the answer to the subject it was computed for',
  );
});

test('a stolen key aimed at the owner’s account is refused before any grant is read', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: 'acct_01HQZXTHIEF01', subjectId: 'sub_01HQZXTHIEF001' },
  ]);

  const key = 'idem_01HQZXSTOLEN3';
  await harness.service.authorize(authorizeRequest({ idempotencyKey: key }));

  // Naming the victim's account rather than their own is the more obvious attack, and it is
  // refused earlier still — isolation runs before the idempotency lookup.
  harness.sessions.answerWith({
    subjectId: 'sub_01HQZXTHIEF001',
    sessionId: 'sess_01HQZXTHIEF01',
  });
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ idempotencyKey: key })),
    (error: unknown) => codeOf(error) === 'cross-account-access',
  );
});

test('a retry from a different session for the same subject is refused', async () => {
  // Idempotency keys are scoped to the session that earned the answer. The same person on a new
  // session is asking a new question and gets a new answer, rather than the old one.
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());

  const key = 'idem_01HQZXRESESS1';
  const decisionId = 'dec_01HQZXRESESS1';
  await harness.service.authorize(authorizeRequest({ decisionId, idempotencyKey: key }));

  harness.sessions.answerWith({ sessionId: 'sess_01HQZXROTATED1' });
  await assert.rejects(
    harness.service.authorize(authorizeRequest({ decisionId, idempotencyKey: key })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as PermissionError).message, /the session it was decided for/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The context is part of the question
// ---------------------------------------------------------------------------

test('a retry with a changed ABAC context is refused', async () => {
  // The context is not a column, so nothing but the fingerprint could catch this. A grant
  // conditioned on one region, satisfied once, must not be replayable from another.
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({
      condition: { kind: 'attribute-equals', attribute: 'region', value: 'region_north1' },
    }),
  );

  const key = 'idem_01HQZXCONTEXT';
  // The decision id is pinned across every call below, so the context is the *only* input that
  // varies. Letting it drift would refuse on the id and prove nothing about the fingerprint.
  const decisionId = 'dec_01HQZXCONTEXT';
  const allowed = await harness.service.authorize(
    authorizeRequest({ decisionId, idempotencyKey: key, context: { region: 'region_north1' } }),
  );
  assert.equal(allowed.decision.effect, 'allow');

  const variants: ReadonlyArray<readonly [string, Record<string, string> | undefined]> = [
    ['a different value', { region: 'region_south1' }],
    ['no context at all', undefined],
    ['an additional attribute', { region: 'region_north1', channel: 'channel_web01' }],
  ];

  for (const [why, context] of variants) {
    const request =
      context === undefined
        ? authorizeRequest({ decisionId, idempotencyKey: key })
        : authorizeRequest({ decisionId, idempotencyKey: key, context });
    await assert.rejects(
      harness.service.authorize(request),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as PermissionError).message, /the ABAC context/, why);
        return true;
      },
      `${why} must not be answered from the stored decision`,
    );
  }

  // And the genuinely identical retry still converges, which is the feature this protects.
  const retry = await harness.service.authorize(
    authorizeRequest({ decisionId, idempotencyKey: key, context: { region: 'region_north1' } }),
  );
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.decision, allowed.decision);
});

test('the canonical form is unambiguous, and stable under key order', () => {
  // If field boundaries were not quoted, `{"a":"b:c"}` and `{"a:b":"c"}` would fingerprint alike
  // and two different contexts would count as "the same request".
  const facts = {
    decisionId: 'dec_01HQZXCANON01',
    subjectId: SUBJECT,
    sessionId: 'sess_01HQZXCANON01',
    accountId: ACCOUNT,
    action: 'read',
    resourceType: 'order',
    resourceId: null,
    purpose: null,
    context: { region: 'region_north1' },
  } as const;

  assert.equal(
    fingerprintDecisionRequest(facts),
    fingerprintDecisionRequest({ ...facts, context: { region: 'region_north1' } }),
    'the same inputs must fingerprint identically',
  );
  assert.notEqual(
    fingerprintDecisionRequest(facts),
    fingerprintDecisionRequest({ ...facts, context: { channel: 'region_north1' } }),
    'a value moved to another attribute is a different request',
  );
  assert.notEqual(
    fingerprintDecisionRequest(facts),
    fingerprintDecisionRequest({ ...facts, sessionId: 'sess_01HQZXCANON02' }),
  );
  assert.equal(
    fingerprintDecisionRequest({
      ...facts,
      context: { region: 'region_north1', channel: 'channel_web01' },
    }),
    fingerprintDecisionRequest({
      ...facts,
      context: { channel: 'channel_web01', region: 'region_north1' },
    }),
    'key order is not part of the question',
  );
  assert.match(canonicalDecisionRequest(facts), /"context":\{"region":"region_north1"\}/);
  assert.match(fingerprintDecisionRequest(facts), /^[0-9a-f]{64}$/);
});

test('the recorded decision carries the fingerprint of what was asked', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());
  const { decision } = await harness.service.authorize(
    authorizeRequest({ context: { region: 'region_north1' } }),
  );

  assert.match(decision.requestFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    decision.requestFingerprint,
    fingerprintDecisionRequest({
      decisionId: decision.decisionId,
      subjectId: decision.subjectId,
      sessionId: decision.sessionId,
      accountId: decision.accountId,
      action: decision.action,
      resourceType: decision.resourceType,
      resourceId: decision.resourceId,
      purpose: decision.purpose,
      context: { region: 'region_north1' },
    }),
    'the stored fingerprint must be reproducible from the decision and the context it was given',
  );
});

// ---------------------------------------------------------------------------
// Who administered an authority statement is part of it
// ---------------------------------------------------------------------------

test('a grant retry from a different administrator is refused', async () => {
  // Authorship is no longer a field, so this is the attack that replaced forging one: capture an
  // administrator's idempotency key and replay it as a *different* administrator. Converging would
  // record the first administrator as the author of the second one's change.
  const harness = await withPolicy();
  const grant = grantRequest({
    grantId: 'grant_01HQZXAUTHOR1',
    idempotencyKey: 'idem_01HQZXAUTH01',
  });
  await harness.service.grant(grant);

  // A second administrator, holding the same administration authority.
  await installFirstAdministrator(
    harness.repository,
    (await storedActivePolicy(harness.repository)).policyVersionId,
    {
      grantId: 'grant_01HQZXADMIN02',
      subjectId: 'sub_01HQZXADMIN002',
      accountId: 'acct_01HQZXADMIN02',
      idempotencyKey: 'idem_01HQZXADMIN02',
    },
  );
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: ADMIN_ACCOUNT, subjectId: ADMIN_SUBJECT },
    { accountId: 'acct_01HQZXADMIN02', subjectId: 'sub_01HQZXADMIN002' },
  ]);
  harness.sessions.answerWith({
    adminSubjectId: 'sub_01HQZXADMIN002',
    adminSessionId: 'sess_01HQZXADMIN02',
  });

  await assert.rejects(
    harness.service.grant({ ...grant }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as PermissionError).message, /the administrator, session or account/);
      return true;
    },
    'who decided somebody could do this is part of the record, not metadata about it',
  );
  assert.equal(
    harness.repository.grants().length,
    3,
    'the two administration grants and the one real grant, and no more',
  );
});

test('a grant retry from the same administrator on a new session is refused', async () => {
  const harness = await withPolicy();
  const grant = grantRequest({ idempotencyKey: 'idem_01HQZXAUTH04' });
  await harness.service.grant(grant);

  harness.sessions.answerWith({ adminSessionId: 'sess_01HQZXADMINRO' });
  await assert.rejects(
    harness.service.grant({ ...grant }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as PermissionError).message, /the administrator, session or account/);
      return true;
    },
    'an administration key is scoped to the session that made the change',
  );
});

test('a policy or revocation retry from a different administrator is refused', async () => {
  const harness = await withPolicy();

  const policy = policyRequest({ version: 7, idempotencyKey: 'idem_01HQZXAUTH02' });
  await harness.service.publishPolicy(policy);

  const granted = await harness.service.grant(grantRequest());
  const revocation = revokeRequest(granted.grant.grantId, { idempotencyKey: 'idem_01HQZXAUTH03' });
  await harness.service.revoke(revocation);

  // The same administrator, a new session — the narrowest possible change of actor.
  harness.sessions.answerWith({ adminSessionId: 'sess_01HQZXADMINR2' });

  await assert.rejects(harness.service.publishPolicy({ ...policy }), (error: unknown) => {
    assert.equal(codeOf(error), 'idempotency-key-reuse');
    assert.match(
      (error as PermissionError).message,
      /the administrator, session, account or bootstrap status/,
    );
    return true;
  });

  await assert.rejects(harness.service.revoke({ ...revocation }), (error: unknown) => {
    assert.equal(codeOf(error), 'idempotency-key-reuse');
    assert.match((error as PermissionError).message, /the administrator, session or account/);
    return true;
  });
});

test('an identical retry from the same administrator still converges', async () => {
  // The other direction: tightening the comparison must not break the idempotency it exists for.
  const harness = await withPolicy();
  const grant = grantRequest({ idempotencyKey: 'idem_01HQZXSAMEAUT' });
  const first = await harness.service.grant(grant);
  const retry = await harness.service.grant({ ...grant });

  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.grant, first.grant);
  assert.equal(harness.repository.grants().length, 2, 'the administration grant, and this one');

  const policy = policyRequest({ version: 9, idempotencyKey: 'idem_01HQZXSAMEPOL' });
  const published = await harness.service.publishPolicy(policy);
  const republished = await harness.service.publishPolicy({ ...policy });
  assert.equal(republished.deduplicated, true);
  assert.deepEqual(republished.policy, published.policy);
});

// ---------------------------------------------------------------------------
// Concurrent conflict recovery
// ---------------------------------------------------------------------------

test('two identical authorizations racing produce one decision and one answer', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());
  const request = authorizeRequest({ idempotencyKey: 'idem_01HQZXRACEDEC' });

  const outcomes = await Promise.allSettled([
    harness.service.authorize({ ...request }),
    harness.service.authorize({ ...request }),
  ]);

  const decisions = outcomes.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value.decision : null,
  );
  assert.equal(
    decisions.filter((decision) => decision !== null).length,
    2,
    'both callers get an answer: one wrote it, the other converged on it',
  );
  assert.deepEqual(decisions[0], decisions[1], 'two identical requests, one answer');
  assert.equal(harness.repository.decisions().length, 1, 'and exactly one decision was recorded');
});

test('a racing authorization with a different context fails closed on the recovery path', async () => {
  // The post-conflict path, reached only when the insert loses. It applies the same complete
  // comparison as the pre-insert retry — a convergence that checked less would be the same hole
  // reached by another route.
  const harness = await withPolicy();
  await harness.service.grant(
    grantRequest({
      condition: {
        kind: 'attribute-in',
        attribute: 'region',
        values: ['region_north1', 'region_south1'],
      },
    }),
  );
  const key = 'idem_01HQZXRACECTX';
  const decisionId = 'dec_01HQZXRACECTX';

  const outcomes = await Promise.allSettled([
    harness.service.authorize(
      authorizeRequest({ decisionId, idempotencyKey: key, context: { region: 'region_north1' } }),
    ),
    harness.service.authorize(
      authorizeRequest({ decisionId, idempotencyKey: key, context: { region: 'region_south1' } }),
    ),
  ]);

  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
    'one of the two wrote its decision',
  );
  assert.equal(rejected.length, 1, 'the other was refused rather than handed the wrong answer');
  assert.equal(codeOf(rejected[0]?.reason), 'idempotency-key-reuse');
  assert.equal(harness.repository.decisions().length, 1);
});

test('a racing authorization from another session fails closed on the recovery path', async () => {
  const harness = await withPolicy();
  await harness.service.grant(grantRequest());
  const key = 'idem_01HQZXRACESES';

  // The second caller's session differs, so the two requests are not the same question however
  // identical the rest of them looks.
  const first = harness.service.authorize(authorizeRequest({ idempotencyKey: key }));
  harness.sessions.answerWith({ sessionId: 'sess_01HQZXRACED002' });
  const second = harness.service.authorize(authorizeRequest({ idempotencyKey: key }));

  const outcomes = await Promise.allSettled([first, second]);
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  assert.equal(rejected.length, 1);
  assert.equal(codeOf(rejected[0]?.reason), 'idempotency-key-reuse');
  assert.equal(harness.repository.decisions().length, 1);
});
