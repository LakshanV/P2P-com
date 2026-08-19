/**
 * K-01 Identity — the subject contract, the kind registry, and every refusal (FND-004a).
 *
 * The refusals *are* this component. A create operation that accepts anything it is given is four
 * lines of code; what makes an identity layer worth having is that it will not become an account,
 * a credential store or a profile, and will not let a natural key into a field that every
 * downstream row copies for ever.
 *
 * So the tests below are weighted towards what is refused, and each names the consequence rather
 * than the rule — a test that asserts "throws malformed-identifier" and stops teaches the next
 * reader nothing about why the rule is there.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IdentityError,
  ORIGIN_KINDS,
  SUBJECT_KINDS,
  SUBJECT_KIND_DEFINITIONS,
  assertOpaqueIdentifier,
  isSubjectKind,
  requireSubjectKind,
  type CreateSubjectRequest,
} from '../kernel/identity/index.ts';

import { AI, OPERATOR, build, createRequest } from './helpers/identity-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof IdentityError ? error.code : undefined;

/** Refuse with this code, and say something specific enough to act on. */
const refuses = async (
  request: Partial<CreateSubjectRequest> | Record<string, unknown>,
  code: string,
  message: RegExp,
): Promise<void> => {
  const { service } = build();
  await assert.rejects(service.create(createRequest(request)), (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(codeOf(error))}`);
    assert.match((error as IdentityError).message, message);
    return true;
  });
};

// ---------------------------------------------------------------------------
// The happy path, and what a subject is
// ---------------------------------------------------------------------------

test('a created subject holds exactly the six declared fields and nothing else', async () => {
  const { service } = build();
  const result = await service.create(
    createRequest({ subjectId: 'sub_01HQZXCONTRACT', idempotencyKey: 'idem_01HQZXCONTRACT' }),
  );

  assert.equal(result.deduplicated, false);
  assert.deepEqual(Object.keys(result.subject).sort(), [
    'createdAt',
    'idempotencyKey',
    'kind',
    'origin',
    'subjectId',
  ]);
  assert.deepEqual(Object.keys(result.subject.origin).sort(), ['id', 'kind']);

  // The absences are the contract. A field here would be a field every downstream component
  // inherits, and one that turns out to belong to K-03 cannot be moved once accounts reference it.
  for (const absent of ['email', 'name', 'accountId', 'status', 'capabilities', 'verified']) {
    assert.ok(
      !(absent in result.subject),
      `a subject must not carry "${absent}" — that belongs to another component`,
    );
  }
});

test('the service reads no clock: the caller supplies the instant, and it comes back exactly', async () => {
  const { service } = build();
  const created = await service.create(
    createRequest({
      subjectId: 'sub_01HQZXINSTANT',
      idempotencyKey: 'idem_01HQZXINSTANT',
      createdAt: '2026-04-01T12:00:00.123456Z',
    }),
  );

  assert.equal(created.subject.createdAt, '2026-04-01T12:00:00.123456Z');
  const read = await service.requireSubject('sub_01HQZXINSTANT');
  assert.equal(read.createdAt, '2026-04-01T12:00:00.123456Z', 'to the microsecond');
});

test('lookup is by id and returns null rather than guessing', async () => {
  const { service } = build();
  await service.create(
    createRequest({ subjectId: 'sub_01HQZXLOOKUP', idempotencyKey: 'idem_01HQZXLOOKUP' }),
  );

  assert.equal((await service.findSubject('sub_01HQZXLOOKUP'))?.subjectId, 'sub_01HQZXLOOKUP');
  assert.equal(await service.findSubject('sub_01HQZXMISSING'), null);
  assert.equal(await service.exists('sub_01HQZXLOOKUP'), true);
  assert.equal(await service.exists('sub_01HQZXMISSING'), false);

  await assert.rejects(
    service.requireSubject('sub_01HQZXMISSING'),
    (error: unknown) => codeOf(error) === 'no-such-subject',
  );
});

test('the service exposes no operation that changes or removes a subject', () => {
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
    ['create', 'exists', 'findSubject', 'requireSubject'],
    'everything downstream references these ids; an identity that can change reattributes history',
  );
});

// ---------------------------------------------------------------------------
// The kind registry
// ---------------------------------------------------------------------------

test('the kind registry is closed, and holds no role', () => {
  assert.deepEqual([...SUBJECT_KINDS], ['person', 'organisation', 'system']);

  // Guide §4: one universal account with capabilities. A role as a kind would mean one person who
  // both buys and sells is two parties who cannot see each other's history.
  for (const role of [
    'buyer',
    'seller',
    'host',
    'guest',
    'supplier',
    'staff',
    'introducer',
    'merchant',
    'customer',
    'admin',
  ]) {
    assert.ok(!isSubjectKind(role), `"${role}" is a capability of an account, not a kind of party`);
  }
  assert.ok(!isSubjectKind('ai'), 'an AI agent is not a party and cannot hold an identity');
});

test('every registered kind documents what it is and what it is not', () => {
  for (const kind of SUBJECT_KINDS) {
    const definition = SUBJECT_KIND_DEFINITIONS[kind];
    assert.equal(definition.kind, kind);
    assert.ok(definition.description.length > 40, `${kind} needs a real description`);
    assert.ok(
      definition.isNot.length > 40,
      `${kind} must record what a reader would wrongly assume it means`,
    );
  }
});

test('an unregistered kind is refused, and the refusal explains the closed list', async () => {
  await refuses({ kind: 'seller' as never }, 'unknown-subject-kind', /capability of an account/i);
  await refuses({ kind: '' as never }, 'unknown-subject-kind', /not a registered subject kind/i);
  await refuses(
    { kind: undefined as never },
    'unknown-subject-kind',
    /not a registered subject kind/i,
  );

  assert.throws(
    () => requireSubjectKind(42),
    (error: unknown) => codeOf(error) === 'unknown-subject-kind',
  );
});

test('all three registered kinds are actually creatable', async () => {
  for (const kind of SUBJECT_KINDS) {
    const { service } = build();
    const created = await service.create(
      createRequest({
        kind,
        subjectId: `sub_01HQZXKIND${kind}`,
        idempotencyKey: `idem_${kind}_01`,
      }),
    );
    assert.equal(created.subject.kind, kind);
  }
});

// ---------------------------------------------------------------------------
// Opaque identifiers: the refusal that matters most
// ---------------------------------------------------------------------------

test('a natural or PII-shaped subject id is refused, with the shape named', async () => {
  const natural: ReadonlyArray<readonly [string, RegExp]> = [
    ['alice@example.com', /email address/i],
    ['+94771234567', /international telephone number/i],
    ['0771234567', /bare run of digits/i],
    ['199012345678', /bare run of digits|long digit run/i],
    ['4111111111111111', /bare run of digits|long digit run|card/i],
    ['GB29NWBK60161331926819', /IBAN|long digit run/i],
    ['https://example.com/u/1', /URL or URI|not a valid identifier/i],
    ['mailto:alice@example.com', /email address/i],
    ['alice.smith', /personal name/i],
    ['nic:912345678V', /labelled document number/i],
    ['passport-X1234567', /labelled document number/i],
    ['example.com', /domain name/i],
  ];

  for (const [value, why] of natural) {
    const { service } = build();
    await assert.rejects(
      service.create(createRequest({ subjectId: value })),
      (error: unknown) => {
        assert.ok(
          codeOf(error) === 'natural-identifier' || codeOf(error) === 'malformed-identifier',
          `"${value}" was accepted as an opaque id (got ${String(codeOf(error))})`,
        );
        assert.match((error as IdentityError).message, why);
        return true;
      },
      `"${value}" must not become an identity id`,
    );
  }
});

test('the natural-identifier refusal explains the cost rather than citing a rule', async () => {
  await refuses(
    { subjectId: 'alice@example.com' },
    'natural-identifier',
    /copied into every account, order, ledger entry and audit record/i,
  );
  await refuses({ subjectId: 'alice@example.com' }, 'natural-identifier', /erasure request/i);
});

test('a credential-shaped identifier is refused', async () => {
  const secrets = [
    'password-reset-handle',
    'api_key_for_alice',
    'sk-abcdefghijklmnopqrstuvwxyz',
    'ghp_abcdefghijklmnopqrstuvwxyz12',
    'AKIAIOSFODNN7EXAMPLE',
    'session_token_holder',
    'bearer-zzzzzzzzzzzz',
  ];

  for (const value of secrets) {
    const { service } = build();
    await assert.rejects(
      service.create(createRequest({ subjectId: value })),
      (error: unknown) => codeOf(error) === 'secret-bearing-input',
      `"${value}" is a credential, not an identifier`,
    );
  }
});

test('a short or malformed identifier is refused, because an enumerable id space is countable', async () => {
  await refuses({ subjectId: 'sub_1' }, 'malformed-identifier', /guessable|enumerable/i);
  await refuses({ subjectId: '' }, 'malformed-identifier', /not a valid identifier|characters/i);
  await refuses({ subjectId: 'sub 01HQZX0001' }, 'malformed-identifier', /not a valid identifier/i);
  await refuses(
    { subjectId: '_leading_underscore' },
    'malformed-identifier',
    /starting alphanumeric/i,
  );
  await refuses(
    { subjectId: 42 as unknown as string },
    'malformed-identifier',
    /expected a string/i,
  );
});

test('the same refusals apply to the idempotency key and the origin id', async () => {
  await refuses({ idempotencyKey: 'alice@example.com' }, 'natural-identifier', /email/i);
  await refuses({ idempotencyKey: 'k1' }, 'malformed-identifier', /guessable|enumerable/i);
  await refuses(
    { origin: { kind: 'human', id: 'alice@example.com' } },
    'natural-identifier',
    /origin\.id/,
  );
  await refuses({ origin: { kind: 'human', id: 'a' } }, 'malformed-identifier', /origin\.id/);
});

test('a well-formed opaque identifier in several common shapes is accepted', () => {
  for (const value of [
    'sub_01HQZX3M4N5P6Q7R8S9T',
    '01HQZX3M4N5P6Q7R8S9TABCDEF',
    'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    'kernel:identity:0001AAAA',
    'ZmFrZS1vcGFxdWUtaWQ',
  ]) {
    assert.equal(assertOpaqueIdentifier(value, 'subjectId'), value, `${value} should be accepted`);
  }
});

// ---------------------------------------------------------------------------
// Foreign concerns: an identity is not an account
// ---------------------------------------------------------------------------

test('a request carrying another component’s field is refused by name', async () => {
  const foreign: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['password', 'hunter2', /K-02 Authentication owns credentials/],
    ['sessionId', 'sess-1', /K-02 Authentication owns sessions/],
    ['accountId', 'acct-1', /K-03 Accounts/],
    ['capabilities', ['buyer'], /K-03 Accounts and the Capability & Verification module/],
    ['roles', ['admin'], /K-04 Permissions/],
    ['verificationLevel', 2, /Capability & Verification/],
    ['email', 'alice@example.com', /profile field, and personal data/],
    ['name', 'Alice Smith', /profile field, and personal data/],
    ['taxId', 'GB123456789', /tax identity/],
    ['status', 'active', /a subject is created and never changes/],
    ['deletedAt', '2026-04-02T00:00:00Z', /a deletion this component does not have/],
    ['mergedInto', 'sub_01HQZXOTHER', /identity merge is deferred/],
  ];

  for (const [field, value, why] of foreign) {
    const { service } = build();
    await assert.rejects(
      service.create({ ...createRequest(), [field]: value }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', `"${field}" was silently accepted`);
        assert.match((error as IdentityError).message, why);
        return true;
      },
      `passing "${field}" must be refused, not dropped`,
    );
  }
});

test('an unrecognised field is refused too, rather than silently dropped', async () => {
  const { service } = build();
  await assert.rejects(
    service.create({ ...createRequest(), nickname: 'Ally' } as CreateSubjectRequest),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as IdentityError).message, /silently dropped/i);
      return true;
    },
    'a field invented tomorrow must fail, not vanish while the caller believes it was stored',
  );
});

test('the origin is who caused the creation, not how they were authenticated', async () => {
  const { service } = build();
  await assert.rejects(
    service.create(
      createRequest({
        origin: { kind: 'human', id: 'ops-alice-console', authenticated: true } as never,
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as IdentityError).message, /K-02 does not exist/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AI, instants, and the rest of the input surface
// ---------------------------------------------------------------------------

test('AI may not author an identity', async () => {
  const { service } = build();
  await assert.rejects(service.create(createRequest({ origin: AI })), (error: unknown) => {
    assert.equal(codeOf(error), 'ai-not-permitted');
    assert.match((error as IdentityError).message, /root of attribution/i);
    assert.match((error as IdentityError).message, /may prompt a human/i);
    return true;
  });

  // `ai` is a representable origin kind precisely so the refusal can be tested. A value that were
  // unrepresentable would also be unexamined.
  assert.ok((ORIGIN_KINDS as readonly string[]).includes('ai'));
});

test('a human or system origin is accepted, and comes back unchanged', async () => {
  for (const origin of [OPERATOR, { kind: 'system' as const, id: 'K-03-account-service' }]) {
    const { service } = build();
    const created = await service.create(
      createRequest({ origin, subjectId: `sub_01HQZXORIG${origin.kind}` }),
    );
    assert.deepEqual({ ...created.subject.origin }, { ...origin });
  }
});

test('a malformed origin is refused rather than defaulted', async () => {
  await refuses({ origin: null as never }, 'malformed-record', /origin must be an object/i);
  await refuses({ origin: 'human' as never }, 'malformed-record', /origin must be an object/i);
  await refuses(
    { origin: { kind: 'robot', id: 'x' } as never },
    'malformed-record',
    /origin\.kind/,
  );
  await refuses({ origin: { kind: 'human' } as never }, 'malformed-identifier', /origin\.id/);
});

test('an impossible calendar instant is refused rather than rolled forward', async () => {
  // `new Date('2026-02-30T00:00:00Z')` silently reports 2 March. A creation instant that moved by
  // two days would reorder this subject against everything created near it.
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-04-01T25:00:00Z',
    '2026-04-01 12:00:00Z',
    '2026-04-01T12:00:00+05:30',
    'yesterday',
    '',
  ]) {
    const { service } = build();
    await assert.rejects(
      service.create(createRequest({ createdAt: bad })),
      (error: unknown) => codeOf(error) === 'malformed-instant',
      `"${bad}" must not become a creation instant`,
    );
  }
});

test('a request that is not an object is refused before anything else happens', async () => {
  const { service } = build();
  for (const bad of [null, undefined, 'sub_01HQZX0001', 42]) {
    await assert.rejects(
      service.create(bad as unknown as CreateSubjectRequest),
      (error: unknown) => codeOf(error) === 'malformed-record' || error instanceof TypeError,
    );
  }
});

test('nothing is written when a request is refused', async () => {
  const { service, repository } = build();
  const attempts = [
    createRequest({ subjectId: 'alice@example.com' }),
    createRequest({ kind: 'seller' as never }),
    createRequest({ origin: AI }),
    createRequest({ createdAt: '2026-02-30T00:00:00Z' }),
  ];

  for (const attempt of attempts) {
    await assert.rejects(service.create(attempt));
  }

  assert.equal(repository.subjects().length, 0, 'a refused request must not occupy the store');
  assert.equal(
    repository.transactionsCommitted,
    0,
    'and must not even open a transaction — validation happens first',
  );
});
