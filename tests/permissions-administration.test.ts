/**
 * K-04 Permissions — who may change who may do what (FND-004d correction).
 *
 * The first revision of this component authorised requests carefully and administered itself not at
 * all. `publishPolicy`, `grant` and `revoke` took no session, resolved no account, and accepted the
 * author of the change as a **field in the request**:
 *
 * ```ts
 * service.grant({ ..., grantedBy: { kind: 'human', id: 'ops-alice-console' } })
 * ```
 *
 * Anybody who could reach the service could therefore grant themselves anything, sign it in
 * somebody else's name, and leave an audit trail naming a person who had no idea. Every guarantee
 * in §2 of the contract sat downstream of that: deny-by-default is worth nothing when the caller
 * can write its own allow.
 *
 * So administration is now authenticated, account-scoped, authorised by an explicit grant, and
 * authored by whoever the session says made it. This suite is the adversary's half: each case is
 * somebody trying to change authority they do not hold, and the honest paths are here too, because
 * a check that refused those would have replaced a security hole with an unusable component.
 *
 * The bootstrap cases matter most. Breaking the circularity — no policy means no authority means no
 * policy — requires *a* bypass, and a bypass nobody has enumerated is the most dangerous thing a
 * security component can contain. Every property claimed for it is asserted below.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryPermissionRepository,
  NO_BOOTSTRAP,
  PermissionError,
  PermissionService,
} from '../kernel/permissions/index.ts';

import {
  ACCOUNT,
  ADMIN_ACCOUNT,
  ADMIN_SUBJECT,
  ADMIN_TOKEN,
  BOOTSTRAP,
  FixedClock,
  REFUSING_BOOTSTRAP,
  StubAccountLookup,
  StubSessionValidator,
  SUBJECT,
  TOKEN,
  bootstrapPolicyRequest,
  build,
  grantRequest,
  installFirstAdministrator,
  policyRequest,
  revokeRequest,
  withPolicy,
  without,
} from './helpers/permission-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

/** Every administration operation, so a case can be stated once and asserted on all three. */
function administrations(harness: Awaited<ReturnType<typeof withPolicy>>) {
  return [
    ['publishPolicy', () => harness.service.publishPolicy(policyRequest({ version: 40 }))],
    ['grant', () => harness.service.grant(grantRequest())],
    ['revoke', () => harness.service.revoke(revokeRequest('grant_01HQZXADMIN01'))],
  ] as const;
}

// ---------------------------------------------------------------------------
// Nobody administers anonymously
// ---------------------------------------------------------------------------

test('every administration operation requires a session that validates', async () => {
  const harness = await withPolicy();
  harness.sessions.answerWith({
    adminRefuseWith: new Error(`the secret ${ADMIN_TOKEN} was wrong`),
  });

  for (const [operation, run] of administrations(harness)) {
    await assert.rejects(
      run(),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-session', operation);
        assert.ok(
          !(error as Error).message.includes(ADMIN_TOKEN),
          `${operation} repeated the presented secret back into the error`,
        );
        return true;
      },
      `${operation} must not write authority for a caller it cannot identify`,
    );
  }

  assert.equal(harness.repository.policies().length, 1, 'the bootstrap policy, and nothing new');
  assert.equal(harness.repository.grants().length, 1, 'the administration grant, and nothing new');
  assert.equal(harness.repository.revocations().length, 0);
});

test('an expired or revoked administrator session administers nothing', async () => {
  for (const [why, session] of [
    ['a revoked session', { adminRevokedAt: '2026-04-01T11:00:00Z' }],
    ['a session past its absolute expiry', { adminAbsoluteExpiresAt: '2026-04-01T11:00:00Z' }],
    ['a session past its idle expiry', { adminIdleExpiresAt: '2026-04-01T11:00:00Z' }],
  ] as const) {
    const harness = await withPolicy();
    harness.sessions.answerWith(session);

    for (const [operation, run] of administrations(harness)) {
      await assert.rejects(
        run(),
        (error: unknown) => codeOf(error) === 'invalid-session',
        `${why} must not be able to ${operation}`,
      );
    }
  }
});

test('an administrator holding no account administers nothing', async () => {
  const harness = await withPolicy();
  harness.accounts.answerWith([{ accountId: ACCOUNT, subjectId: SUBJECT }]);

  for (const [operation, run] of administrations(harness)) {
    await assert.rejects(
      run(),
      (error: unknown) => codeOf(error) === 'unknown-account',
      `${operation} needs an account to scope the administrator's authority to`,
    );
  }
});

