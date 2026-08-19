/**
 * K-03 Accounts — concurrency, transaction composition and immutability (FND-004b).
 *
 * The one-account-per-subject rule is the only invariant in this component that a *single* caller
 * cannot break. Every check in the service is a read followed by a write, and two callers can both
 * read "no account for this party" before either writes. So the interesting tests are all here:
 *
 *   - **One party, one account, under a race.** Two openings for one subject with *different*
 *     account ids must produce one account and one refusal. Converging would be wrong — a second
 *     account id is a caller error, not a retry — so the loser is told, not accommodated.
 *   - **Identical retries converge.** Same key, same content: one account, and the loser is told
 *     what happened rather than handed a conflict it would answer by opening a second account.
 *   - **Mismatched reuse fails closed.** Convergence must not become "return whatever holds the
 *     key", which would hand a caller the wrong party's account to transact against.
 *   - **Enlistment without nested transaction control**, so a future registration path can create a
 *     K-01 subject and a K-03 account in one transaction.
 *   - **Immutability across the boundary.** An account a caller holds must not be the account the
 *     store holds.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountError,
  AccountService,
  EnlistedAccountRepository,
  InMemoryAccountRepository,
  PostgresAccountRepository,
  enlistedClient,
  isSealed,
  sealAccount,
} from '../kernel/accounts/index.ts';
import type {
  AccountRepository,
  AccountTransaction,
  UniversalAccount,
} from '../kernel/accounts/index.ts';
import type { DatabaseClient } from '../platform/db/client.ts';

import {
  AI,
  KNOWN_SUBJECT,
  StubSubjectLookup,
  account,
  build,
  openRequest,
  row,
} from './helpers/account-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AccountError ? error.code : undefined;

/** The record type with every `readonly` stripped, so a test can attempt what a caller would. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

const mutableAccount = (overrides: Partial<UniversalAccount> = {}): Mutable<UniversalAccount> => ({
  accountId: 'acct_01HQZXMUTABLE',
  subjectId: 'sub_01HQZXMUTABLE',
  createdAt: '2026-04-01T12:00:00Z',
  origin: { kind: 'system', id: 'K-03-account-service' },
  idempotencyKey: 'idem_01HQZXMUTABLE',
  ...overrides,
});

/** Release both racers at the same moment, so the outcome is the code's and not the scheduler's. */
function gate(count: number): () => Promise<void> {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  return () => {
    arrived += 1;
    if (arrived === count) release?.();
    return opened;
  };
}

// ---------------------------------------------------------------------------
// One party, one account — under concurrency
// ---------------------------------------------------------------------------

test('two openings for one subject produce one account and one refusal', async () => {
  // The race the whole component exists to survive. Both callers read a store with no account for
  // this party; both try to insert; the uniqueness constraint decides.
  const { service, repository } = build();

  const outcomes = await Promise.allSettled([
    service.open(
      openRequest({ accountId: 'acct_01HQZXRACE0A', idempotencyKey: 'idem_01HQZXRACE0A' }),
    ),
    service.open(
      openRequest({ accountId: 'acct_01HQZXRACE0B', idempotencyKey: 'idem_01HQZXRACE0B' }),
    ),
  ]);

  assert.equal(repository.accounts().length, 1, 'one party, one account');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1, 'exactly one caller was refused');
  assert.equal(
    codeOf((rejected[0] as PromiseRejectedResult).reason),
    'subject-already-has-account',
    'and told which invariant it hit, rather than being handed the other account',
  );
});

test('a losing opener is never converged onto an account it did not ask for', async () => {
  // Deliberate asymmetry. An identical retry converges; a *different* account id for the same
  // party does not, because the caller would then believe its own id was in use and reference it.
  const { service, repository } = build();
  await service.open(
    openRequest({ accountId: 'acct_01HQZXHELD001', idempotencyKey: 'idem_01HQZXHELD001' }),
  );

  await assert.rejects(
    service.open(
      openRequest({ accountId: 'acct_01HQZXWANTED1', idempotencyKey: 'idem_01HQZXWANTED1' }),
    ),
    (error: unknown) => codeOf(error) === 'subject-already-has-account',
  );

  assert.equal(
    await service.findAccount('acct_01HQZXWANTED1'),
    null,
    'the id it asked for is free',
  );
  assert.equal(repository.accounts()[0]?.accountId, 'acct_01HQZXHELD001');
});

