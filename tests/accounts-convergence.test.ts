/**
 * K-03 — retry convergence survives whichever constraint PostgreSQL happens to pick (FND-004b
 * correction).
 *
 * An identical concurrent opening violates **all three** uniqueness constraints at once: same
 * account id, same subject, same idempotency key. PostgreSQL reports whichever unique index it
 * checked first, and that choice is not something this component can predict, pin or influence —
 * it depends on index order, on the plan, and on which check the executor reached before raising.
 *
 * The first revision of the convergence path treated the *reported constraint* as evidence of
 * *what happened*. It converged on `duplicate-account-id` and `idempotency-key-reuse` but not on
 * `subject-already-has-account`, reasoning that a second account for one party is a caller error
 * rather than a retry. That is true of the situation and false as a way to recognise it: a genuine
 * retry reported as `subject-already-has-account` was refused, so convergence held or failed
 * depending on something the server chose.
 *
 * Nothing caught it, because the in-memory repository checks in a fixed order and always reported
 * the account id first. Every concurrency test in `accounts-concurrency.test.ts` exercised exactly
 * one of the three branches and passed. That is the shape of an in-memory/PostgreSQL parity gap:
 * the reference implementation is deterministic where the real one is not, and a test suite built
 * only on the reference never sees the other paths.
 *
 * So this suite drives the **real adapter and the real service** against a fake that reports each
 * constraint in turn, and asserts the two things that must both hold:
 *
 *   - an identical opening converges, whichever constraint was reported;
 *   - anything that is not an identical opening preserves the **original domain refusal**, so a
 *     genuinely different account for a party that already has one still hears
 *     `subject-already-has-account` — which is what happened — rather than a synthesised
 *     complaint about an idempotency key that was never reused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountError,
  AccountService,
  PostgresAccountRepository,
} from '../kernel/accounts/index.ts';
import type {
  AccountRepository,
  AccountTransaction,
  UniversalAccount,
} from '../kernel/accounts/index.ts';
import type { Database, DatabaseClient, QueryResult } from '../platform/db/client.ts';

import { StubSubjectLookup, openRequest, row } from './helpers/account-fixtures.ts';
import { sqlstateError } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AccountError ? error.code : undefined;

/** The three unique constraints in migration 0007, and what the adapter normalises each into. */
const CONSTRAINTS: ReadonlyArray<{
  readonly constraint: string;
  readonly code: string;
  readonly why: string;
}> = [
  {
    constraint: 'universal_account_pkey',
    code: 'duplicate-account-id',
    why: 'the primary key was checked first',
  },
  {
    constraint: 'universal_account_subject_unique',
    code: 'subject-already-has-account',
    why: 'the one-account-per-party index was checked first',
  },
  {
    constraint: 'universal_account_idempotency_unique',
    code: 'idempotency-key-reuse',
    why: 'the idempotency index was checked first',
  },
];

/** The winner's row, and the request that is a byte-for-byte retry of the opening that wrote it. */
const WINNER = row();
const IDENTICAL = openRequest({
  accountId: 'acct_01HQZXTESTROW',
  subjectId: 'sub_01HQZXTESTROW',
  idempotencyKey: 'idem_01HQZXTESTROW',
  createdAt: '2026-04-01T12:00:00Z',
});

interface RaceOptions {
  /** Which unique constraint the server reports for the INSERT. */
  readonly constraint: string;
  /** What the *re-read* by idempotency key finds. `null` means the key was never used. */
  readonly winner: Record<string, unknown> | null;
  /** What a read by subject id finds inside the losing transaction. Usually nothing. */
  readonly holder?: Record<string, unknown> | null;
}

/**
 * A database that reproduces the losing side of a real race.
 *
 * The sequence is exactly what happens against a server: the loser reads before the winner has
 * committed, so it sees nothing; it inserts; the server refuses on one of the three unique indexes;
 * and by the time it re-reads, the winner is visible.
 *
 * Stateful, because that visibility change is the whole point — the first read by idempotency key
 * must return nothing and the second must return the winner. A stateless canned-response fake
 * cannot express it, which is part of why this defect survived.
 */
class RacingDatabase implements Database {
  readonly description = 'postgres://racer:***@127.0.0.1:5432/raced';
  readonly statements: string[] = [];
  keyReads = 0;

  readonly #options: RaceOptions;

  constructor(options: RaceOptions) {
    this.#options = options;
  }