test('the author is derived from the session, and cannot be supplied', async () => {
  const harness = await withPolicy();

  // Every shape of forged authorship, on every operation.
  const forged: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a human somebody else', { publishedBy: { kind: 'human', id: 'ops-bob-console' } }],
    ['a system authority', { grantedBy: { kind: 'system', id: 'k04-bootstrap' } }],
    ['an agent', { revokedBy: { kind: 'ai', id: 'agent-1' } }],
    ['a named actor', { actor: 'sub_01HQZXATTACKER' }],
    ['a requested bootstrap', { bootstrap: true }],
  ];

  for (const [why, field] of forged) {
    await assert.rejects(
      harness.service.grant({ ...grantRequest(), ...field }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-authorization', why);
        return true;
      },
      `${why} must be refused: authorship is derived, not declared`,
    );
  }

  // What is recorded instead: the authenticated administrator, as a human, by subject id.
  const granted = await harness.service.grant(grantRequest());
  assert.deepEqual(granted.grant.grantedBy, { kind: 'human', id: ADMIN_SUBJECT });

  const published = await harness.service.publishPolicy(policyRequest({ version: 41 }));
  assert.deepEqual(published.policy.publishedBy, { kind: 'human', id: ADMIN_SUBJECT });
  assert.equal(published.policy.bootstrap, false, 'an administered policy is not a bootstrap one');

  const revocation = await harness.service.revoke(revokeRequest(granted.grant.grantId));
  assert.deepEqual(revocation.revokedBy, { kind: 'human', id: ADMIN_SUBJECT });
});

// ---------------------------------------------------------------------------
// Authenticated is not authorised
// ---------------------------------------------------------------------------

test('an authenticated subject with no administration grant administers nothing', async () => {
  // The ordinary user of every other suite: a real session, a real account, and no authority over
  // authority. This is the case that separates authentication from authorisation.
  const harness = await withPolicy();
  harness.sessions.answerWith({ adminSubjectId: SUBJECT, adminSessionId: 'sess_01HQZXPERM0001' });

  for (const [operation, run] of administrations(harness)) {
    await assert.rejects(
      run(),
      (error: unknown) => {
        assert.equal(codeOf(error), 'administration-denied', operation);
        assert.match(
          (error as PermissionError).message,
          /requires an explicit grant of it, like everything else here/,
        );
        return true;
      },
      `${operation} must require authority, not merely a session`,
    );
  }
});

test('an administration grant in another account does not administer this one', async () => {
  const harness = await withPolicy();
  // The administrator's grant is scoped to their own account. Move the account the lookup reports
  // and the grant no longer applies — authority never spans accounts, administration included.
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: 'acct_01HQZXELSEWH1', subjectId: ADMIN_SUBJECT },
  ]);

  await assert.rejects(
    harness.service.grant(grantRequest()),
    (error: unknown) => codeOf(error) === 'administration-denied',
    'an administrator in one account is not an administrator everywhere',
  );
});

test('a revoked or expired administration grant stops administering', async () => {
  const harness = await withPolicy();
  await harness.service.revoke(
    revokeRequest('grant_01HQZXADMIN01', { revocationId: 'rev_01HQZXADMINOF' }),
  );

  for (const [operation, run] of administrations(harness)) {
    await assert.rejects(
      run(),
      (error: unknown) => {
        assert.equal(codeOf(error), 'administration-denied', operation);
        assert.match((error as PermissionError).message, /revoked/);
        return true;
      },
      `${operation} must stop the moment the administrator's own grant is revoked`,
    );
  }
});

test('a staff administrator must declare a purpose, and the right one', async () => {
  const harness = await withPolicy();

  // ADMIN is a staff role, so the administration grant carries a purpose and the call must match
  // it. Purpose limitation applies to administering permissions like it applies to anything else.
  await assert.rejects(
    harness.service.grant(without(grantRequest(), 'administrationPurpose')),
    (error: unknown) => {
      assert.equal(codeOf(error), 'administration-denied');
      assert.match((error as PermissionError).message, /no purpose was declared/);
      return true;
    },
  );

  await assert.rejects(
    harness.service.grant(grantRequest({ administrationPurpose: 'fraud-investigation' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'administration-denied');
      assert.match((error as PermissionError).message, /not the purpose it was granted for/);
      return true;
    },
  );
});

test('SUPER_ADMIN is not a way around any of this', async () => {
  const harness = await withPolicy();
  harness.sessions.answerWith({
    adminSubjectId: 'sub_01HQZXSUPER001',
    adminSessionId: 'sess_01HQZXSUPER01',
  });
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: 'acct_01HQZXSUPER01', subjectId: 'sub_01HQZXSUPER001' },
  ]);

  // A SUPER_ADMIN grant that is not an administration grant confers no administration.
  await installFirstAdministrator(
    harness.repository,
    (await harness.service.activePolicy()).policyVersionId,
    {
      grantId: 'grant_01HQZXSUPER01',
      subjectId: 'sub_01HQZXSUPER001',
      accountId: 'acct_01HQZXSUPER01',
      role: 'SUPER_ADMIN',
      action: 'read',
      resourceType: 'account',
      idempotencyKey: 'idem_01HQZXSUPER01',
    },
  );

  await assert.rejects(
    harness.service.grant(grantRequest()),
    (error: unknown) => codeOf(error) === 'administration-denied',
    'the role name confers nothing; only an explicit grant of grant-permission does',
  );
});