test('many simultaneous openings for one subject still leave exactly one account', async () => {
  const { service, repository } = build();
  const arrive = gate(5);

  const outcomes = await Promise.allSettled(
    ['A', 'B', 'C', 'D', 'E'].map(async (suffix) => {
      await arrive();
      return service.open(
        openRequest({
          accountId: `acct_01HQZXSTORM${suffix}`,
          idempotencyKey: `idem_01HQZXSTORM${suffix}`,
        }),
      );
    }),
  );

  assert.equal(repository.accounts().length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  for (const outcome of outcomes.filter((entry) => entry.status === 'rejected')) {
    assert.equal(codeOf(outcome.reason), 'subject-already-has-account');
  }
});

test('the in-memory repository refuses at commit what PostgreSQL refuses by constraint', async () => {
  // Parity, not convenience. Both transactions read a store with no account for the subject; the
  // second to commit must lose, exactly as `UNIQUE (subject_id)` would decide. K-08 shipped
  // without this parity and every concurrency guarantee proved against it was worth less than it
  // appeared (§11.15).
  const repository = new InMemoryAccountRepository();
  const arrive = gate(2);

  const outcomes = await Promise.allSettled(
    ['A', 'B'].map((suffix) =>
      repository.withTransaction(async (tx) => {
        await arrive();
        await tx.insertAccount(
          account({
            accountId: `acct_01HQZXCOMMIT${suffix}`,
            subjectId: 'sub_01HQZXSHAREDPARTY',
            idempotencyKey: `idem_01HQZXCOMMIT${suffix}`,
          }),
        );
      }),
    ),
  );

  assert.equal(repository.accounts().length, 1, 'the unique constraint admitted exactly one');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(
    codeOf((rejected[0] as PromiseRejectedResult).reason),
    'subject-already-has-account',
  );
});

test('duplicate account ids and reused keys are also refused at commit', async () => {
  for (const [why, second, expected] of [
    [
      'a duplicate account id',
      {
        accountId: 'acct_01HQZXSAMEID',
        subjectId: 'sub_01HQZXOTHER1',
        idempotencyKey: 'idem_B01X',
      },
      'duplicate-account-id',
    ],
    [
      'a reused idempotency key',
      {
        accountId: 'acct_01HQZXOTHERID',
        subjectId: 'sub_01HQZXOTHER2',
        idempotencyKey: 'idem_A01X',
      },
      'idempotency-key-reuse',
    ],
  ] as const) {
    const repository = new InMemoryAccountRepository();
    const arrive = gate(2);

    const outcomes = await Promise.allSettled([
      repository.withTransaction(async (tx) => {
        await arrive();
        await tx.insertAccount(
          account({
            accountId: 'acct_01HQZXSAMEID',
            subjectId: 'sub_01HQZXFIRSTP',
            idempotencyKey: 'idem_A01X',
          }),
        );
      }),
      repository.withTransaction(async (tx) => {
        await arrive();
        await tx.insertAccount(account(second));
      }),
    ]);

    assert.equal(repository.accounts().length, 1, why);
    assert.equal(
      codeOf(
        (outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason,
      ),
      expected,
      why,
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotent retry
// ---------------------------------------------------------------------------

test('a sequential retry returns the original account rather than opening a second', async () => {
  const { service, repository } = build();
  const request = openRequest({
    accountId: 'acct_01HQZXRETRY01',
    idempotencyKey: 'idem_01HQZXRETRY01',
  });

  const first = await service.open(request);
  const second = await service.open(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.account, first.account);
  assert.equal(repository.accounts().length, 1);
});

test('concurrent identical retries converge on one account', async () => {
  const { service, repository } = build();
  const request = openRequest({
    accountId: 'acct_01HQZXCONV001',
    idempotencyKey: 'idem_01HQZXCONV001',
  });

  const results = await Promise.all([
    service.open(request),
    service.open(request),
    service.open(request),
  ]);

  assert.equal(repository.accounts().length, 1, 'three openers, one account');
  for (const result of results) {
    assert.deepEqual(result.account, results[0]?.account);
  }
  assert.equal(
    results.filter((result) => !result.deduplicated).length,
    1,
    'exactly one opener actually opened it, and the others say so',
  );
});

test('a key reused for a different account fails closed, sequentially and concurrently', async () => {
  for (const [why, mutation] of [
    ['a different account id', { accountId: 'acct_01HQZXDIFFER1' }],
    ['a different instant', { createdAt: '2026-04-02T12:00:00Z' }],
    ['a different origin', { origin: { kind: 'human' as const, id: 'ops-mallory-console' } }],
  ] as const) {
    const { service } = build();
    const first = openRequest({
      accountId: 'acct_01HQZXREUSE01',
      idempotencyKey: 'idem_01HQZXREUSE01',
    });
    await service.open(first);

    await assert.rejects(
      service.open({ ...first, ...mutation }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as AccountError).message, /the wrong party's account/i);
        return true;
      },
      `${why} must not be returned as if it were the original`,
    );
  }
});

test('a subject with a different id under a reused key is refused, not converged', async () => {
  // The nastiest mismatch: the key says "this is a retry", the subject says "this is a different
  // party". Returning the earlier account would hand the caller somebody else's account.
  const { service } = build(['sub_01HQZXPARTY01', 'sub_01HQZXPARTY02']);
  await service.open(
    openRequest({
      accountId: 'acct_01HQZXMIX0001',
      subjectId: 'sub_01HQZXPARTY01',
      idempotencyKey: 'idem_01HQZXMIX0001',
    }),
  );

  await assert.rejects(
    service.open(
      openRequest({
        accountId: 'acct_01HQZXMIX0001',
        subjectId: 'sub_01HQZXPARTY02',
        idempotencyKey: 'idem_01HQZXMIX0001',
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as AccountError).message, /subjectId was/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Transaction composition
// ---------------------------------------------------------------------------

test('an enlisted repository issues no transaction control of its own', async () => {
  // What the registration path needs: a K-01 subject and a K-03 account in one transaction, so a
  // party is never left with an identity and no account, or an account and no identity.
  const database = new RecordingDatabase();
  const client = await database.connect();

  await client.query('BEGIN;');
  await client.query(
    "INSERT INTO kernel_identity.identity_subject (subject_id) VALUES ('sub_01HQZXTOGETHER');",
  );
  await PostgresAccountRepository.enlist(client).withTransaction((tx) =>
    tx.insertAccount(account({ accountId: 'acct_01HQZXENLISTED' })),
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
    statements.some((sql) => sql.includes('INSERT INTO kernel_accounts.universal_account')),
    'and the account was written inside it',
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
        assert.match((error as AccountError).message, /belongs to the caller/i);
        return true;
      },
      `"${sql}" would end the caller's transaction, not a nested one`,
    );
  }

  assert.deepEqual(database.statements(), [], 'none of them reached the server');
});

test('an enlisted client never releases the connection it was given', async () => {
  const database = new RecordingDatabase();
  const guarded = enlistedClient(await database.connect());

  await guarded.release();
  assert.equal(
    database.sessionsReleased,
    0,
    'the caller opened this connection and has work of its own still to do on it',
  );
});

test('the guarded client passes ordinary statements straight through', async () => {
  // A guard that blocked everything would pass the refusal test above while making the enlisted
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
  await guarded.query('SELECT 1;');
  await guarded.query('INSERT INTO kernel_accounts.universal_account VALUES ($1);', ['x']);
  assert.deepEqual(calls, [
    'SELECT 1;',
    'INSERT INTO kernel_accounts.universal_account VALUES ($1);',
  ]);
});

test('a failure inside an enlisted write propagates so the caller can roll back', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO kernel_accounts/i });
  const client = await database.connect();
  await client.query('BEGIN;');

  await assert.rejects(
    new EnlistedAccountRepository(client).withTransaction((tx) =>
      tx.insertAccount(account({ accountId: 'acct_01HQZXENLFAIL' })),
    ),
    /simulated database failure/,
  );

  await client.query('ROLLBACK;');
  assert.ok(database.indexOf(/^ROLLBACK;$/) > -1, 'the caller, not this component, decides');
});

test('both PostgreSQL paths write through one implementation', async () => {
  const owned = new RecordingDatabase();
  const enlistedDatabase = new RecordingDatabase();
  const written = account({ accountId: 'acct_01HQZXSAMESQL', subjectId: 'sub_01HQZXSAMESQL' });

  await new PostgresAccountRepository(owned).withTransaction((tx) => tx.insertAccount(written));

  const client = await enlistedDatabase.connect();
  await PostgresAccountRepository.enlist(client).withTransaction((tx) => tx.insertAccount(written));

  const insertOf = (database: RecordingDatabase) =>
    database.queries.find((query) => /INSERT INTO kernel_accounts/i.test(query.sql));

  assert.deepEqual(insertOf(owned)?.sql, insertOf(enlistedDatabase)?.sql);
  assert.deepEqual(insertOf(owned)?.params, insertOf(enlistedDatabase)?.params);
});

// ---------------------------------------------------------------------------
// Immutability across every boundary
// ---------------------------------------------------------------------------

const MUTATIONS: ReadonlyArray<{
  readonly why: string;
  readonly mutate: (account: UniversalAccount) => void;
}> = [
  {
    why: 'the subject link',
    mutate: (a) => void ((a as unknown as Record<string, unknown>).subjectId = 'sub_01HQZXOTHER1'),
  },
  {
    why: 'the account id',
    mutate: (a) => void ((a as unknown as Record<string, unknown>).accountId = 'acct_01HQZXOTHER'),
  },
  {
    why: 'the origin id',
    mutate: (a) => void ((a.origin as unknown as Record<string, unknown>).id = 'someone-else'),
  },
  {
    why: 'the origin kind',
    mutate: (a) => void ((a.origin as unknown as Record<string, unknown>).kind = 'ai'),
  },
  {
    why: 'the instant',
    mutate: (a) =>
      void ((a as unknown as Record<string, unknown>).createdAt = '2020-01-01T00:00:00Z'),
  },
  {
    why: 'a smuggled capability',
    mutate: (a) => void ((a as unknown as Record<string, unknown>).capabilities = ['seller']),
  },
];

test('sealAccount freezes the account and its origin, and copies rather than freezing the caller’s', () => {
  const original = mutableAccount();
  const sealed = sealAccount(original);

  assert.ok(isSealed(sealed));
  assert.notEqual(sealed.origin, original.origin, 'a distinct origin object');
  assert.ok(!Object.isFrozen(original.origin), "the caller's own object is left alone");

  original.origin.id = 'changed-afterwards';
  assert.equal(sealed.origin.id, 'K-03-account-service', 'the seal did not follow the caller');

  assert.deepEqual(sealAccount(sealed), sealed, 'sealing a sealed account changes nothing');
});

test('every mutation through a service result throws and changes nothing', async () => {
  for (const scenario of MUTATIONS) {
    const { service, repository } = build();
    const result = await service.open(
      openRequest({ accountId: 'acct_01HQZXSEALED1', idempotencyKey: 'idem_01HQZXSEALED1' }),
    );
    const before = structuredClone(repository.accounts()[0]);

    assert.throws(() => scenario.mutate(result.account), TypeError, `${scenario.why} was writable`);
    assert.deepEqual(repository.accounts()[0], before, `${scenario.why} changed stored state`);
  }
});

test('every mutation through a repository read throws and changes nothing', async () => {
  const { service, repository } = build();
  await service.open(
    openRequest({ accountId: 'acct_01HQZXSEALED2', idempotencyKey: 'idem_01HQZXSEALED2' }),
  );
  const before = structuredClone(repository.accounts()[0]);

  for (const scenario of MUTATIONS) {
    for (const read of [
      await service.requireAccount('acct_01HQZXSEALED2'),
      await service.findAccountForSubject(KNOWN_SUBJECT),
    ]) {
      assert.ok(read !== null && isSealed(read), `${scenario.why}: the read was not sealed`);
      assert.throws(() => scenario.mutate(read), TypeError, `${scenario.why} was writable`);
    }

    const inTransaction = await repository.withTransaction((tx: AccountTransaction) =>
      tx.findAccountByIdempotencyKey('idem_01HQZXSEALED2'),
    );
    assert.ok(inTransaction !== null && isSealed(inTransaction));
  }

  assert.deepEqual(repository.accounts()[0], before);
});

test('a caller that keeps its input cannot reach the stored account through it', async () => {
  const { service, repository } = build();
  const origin = { kind: 'human' as const, id: 'ops-alice-console' };
  await service.open(
    openRequest({ accountId: 'acct_01HQZXSEVERED', idempotencyKey: 'idem_01HQZXSEVERED', origin }),
  );
  const before = structuredClone(repository.accounts()[0]);

  origin.id = 'ops-mallory-console';

  assert.deepEqual(repository.accounts()[0], before, 'none of it reached the store');
  assert.equal(repository.accounts()[0]?.origin.id, 'ops-alice-console');
});

test('a seeded account is severed from the array the test still holds', () => {
  const repository = new InMemoryAccountRepository();
  const seeded = mutableAccount();
  repository.seed([seeded]);
  const before = structuredClone(repository.accounts()[0]);

  seeded.origin.id = 'someone-else';
  seeded.subjectId = 'sub_01HQZXCHANGED';

  assert.deepEqual(repository.accounts()[0], before, 'seeding copied rather than borrowed');
  assert.ok(isSealed(repository.accounts()[0] as UniversalAccount));
});

test('an inserted account is severed from the object the caller inserted', async () => {
  const repository = new InMemoryAccountRepository();
  const inserted = mutableAccount();
  await repository.withTransaction((tx) => tx.insertAccount(inserted));
  const before = structuredClone(repository.accounts()[0]);

  inserted.origin.id = 'someone-else';

  assert.deepEqual(repository.accounts()[0], before);
});

test('an account decoded from PostgreSQL is sealed like every other crossing', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [row()] }] });
  const repository: AccountRepository = new PostgresAccountRepository(database);

  const decoded = await repository.withTransaction((tx) =>
    tx.findAccountById('acct_01HQZXTESTROW'),
  );
  assert.ok(decoded !== null && isSealed(decoded));
  assert.throws(() => {
    (decoded.origin as unknown as Record<string, unknown>).id = 'tampered';
  }, TypeError);
});

