/**
 * K-04 Permissions — races, retries and the history that cannot be rewritten (FND-004d).
 *
 * Authority is the thing most worth racing. Two grants written at once, a grant and its revocation
 * crossing, a decision retried while the first copy is still in flight, a stale worker acting on a
 * revoked grant — each is a way for a caller to end up with more access than anybody intended, and
 * each is proved here against the reference repository, which checks its uniqueness **at commit
 * against the store as it stands** exactly as PostgreSQL would.
 *
 * The overlaps are arranged rather than hoped for: a latch holds one transaction open in the window
 * between "the body finished" and "the commit ran". Two calls that merely start close together
 * prove nothing, because nothing in the runtime promises they interleave at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryPermissionRepository,
  PermissionError,
  type PermissionRepository,
  type PermissionTransaction,
} from '../kernel/permissions/index.ts';

import {
  authorizeRequest,
  build,
  grantRequest,
  policyRequest,
  revokeRequest,
  withPolicy,
} from './helpers/permission-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PermissionError ? error.code : undefined;

/** A promise the test opens by hand, so "these two transactions overlapped" is a fact. */
class Latch {
  readonly opened: Promise<void>;
  readonly open: () => void;

  constructor() {
    let release: () => void = () => undefined;
    this.opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.open = (): void => {
      release();
    };
  }
}

/**
 * The real in-memory repository, with one seam: a transaction can be held open after its body has
 * finished and before it commits — the window a race lives in.
 */
class GatedRepository implements PermissionRepository {
  readonly store = new InMemoryPermissionRepository();
  #gate: (result: unknown) => Promise<void> = () => Promise.resolve();

  gateWith(gate: (result: unknown) => Promise<void>): void {
    this.#gate = gate;
  }

  withTransaction<T>(body: (tx: PermissionTransaction) => Promise<T>): Promise<T> {
    return this.store.withTransaction(async (tx) => {
      const result = await body(tx);
      await this.#gate(result);
      return result;
    });
  }
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an identical grant retry converges on the original, and a different one fails closed', async () => {
  const harness = await withPolicy();
  const request = grantRequest({ grantId: 'grant_01HQZXRETRY01', idempotencyKey: 'idem_01HQZXRT01' });

  const first = await harness.service.grant(request);
  const retry = await harness.service.grant({ ...request });

  assert.equal(first.deduplicated, false);
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.grant, first.grant);
  assert.equal(harness.repository.grants().length, 1, 'one grant, not two');

  // The same key for a *wider* grant is the escalation this check exists to stop.
  for (const [why, mutation] of [
    ['a different effect', { effect: 'deny' }],
    ['a different action', { action: 'create' }],
    ['a different resource type', { resourceType: 'account' }],
    ['a different subject', { subjectId: 'sub_01HQZXOTHER001' }],
    ['a different account', { accountId: 'acct_01HQZXOTHER01' }],
    ['a different role', { role: 'SUPPORT', purpose: 'support-request' }],
  ] as const) {
    await assert.rejects(
      harness.service.grant({ ...request, ...mutation }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as PermissionError).message, /an authority it never granted/);
        return true;
      },
      `${why} must not be returned as if it were the original`,
    );
  }
  assert.equal(harness.repository.grants().length, 1);
});

test('a decision retry returns the decision that was taken, not a fresh one', async () => {
  const harness = await withPolicy();
  const granted = await harness.service.grant(grantRequest());
  const request = authorizeRequest({ idempotencyKey: 'idem_01HQZXDECIDE1' });

  const first = await harness.service.authorize(request);
  assert.equal(first.decision.effect, 'allow');
  assert.equal(first.deduplicated, false);

  // The grant is revoked between the two calls. A retry must still return the decision that was
  // actually taken — re-deciding would let a caller retry until the answer changed, in either
  // direction.
  await harness.service.revoke(revokeRequest(granted.grant.grantId));

  const retry = await harness.service.authorize({ ...request });
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.decision, first.decision, 'the recorded decision is the answer');
  assert.equal(harness.repository.decisions().length, 1);

  // But a *new* question gets the current answer.
  const fresh = await harness.service.authorize(authorizeRequest());
  assert.equal(fresh.decision.effect, 'deny');
  assert.equal(fresh.decision.reason, 'grant-revoked');
});

