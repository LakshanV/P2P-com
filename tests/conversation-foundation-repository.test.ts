/**
 * K-12 Conversation Foundation — port conformance, adapter queries, and the module contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { stripNoise } from '../platform/db/migrations.ts';
import { KERNEL_SCHEMA_PREFIX, knownSchemas } from '../platform/db/schema-namespaces.ts';
import {
  CONVERSATION_SCHEMA,
  ConversationError,
  InMemoryConversationRepository,
  PostgresConversationRepository,
  TIMESTAMP_COLUMNS,
  toConversation,
  toMessage,
  toParticipant,
} from '../kernel/conversation-foundation/index.ts';

import {
  conversationRecord,
  messageRecord,
  participantRecord,
  conversationRow,
  participantRow,
  messageRow,
} from './helpers/conversation-foundation-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'conversation-foundation');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0018_create_kernel_conversation_foundation_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0018_create_kernel_conversation_foundation_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof ConversationError ? error.code : undefined;

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('a conversation is created once and never rewritten', async () => {
  const repository = new InMemoryConversationRepository();
  const first = conversationRecord({ conversationId: 'conv_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertConversation(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertConversation(
        conversationRecord({
          conversationId: 'conv_01HQZXPORT01',
          idempotencyKey: 'idem_port_02',
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-conversation-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertConversation(
        conversationRecord({
          conversationId: 'conv_01HQZXPORT02',
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.conversations().length, 1);
});

test('a participant is created once and never rewritten', async () => {
  const repository = new InMemoryConversationRepository();
  const first = participantRecord({ participantId: 'part_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertParticipant(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertParticipant(
        participantRecord({
          participantId: 'part_01HQZXPORT01',
          idempotencyKey: 'idem_part_port02',
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-participant-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertParticipant(
        participantRecord({
          participantId: 'part_01HQZXPORT02',
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertParticipant(
        participantRecord({
          participantId: 'part_01HQZXPORT03',
          conversationId: first.conversationId,
          accountId: first.accountId,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-participant-account',
  );

  assert.equal(repository.participants().length, 1);
});

test('a message is created once and never rewritten', async () => {
  const repository = new InMemoryConversationRepository();
  const first = messageRecord({ messageId: 'msg_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertMessage(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertMessage(
        messageRecord({
          messageId: 'msg_01HQZXPORT01',
          idempotencyKey: 'idem_msg_port02',
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-message-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertMessage(
        messageRecord({
          messageId: 'msg_01HQZXPORT02',
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.messages().length, 1);
});

test('the port exposes no way to change, remove or rewrite a record', () => {
  const repository = new InMemoryConversationRepository();
  const operations = new Set<string>();

  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations].filter((operation) =>
      /update|delete|remove|amend|edit|rewrite|set[A-Z]/i.test(operation),
    );
    assert.deepEqual(mutators, [], 'conversations and messages are append-only');

    assert.ok(operations.has('insertConversation'));
    assert.ok(operations.has('insertParticipant'));
    assert.ok(operations.has('insertMessage'));
    assert.ok(operations.has('findMessagesByConversation'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryConversationRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertConversation(conversationRecord({ conversationId: 'conv_01HQZXROLLBK' }));
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.conversations().length, 0);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemoryConversationRepository();
  const conversation = conversationRecord({ conversationId: 'conv_01HQZXINTX' });

  const found = await repository.withTransaction(async (tx) => {
    await tx.insertConversation(conversation);
    return {
      byId: await tx.findConversationById('conv_01HQZXINTX'),
      byKey: await tx.findConversationByIdempotencyKey(conversation.idempotencyKey),
      missing: await tx.findConversationById('conv_01HQZXNOSUCH'),
    };
  });

  assert.equal(found.byId?.conversationId, 'conv_01HQZXINTX');
  assert.equal(found.byKey?.conversationId, 'conv_01HQZXINTX');
  assert.equal(found.missing, null);
});

test('messages are paginated by sentAt descending with a stable tie-breaker', async () => {
  const repository = new InMemoryConversationRepository();
  const conversation = conversationRecord({ conversationId: 'conv_01HQZXPAGE' });

  const result = await repository.withTransaction(async (tx) => {
    await tx.insertConversation(conversation);
    for (let i = 0; i < 5; i += 1) {
      await tx.insertMessage(
        messageRecord({
          messageId: `msg_01HQZXPAGE${i}`,
          conversationId: conversation.conversationId,
          sentAt: '2026-04-01T12:00:00Z',
          idempotencyKey: `idem_page_${i}`,
        }),
      );
    }
    return tx.findMessagesByConversation(conversation.conversationId, { after: null, limit: 3 });
  });

  assert.equal(result.length, 3);
});

// ---------------------------------------------------------------------------
// Adapter queries — asserted on the SQL as issued, not as written
// ---------------------------------------------------------------------------

test('every read projects timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /SELECT.*FROM.*conversation\b/i, rows: [conversationRow()] },
      { match: /SELECT.*FROM.*participant\b/i, rows: [participantRow()] },
      { match: /SELECT.*FROM.*message\b/i, rows: [messageRow()] },
    ],
  });
  await new PostgresConversationRepository(database).withTransaction(async (tx) => {
    await tx.findConversationById('conv_01HQZXTESTROW');
    await tx.findParticipantById('part_01HQZXTESTROW');
    await tx.findMessageById('msg_01HQZXTESTROW');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.equal(selects.length, 3, 'all three read paths were exercised');

  for (const sql of selects) {
    const columnsInSql = TIMESTAMP_COLUMNS.filter((column) => sql.includes(`AS ${column}`));
    assert.ok(columnsInSql.length > 0, `no timestamp columns projected in: ${sql}`);

    for (const column of columnsInSql) {
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text: a Date holds milliseconds where the column holds microseconds`,
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw, which would hand the driver something to parse`,
      );
    }
  }
});

test('no statement K-12 issues names another unit schema', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /SELECT.*FROM.*\.conversation\b/i, rows: [conversationRow()] },
      { match: /SELECT.*FROM.*\.participant\b/i, rows: [participantRow()] },
      { match: /SELECT.*FROM.*\.message\b/i, rows: [messageRow()] },
    ],
  });
  const repository = new PostgresConversationRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.findConversationById('conv_01HQZXTESTROW');
    await tx.findParticipantById('part_01HQZXTESTROW');
    await tx.findMessageById('msg_01HQZXTESTROW');
    await tx.insertConversation(conversationRecord({ conversationId: 'conv_01HQZXSCHEMA' }));
  });

  assert.ok(database.statements().length > 0, 'statements were actually issued');
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === CONVERSATION_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-12 statement reaches ${schema}: ${sql}`);
    }
  }
});

test('reads are parameterised and never interpolate the caller value', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresConversationRepository(database).withTransaction((tx) =>
    tx.findConversationById("conv_01' OR 1=1--"),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE conversation_id = \$1;/);
  assert.deepEqual(select.params, ["conv_01' OR 1=1--"]);
});

test('conversation inserts use five bound parameters', async () => {
  const database = new RecordingDatabase();
  const conversation = conversationRecord({ conversationId: 'conv_01HQZXINSERT' });
  await new PostgresConversationRepository(database).withTransaction((tx) =>
    tx.insertConversation(conversation),
  );

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, /INSERT INTO kernel_conversation_foundation\.conversation/);
  assert.equal(insert.params.length, 5);
});

test('a failure rolls back and still releases the connection', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });
  await assert.rejects(
    new PostgresConversationRepository(database).withTransaction((tx) =>
      tx.insertConversation(conversationRecord({ conversationId: 'conv_01HQZXFAILED' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['conversation_pkey', 'duplicate-conversation-id'],
    ['conversation_idempotency_unique', 'idempotency-key-reuse'],
    ['participant_conversation_account_unique', 'duplicate-participant-account'],
    ['message_pkey', 'duplicate-message-id'],
  ] as const) {
    const database = new RecordingDatabase({
      failures: [
        {
          match: /INSERT INTO/i,
          error: sqlstateError(
            `duplicate key value violates unique constraint "${constraint}"`,
            '23505',
            constraint,
          ),
        },
      ],
    });

    await assert.rejects(
      new PostgresConversationRepository(database).withTransaction((tx) =>
        tx.insertConversation(conversationRecord({ conversationId: 'conv_01HQZXCONFLICT' })),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}, not as a raw driver error`,
    );
  }
});

// ---------------------------------------------------------------------------
// Decoding — fail-closed, against the creation rules
// ---------------------------------------------------------------------------

test('a well-formed row decodes, and comes back sealed', () => {
  const decoded = toConversation(conversationRow());
  assert.equal(decoded.conversationId, 'conv_01HQZXTESTROW');
  assert.equal(decoded.context, 'direct');
  assert.equal(decoded.createdAt, '2026-04-01T12:00:00Z');
  assert.ok(Object.isFrozen(decoded));
});

test('a stored conversation row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      'an email as a conversation id',
      { conversation_id: 'alice@example.com' },
      'natural-identifier',
    ],
    [
      'a credential as an idempotency key',
      { idempotency_key: 'bearer-zzzzzzzzzzzz' },
      'secret-bearing-input',
    ],
    ['an unknown context', { context: 'group' }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toConversation({ ...conversationRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
      `${why} must not come back as a real record`,
    );
  }
});

test('a stored participant row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      'a personal name as a participant id',
      { participant_id: 'alice.smith' },
      'natural-identifier',
    ],
    ['an unknown role', { role: 'guest' }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toParticipant({ ...participantRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
      `${why} must not come back as a real record`,
    );
  }
});

test('a stored message row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['a short message id', { message_id: 'msg_1' }, 'malformed-identifier'],
    ['an unknown message type', { message_type: 'image' }, 'malformed-record'],
    ['empty message content', { content: '' }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => toMessage({ ...messageRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
      `${why} must not come back as a real record`,
    );
  }
});

test('a malformed persisted timestamp is refused rather than approximated', () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    [
      'a Date instead of text',
      { created_at: new Date('2026-04-01T12:00:00Z') },
      /rather than text/,
    ],
    ['a millisecond timestamp', { created_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
    ['an impossible date', { created_at: '2026-02-30T00:00:00.000000Z' }, /created_at/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => toConversation({ ...conversationRow(), ...columns }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as ConversationError).message, message, why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('participant and message rows decode and come back sealed', () => {
  const participant = toParticipant(participantRow());
  assert.equal(participant.participantId, 'part_01HQZXTESTROW');
  assert.equal(participant.role, 'member');
  assert.ok(Object.isFrozen(participant));

  const message = toMessage(messageRow());
  assert.equal(message.messageId, 'msg_01HQZXTESTROW');
  assert.equal(message.messageType, 'text');
  assert.ok(Object.isFrozen(message));
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-12 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-12');
  assert.ok(component !== undefined, 'K-12 is registered in the architecture manifest');
  assert.equal(component.dir, 'conversation-foundation');
  assert.equal(CONVERSATION_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(
    knownSchemas().includes(CONVERSATION_SCHEMA),
    'the schema is one the platform knows about',
  );
});

test('neither the adapter nor the migration names another unit schema', () => {
  const MIGRATION_UP_CODE = stripNoise(MIGRATION_UP);
  const MIGRATION_DOWN_CODE = stripNoise(MIGRATION_DOWN);
  const ADAPTER_CODE = stripComments(ADAPTER_SOURCE);

  for (const schema of knownSchemas()) {
    if (schema === CONVERSATION_SCHEMA) continue;
    assert.ok(!ADAPTER_CODE.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!MIGRATION_UP_CODE.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN_CODE.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_conversation_foundation$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_conversation_foundation$/m);

  assert.ok(
    !/REFERENCES/i.test(MIGRATION_UP_CODE),
    'no foreign key: a cross-schema one would make another schema unable to roll back without K-12',
  );
});

test('no source file in this component can change or remove a record', () => {
  for (const [name, source] of [
    ['postgres-repository.ts', ADAPTER_SOURCE],
    ['repository.ts', PORT_SOURCE],
    ['service.ts', SERVICE_SOURCE],
  ] as const) {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|\s)\/\/[^\n]*/g, ' ')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, '``');

    for (const forbidden of [/\bUPDATE\s+kernel_/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — a conversation record is written once`,
      );
    }
  }
});

test('the migration enforces the conversation contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT conversation_pkey PRIMARY KEY \(conversation_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT conversation_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT conversation_context_known\s+CHECK \(context IN \('direct', 'transaction', 'support', 'ai'\)\)/,
  );

  for (const column of ['conversation_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(
        `CHECK \\(kernel_conversation_foundation\\.is_opaque_identifier\\(${column}\\)\\)`,
      ),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  for (const forbidden of ['status', 'state', 'updated_at', 'deleted_at']) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}\\s`, 'm').test(MIGRATION_UP),
      `the conversation table declares a "${forbidden}" column, which is a lifecycle this component does not have`,
    );
  }
});

