/**
 * K-01 — persisted subjects are held to exactly what creation demands (FND-004a correction).
 *
 * The slice shipped with an asymmetry. Creation refused a subject id that looked like an email, a
 * telephone number, a `first.last` personal name, an IBAN, a domain or a credential. Decoding asked
 * only whether each column was non-empty text and whether two of them held a known enum value. So a
 * row written around the adapter — by hand at three in the morning, by a restore, by a migration
 * script — decoded cleanly and came back as a real party while carrying exactly the natural key the
 * creation path exists to keep out. And migration 0006's constraints, whose comments claimed to
 * prohibit natural keys, admitted four whole classes of them.
 *
 * Validation on the way *in* protects the store from a caller. Validation on the way *out* protects
 * every consumer from the store — and the store is the thing this component controls least.
 *
 * This suite drives one corpus of identifiers through **three** enforcement points and demands they
 * agree:
 *
 *   1. the service, at creation;
 *   2. `validateSubject`, which the PostgreSQL decoder calls on every row;
 *   3. the SQL rule set, extracted from `is_opaque_identifier` in migration 0006 and evaluated
 *      here, because no PostgreSQL runtime is available to run it against.
 *
 * A corpus shared by all three is what makes drift impossible to introduce quietly: adding a rule
 * to one place and not the others fails here rather than in production two years later.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  IdentityError,
  IdentityService,
  InMemoryIdentityRepository,
  PostgresIdentityRepository,
  toSubject,
  validateSubject,
} from '../kernel/identity/index.ts';
import type { IdentitySubject } from '../kernel/identity/index.ts';

import { createRequest, row } from './helpers/identity-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_UP = readFileSync(
  path.join(HERE, '..', 'db', 'migrations', '0006_create_kernel_identity_schema.up.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof IdentityError ? error.code : undefined;

const decode = (columns: Record<string, unknown>): IdentitySubject =>
  toSubject(columns as unknown as Parameters<typeof toSubject>[0]);

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * Identifiers that must be accepted everywhere.
 *
 * Kept deliberately varied. A rule tightened until only one generator's output survives would pass
 * a single-shape corpus and break every caller that chose a different one, and "without weakening
 * the accepted opaque-ID domain" is half of this correction.
 */
const OPAQUE: readonly string[] = [
  'sub_01HQZX3M4N5P6Q7R8S9T',
  '01HQZX3M4N5P6Q7R8S9TABCDEF',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  'kernel:identity:0001AAAA',
  'ZmFrZS1vcGFxdWUtaWQ',
  'K-03-account-service',
  'ops-alice-console',
  'idem_01HQZXPROBE001',
  'a1b2c3d4e5f6a7b8',
  'sub.01HQZX.3M4N5P',
];

/**
 * Identifiers that must be refused everywhere, with why.
 *
 * The four classes named in this correction are the ones migration 0006 previously admitted: a
 * domain, a `first.last` name, a compact IBAN or document number, and a 10–11 digit telephone
 * number. Each satisfied every constraint the table declared while the service refused it.
 */
const NATURAL: ReadonlyArray<{ readonly value: string; readonly why: string }> = [
  // Domains — the class the old `[0-9]{12,}` and `@` checks could not see at all.
  { value: 'example.com', why: 'a domain' },
  { value: 'jaya.market.lk', why: 'a country-coded domain' },
  { value: 'shop-front.co.uk', why: 'a second-level domain' },
  { value: 'my-startup.io', why: 'a short TLD' },

  // Personal names. A subject id that is somebody's name is personal data in every downstream row.
  { value: 'alice.smith', why: 'first.last' },
  { value: 'alice_smith', why: 'first_last' },
  { value: 'Alice-Smith', why: 'First-Last' },

  // Compact document and account numbers, short enough to slip under a 12-digit rule.
  { value: 'GB29NWBK6016133192', why: 'an IBAN of 18 characters' },
  { value: 'LK12BANK3456789012', why: 'a local IBAN' },
  { value: 'nic:912345678V', why: 'a labelled national identity number' },
  { value: 'passport-X1234567', why: 'a labelled passport number' },
  { value: 'VAT.GB123456789', why: 'a labelled tax number' },

  // Telephone numbers of 10 and 11 digits — under the 12-digit rule the old CHECK relied on.
  { value: '0771234567', why: 'a 10-digit telephone number' },
  { value: '07712345678', why: 'an 11-digit telephone number' },
  { value: '9412345678', why: 'a 10-digit national number' },

  // The classes the old CHECK did catch, kept so a rewrite cannot lose them.
  { value: 'alice@example.com', why: 'an email address' },
  { value: '199012345678901', why: 'a long digit run' },
  { value: 'sub_1', why: 'too short to be opaque' },
  { value: 'https:sub01HQZX', why: 'a URI scheme' },
];

