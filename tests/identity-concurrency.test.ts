/**
 * K-01 Identity — concurrency, transaction composition and immutability (FND-004a).
 *
 * Three properties that only fail when something else is happening at the same time, plus the one
 * that only fails when a caller keeps a reference.
 *
 *   - **Retry convergence.** Two retries of one creation that overlap in time each read a store
 *     with no such idempotency key, so both try to insert and one loses. The loser has not failed:
 *     the creation it was retrying succeeded. It must converge on the winner and return it, because
 *     a caller retrying after a timeout has done nothing wrong — and a caller told "conflict" here
 *     will create a *second* identity for the same party, which is the failure this key exists to
 *     prevent.
 *   - **Mismatched reuse still fails closed.** Convergence must not become "return whatever holds
 *     the key". A key reused for a different subject hands back an identity for a party the caller
 *     never asked about, which it then attaches an account to.
 *   - **Enlistment without nested transaction control.** PostgreSQL has no nested transactions: a
 *     `COMMIT` from an enlisted path ends the *caller's* transaction.
 *   - **Immutability across the boundary.** A subject a caller holds must not be the subject the
 *     store holds. K-09 shipped with the opposite (§11.20), so this is asserted from every
 *     direction a subject can be handed across.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EnlistedIdentityRepository,
  IdentityError,
  IdentityService,
  InMemoryIdentityRepository,
  PostgresIdentityRepository,
  enlistedClient,
  isSealed,
  sealSubject,
} from '../kernel/identity/index.ts';
import type {
  IdentityRepository,
  IdentitySubject,
  IdentityTransaction,
} from '../kernel/identity/index.ts';
import type { DatabaseClient } from '../platform/db/client.ts';

import { AI, build, createRequest, row, subject } from './helpers/identity-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof IdentityError ? error.code : undefined;

/** The record type with every `readonly` stripped, so a test can attempt what a caller would. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

const mutableSubject = (overrides: Partial<IdentitySubject> = {}): Mutable<IdentitySubject> => ({
  subjectId: 'sub_01HQZXMUTABLE',
  kind: 'person',
  createdAt: '2026-04-01T12:00:00Z',
  origin: { kind: 'system', id: 'K-03-account-service' },
  idempotencyKey: 'idem_01HQZXMUTABLE',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Idempotent retry, sequential and concurrent
// ---------------------------------------------------------------------------

test('a sequential retry returns the original subject rather than creating a second', async () => {
  const { service, repository } = build();
  const request = createRequest({
    subjectId: 'sub_01HQZXRETRY01',
    idempotencyKey: 'idem_01HQZXRETRY01',
  });

  const first = await service.create(request);
  const second = await service.create(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.subject, first.subject);
  assert.equal(repository.subjects().length, 1, 'one party, one subject');
});

test('concurrent identical retries converge on one subject', async () => {
  // The race the idempotency key exists for. Both callers read a store with no such key, both
  // insert, one loses — and the loser must be told what happened rather than handed a conflict it
  // would respond to by creating a second identity.
  const { service, repository } = build();
  const request = createRequest({
    subjectId: 'sub_01HQZXRACE001',
    idempotencyKey: 'idem_01HQZXRACE001',
  });

  const results = await Promise.all([
    service.create(request),
    service.create(request),
    service.create(request),
  ]);

  assert.equal(repository.subjects().length, 1, 'three creators, one identity');
  for (const result of results) {
    assert.equal(result.subject.subjectId, 'sub_01HQZXRACE001');
    assert.deepEqual(result.subject, results[0]?.subject);
  }
  assert.equal(
    results.filter((result) => !result.deduplicated).length,
    1,
    'exactly one creator actually created it, and the others say so',
  );
});

test('concurrent creations of different subjects all succeed', async () => {
  const { service, repository } = build();
  const results = await Promise.all(
    ['A', 'B', 'C', 'D'].map((suffix) =>
      service.create(
        createRequest({
          subjectId: `sub_01HQZXPARALLEL${suffix}`,
          idempotencyKey: `idem_01HQZXPARALLEL${suffix}`,
        }),
      ),
    ),
  );

  assert.equal(repository.subjects().length, 4);
  assert.equal(new Set(results.map((result) => result.subject.subjectId)).size, 4);
});

test('a key reused for a different subject fails closed, sequentially and concurrently', async () => {
  for (const [why, mutation] of [
    ['a different subject id', { subjectId: 'sub_01HQZXDIFFERENT' }],
    ['a different kind', { kind: 'organisation' as const }],
    ['a different instant', { createdAt: '2026-04-02T12:00:00Z' }],
    ['a different origin', { origin: { kind: 'human' as const, id: 'ops-mallory-console' } }],
  ] as const) {
    const { service } = build();
    const first = createRequest({
      subjectId: 'sub_01HQZXREUSE01',
      idempotencyKey: 'idem_01HQZXREUSE01',
    });
    await service.create(first);

    await assert.rejects(
      service.create({ ...first, ...mutation }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as IdentityError).message, /a party the caller never asked about/i);
        return true;
      },
      `${why} must not be returned as if it were the original`,
    );
  }

  // And the same when the mismatch is discovered by the convergence path rather than the read.
  const { service, repository } = build();
  const base = createRequest({
    subjectId: 'sub_01HQZXREUSE02',
    idempotencyKey: 'idem_01HQZXREUSE02',
  });
  const outcomes = await Promise.allSettled([
    service.create(base),
    service.create({ ...base, subjectId: 'sub_01HQZXREUSE03' }),
  ]);

  assert.equal(repository.subjects().length, 1, 'only one of the two landed');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1, 'the mismatched one was refused rather than converged');
  assert.equal(codeOf((rejected[0] as PromiseRejectedResult).reason), 'idempotency-key-reuse');
});

test('a duplicate subject id under a new key is refused, not deduplicated', async () => {
  const { service, repository } = build();
  await service.create(
    createRequest({ subjectId: 'sub_01HQZXDUPE001', idempotencyKey: 'idem_01HQZXDUPE001' }),
  );

  await assert.rejects(
    service.create(
      createRequest({ subjectId: 'sub_01HQZXDUPE001', idempotencyKey: 'idem_01HQZXDUPE002' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-subject-id',
    'a second party must not silently take over an existing id',
  );
  assert.equal(repository.subjects().length, 1);
});

test('the in-memory repository refuses at commit what PostgreSQL refuses by constraint', async () => {
  // Parity, not convenience. K-08 shipped with an in-memory repository that accepted a conflict
  // the database rejects, so every concurrency guarantee proved against it was worth less than it
  // appeared (§11.15). Both transactions read a store with no such key; the second to commit must
  // lose, exactly as the unique index would decide.
  const repository = new InMemoryIdentityRepository();
  const first = subject({ subjectId: 'sub_01HQZXCOMMIT1', idempotencyKey: 'idem_01HQZXSHARED' });
  const second = subject({ subjectId: 'sub_01HQZXCOMMIT2', idempotencyKey: 'idem_01HQZXSHARED' });

  let bothInside: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    bothInside = resolve;
  });
  let entered = 0;
  const enter = (): Promise<void> => {
    entered += 1;
    if (entered === 2) bothInside?.();
    return gate;
  };

  const outcomes = await Promise.allSettled([
    repository.withTransaction(async (tx) => {
      await enter();
      await tx.insertSubject(first);
    }),
    repository.withTransaction(async (tx) => {
      await enter();
      await tx.insertSubject(second);
    }),
  ]);

  assert.equal(repository.subjects().length, 1, 'the unique key admitted exactly one');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(
    codeOf((rejected[0] as PromiseRejectedResult).reason),
    'idempotency-key-reuse',
    'and the loser was told which constraint it hit',
  );
});

test('a duplicate subject id is refused at commit too', async () => {
  const repository = new InMemoryIdentityRepository();
  const shared = 'sub_01HQZXCOMMITID';

  let bothInside: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    bothInside = resolve;
  });
  let entered = 0;
  const enter = (): Promise<void> => {
    entered += 1;
    if (entered === 2) bothInside?.();
    return gate;
  };

  const outcomes = await Promise.allSettled(
    ['idem_01HQZXCOMMITA', 'idem_01HQZXCOMMITB'].map((key) =>
      repository.withTransaction(async (tx) => {
        await enter();
        await tx.insertSubject(subject({ subjectId: shared, idempotencyKey: key }));
      }),
    ),
  );

  assert.equal(repository.subjects().length, 1);
  assert.equal(
    codeOf(
      (outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason,
    ),
    'duplicate-subject-id',
  );
});

// ---------------------------------------------------------------------------
// Transaction composition
// ---------------------------------------------------------------------------

test('an enlisted repository issues no transaction control of its own', async () => {
  // What a future K-03 needs: the account row and its subject in one transaction, so either both
  // commit or neither does.
  const database = new RecordingDatabase();
  const client = await database.connect();

  await client.query('BEGIN;');
  await client.query("INSERT INTO module_account.account (id) VALUES ('acct-1');");
  const enlisted = PostgresIdentityRepository.enlist(client);
  await enlisted.withTransaction((tx) =>
    tx.insertSubject(subject({ subjectId: 'sub_01HQZXENLISTED' })),
  );
  await client.query('COMMIT;');
  await client.release();

  const statements = database.statements();
  assert.deepEqual(
    statements.filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/i.test(sql)),
    ['BEGIN;', 'COMMIT;'],
    'exactly the caller’s own transaction control, and nothing added by the enlisted path',
  );
  assert.ok(
    statements.some((sql) => sql.includes('INSERT INTO kernel_identity.identity_subject')),
    'and the subject was written inside it',
  );
  assert.equal(database.sessionsOpened, 1, 'no second connection was opened');
});

test('an enlisted path that tries to control the transaction is refused', async () => {
  const database = new RecordingDatabase();
  const guarded = enlistedClient(await database.connect());

  for (const sql of [
    'BEGIN;',
    'START TRANSACTION;',
    'COMMIT;',
    'ROLLBACK;',
    'SAVEPOINT s1;',
    'RELEASE SAVEPOINT s1;',
    '  begin;',
  ]) {
    await assert.rejects(
      guarded.query(sql),
      (error: unknown) => {
        assert.equal(codeOf(error), 'nested-transaction', sql);
        assert.match((error as IdentityError).message, /belongs to the caller/i);
        return true;
      },
      `"${sql}" would end the caller's transaction, not a nested one`,
    );
  }

  assert.deepEqual(database.statements(), [], 'none of them reached the server');
});

test('an enlisted client never releases the connection it was given', async () => {
  const database = new RecordingDatabase();
  const real = await database.connect();
  const guarded = enlistedClient(real);

  await guarded.release();
  assert.equal(
    database.sessionsReleased,
    0,
    'the caller opened this connection and has work of its own still to do on it',
  );
});

test('a failure inside an enlisted write propagates so the caller can roll back', async () => {
  // Swallowing it would commit the caller's domain rows with no subject — the outcome enlistment
  // exists to prevent.
  const database = new RecordingDatabase({ failOn: /INSERT INTO kernel_identity/i });
  const client = await database.connect();
  await client.query('BEGIN;');

  await assert.rejects(
    new EnlistedIdentityRepository(client).withTransaction((tx) =>
      tx.insertSubject(subject({ subjectId: 'sub_01HQZXENLFAIL' })),
    ),
    /simulated database failure/,
  );

  await client.query('ROLLBACK;');
  assert.ok(database.indexOf(/^ROLLBACK;$/) > -1, 'the caller, not this component, decides');
});

test('both PostgreSQL paths write through one implementation', async () => {
  // Two adapters that drifted apart would mean the enlisted path was proved by nothing the owned
  // path proves. Same statement, same parameters, from both.
  const owned = new RecordingDatabase();
  const enlistedDatabase = new RecordingDatabase();
  const written = subject({ subjectId: 'sub_01HQZXSAMESQL', idempotencyKey: 'idem_01HQZXSAMESQL' });

  await new PostgresIdentityRepository(owned).withTransaction((tx) => tx.insertSubject(written));

  const client = await enlistedDatabase.connect();
  await PostgresIdentityRepository.enlist(client).withTransaction((tx) =>
    tx.insertSubject(written),
  );

  const insertOf = (database: RecordingDatabase) =>
    database.queries.find((query) => /INSERT INTO kernel_identity/i.test(query.sql));

  assert.deepEqual(insertOf(owned)?.sql, insertOf(enlistedDatabase)?.sql);
  assert.deepEqual(insertOf(owned)?.params, insertOf(enlistedDatabase)?.params);
});

// ---------------------------------------------------------------------------
// Immutability across every boundary
// ---------------------------------------------------------------------------

/** Every write a caller could attempt, and the field each would have changed. */
const MUTATIONS: ReadonlyArray<{
  readonly why: string;
  readonly mutate: (subject: IdentitySubject) => void;
}> = [
  {
    why: 'the origin id',
    mutate: (s) => void ((s.origin as unknown as Record<string, unknown>).id = 'someone-else'),
  },
  {
    why: 'the origin kind',
    mutate: (s) => void ((s.origin as unknown as Record<string, unknown>).kind = 'ai'),
  },
  {
    why: 'the subject id',
    mutate: (s) => void ((s as unknown as Record<string, unknown>).subjectId = 'sub_01HQZXOTHER1'),
  },
  {
    why: 'the kind',
    mutate: (s) => void ((s as unknown as Record<string, unknown>).kind = 'organisation'),
  },
  {
    why: 'the instant',
    mutate: (s) =>
      void ((s as unknown as Record<string, unknown>).createdAt = '2020-01-01T00:00:00Z'),
  },
  {
    why: 'a smuggled field',
    mutate: (s) => void ((s as unknown as Record<string, unknown>).accountId = 'acct-1'),
  },
];