  connect(): Promise<DatabaseClient> {
    return Promise.resolve({
      query: <Row = Record<string, unknown>>(sql: string): Promise<QueryResult<Row>> => {
        this.statements.push(sql.replace(/\s+/g, ' ').trim());

        if (/^\s*INSERT/i.test(sql)) {
          return Promise.reject(
            sqlstateError(
              `duplicate key value violates unique constraint "${this.#options.constraint}"`,
              '23505',
              this.#options.constraint,
            ),
          );
        }

        if (/WHERE idempotency_key = \$1/.test(sql)) {
          this.keyReads += 1;
          // The winner is invisible until after our insert has already failed.
          const visible = this.keyReads > 1 ? this.#options.winner : null;
          return Promise.resolve(rowsOf<Row>(visible));
        }
        if (/WHERE subject_id = \$1/.test(sql)) {
          return Promise.resolve(rowsOf<Row>(this.#options.holder ?? null));
        }

        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      release: (): Promise<void> => Promise.resolve(),
    });
  }
}

function rowsOf<Row>(value: Record<string, unknown> | null): QueryResult<Row> {
  return value === null
    ? { rows: [], rowCount: 0 }
    : { rows: [value as unknown as Row], rowCount: 1 };
}

const serviceOver = (database: Database, known: readonly string[] = ['sub_01HQZXTESTROW']) =>
  new AccountService(new PostgresAccountRepository(database), new StubSubjectLookup(known));

// ---------------------------------------------------------------------------
// Convergence, whichever constraint the server picked
// ---------------------------------------------------------------------------

test('an identical opening converges whichever unique constraint PostgreSQL reports', async () => {
  // The defect. Before the fix, the second of these three cases failed with
  // `subject-already-has-account` — a genuine retry refused because of which index the server
  // happened to check first.
  for (const { constraint, why } of CONSTRAINTS) {
    const database = new RacingDatabase({ constraint, winner: WINNER });
    const result = await serviceOver(database).open({ ...IDENTICAL });

    assert.equal(result.deduplicated, true, `${constraint} (${why}) did not converge`);
    assert.equal(result.account.accountId, 'acct_01HQZXTESTROW');
    assert.equal(result.account.subjectId, 'sub_01HQZXTESTROW');
    assert.equal(result.account.idempotencyKey, 'idem_01HQZXTESTROW');
    assert.equal(result.account.createdAt, '2026-04-01T12:00:00Z');
    assert.deepEqual({ ...result.account.origin }, { kind: 'system', id: 'K-03-account-service' });
  }
});

test('convergence re-reads by idempotency key, in a transaction of its own', async () => {
  // The re-read has to be a *new* transaction. The losing one is finished — against a server it
  // has already been rolled back — so a read inside it would see nothing whatever the winner did.
  const database = new RacingDatabase({
    constraint: 'universal_account_subject_unique',
    winner: WINNER,
  });
  await serviceOver(database).open({ ...IDENTICAL });

  const transactions = database.statements.filter((sql) => sql === 'BEGIN;');
  assert.equal(transactions.length, 2, 'one failed opening, then one read to converge');
  assert.equal(database.keyReads, 2, 'read once before inserting, once after being refused');
  assert.ok(
    database.statements.indexOf('ROLLBACK;') < database.statements.lastIndexOf('BEGIN;'),
    'the losing transaction is rolled back before the convergence read opens',
  );
});

test('the whole logical account is compared, not just the key that matched', async () => {
  // Four fields, and each of them alone is enough to say "this is a different opening". The key
  // is excluded because matching on it is what got us here.
  const mismatches: ReadonlyArray<{
    readonly why: string;
    readonly winner: Record<string, unknown>;
  }> = [
    { why: 'a different account id', winner: row({ account_id: 'acct_01HQZXOTHER01' }) },
    { why: 'a different subject', winner: row({ subject_id: 'sub_01HQZXOTHER01' }) },
    { why: 'a different instant', winner: row({ created_at: '2020-01-01T00:00:00.000000Z' }) },
    { why: 'a different origin kind', winner: row({ origin_kind: 'human' }) },
    { why: 'a different origin id', winner: row({ origin_id: 'ops-mallory-console' }) },
  ];

  for (const { why, winner } of mismatches) {
    for (const { constraint, code } of CONSTRAINTS) {
      const database = new RacingDatabase({ constraint, winner });
      await assert.rejects(
        serviceOver(database, ['sub_01HQZXTESTROW', 'sub_01HQZXOTHER01']).open({ ...IDENTICAL }),
        (error: unknown) => {
          assert.equal(
            codeOf(error),
            code,
            `${why} under ${constraint} must preserve the original refusal`,
          );
          return true;
        },
        `${why} must not converge`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Fail-closed: the original domain refusal is preserved
// ---------------------------------------------------------------------------

test('a genuinely different account for a party that already has one never converges', async () => {
  // The case the first revision was trying to protect, and the reason its exclusion looked
  // reasonable. It is still protected — by the *content* check rather than by refusing to look.
  const database = new RacingDatabase({
    constraint: 'universal_account_subject_unique',
    winner: null, // this caller's key was never used by anybody
    holder: null, // and the incumbent was committed after our read
  });

  await assert.rejects(
    serviceOver(database).open(
      openRequest({
        accountId: 'acct_01HQZXWANTED1',
        subjectId: 'sub_01HQZXTESTROW',
        idempotencyKey: 'idem_01HQZXWANTED1',
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'subject-already-has-account');
      assert.match(
        (error as AccountError).message,
        /already holds a universal account|already has an account/i,
        'the caller hears what actually happened, not a complaint about a key it never reused',
      );
      assert.ok(
        !/idempotency key/i.test((error as AccountError).message),
        'and specifically not an idempotency-key message, which would send it to the wrong fix',
      );
      return true;
    },
  );
});

test('each constraint preserves its own refusal when the key finds nothing', async () => {
  for (const { constraint, code } of CONSTRAINTS) {
    const database = new RacingDatabase({ constraint, winner: null });
    await assert.rejects(serviceOver(database).open({ ...IDENTICAL }), (error: unknown) => {
      assert.equal(codeOf(error), code, `${constraint} must surface as ${code}`);
      return true;
    });
  }
});

test('a reused key naming a different party fails closed rather than converging', async () => {
  // The nastiest collision: the key says "retry", the subject says "different party". Converging
  // would hand the caller somebody else's account to transact against.
  const database = new RacingDatabase({
    constraint: 'universal_account_idempotency_unique',
    winner: row({ subject_id: 'sub_01HQZXPARTY001', account_id: 'acct_01HQZXPARTY001' }),
  });

  await assert.rejects(
    serviceOver(database, ['sub_01HQZXTESTROW']).open({ ...IDENTICAL }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('a non-uniqueness failure is never treated as a race', async () => {
  // Convergence is for conflicts that mean "somebody else got there first". A dropped connection
  // means nothing of the kind, and re-reading after one would be guessing.
  const database: Database = {
    description: 'postgres://racer:***@127.0.0.1:5432/raced',
    connect: () =>
      Promise.resolve({
        query: (sql: string) =>
          /^\s*INSERT/i.test(sql)
            ? Promise.reject(sqlstateError('connection terminated', '08006'))
            : Promise.resolve({ rows: [], rowCount: 0 }),
        release: () => Promise.resolve(),
      }),
  };

  await assert.rejects(serviceOver(database).open({ ...IDENTICAL }), /connection terminated/);
});

// ---------------------------------------------------------------------------
// The same guarantee stated against the port, independent of any adapter
// ---------------------------------------------------------------------------

/** A repository that refuses one insert with a chosen code, then behaves normally. */
function repositoryRefusing(
  code: 'duplicate-account-id' | 'subject-already-has-account' | 'idempotency-key-reuse',
  stored: UniversalAccount | null,
): AccountRepository {
  // Outside `withTransaction`, because the winner becoming visible *between* transactions is the
  // whole thing being modelled. A flag scoped to one transaction would make the convergence
  // re-read see nothing and hide the guarantee under test.
  let attempted = false;

  return {
    withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T> {
      return body({
        findAccountById: () => Promise.resolve(null),
        findAccountBySubjectId: () => Promise.resolve(null),
        findAccountByIdempotencyKey: () => Promise.resolve(attempted ? stored : null),
        insertAccount: () => {
          attempted = true;
          return Promise.reject(new AccountError(code, `refused by ${code}`));
        },
      });
    },
  };
}

test('the service converges on any of the three port-level conflicts, and only on a match', async () => {
  // Stated against the port so the guarantee does not depend on the PostgreSQL adapter existing.
  // Any repository that reports one of these three is reporting a race, and the content decides.
  const winner: UniversalAccount = {
    accountId: 'acct_01HQZXTESTROW',
    subjectId: 'sub_01HQZXTESTROW',
    createdAt: '2026-04-01T12:00:00Z',
    origin: { kind: 'system', id: 'K-03-account-service' },
    idempotencyKey: 'idem_01HQZXTESTROW',
  };

  for (const { code } of CONSTRAINTS) {
    const typed = code as Parameters<typeof repositoryRefusing>[0];

    const converged = await new AccountService(
      repositoryRefusing(typed, winner),
      new StubSubjectLookup(['sub_01HQZXTESTROW']),
    ).open({ ...IDENTICAL });
    assert.equal(converged.deduplicated, true, `${code} did not converge on an identical opening`);
    assert.deepEqual({ ...converged.account }, { ...winner, origin: { ...winner.origin } });

    await assert.rejects(
      new AccountService(
        repositoryRefusing(typed, { ...winner, subjectId: 'sub_01HQZXOTHER01' }),
        new StubSubjectLookup(['sub_01HQZXTESTROW']),
      ).open({ ...IDENTICAL }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, `${code} must be preserved on a mismatch`);
        return true;
      },
    );

    await assert.rejects(
      new AccountService(
        repositoryRefusing(typed, null),
        new StubSubjectLookup(['sub_01HQZXTESTROW']),
      ).open({ ...IDENTICAL }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, `${code} must be preserved when nothing holds the key`);
        return true;
      },
    );
  }
});