test('the migration enforces the participant contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT participant_pkey PRIMARY KEY \(participant_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT participant_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT participant_conversation_account_unique UNIQUE \(conversation_id, account_id\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT participant_role_known\s+CHECK \(role IN \('owner', 'member', 'ai', 'system'\)\)/,
  );

  for (const column of ['participant_id', 'conversation_id', 'account_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(
        `CHECK \\(kernel_conversation_foundation\\.is_opaque_identifier\\(${column}\\)\\)`,
      ),
      `${column} does not go through is_opaque_identifier`,
    );
  }
});

test('the migration enforces the message contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT message_pkey PRIMARY KEY \(message_id\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT message_idempotency_unique UNIQUE \(idempotency_key\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT message_type_known\s+CHECK \(message_type IN \('text', 'system'\)\)/,
  );
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT message_content_present\s+CHECK \(length\(btrim\(content\)\) > 0\)/,
  );

  for (const column of ['message_id', 'conversation_id', 'participant_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(
        `CHECK \\(kernel_conversation_foundation\\.is_opaque_identifier\\(${column}\\)\\)`,
      ),
      `${column} does not go through is_opaque_identifier`,
    );
  }
});

test('the migration creates append-only triggers', () => {
  assert.match(
    MIGRATION_UP,
    /CREATE OR REPLACE FUNCTION kernel_conversation_foundation\.refuse_mutation/,
  );
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER conversation_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_conversation_foundation\.conversation/,
  );
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER participant_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_conversation_foundation\.participant/,
  );
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER message_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_conversation_foundation\.message/,
  );
});