test('sealSubject freezes the subject and its origin, copies rather than freezing the caller’s', () => {
  const original = mutableSubject();
  const sealed = sealSubject(original);

  assert.ok(isSealed(sealed));
  assert.notEqual(sealed.origin, original.origin, 'a distinct origin object');
  assert.ok(!Object.isFrozen(original.origin), "the caller's own object is left alone");

  original.origin.id = 'changed-afterwards';
  assert.equal(sealed.origin.id, 'K-03-account-service', 'the seal did not follow the caller');

  assert.deepEqual(sealSubject(sealed), sealed, 'sealing a sealed subject changes nothing');
});

test('every mutation through a service result throws and changes nothing', async () => {
  for (const scenario of MUTATIONS) {
    const { service, repository } = build();
    const result = await service.create(
      createRequest({ subjectId: 'sub_01HQZXSEALED1', idempotencyKey: 'idem_01HQZXSEALED1' }),
    );
    const before = structuredClone(repository.subjects()[0]);

    assert.throws(() => scenario.mutate(result.subject), TypeError, `${scenario.why} was writable`);
    assert.deepEqual(repository.subjects()[0], before, `${scenario.why} changed stored state`);
  }
});

test('every mutation through a repository read throws and changes nothing', async () => {
  const { service, repository } = build();
  await service.create(
    createRequest({ subjectId: 'sub_01HQZXSEALED2', idempotencyKey: 'idem_01HQZXSEALED2' }),
  );
  const before = structuredClone(repository.subjects()[0]);

  for (const scenario of MUTATIONS) {
    const read = await service.requireSubject('sub_01HQZXSEALED2');
    assert.ok(isSealed(read), `${scenario.why}: the read was not sealed`);
    assert.throws(() => scenario.mutate(read), TypeError, `${scenario.why} was writable on a read`);

    const inTransaction = await repository.withTransaction((tx: IdentityTransaction) =>
      tx.findSubjectByIdempotencyKey('idem_01HQZXSEALED2'),
    );
    assert.ok(inTransaction !== null && isSealed(inTransaction));
  }

  assert.deepEqual(repository.subjects()[0], before);
});

