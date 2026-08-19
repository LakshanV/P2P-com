/**
 * K-03 Accounts — the contract, every refusal, and the real K-01 dependency (FND-004b).
 *
 * Two things are being proved here, and the second is why this slice exists at all.
 *
 * **The account holds nothing.** Not a capability, not a role, not a verification level, not a
 * balance, not a profile field. That is the guide's §4 — one universal account with capabilities —
 * and it survives only if the refusals are executable. A component that merely *documents* the
 * absence acquires an `isSeller` column the first time somebody is in a hurry, and from then on the
 * question "what about a party that sells under two businesses" has the wrong answer available.
 *
 * **K-03 is the first real consumer of K-01.** Not a fake of it: the last section wires the actual
 * `IdentityService` to the actual `AccountService` and drives a subject creation followed by an
 * account opening. Every previous kernel component's cross-component path was a capability nothing
 * used; this one is used.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AccountError,
  AccountService,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  InMemoryAccountRepository,
  NO_SUBJECTS,
  ORIGIN_KINDS,
  type OpenAccountRequest,
} from '../kernel/accounts/index.ts';
import {
  IdentityService,
  InMemoryIdentityRepository,
  type CreateSubjectRequest,
} from '../kernel/identity/index.ts';

import { AI, KNOWN_SUBJECT, OPERATOR, build, openRequest } from './helpers/account-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AccountError ? error.code : undefined;

/** Refuse with this code, and say something specific enough to act on. */
const refuses = async (
  request: Partial<OpenAccountRequest>,
  code: string,
  message: RegExp,
): Promise<void> => {
  const { service } = build();
  await assert.rejects(service.open(openRequest(request)), (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(codeOf(error))}`);
    assert.match((error as AccountError).message, message);
    return true;
  });
};

// ---------------------------------------------------------------------------
// What an account is, and what it is not
// ---------------------------------------------------------------------------

test('an opened account holds exactly the five declared fields and nothing else', async () => {
  const { service } = build();
  const result = await service.open(
    openRequest({ accountId: 'acct_01HQZXCONTRACT', idempotencyKey: 'idem_01HQZXCONTRACT' }),
  );

  assert.equal(result.deduplicated, false);
  assert.deepEqual(Object.keys(result.account).sort(), [
    'accountId',
    'createdAt',
    'idempotencyKey',
    'origin',
    'subjectId',
  ]);
  assert.deepEqual(Object.keys(result.account.origin).sort(), ['id', 'kind']);

  // The absences are the contract. Each of these is where the "one account" rule would start to
  // bend, because an account that carries one invites a second account for a party that needs two.
  for (const absent of [
    'capabilities',
    'roles',
    'verified',
    'verificationLevel',
    'balance',
    'points',
    'email',
    'name',
    'status',
    'isSeller',
    'isBuyer',
    'sessionId',
    'password',
  ]) {
    assert.ok(
      !(absent in result.account),
      `an account must not carry "${absent}" — that belongs to another component`,
    );
  }
});

test('the service reads no clock and returns the instant it was given', async () => {
  const { service } = build();
  const opened = await service.open(
    openRequest({
      accountId: 'acct_01HQZXINSTANT',
      idempotencyKey: 'idem_01HQZXINSTANT',
      createdAt: '2026-04-01T12:00:00.123456Z',
    }),
  );

  assert.equal(opened.account.createdAt, '2026-04-01T12:00:00.123456Z');
  const read = await service.requireAccount('acct_01HQZXINSTANT');
  assert.equal(read.createdAt, '2026-04-01T12:00:00.123456Z', 'to the microsecond');
});

test('lookup works by account id and by subject id, and returns null rather than guessing', async () => {
  const { service } = build();
  await service.open(
    openRequest({ accountId: 'acct_01HQZXLOOKUP', idempotencyKey: 'idem_01HQZXLOOKUP' }),
  );

  assert.equal((await service.findAccount('acct_01HQZXLOOKUP'))?.accountId, 'acct_01HQZXLOOKUP');
  assert.equal(await service.findAccount('acct_01HQZXMISSING'), null);

  const forSubject = await service.findAccountForSubject(KNOWN_SUBJECT);
  assert.equal(forSubject?.accountId, 'acct_01HQZXLOOKUP', 'the party reaches its own account');
  assert.equal(await service.findAccountForSubject('sub_01HQZXNOBODY'), null);

  assert.equal(await service.hasAccount(KNOWN_SUBJECT), true);
  assert.equal(await service.hasAccount('sub_01HQZXNOBODY'), false);

  await assert.rejects(
    service.requireAccount('acct_01HQZXMISSING'),
    (error: unknown) => codeOf(error) === 'no-such-account',
  );
});

test('the service exposes no operation that changes, removes or relinks an account', () => {
  const { service } = build();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');

  assert.deepEqual(
    [...operations].sort(),
    ['findAccount', 'findAccountForSubject', 'hasAccount', 'open', 'requireAccount'],
    'orders and payments name these ids; an account that can be relinked reattributes all of them',
  );
});

test('there is no authentication, capability or balance surface anywhere in the component', () => {
  const { service } = build();
  const repository = new InMemoryAccountRepository();

  const surface = new Set<string>();
  for (const target of [service, repository] as const) {
    let proto: object | null = Object.getPrototypeOf(target) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }
  }

  // A component that grew any of these would have stopped being an account and started being an
  // account *system*, which is four other components' work.
  const forbidden = [...surface].filter((name) =>
    /login|logout|authenticat|password|credential|session|token|capabilit|role|grant|permission|verif|balance|credit|debit|payout|persona/i.test(
      name,
    ),
  );
  assert.deepEqual(forbidden, [], 'K-03 holds a link and a provenance record, and nothing else');
});

// ---------------------------------------------------------------------------
// One party, one account
// ---------------------------------------------------------------------------

test('a second account for the same subject is refused, and says which account exists', async () => {
  const { service, repository } = build();
  await service.open(
    openRequest({ accountId: 'acct_01HQZXFIRST01', idempotencyKey: 'idem_01HQZXFIRST01' }),
  );

  await assert.rejects(
    service.open(
      openRequest({ accountId: 'acct_01HQZXSECOND1', idempotencyKey: 'idem_01HQZXSECOND1' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'subject-already-has-account');
      assert.match((error as AccountError).message, /acct_01HQZXFIRST01/);
      assert.match((error as AccountError).message, /split the same person across two histories/i);
      assert.match((error as AccountError).message, /Capabilities are what differ/i);
      return true;
    },
  );

  assert.equal(repository.accounts().length, 1, 'one party, one account');
});

test('different subjects each get their own account', async () => {
  const { service, repository } = build(['sub_01HQZXPARTY0A', 'sub_01HQZXPARTY0B']);
  await service.open(openRequest({ subjectId: 'sub_01HQZXPARTY0A' }));
  await service.open(openRequest({ subjectId: 'sub_01HQZXPARTY0B' }));

  assert.equal(repository.accounts().length, 2);
  assert.equal(new Set(repository.accounts().map((entry) => entry.subjectId)).size, 2);
});

// ---------------------------------------------------------------------------
// The K-01 dependency
// ---------------------------------------------------------------------------

test('an account for a subject K-01 does not know is refused before anything is written', async () => {
  const { service, repository, subjects } = build();

  await assert.rejects(
    service.open(openRequest({ subjectId: 'sub_01HQZXNOBODY01' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unknown-subject');
      assert.match((error as AccountError).message, /sub_01HQZXNOBODY01/);
      assert.match((error as AccountError).message, /would invent a party/i);
      return true;
    },
  );

  assert.deepEqual(subjects.asked, ['sub_01HQZXNOBODY01'], 'K-01 was consulted');
  assert.equal(repository.accounts().length, 0, 'and nothing was written');
  assert.equal(
    repository.transactionsCommitted + repository.transactionsRolledBack,
    0,
    'the account transaction never opened — an unknown party must not occupy a connection',
  );
});

test('a malformed request never reaches K-01 at all', async () => {
  // Order matters both ways. An unknown subject must not open a transaction, and a request that
  // cannot be written must not trouble another component to find that out.
  const { service, subjects, repository } = build();

  await assert.rejects(service.open(openRequest({ accountId: 'alice@example.com' })));
  await assert.rejects(service.open(openRequest({ createdAt: '2026-02-30T00:00:00Z' })));
  await assert.rejects(service.open(openRequest({ origin: AI })));

  assert.deepEqual(subjects.asked, [], 'K-01 was never consulted for a request that cannot be met');
  assert.equal(repository.accounts().length, 0);
});

test('the default lookup fails closed rather than accepting parties nobody has heard of', async () => {
  const service = new AccountService(new InMemoryAccountRepository(), NO_SUBJECTS);
  await assert.rejects(
    service.open(openRequest()),
    (error: unknown) => codeOf(error) === 'unknown-subject',
    'a caller with no identity component wired must get refusals, not silent acceptance',
  );
});

test('the real K-01 service satisfies the lookup contract and the two compose', async () => {
  // The proof that this is a real consumer rather than a shape that resembles one. No adapter, no
  // translation layer: `IdentityService` *is* a `SubjectLookup`.
  const identity = new IdentityService(new InMemoryIdentityRepository());
  const accounts = new InMemoryAccountRepository();
  const service = new AccountService(accounts, identity);

  const subjectRequest: CreateSubjectRequest = {
    subjectId: 'sub_01HQZXREALK01A',
    kind: 'person',
    createdAt: '2026-04-01T12:00:00Z',
    origin: { kind: 'human', id: 'ops-alice-console' },
    idempotencyKey: 'idem_01HQZXSUBJECT1',
  };

  // Before the subject exists, the account is refused — by the real component, not a stub.
  await assert.rejects(
    service.open(openRequest({ subjectId: 'sub_01HQZXREALK01A' })),
    (error: unknown) => codeOf(error) === 'unknown-subject',
  );

  const subject = await identity.create(subjectRequest);
  const opened = await service.open(
    openRequest({
      accountId: 'acct_01HQZXREALK01',
      subjectId: subject.subject.subjectId,
      idempotencyKey: 'idem_01HQZXREALK01',
    }),
  );

  assert.equal(opened.account.subjectId, 'sub_01HQZXREALK01A');
  assert.equal(accounts.accounts().length, 1);

  // And the link points at a subject that really is there, reachable through K-01.
  const linked = await identity.requireSubject(opened.account.subjectId);
  assert.equal(linked.kind, 'person');
});

test('K-03 asks K-01 exactly one question, and asks it once per opening', async () => {
  // The coupling is one bit. A port that grew richer would let K-03 start making decisions about
  // subjects, which is K-01's job.
  const { service, subjects } = build();
  await service.open(openRequest({ accountId: 'acct_01HQZXONEASK' }));

  assert.deepEqual(subjects.asked, [KNOWN_SUBJECT]);
  assert.deepEqual(
    Object.getOwnPropertyNames(Object.getPrototypeOf(subjects) as object).sort(),
    ['constructor', 'exists'],
    'the port is one method wide, so K-03 cannot start reasoning about subjects',
  );
});

// ---------------------------------------------------------------------------
// Foreign concerns: an account is not an account system
// ---------------------------------------------------------------------------

test('every foreign field is refused by name, with the component that owns it', async () => {
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['password', 'hunter2', /K-02 Authentication owns credentials/],
    ['sessionId', 'sess-1', /K-02 Authentication owns sessions/],
    ['roles', ['admin'], /K-04 Permissions owns roles and grants/],
    ['permissions', ['read'], /K-04 Permissions owns permission evaluation/],
    ['capabilities', ['seller'], /Capability & Verification module owns capability activation/],
    ['isSeller', true, /selling is a capability/],
    ['isBuyer', true, /buying is a capability/],
    ['persona', 'seller', /a persona is a capability/],
    ['accountType', 'business', /an account has no type/],
    ['verificationLevel', 2, /owns verification level/],
    ['kycStatus', 'pending', /owns identity verification/],
    ['email', 'alice@example.com', /profile field, and personal data/],
    ['name', 'Alice Smith', /profile field, and personal data/],
    ['balance', 1000, /K-10 Ledger foundation is the authority on every amount/],
    ['currency', 'LKR', /K-10 Ledger foundation owns monetary representation/],
    ['points', 500, /Rewards module owns points/],
    ['payoutAccount', 'bank-1', /Seller Payouts module owns payout destinations/],
    ['status', 'active', /an account is created and never changes/],
    ['closedAt', '2026-05-01T00:00:00Z', /closure is deferred/],
    ['mergedInto', 'acct_01HQZXOTHER', /account merge is deferred/],
    ['subjectKind', 'person', /K-01 Identity owns what kind of party a subject is/],
  ];

  for (const [field, value, why] of cases) {
    const { service, repository } = build();
    await assert.rejects(
      service.open({ ...openRequest(), [field]: value }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', `"${field}" was silently accepted`);
        assert.match((error as AccountError).message, why);
        return true;
      },
      `passing "${field}" must be refused, not dropped`,
    );
    assert.equal(repository.accounts().length, 0);
  }
});

test('the refusal explains why the account stays empty, not merely that it does', async () => {
  await refuses(
    { capabilities: ['seller'] } as Partial<OpenAccountRequest>,
    'foreign-concern',
    /the "one account" rule starts bending/i,
  );
});

test('an unrecognised field is refused too, rather than silently dropped', async () => {
  const { service } = build();
  await assert.rejects(
    service.open({ ...openRequest(), nickname: 'Ally' } as OpenAccountRequest),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as AccountError).message, /silently dropped/i);
      return true;
    },
  );
});

test('the foreign-field table names a real owner for every entry', () => {
  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(owner.length > 20, `${field} needs a real explanation, not a label`);
    assert.ok(
      /K-\d\d|module|deferred|capabilit|profile|preference|personal data|state machine|written once|no type/i.test(
        owner,
      ),
      `${field} does not name who owns it or why it is absent: "${owner}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Identifiers, instants, AI
// ---------------------------------------------------------------------------

test('K-01’s identifier rules apply to every K-03 identifier, in K-03’s vocabulary', async () => {
  const natural: ReadonlyArray<readonly [string, string]> = [
    ['accountId', 'alice@example.com'],
    ['accountId', 'alice.smith'],
    ['accountId', 'example.com'],
    ['accountId', '0771234567'],
    ['accountId', 'acct_1'],
    ['subjectId', 'alice@example.com'],
    ['subjectId', 'GB29NWBK6016133192'],
    ['idempotencyKey', 'passport-X1234567'],
  ];

  for (const [field, value] of natural) {
    const { service } = build([value]);
    await assert.rejects(service.open(openRequest({ [field]: value })), (error: unknown) => {
      assert.ok(
        error instanceof AccountError,
        `${field}=${value} raised an ${(error as Error).name} from a component the caller ` +
          'never called',
      );
      assert.ok(
        ['natural-identifier', 'malformed-identifier'].includes(String(codeOf(error))),
        `${field}=${value} got ${String(codeOf(error))}`,
      );
      return true;
    });
  }
});

test('credential-shaped identifiers are refused on every field', async () => {
  for (const field of ['accountId', 'subjectId', 'idempotencyKey'] as const) {
    const { service } = build(['sk-abcdefghijklmnopqrstuvwxyz']);
    await assert.rejects(
      service.open(openRequest({ [field]: 'sk-abcdefghijklmnopqrstuvwxyz' })),
      (error: unknown) => codeOf(error) === 'secret-bearing-input',
      `${field} accepted a credential`,
    );
  }

  const { service } = build();
  await assert.rejects(
    service.open(openRequest({ origin: { kind: 'human', id: 'api_key_for_alice' } })),
    (error: unknown) => codeOf(error) === 'secret-bearing-input',
  );
});

test('the K-01 refusal mapping is total over what K-01 can raise here', () => {
  // A new K-01 identifier refusal must be given a K-03 meaning rather than escaping as an
  // IdentityError from a call the caller never made.
  assert.deepEqual(Object.keys(IDENTITY_REFUSALS).sort(), [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
  ]);
  for (const [from, to] of Object.entries(IDENTITY_REFUSALS)) {
    assert.equal(from, to, 'the codes carry the same meaning and should keep the same name');
  }
});

test('AI may not author an account', async () => {
  const { service, repository } = build();
  await assert.rejects(service.open(openRequest({ origin: AI })), (error: unknown) => {
    assert.equal(codeOf(error), 'ai-not-permitted');
    assert.match((error as AccountError).message, /counterparty nobody agreed to/i);
    assert.match((error as AccountError).message, /may prompt a human/i);
    return true;
  });
  assert.equal(repository.accounts().length, 0);

  assert.ok(
    (ORIGIN_KINDS as readonly string[]).includes('ai'),
    'representable so it can be tested',
  );
});

test('a human or system origin is accepted and comes back unchanged', async () => {
  for (const origin of [OPERATOR, { kind: 'system' as const, id: 'K-03-account-service' }]) {
    const { service } = build();
    const opened = await service.open(openRequest({ origin }));
    assert.deepEqual({ ...opened.account.origin }, { ...origin });
  }
});

test('a malformed origin is refused rather than defaulted', async () => {
  await refuses({ origin: null as never }, 'malformed-record', /origin must be an object/i);
  await refuses(
    { origin: { kind: 'robot', id: 'x' } as never },
    'malformed-record',
    /origin\.kind/,
  );
  await refuses({ origin: { kind: 'human' } as never }, 'malformed-identifier', /origin\.id/);
  await refuses(
    { origin: { kind: 'human', id: 'ops-alice-console', authenticated: true } as never },
    'foreign-concern',
    /K-02 does not exist/i,
  );
});

test('an impossible calendar instant is refused rather than rolled forward', async () => {
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-04-01 12:00:00Z',
    '2026-04-01T12:00:00+05:30',
    'yesterday',
    '',
  ]) {
    const { service } = build();
    await assert.rejects(
      service.open(openRequest({ createdAt: bad })),
      (error: unknown) => codeOf(error) === 'malformed-instant',
      `"${bad}" must not become a creation instant`,
    );
  }
});

test('nothing is written when a request is refused', async () => {
  const { service, repository } = build();
  for (const attempt of [
    openRequest({ accountId: 'alice@example.com' }),
    openRequest({ origin: AI }),
    openRequest({ createdAt: '2026-02-30T00:00:00Z' }),
    openRequest({ subjectId: 'sub_01HQZXNOBODY02' }),
  ]) {
    await assert.rejects(service.open(attempt));
  }

  assert.equal(repository.accounts().length, 0);
  assert.equal(repository.transactionsCommitted, 0, 'validation happens before any transaction');
});