// ---------------------------------------------------------------------------
// Bootstrap: the one bypass, and its edges
// ---------------------------------------------------------------------------

test('with no bootstrap authority wired, the first policy cannot be published at all', async () => {
  const harness = build({ bootstrap: REFUSING_BOOTSTRAP });

  await assert.rejects(
    harness.service.publishPolicy(bootstrapPolicyRequest()),
    (error: unknown) => {
      assert.equal(codeOf(error), 'administration-denied');
      assert.match((error as PermissionError).message, /explicit deployment decision/);
      return true;
    },
    'refusal is the default, and an unwired deployment stays refused',
  );
  assert.equal(harness.repository.policies().length, 0);
});

test('the default service has no bootstrap authority', async () => {
  // Constructed the way a consumer would, with no bootstrap named at all.
  const service = new PermissionService({
    repository: new InMemoryPermissionRepository(),
    sessions: new StubSessionValidator(),
    accounts: new StubAccountLookup(),
    clock: new FixedClock(),
  });

  await assert.rejects(
    service.publishPolicy(bootstrapPolicyRequest()),
    (error: unknown) => codeOf(error) === 'administration-denied',
    'the default is NO_BOOTSTRAP; a deployment that wants one says so',
  );
  assert.equal(NO_BOOTSTRAP.permitsBootstrap(), false);
});

test('a bootstrap publication records that it was one, and who did it', async () => {
  const harness = build();
  const published = await harness.service.publishPolicy(bootstrapPolicyRequest());

  assert.equal(published.policy.bootstrap, true, 'the evidence is on the row, not in a log line');
  assert.deepEqual(
    published.policy.publishedBy,
    { kind: 'system', id: BOOTSTRAP.authorityId },
    'nobody was authenticated, so the author is the authority rather than a person',
  );
});

test('bootstrap is refused the moment a policy exists', async () => {
  const harness = await withPolicy();

  await assert.rejects(
    harness.service.publishPolicy(bootstrapPolicyRequest({ version: 2 })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'administration-denied');
      assert.match((error as PermissionError).message, /nothing to bootstrap/);
      return true;
    },
    'bootstrap cannot be reused to install a wider policy over a real one',
  );
  assert.equal(harness.repository.policies().length, 1);
});

test('bootstrap cannot create a grant or a revocation', async () => {
  const harness = build();
  await harness.service.publishPolicy(bootstrapPolicyRequest());

  // No token, and no bootstrap path for either operation: the request type requires one, and the
  // service refuses without it. Bootstrap installs rules and hands nobody authority under them.
  await assert.rejects(
    harness.service.grant(without(grantRequest(), 'presentedToken')),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'there is no bootstrap path to a grant',
  );

  await assert.rejects(
    harness.service.revoke(without(revokeRequest('grant_01HQZXANY0001'), 'presentedToken')),
    (error: unknown) => codeOf(error) === 'invalid-session',
    'there is no bootstrap path to a revocation',
  );

  assert.equal(harness.repository.grants().length, 0, 'bootstrap granted nobody anything');
  assert.equal(harness.repository.revocations().length, 0);
});

test('presenting a session takes the authenticated path even on an empty store', async () => {
  // A caller that presents a token is claiming to be an administrator, and the claim is checked
  // rather than waved through into bootstrap because the store happens to be empty.
  const harness = build();

  await assert.rejects(harness.service.publishPolicy(policyRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'no-such-policy');
    assert.match((error as PermissionError).message, /from the injected bootstrap authority/);
    return true;
  });
  assert.equal(harness.repository.policies().length, 0);
});

test('a bootstrap retry converges, and a re-bootstrap under a new key does not', async () => {
  const harness = build();
  const request = bootstrapPolicyRequest({
    policyVersionId: 'pol_01HQZXBOOT001',
    idempotencyKey: 'idem_01HQZXBOOT001',
  });

  const first = await harness.service.publishPolicy(request);
  const retry = await harness.service.publishPolicy({ ...request });
  assert.equal(retry.deduplicated, true, 'a retried bootstrap is the same bootstrap');
  assert.deepEqual(retry.policy, first.policy);

  await assert.rejects(
    harness.service.publishPolicy(
      bootstrapPolicyRequest({
        policyVersionId: 'pol_01HQZXBOOT002',
        version: 2,
        idempotencyKey: 'idem_01HQZXBOOT002',
      }),
    ),
    (error: unknown) => codeOf(error) === 'administration-denied',
    'a second bootstrap is not a retry; it is a second first policy',
  );
  assert.equal(harness.repository.policies().length, 1);
});