test('a caller that keeps its input cannot reach the stored subject through it', async () => {
  const { service, repository } = build();
  const origin = { kind: 'human' as const, id: 'ops-alice-console' };
  await service.create(
    createRequest({ subjectId: 'sub_01HQZXSEVERED', idempotencyKey: 'idem_01HQZXSEVERED', origin }),
  );
  const before = structuredClone(repository.subjects()[0]);

  origin.id = 'ops-mallory-console';

  assert.deepEqual(repository.subjects()[0], before, 'none of it reached the store');
  assert.equal(repository.subjects()[0]?.origin.id, 'ops-alice-console');
});

test('a seeded subject is severed from the array the test still holds', () => {
  const repository = new InMemoryIdentityRepository();
  const seeded = mutableSubject();
  repository.seed([seeded]);
  const before = structuredClone(repository.subjects()[0]);

  seeded.origin.id = 'someone-else';
  seeded.subjectId = 'sub_01HQZXCHANGED';

  assert.deepEqual(repository.subjects()[0], before, 'seeding copied rather than borrowed');
  assert.ok(isSealed(repository.subjects()[0] as IdentitySubject));
});

test('an inserted subject is severed from the object the caller inserted', async () => {
  const repository = new InMemoryIdentityRepository();
  const inserted = mutableSubject();
  await repository.withTransaction((tx) => tx.insertSubject(inserted));
  const before = structuredClone(repository.subjects()[0]);

  inserted.origin.id = 'someone-else';

  assert.deepEqual(repository.subjects()[0], before);
});