/** Credential-shaped values, which must be refused wherever an identifier is accepted. */
const CREDENTIALS: ReadonlyArray<{ readonly value: string; readonly why: string }> = [
  { value: 'password-reset-handle', why: 'names a password' },
  { value: 'api_key_for_alice', why: 'names an API key' },
  { value: 'svc-access-key-01', why: 'names an access key' },
  { value: 'bearer-zzzzzzzzzzzz', why: 'names a bearer token' },
  { value: 'authorization-01HQZX', why: 'names an authorization header' },
  { value: 'sk-abcdefghijklmnopqrstuvwxyz', why: 'is a provider secret key' },
  { value: 'ghp_abcdefghijklmnopqrstuvwxyz12', why: 'is a GitHub token' },
  { value: 'AKIAIOSFODNN7EXAMPLE', why: 'is an AWS access key id' },
  {
    value: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    why: 'is a JSON web token',
  },
];

const REFUSED = [...NATURAL, ...CREDENTIALS];

// ---------------------------------------------------------------------------
// 1. The decoder is held to the creation rules
// ---------------------------------------------------------------------------

const IDENTIFIER_COLUMNS = ['subject_id', 'origin_id', 'idempotency_key'] as const;

test('a stored identifier that creation would refuse is refused on decode', () => {
  // The defect this correction exists for. Before it, every one of these decoded and was returned.
  for (const column of IDENTIFIER_COLUMNS) {
    for (const { value, why } of REFUSED) {
      assert.throws(
        () => decode(row({ [column]: value })),
        (error: unknown) => {
          assert.ok(
            ['natural-identifier', 'secret-bearing-input', 'malformed-identifier'].includes(
              String(codeOf(error)),
            ),
            `${column} = ${value} (${why}) decoded with code ${String(codeOf(error))}`,
          );
          return true;
        },
        `${column} holding ${value} (${why}) must not come back as a real party`,
      );
    }
  }
});