test('a bootstrap key cannot be reused for an administered publication', async () => {
  const harness = await withPolicy();
  const bootstrapKey = harness.repository.policies()[0]?.idempotencyKey;
  assert.ok(bootstrapKey !== undefined);

  await assert.rejects(
    harness.service.publishPolicy(policyRequest({ version: 2, idempotencyKey: bootstrapKey })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match(
        (error as PermissionError).message,
        /the administrator, session, account or bootstrap status/,
      );
      return true;
    },
    'a bootstrap and an administered publication are never the same request',
  );
});

// ---------------------------------------------------------------------------
// The authorised path still works
// ---------------------------------------------------------------------------

test('an authorised administrator can publish, grant and revoke', async () => {
  const harness = await withPolicy();

  const published = await harness.service.publishPolicy(policyRequest({ version: 3 }));
  assert.equal(published.policy.version, 3);
  assert.equal(published.policy.bootstrap, false);

  const granted = await harness.service.grant(grantRequest());
  assert.equal(granted.deduplicated, false);
  assert.deepEqual(granted.grant.grantedBy, { kind: 'human', id: ADMIN_SUBJECT });

  const revocation = await harness.service.revoke(revokeRequest(granted.grant.grantId));
  assert.equal(revocation.grantId, granted.grant.grantId);

  // And the grant it wrote decides a real request.
  const decision = await harness.service.authorize({
    decisionId: 'dec_01HQZXADMINOK',
    presentedToken: TOKEN,
    accountId: ACCOUNT,
    action: 'read',
    resourceType: 'order',
    idempotencyKey: 'idem_01HQZXADMINOK',
  });
  assert.equal(decision.decision.effect, 'deny', 'revoked before it was used');
  assert.equal(decision.decision.reason, 'grant-revoked');
});

test('identical concurrent administrations from one administrator converge', async () => {
  const harness = await withPolicy();
  const request = grantRequest({
    grantId: 'grant_01HQZXRACEADM',
    idempotencyKey: 'idem_01HQZXRACEADM',
  });

  const outcomes = await Promise.allSettled([
    harness.service.grant({ ...request }),
    harness.service.grant({ ...request }),
  ]);

  const grants = outcomes.map((outcome) =>
    outcome.status === 'fulfilled' ? outcome.value.grant : null,
  );
  assert.equal(
    grants.filter((grant) => grant !== null).length,
    2,
    'both administrators get an answer: one wrote it, the other converged on it',
  );
  assert.deepEqual(grants[0], grants[1], 'and it is the same grant');
  assert.equal(
    harness.repository.grants().length,
    2,
    'the administration grant and one raced grant',
  );
});

test('concurrent administrations from different administrators do not converge', async () => {
  const harness = await withPolicy();
  await installFirstAdministrator(
    harness.repository,
    (await harness.service.activePolicy()).policyVersionId,
    {
      grantId: 'grant_01HQZXADMIN03',
      subjectId: 'sub_01HQZXADMIN003',
      accountId: 'acct_01HQZXADMIN03',
      idempotencyKey: 'idem_01HQZXADMIN03',
    },
  );
  harness.accounts.answerWith([
    { accountId: ACCOUNT, subjectId: SUBJECT },
    { accountId: ADMIN_ACCOUNT, subjectId: ADMIN_SUBJECT },
    { accountId: 'acct_01HQZXADMIN03', subjectId: 'sub_01HQZXADMIN003' },
  ]);

  const request = grantRequest({
    grantId: 'grant_01HQZXRACETWO',
    idempotencyKey: 'idem_01HQZXRACETWO',
  });

  // The first administrator writes it; the second, arriving under the same key, is a different
  // authority statement and must be refused rather than converged on.
  const first = await harness.service.grant({ ...request });
  assert.equal(first.deduplicated, false);

  harness.sessions.answerWith({
    adminSubjectId: 'sub_01HQZXADMIN003',
    adminSessionId: 'sess_01HQZXADMIN03',
  });
  await assert.rejects(harness.service.grant({ ...request }), (error: unknown) => {
    assert.equal(codeOf(error), 'idempotency-key-reuse');
    assert.match((error as PermissionError).message, /the administrator, session or account/);
    return true;
  });
});