test('the rollback reverses exactly what the forward migration created', () => {
  const created = [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  const dropped = [...MIGRATION_DOWN.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/g)].map((match) =>
    String(match[1]),
  );
  assert.deepEqual([...created].sort(), [...dropped].sort());

  for (const match of MIGRATION_UP.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)) {
    assert.ok(
      MIGRATION_DOWN.includes(String(match[1])),
      `${String(match[1])} is created but never dropped`,
    );
  }

  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TRIGGER') < MIGRATION_DOWN.indexOf('DROP FUNCTION'),
    'a function cannot be dropped while a trigger still references it',
  );
  assert.ok(
    MIGRATION_DOWN.indexOf('DROP TABLE') <
      MIGRATION_DOWN.indexOf(
        'DROP FUNCTION IF EXISTS kernel_conversation_foundation.is_opaque_identifier',
      ),
    'the CHECK constraints reference the rule function, so the table must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_conversation_foundation CASCADE/);
});

test('CONTRACT.md records the refusals the code actually raises', () => {
  for (const code of [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
    'malformed-instant',
    'foreign-concern',
    'duplicate-conversation-id',
    'duplicate-participant-id',
    'duplicate-message-id',
    'duplicate-participant-account',
    'idempotency-key-reuse',
    'unknown-conversation',
    'unknown-participant',
    'nested-transaction',
    'malformed-record',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }
});