test('the refusal says the row was not written by this component', () => {
  // A stored row failing a creation rule is a *database* problem, and the message has to send the
  // reader there rather than to the validator.
  assert.throws(
    () => decode(row({ subject_id: 'alice@example.com' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'natural-identifier');
      assert.match((error as IdentityError).message, /not written by this component/i);
      assert.match((error as IdentityError).message, /rather than presenting it as a real party/i);
      return true;
    },
  );

  // And at creation the same rule produces the same code with no such clause, because there the
  // caller is the problem.
  const service = new IdentityService(new InMemoryIdentityRepository());
  return assert.rejects(
    service.create(createRequest({ subjectId: 'alice@example.com' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'natural-identifier');
      assert.ok(!/not written by this component/i.test((error as IdentityError).message));
      return true;
    },
  );
});

test('every opaque identifier round-trips through decoding unchanged', () => {
  for (const value of OPAQUE) {
    for (const column of IDENTIFIER_COLUMNS) {
      const decoded = decode(row({ [column]: value }));
      const stored =
        column === 'subject_id'
          ? decoded.subjectId
          : column === 'origin_id'
            ? decoded.origin.id
            : decoded.idempotencyKey;
      assert.equal(stored, value, `${value} must survive decoding in ${column}`);
    }
  }
});

test('a stored kind or origin kind outside the registry is refused', () => {
  for (const kind of ['seller', 'buyer', 'host', 'ai', 'Person', '']) {
    assert.throws(
      () => decode(row({ kind })),
      (error: unknown) =>
        codeOf(error) === 'unknown-subject-kind' || codeOf(error) === 'malformed-record',
      `kind "${kind}" must not decode`,
    );
  }

  assert.throws(
    () => decode(row({ origin_kind: 'ai' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ai-not-permitted');
      assert.match((error as IdentityError).message, /root of attribution/i);
      assert.match((error as IdentityError).message, /not written by this component/i);
      return true;
    },
    'a row claiming an AI origin must never become a real party',
  );
});

test('malformed runtime fields are refused before anything is returned', () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    ['a numeric subject id', { subject_id: 42 }, /expected non-empty text/],
    ['a boolean kind', { kind: true }, /expected non-empty text/],
    ['an object origin id', { origin_id: { id: 'x' } }, /expected non-empty text/],
    ['a null idempotency key', { idempotency_key: null }, /expected non-empty text/],
    ['an array subject id', { subject_id: ['sub_01HQZX0001'] }, /expected non-empty text/],
    ['a Date for created_at', { created_at: new Date() }, /rather than text/],
    ['a numeric created_at', { created_at: 1_775_000_000 }, /rather than text/],
    ['a millisecond created_at', { created_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
    ['an impossible created_at', { created_at: '2026-02-30T00:00:00.000000Z' }, /created_at/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => decode(row(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as IdentityError).message, message, why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('validateSubject refuses a candidate that is not a subject at all', () => {
  for (const candidate of [null, undefined, 'sub_01HQZX0001', 42, []]) {
    assert.throws(
      () => validateSubject(candidate, 'stored row'),
      (error: unknown) => codeOf(error) === 'malformed-record',
      `${String(candidate)} is not a subject`,
    );
  }

  // An extra own property is refused rather than dropped: a subject that carried one would be a
  // subject this component did not write.
  assert.throws(
    () =>
      validateSubject(
        {
          subjectId: 'sub_01HQZX0001AAA',
          kind: 'person',
          createdAt: '2026-04-01T12:00:00Z',
          origin: { kind: 'system', id: 'K-03-account-service' },
          idempotencyKey: 'idem_01HQZX0001AAA',
          accountId: 'acct-1',
        },
        'stored row',
      ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as IdentityError).message, /unrecognised field "accountId"/);
      return true;
    },
  );
});

test('the adapter refuses a natural-key row on every read path', async () => {
  const database = new RecordingDatabase({
    selects: [{ match: /SELECT/i, rows: [row({ subject_id: 'alice.smith' })] }],
  });
  const repository = new PostgresIdentityRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.findSubjectById('alice.smith')),
    (error: unknown) => codeOf(error) === 'natural-identifier',
  );
  await assert.rejects(
    repository.withTransaction((tx) => tx.findSubjectByIdempotencyKey('idem_01HQZXTESTROW')),
    (error: unknown) => codeOf(error) === 'natural-identifier',
  );
});

test('one shared function decides, at creation and on decode alike', () => {
  // Not "the same rules" — the same function. Two lists that happen to agree today are two lists
  // that will disagree after the next change.
  const subject = {
    subjectId: 'sub_01HQZXSHARED01',
    kind: 'person',
    createdAt: '2026-04-01T12:00:00Z',
    origin: { kind: 'system', id: 'K-03-account-service' },
    idempotencyKey: 'idem_01HQZXSHARED01',
  };

  assert.deepEqual(validateSubject(subject, 'request'), validateSubject(subject, 'stored row'));

  const serviceSource = readFileSync(
    path.join(HERE, '..', 'kernel', 'identity', 'service.ts'),
    'utf8',
  );
  const adapterSource = readFileSync(
    path.join(HERE, '..', 'kernel', 'identity', 'postgres-repository.ts'),
    'utf8',
  );
  assert.match(serviceSource, /validateSubject\(/, 'the service must call the shared validator');
  assert.match(adapterSource, /validateSubject\(/, 'and so must the decoder');
});

// ---------------------------------------------------------------------------
// 2. The SQL rule set, extracted from the migration and evaluated
// ---------------------------------------------------------------------------

/**
 * Translate one POSIX clause of `is_opaque_identifier` into a JavaScript predicate.
 *
 * Only the forms the function actually uses are understood, and anything else **throws** rather
 * than being read as satisfied — so rewriting a clause into a shape this cannot check is a failing
 * test, not a silent pass. That is the difference between a guard and a decoration.
 */
function clauseToPredicate(clause: string): (value: string) => boolean {
  const trimmed = clause.trim();

  if (trimmed === "position('@' in value) = 0") {
    return (value) => !value.includes('@');
  }

  const match = /^value (!?~\*?) '(.*)'$/.exec(trimmed);
  if (match === null) {
    throw new Error(`is_opaque_identifier uses a clause this test cannot evaluate: ${trimmed}`);
  }

  const [, operator, pattern] = match;
  // PostgreSQL ARE spells the word boundary `\y`; JavaScript spells it `\b`.
  const expression = new RegExp(
    String(pattern).replace(/\\y/g, '\\b'),
    String(operator).endsWith('*') ? 'i' : '',
  );
  const negated = String(operator).startsWith('!');
  return (value) => (negated ? !expression.test(value) : expression.test(value));
}

/** Every clause of the SQL function, as predicates. */
function sqlRules(): ReadonlyArray<(value: string) => boolean> {
  const body = /AS \$rules\$([\s\S]*?)\$rules\$/.exec(MIGRATION_UP);
  assert.ok(body !== null, 'is_opaque_identifier was not found in migration 0006');

  const clauses = String(body[1])
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').trim())
    .filter((line) => line !== '')
    .join(' ')
    .replace(/^SELECT\s+/, '')
    .split(/\s+AND\s+/);

  assert.ok(clauses.length >= 12, `expected the full rule set, found ${clauses.length} clauses`);
  return clauses.map(clauseToPredicate);
}

const acceptedBySql = (value: string): boolean => sqlRules().every((rule) => rule(value));

test('the SQL rule set accepts every identifier the service accepts', () => {
  for (const value of OPAQUE) {
    assert.ok(
      acceptedBySql(value),
      `${value} is accepted by the service but refused by the database — a direct write of a ` +
        'perfectly good id would fail, which is a weakening of the accepted domain',
    );
  }
});

test('the SQL rule set refuses every identifier the service refuses', () => {
  for (const { value, why } of REFUSED) {
    assert.ok(
      !acceptedBySql(value),
      `${value} (${why}) is refused by the service but admitted by the database, so a write ` +
        'around the adapter puts it in the table for ever',
    );
  }
});

test('the corpus is judged identically by the service and by the SQL', () => {
  // The agreement stated directly, rather than inferred from the two tests above passing. If a
  // future rule is added to one side only, this is what says so.
  for (const value of [...OPAQUE, ...REFUSED.map((entry) => entry.value)]) {
    let acceptedByService = true;
    try {
      validateSubject(
        {
          subjectId: value,
          kind: 'person',
          createdAt: '2026-04-01T12:00:00Z',
          origin: { kind: 'system', id: 'K-03-account-service' },
          idempotencyKey: 'idem_01HQZXCORPUS01',
        },
        'request',
      );
    } catch {
      acceptedByService = false;
    }

    assert.equal(
      acceptedByService,
      acceptedBySql(value),
      `the service and the database disagree about "${value}"`,
    );
  }
});

test('all three identifier columns are held to the one rule set', () => {
  for (const column of ['subject_id', 'origin_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_identity\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier, so it is judged by a weaker standard`,
    );
  }

  // And nothing is left checking a subset of the rules on its own, which is how the two standards
  // diverged in the first revision.
  assert.ok(
    !/CHECK \((?:subject_id|origin_id|idempotency_key) [~!]/.test(MIGRATION_UP),
    'an identifier column still carries its own ad-hoc regex CHECK alongside the shared function',
  );
});

test('the rollback drops the rule function after the table that depends on it', () => {
  const down = readFileSync(
    path.join(HERE, '..', 'db', 'migrations', '0006_create_kernel_identity_schema.down.sql'),
    'utf8',
  );

  assert.match(down, /DROP FUNCTION IF EXISTS kernel_identity\.is_opaque_identifier\(text\)/);
  assert.ok(
    down.indexOf('DROP TABLE') <
      down.indexOf('DROP FUNCTION IF EXISTS kernel_identity.is_opaque_identifier'),
    'the CHECK constraints reference the function, so the table must go first',
  );
});

test('the function is IMMUTABLE and strict, which is what lets a CHECK call it', () => {
  const definition =
    /CREATE OR REPLACE FUNCTION kernel_identity\.is_opaque_identifier[\s\S]*?AS \$rules\$/.exec(
      MIGRATION_UP,
    );
  assert.ok(definition !== null);
  assert.match(
    definition[0],
    /\bIMMUTABLE\b/,
    'PostgreSQL only accepts immutable calls in a CHECK',
  );
  assert.match(definition[0], /RETURNS NULL ON NULL INPUT/);
  assert.match(definition[0], /RETURNS boolean/);
});