// ---------------------------------------------------------------------------
// The refusals hold under concurrency too
// ---------------------------------------------------------------------------

test('an AI-authored opening is refused however many callers race it', async () => {
  const { service, repository } = build(['sub_01HQZXAIRACE1', 'sub_01HQZXAIRACE2']);
  const outcomes = await Promise.allSettled([
    service.open(openRequest({ subjectId: 'sub_01HQZXAIRACE1', origin: AI })),
    service.open(openRequest({ subjectId: 'sub_01HQZXAIRACE2', origin: AI })),
  ]);

  assert.equal(repository.accounts().length, 0);
  for (const outcome of outcomes) {
    assert.equal(codeOf((outcome as PromiseRejectedResult).reason), 'ai-not-permitted');
  }
});

test('an unknown subject is refused however many callers race it', async () => {
  const { service, repository, subjects } = build([]);
  const outcomes = await Promise.allSettled([
    service.open(openRequest({ accountId: 'acct_01HQZXNOPARTY1' })),
    service.open(openRequest({ accountId: 'acct_01HQZXNOPARTY2' })),
  ]);

  assert.equal(repository.accounts().length, 0);
  assert.equal(repository.transactionsCommitted + repository.transactionsRolledBack, 0);
  assert.equal(subjects.asked.length, 2, 'both asked K-01, and both were told no');
  for (const outcome of outcomes) {
    assert.equal(codeOf((outcome as PromiseRejectedResult).reason), 'unknown-subject');
  }
});

test('the service is usable against a bare repository with no extra wiring', async () => {
  const store = new Map<string, UniversalAccount>();
  const recording: AccountRepository = {
    withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T> {
      const all = (): UniversalAccount[] => [...store.values()];
      return body({
        findAccountById: (id) => Promise.resolve(store.get(id) ?? null),
        findAccountBySubjectId: (id) =>
          Promise.resolve(all().find((entry) => entry.subjectId === id) ?? null),
        findAccountByIdempotencyKey: (key) =>
          Promise.resolve(all().find((entry) => entry.idempotencyKey === key) ?? null),
        insertAccount: (entry) => {
          store.set(entry.accountId, entry);
          return Promise.resolve();
        },
      });
    },
  };

  const service = new AccountService(recording, new StubSubjectLookup());
  const opened = await service.open(
    openRequest({ accountId: 'acct_01HQZXINJECTED', idempotencyKey: 'idem_01HQZXINJECTED' }),
  );

  assert.equal(opened.account.accountId, 'acct_01HQZXINJECTED');
  assert.ok(isSealed(await service.requireAccount('acct_01HQZXINJECTED')));
});