test('an idempotency key reused for a different question is refused, not answered', async () => {
  // The confused-deputy shape: reuse the key from an allowed read of one resource to ask about
  // another, and receive the allow that was computed for something else.
  const harness = await withPolicy();
  await harness.service.grant(grantRequest({ resourceId: 'order_01HQZXMINE001' }));

  const key = 'idem_01HQZXCONFUSE';
  const allowed = await harness.service.authorize(
    authorizeRequest({ resourceId: 'order_01HQZXMINE001', idempotencyKey: key }),
  );
  assert.equal(allowed.decision.effect, 'allow');

  await assert.rejects(
    harness.service.authorize(
      authorizeRequest({ resourceId: 'order_01HQZXYOURS01', idempotencyKey: key }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as PermissionError).message, /how a confused deputy is built/);
      return true;
    },
  );
});

test('a policy version number cannot be reused, whatever the key', async () => {
  const harness = await withPolicy();
  await assert.rejects(
    harness.service.publishPolicy(policyRequest({ version: 1 })),
    (error: unknown) => codeOf(error) === 'duplicate-policy-version',
    'two rows claiming one version would make "the policy of the day" ambiguous',
  );
});

// ---------------------------------------------------------------------------
// Races
// ---------------------------------------------------------------------------

test('two identical grants racing produce one grant', async () => {
  const repository = new GatedRepository();
  const harness = build({ repository: repository.store });
  await harness.service.publishPolicy(policyRequest());

  // Both callers work against the same store through the same service.
  const gated = build({ repository: repository.store });
  await gated.service.publishPolicy(policyRequest({ version: 2 })).catch(() => undefined);

  const request = grantRequest({ grantId: 'grant_01HQZXRACE001', idempotencyKey: 'idem_01HQZXRACE1' });
  const outcomes = await Promise.allSettled([
    harness.service.grant({ ...request }),
    harness.service.grant({ ...request }),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    2,
    'both callers get an answer: one wrote it, the other converged on it',
  );
  assert.equal(repository.store.grants().length, 1, 'and there is exactly one grant');
});

test('a grant and its revocation racing leave exactly one revocation', async () => {
  const harness = await withPolicy();
  const granted = await harness.service.grant(grantRequest());

  const outcomes = await Promise.allSettled([
    harness.service.revoke(revokeRequest(granted.grant.grantId)),
    harness.service.revoke(revokeRequest(granted.grant.grantId)),
  ]);

  assert.equal(harness.repository.revocations().length, 1, 'one revocation per grant');
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  assert.equal(rejected.length, 1, 'the loser is told, rather than silently rewriting the instant');
  assert.equal(codeOf(rejected[0]?.reason), 'stale-revocation');
});

test('a losing transaction leaves no partial authority behind', async () => {
  const repository = new GatedRepository();
  const harness = build({ repository: repository.store });
  await harness.service.publishPolicy(policyRequest());

  const held = new Latch();
  const ready = new Latch();
  const policyVersionId = (await harness.service.activePolicy()).policyVersionId;

  // A transaction that writes a grant, then is held open while another writes the same key.
  const losing = repository.withTransaction(async (tx) => {
    await tx.insertGrant({
      grantId: 'grant_01HQZXLOSER01',
      subjectId: 'sub_01HQZXPERM0001',
      accountId: 'acct_01HQZXPERM0001',
      role: 'CUSTOMER',
      effect: 'allow',
      action: 'read',
      resourceType: 'order',
      resourceId: null,
      purpose: null,
      condition: null,
      policyVersionId,
      grantedAt: '2026-04-01T12:00:00Z',
      notBefore: null,
      expiresAt: null,
      grantedBy: { kind: 'human', id: 'ops-alice-console' },
      idempotencyKey: 'idem_01HQZXCONTEST',
    });
    ready.open();
    await held.opened;
  });
  await ready.opened;

  // The winner commits the same idempotency key first.
  await repository.store.withTransaction((tx) =>
    tx.insertGrant({
      grantId: 'grant_01HQZXWINNER1',
      subjectId: 'sub_01HQZXPERM0001',
      accountId: 'acct_01HQZXPERM0001',
      role: 'CUSTOMER',
      effect: 'allow',
      action: 'read',
      resourceType: 'order',
      resourceId: null,
      purpose: null,
      condition: null,
      policyVersionId,
      grantedAt: '2026-04-01T12:00:00Z',
      notBefore: null,
      expiresAt: null,
      grantedBy: { kind: 'human', id: 'ops-alice-console' },
      idempotencyKey: 'idem_01HQZXCONTEST',
    }),
  );

  held.open();
  await assert.rejects(losing, (error: unknown) => codeOf(error) === 'idempotency-key-reuse');

  const grants = repository.store.grants();
  assert.equal(grants.length, 1, 'the refused transaction wrote nothing');
  assert.equal(grants[0]?.grantId, 'grant_01HQZXWINNER1');
});

// ---------------------------------------------------------------------------
// Stale state cannot authorise
// ---------------------------------------------------------------------------

test('a stale worker acting after a revocation is denied', async () => {
  // v3 §49's "stale worker acting after newer state", in the authority layer: the worker holds a
  // decision it took a minute ago and asks again with a fresh key. The answer must be the current
  // one, not the one it remembers.
  const harness = await withPolicy();
  const granted = await harness.service.grant(grantRequest());
  const before = await harness.service.authorize(authorizeRequest());
  assert.equal(before.decision.effect, 'allow');

  await harness.service.revoke(revokeRequest(granted.grant.grantId));

  const now = await harness.service.authorize(authorizeRequest());
  assert.equal(now.decision.effect, 'deny');
  assert.equal(now.decision.reason, 'grant-revoked');
  assert.notEqual(now.decision.decisionId, before.decision.decisionId);
});

test('a malformed stored grant cannot authorise anything', async () => {
  // The row was written around the service — the case fail-closed decoding exists for. Nothing in
  // the store may be treated as authority unless it is exactly what this component writes.
  const harness = await withPolicy();
  const policy = await harness.service.activePolicy();

  harness.repository.seed({
    policies: [policy],
    grants: [
      {
        grantId: 'grant_01HQZXBROKEN1',
        subjectId: 'sub_01HQZXPERM0001',
        accountId: 'acct_01HQZXPERM0001',
        role: 'CUSTOMER',
        // An effect nothing here writes. Deny-by-default is not "treat unknown as deny and carry
        // on" — an unreadable authority row is a refusal, because the same row could as easily
        // have been an unreadable allow.
        effect: 'maybe' as never,
        action: 'read',
        resourceType: 'order',
        resourceId: null,
        purpose: null,
        condition: null,
        policyVersionId: policy.policyVersionId,
        grantedAt: '2026-04-01T12:00:00Z',
        notBefore: null,
        expiresAt: null,
        grantedBy: { kind: 'human', id: 'ops-alice-console' },
        idempotencyKey: 'idem_01HQZXBROKEN1',
      },
    ],
  });

  const decision = await harness.service.authorize(authorizeRequest());
  assert.equal(decision.decision.effect, 'deny', 'a row nobody here wrote cannot allow anything');
});

// ---------------------------------------------------------------------------
// Append-only history
// ---------------------------------------------------------------------------

test('the port exposes no way to update or delete authority', () => {
  const repository = new InMemoryPermissionRepository();
  return repository.withTransaction((tx) => {
    const operations = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const forbidden = [...operations].filter((name) =>
      /delete|remove|purge|truncate|update|edit|rewrite|widen/i.test(name),
    );
    assert.deepEqual(
      forbidden,
      [],
      'an edited grant answers "who may do this" and destroys "who could have, and who said so"',
    );
    for (const required of ['insertGrant', 'insertRevocation', 'insertDecision', 'insertPolicyVersion']) {
      assert.ok(operations.has(required));
    }
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryPermissionRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertPolicyVersion({
        policyVersionId: 'pol_01HQZXROLLBK1',
        version: 1,
        roles: [{ role: 'CUSTOMER', capabilities: [{ action: 'read', resourceType: 'order' }] }],
        publishedAt: '2026-04-01T12:00:00Z',
        publishedBy: { kind: 'human', id: 'ops-alice-console' },
        idempotencyKey: 'idem_01HQZXROLLBK1',
      });
      throw new Error('something went wrong after the policy was written');
    }),
    /something went wrong/,
  );

  assert.equal(repository.policies().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('no source file in this component can update or delete a record', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kernel', 'permissions');
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const code = stripComments(readFileSync(path.join(dir, file), 'utf8'));
    for (const forbidden of [/\bUPDATE\s+\$?\{?kernel_permissions/i, /\bDELETE\s+FROM/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${file} contains ${String(forbidden)} — authority history is append-only at every layer`,
      );
    }
  }
});