test('a subject decoded from PostgreSQL is sealed like every other crossing', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [row()] }] });
  const repository: IdentityRepository = new PostgresIdentityRepository(database);

  const decoded = await repository.withTransaction((tx) => tx.findSubjectById('sub_01HQZXTESTROW'));
  assert.ok(decoded !== null && isSealed(decoded));
  assert.throws(() => {
    (decoded.origin as unknown as Record<string, unknown>).id = 'tampered';
  }, TypeError);
});

// ---------------------------------------------------------------------------
// The refusals hold under concurrency too
// ---------------------------------------------------------------------------

test('an AI-authored creation is refused however many callers race it', async () => {
  const { service, repository } = build();
  const outcomes = await Promise.allSettled([
    service.create(createRequest({ subjectId: 'sub_01HQZXAIRACE1', origin: AI })),
    service.create(createRequest({ subjectId: 'sub_01HQZXAIRACE2', origin: AI })),
  ]);

  assert.equal(repository.subjects().length, 0);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(codeOf(outcome.reason), 'ai-not-permitted');
  }
});

test('the service is usable against a bare repository with no extra wiring', async () => {
  // The port is injected, so a caller supplying its own implementation gets the same guarantees.
  const calls: string[] = [];
  const store = new Map<string, IdentitySubject>();
  const recording: IdentityRepository = {
    withTransaction<T>(body: (tx: IdentityTransaction) => Promise<T>): Promise<T> {
      calls.push('withTransaction');
      return body({
        findSubjectById: (id) => Promise.resolve(store.get(id) ?? null),
        findSubjectByIdempotencyKey: (key) =>
          Promise.resolve([...store.values()].find((s) => s.idempotencyKey === key) ?? null),
        insertSubject: (s) => {
          store.set(s.subjectId, s);
          return Promise.resolve();
        },
      });
    },
  };

  const service = new IdentityService(recording);
  const created = await service.create(
    createRequest({ subjectId: 'sub_01HQZXINJECTED', idempotencyKey: 'idem_01HQZXINJECTED' }),
  );

  assert.equal(created.subject.subjectId, 'sub_01HQZXINJECTED');
  assert.ok(calls.length >= 1, 'the injected repository was actually used');
  assert.ok(isSealed(await service.requireSubject('sub_01HQZXINJECTED')));
});

test('the guarded client passes ordinary statements straight through', () => {
  // A guard that blocked everything would pass the refusal tests above while making the enlisted
  // path useless.
  const calls: string[] = [];
  const client: DatabaseClient = {
    query: (sql: string) => {
      calls.push(sql);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => Promise.resolve(),
  };

  const guarded = enlistedClient(client);
  return guarded
    .query('SELECT 1;')
    .then(() => guarded.query('INSERT INTO kernel_identity.identity_subject VALUES ($1);', ['x']))
    .then(() => {
      assert.deepEqual(calls, [
        'SELECT 1;',
        'INSERT INTO kernel_identity.identity_subject VALUES ($1);',
      ]);
    });
});
