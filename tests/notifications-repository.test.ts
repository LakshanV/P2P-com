/**
 * K-14 Notifications — port conformance, adapter queries, and the module contract.
 *
 * Four kinds of assertion:
 *
 *   - Port conformance. The in-memory repository is the reference implementation.
 *   - No mutation capability. The port exposes no way to mutate a channel or delivery attempt.
 *   - Adapter queries. Statement shape is behaviour, so the real adapter is run against a recording
 *     fake and what it sends is inspected.
 *   - Module contract. Ownership, schema, migration and write-once trigger, asserted mechanically.
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
  CHANNEL_TABLE,
  DELIVERY_ATTEMPT_TABLE,
  NOTIFICATION_SCHEMA,
  NOTIFICATION_TABLE,
  NotificationError,
  InMemoryNotificationRepository,
  PostgresNotificationRepository,
  toChannel,
  toDeliveryAttempt,
  toNotification,
} from '../kernel/notifications/index.ts';
import type {
  DeliveryAttempt,
  Notification,
  NotificationChannel,
} from '../kernel/notifications/index.ts';

import {
  channelRecord,
  channelRow,
  deliveryAttemptRow,
  notificationRow,
} from './helpers/notifications-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'notifications');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const PORT_SOURCE = readFileSync(path.join(MODULE_DIR, 'repository.ts'), 'utf8');
const SERVICE_SOURCE = readFileSync(path.join(MODULE_DIR, 'service.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATIONS = path.join(HERE, '..', 'db', 'migrations');
const MIGRATION_UP = readFileSync(
  path.join(MIGRATIONS, '0020_create_kernel_notification_schema.up.sql'),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(MIGRATIONS, '0020_create_kernel_notification_schema.down.sql'),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof NotificationError ? error.code : undefined;

/** Source with comments blanked, so a scan sees code and not prose. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, ' ');

const decodeChannel = (columns: Record<string, unknown>): NotificationChannel => toChannel(columns);
const decodeNotification = (columns: Record<string, unknown>): Notification =>
  toNotification(columns);
const decodeAttempt = (columns: Record<string, unknown>): DeliveryAttempt =>
  toDeliveryAttempt(columns);

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

test('a channel is created once and never rewritten', async () => {
  const repository = new InMemoryNotificationRepository();
  const first = channelRecord({ channelId: 'chan_01HQZXPORT01' });
  await repository.withTransaction((tx) => tx.insertChannel(first));

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertChannel({ ...first, channel: 'email', idempotencyKey: 'idem_PORT02X' }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-channel-id',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertChannel({
        ...first,
        channelId: 'chan_01HQZXPORT02',
        idempotencyKey: 'idem_PORT03X',
      }),
    ),
    (error: unknown) => codeOf(error) === 'duplicate-channel-provider',
  );
  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertChannel({ ...first, channelId: 'chan_01HQZXPORT03', channel: 'email' }),
    ),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );

  assert.equal(repository.channels().length, 1);
});

test('the port exposes no way to change or remove a channel or delivery attempt', () => {
  const repository = new InMemoryNotificationRepository();
  const operations = new Set<string>();

  return repository.withTransaction((tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object | null;
    while (proto !== null && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
      proto = Object.getPrototypeOf(proto) as object | null;
    }

    const mutators = [...operations].filter((operation) =>
      /update|delete|remove|relink|merge|amend|close|suspend|purge|truncate|set[A-Z]/i.test(
        operation,
      ),
    );
    // updateNotificationStatus is the only allowed mutation because a notification's status and
    // sent_at change as delivery attempts arrive.
    const forbidden = mutators.filter((operation) => operation !== 'updateNotificationStatus');
    assert.deepEqual(
      forbidden,
      [],
      'channels and delivery attempts are append-only; a mutation path would break that',
    );

    assert.ok(operations.has('insertChannel'));
    assert.ok(operations.has('insertNotification'));
    assert.ok(operations.has('insertDeliveryAttempt'));
    assert.ok(operations.has('updateNotificationStatus'));
    return Promise.resolve();
  });
});

test('a failed transaction writes nothing', async () => {
  const repository = new InMemoryNotificationRepository();
  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertChannel(channelRecord({ channelId: 'chan_01HQZXROLLBK' }));
      throw new Error('something went wrong after the insert');
    }),
    /something went wrong/,
  );

  assert.equal(repository.channels().length, 0, 'a caller that sees a failure assumes nothing ran');
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

test('lookups inside a transaction see what that transaction wrote', async () => {
  const repository = new InMemoryNotificationRepository();
  const channel = channelRecord({ channelId: 'chan_01HQZXINTX' });

  const found = await repository.withTransaction(async (tx) => {
    await tx.insertChannel(channel);
    return {
      byId: await tx.findChannelById('chan_01HQZXINTX'),
      byChannel: await tx.findChannelByChannel('in_app'),
      byKey: await tx.findChannelByIdempotencyKey(channel.idempotencyKey),
      missing: await tx.findChannelById('chan_01HQZXNOSUCH'),
    };
  });

  assert.equal(found.byId?.channelId, 'chan_01HQZXINTX');
  assert.equal(found.byChannel?.channelId, 'chan_01HQZXINTX');
  assert.equal(found.byKey?.channelId, 'chan_01HQZXINTX');
  assert.equal(found.missing, null);
});

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

test('every read projects timestamps as UTC text, never as a driver Date', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_notifications\.channel/i, rows: [channelRow()] },
      { match: /FROM kernel_notifications\.notification/i, rows: [notificationRow()] },
      { match: /FROM kernel_notifications\.delivery_attempt/i, rows: [deliveryAttemptRow()] },
    ],
  });
  await new PostgresNotificationRepository(database).withTransaction(async (tx) => {
    await tx.findChannelById('chan_01HQZXTESTROW');
    await tx.findChannelByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findChannelByChannel('in_app');
    await tx.findChannelByChannelAndProvider('in_app', 'in_app');
    await tx.findNotificationById('not_01HQZXTESTROW');
    await tx.findNotificationByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findDeliveryAttemptById('att_01HQZXTESTROW');
    await tx.findDeliveryAttemptByIdempotencyKey('idem_01HQZXTESTROW');
  });

  const selects = database.statements().filter((sql) => sql.startsWith('SELECT'));
  assert.ok(selects.length > 0, 'read paths were exercised');

  const tableTimestamps: Readonly<Record<string, readonly string[]>> = {
    'kernel_notifications.channel': ['created_at'],
    'kernel_notifications.notification': ['created_at', 'scheduled_at', 'sent_at'],
    'kernel_notifications.delivery_attempt': ['attempted_at'],
  };

  for (const sql of selects) {
    const table = Object.keys(tableTimestamps).find((t) => sql.includes(`FROM ${t}`));
    assert.ok(table, `could not identify table for query: ${sql}`);
    const columns = tableTimestamps[table];
    assert.ok(columns, `no timestamp columns known for table ${table}`);
    for (const column of columns) {
      assert.match(
        sql,
        new RegExp(
          `to_char\\(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\\.US"Z"'\\) AS ${column}`,
        ),
        `${column} must be projected as text: a Date holds milliseconds where the column holds ` +
          'microseconds',
      );
      assert.ok(
        !new RegExp(`(SELECT|,)\\s*${column}\\s*(,|FROM)`).test(sql),
        `${column} is also selected raw, which would hand the driver something to parse`,
      );
    }
  }
});

test("no statement K-14 issues names another unit's schema", async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /FROM kernel_notifications\.channel/i, rows: [channelRow()] },
      { match: /FROM kernel_notifications\.notification/i, rows: [notificationRow()] },
      { match: /FROM kernel_notifications\.delivery_attempt/i, rows: [deliveryAttemptRow()] },
    ],
  });
  const repository = new PostgresNotificationRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.findChannelById('chan_01HQZXTESTROW');
    await tx.findChannelByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findChannelByChannel('in_app');
    await tx.findChannelByChannelAndProvider('in_app', 'in_app');
    await tx.findNotificationById('not_01HQZXTESTROW');
    await tx.findNotificationByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.findDeliveryAttemptById('att_01HQZXTESTROW');
    await tx.findDeliveryAttemptByIdempotencyKey('idem_01HQZXTESTROW');
    await tx.insertChannel(channelRecord({ channelId: 'chan_01HQZXSCHEMA' }));
  });

  assert.ok(database.statements().length > 0, 'statements were actually issued');
  for (const sql of database.statements()) {
    for (const schema of knownSchemas()) {
      if (schema === NOTIFICATION_SCHEMA) continue;
      assert.ok(!sql.includes(`${schema}.`), `a K-14 statement reaches ${schema}: ${sql}`);
    }
  }
});

test("reads are parameterised and never interpolate the caller's value", async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresNotificationRepository(database).withTransaction((tx) =>
    tx.findChannelById("chan_01' OR 1=1--"),
  );

  const select = database.queries.find((query) => query.sql.startsWith('SELECT'));
  assert.ok(select !== undefined);
  assert.match(select.sql, /WHERE channel_id = \$1;/);
  assert.deepEqual(select.params, ["chan_01' OR 1=1--"]);
});

test('channel reads differ only by column, and the column is never caller-supplied', async () => {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  await new PostgresNotificationRepository(database).withTransaction(async (tx) => {
    await tx.findChannelById('chan_01HQZXSHAPE1');
    await tx.findChannelByIdempotencyKey('idem_01HQZXSHAPE1');
    await tx.findChannelByChannel('in_app');
    await tx.findChannelByChannelAndProvider('in_app', 'in_app');
  });

  const channelSelects = database
    .statements()
    .filter((sql) => sql.startsWith('SELECT') && sql.includes('kernel_notifications.channel'));
  const columns = channelSelects.map((sql) => /WHERE (\w+) = \$1;/.exec(sql)?.[1]);
  assert.deepEqual(columns, ['channel_id', 'idempotency_key', 'channel', undefined]);
});

test('an insert is one INSERT with bound parameters, inside BEGIN/COMMIT', async () => {
  const database = new RecordingDatabase();
  const channel = channelRecord({
    channelId: 'chan_01HQZXINSERT',
    idempotencyKey: 'idem_chan_01HQZXINSERT',
  });
  await new PostgresNotificationRepository(database).withTransaction((tx) =>
    tx.insertChannel(channel),
  );

  const statements = database.statements();
  assert.equal(statements[0], 'BEGIN;');
  assert.equal(statements[statements.length - 1], 'COMMIT;');

  const insert = database.queries.find((query) => /INSERT INTO/i.test(query.sql));
  assert.ok(insert !== undefined);
  assert.match(insert.sql, new RegExp(`INSERT INTO ${CHANNEL_TABLE.replace('.', '\\.')}`));
  assert.deepEqual(insert.params, [
    'chan_01HQZXINSERT',
    'in_app',
    'in_app',
    true,
    '{}',
    channel.createdAt,
    'idem_chan_01HQZXINSERT',
  ]);
  assert.equal(database.sessionsReleased, 1, 'the connection is released whatever happens');
});

test('a failure rolls back and still releases the connection', async () => {
  const database = new RecordingDatabase({ failOn: /INSERT INTO/i });
  await assert.rejects(
    new PostgresNotificationRepository(database).withTransaction((tx) =>
      tx.insertChannel(channelRecord({ channelId: 'chan_01HQZXFAILED' })),
    ),
  );

  assert.ok(database.indexOf(/^ROLLBACK;$/m) > -1, 'the transaction was rolled back');
  assert.equal(database.indexOf(/^COMMIT;$/m), -1, 'and never committed');
  assert.equal(database.sessionsReleased, 1);
});

test('a unique violation becomes the refusal it actually is', async () => {
  for (const [constraint, expected] of [
    ['channel_pkey', 'duplicate-channel-id'],
    ['channel_idempotency_unique', 'idempotency-key-reuse'],
    ['channel_channel_provider_unique', 'duplicate-channel-provider'],
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
      new PostgresNotificationRepository(database).withTransaction((tx) =>
        tx.insertChannel(channelRecord({ channelId: 'chan_01HQZXCONFLICT' })),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} must surface as ${expected}, not as a raw driver error`,
    );
  }
});

test('an error the adapter does not understand is passed through unchanged', async () => {
  const database = new RecordingDatabase({
    failures: [{ match: /INSERT INTO/i, error: sqlstateError('connection terminated', '08006') }],
  });

  await assert.rejects(
    new PostgresNotificationRepository(database).withTransaction((tx) =>
      tx.insertChannel(channelRecord({ channelId: 'chan_01HQZXCONNGONE' })),
    ),
    /connection terminated/,
  );
});

// ---------------------------------------------------------------------------
// Decoding — fail-closed, against the creation rules
// ---------------------------------------------------------------------------

test('a well-formed channel row decodes, and comes back sealed', () => {
  const decoded = decodeChannel(channelRow());

  assert.equal(decoded.channelId, 'chan_01HQZXTESTROW');
  assert.equal(decoded.createdAt, '2026-04-01T12:00:00Z');
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.configuration));
});

test('a stored channel row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as a channel id', { channel_id: 'alice@example.com' }, 'natural-identifier'],
    ['a short channel id', { channel_id: 'chan_1' }, 'malformed-identifier'],
    ['an unknown channel', { channel: 'fax' }, 'invalid-channel'],
    ['a null provider', { provider: null }, 'malformed-record'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => decodeChannel(channelRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as NotificationError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real channel`,
    );
  }
});

test('a well-formed notification row decodes, and comes back sealed', () => {
  const decoded = decodeNotification(notificationRow());

  assert.equal(decoded.notificationId, 'not_01HQZXTESTROW');
  assert.equal(decoded.createdAt, '2026-04-01T12:00:00Z');
  assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.payload));
});

test('a stored notification row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    [
      'an email as a notification id',
      { notification_id: 'alice@example.com' },
      'natural-identifier',
    ],
    ['a short account id', { account_id: 'acct_1' }, 'malformed-identifier'],
    ['an unknown channel', { channel: 'fax' }, 'invalid-channel'],
    ['an unknown priority', { priority: 'highest' }, 'invalid-priority'],
    ['an unknown status', { status: 'cancelled' }, 'invalid-status'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => decodeNotification(notificationRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as NotificationError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real notification`,
    );
  }
});

test('a malformed persisted notification row is refused rather than approximated', () => {
  const malformed: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
    [
      'a Date instead of text',
      { created_at: new Date('2026-04-01T12:00:00Z') },
      /rather than text/,
    ],
    ['a millisecond timestamp', { created_at: '2026-04-01T12:00:00.000Z' }, /projected form/],
    ['a local timestamp', { created_at: '2026-04-01 12:00:00+05:30' }, /projected form/],
    ['an impossible date', { created_at: '2026-02-30T00:00:00.000000Z' }, /createdAt/],
    ['a null template id', { template_id: null }, /expected non-empty text/],
  ];

  for (const [why, columns, message] of malformed) {
    assert.throws(
      () => decodeNotification(notificationRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-record', why);
        assert.match((error as NotificationError).message, message, why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('a well-formed delivery attempt row decodes, and comes back sealed', () => {
  const decoded = decodeAttempt(deliveryAttemptRow());

  assert.equal(decoded.attemptId, 'att_01HQZXTESTROW');
  assert.equal(decoded.attemptedAt, '2026-04-01T12:00:01Z');
  assert.ok(Object.isFrozen(decoded));
});

test('a stored delivery attempt row is held to exactly what creation demands', () => {
  const refused: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an email as an attempt id', { attempt_id: 'alice@example.com' }, 'natural-identifier'],
    ['an unknown status', { status: 'cancelled' }, 'invalid-attempt-status'],
    ['a short notification id', { notification_id: 'not_1' }, 'malformed-identifier'],
  ];

  for (const [why, columns, code] of refused) {
    assert.throws(
      () => decodeAttempt(deliveryAttemptRow(columns)),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        assert.match(
          (error as NotificationError).message,
          /not written by this component/i,
          `${why}: the refusal must send the reader to the database`,
        );
        return true;
      },
      `${why} must not come back as a real delivery attempt`,
    );
  }
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('K-14 owns exactly one schema, derived from the manifest', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-14');
  assert.ok(component !== undefined, 'K-14 is registered in the architecture manifest');
  assert.equal(component.dir, 'notifications');
  assert.equal(NOTIFICATION_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir}`);
  assert.ok(
    knownSchemas().includes(NOTIFICATION_SCHEMA),
    'the schema is one the platform knows about',
  );
  assert.equal(CHANNEL_TABLE, `${NOTIFICATION_SCHEMA}.channel`);
  assert.equal(NOTIFICATION_TABLE, `${NOTIFICATION_SCHEMA}.notification`);
  assert.equal(DELIVERY_ATTEMPT_TABLE, `${NOTIFICATION_SCHEMA}.delivery_attempt`);
});

test("neither the adapter nor the migration names another unit's schema", () => {
  const MIGRATION_UP_CODE = stripNoise(MIGRATION_UP);
  const MIGRATION_DOWN_CODE = stripNoise(MIGRATION_DOWN);
  const ADAPTER_CODE = stripComments(ADAPTER_SOURCE);

  for (const schema of knownSchemas()) {
    if (schema === NOTIFICATION_SCHEMA) continue;
    assert.ok(!ADAPTER_CODE.includes(`${schema}.`), `the adapter touches ${schema}`);
    assert.ok(!MIGRATION_UP_CODE.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN_CODE.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
  assert.match(MIGRATION_UP, /^-- owner: kernel_notifications$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_notifications$/m);

  assert.ok(
    !/REFERENCES/i.test(MIGRATION_UP_CODE),
    'no foreign key: a cross-schema one would make another unit unable to roll back',
  );
});

test('no source file in this component can change or remove a channel or delivery attempt', () => {
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

    for (const forbidden of [/\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i]) {
      assert.ok(
        !forbidden.test(code),
        `${name} contains ${String(forbidden)} — a channel and a delivery attempt are written once`,
      );
    }
  }
});

test('the migration enforces the notification contract in the database', () => {
  assert.match(MIGRATION_UP, /CONSTRAINT channel_pkey PRIMARY KEY \(channel_id\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT channel_idempotency_unique UNIQUE \(idempotency_key\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT channel_channel_provider_unique UNIQUE \(channel, provider\)/,
  );
  assert.match(MIGRATION_UP, /CONSTRAINT notification_pkey PRIMARY KEY \(notification_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT notification_idempotency_unique UNIQUE \(idempotency_key\)/,
  );
  assert.match(MIGRATION_UP, /CONSTRAINT delivery_attempt_pkey PRIMARY KEY \(attempt_id\)/);
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT delivery_attempt_idempotency_unique UNIQUE \(idempotency_key\)/,
  );

  assert.match(MIGRATION_UP, /CONSTRAINT channel_channel_known/);
  assert.match(
    MIGRATION_UP,
    /CHECK \(channel IN \('in_app', 'email', 'sms', 'push', 'whatsapp'\)\)/,
  );
  assert.match(MIGRATION_UP, /CONSTRAINT notification_priority_known/);
  assert.match(MIGRATION_UP, /CHECK \(priority IN \('low', 'normal', 'high', 'urgent'\)\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT notification_status_known/);
  assert.match(MIGRATION_UP, /CHECK \(status IN \('pending', 'sent', 'failed', 'scheduled'\)\)/);
  assert.match(MIGRATION_UP, /CONSTRAINT delivery_attempt_status_known/);
  assert.match(MIGRATION_UP, /CHECK \(status IN \('success', 'failure'\)\)/);

  for (const column of ['channel_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_notifications\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  for (const column of ['notification_id', 'account_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_notifications\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  for (const column of ['attempt_id', 'notification_id', 'idempotency_key']) {
    assert.match(
      MIGRATION_UP,
      new RegExp(`CHECK \\(kernel_notifications\\.is_opaque_identifier\\(${column}\\)\\)`),
      `${column} does not go through is_opaque_identifier`,
    );
  }

  for (const forbidden of ['updated_at', 'deleted_at', 'template_body', 'template_content']) {
    assert.ok(
      !new RegExp(`^\\s+${forbidden}\\s`, 'm').test(MIGRATION_UP),
      `the table declares a "${forbidden}" column, which belongs to another component`,
    );
  }
});

test("K-14's opacity rules are character-for-character K-01's", () => {
  const body = (sql: string): string => {
    const found = /AS \$rules\$([\s\S]*?)\$rules\$/.exec(sql);
    assert.ok(found !== null, 'is_opaque_identifier was not found');
    return String(found[1]);
  };

  const identityMigration = readFileSync(
    path.join(MIGRATIONS, '0006_create_kernel_identity_schema.up.sql'),
    'utf8',
  );

  assert.equal(
    body(MIGRATION_UP),
    body(identityMigration),
    'K-14 and K-01 must judge an identifier identically; they are the same rule, written twice ' +
      'only because each schema must be independently creatable and droppable',
  );
});

test('the migration refuses mutation on append-only tables', () => {
  assert.match(MIGRATION_UP, /CREATE OR REPLACE FUNCTION kernel_notifications\.refuse_mutation/);
  assert.match(MIGRATION_UP, /RAISE EXCEPTION/);
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER channel_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_notifications\.channel/,
  );
  assert.match(
    MIGRATION_UP,
    /CREATE TRIGGER delivery_attempt_is_append_only\s+BEFORE UPDATE OR DELETE ON kernel_notifications\.delivery_attempt/,
  );
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS channel_is_append_only/);
  assert.match(MIGRATION_DOWN, /DROP TRIGGER IF EXISTS delivery_attempt_is_append_only/);
  assert.match(MIGRATION_DOWN, /DROP FUNCTION IF EXISTS kernel_notifications\.refuse_mutation/);
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
      MIGRATION_DOWN.indexOf('DROP FUNCTION IF EXISTS kernel_notifications.is_opaque_identifier'),
    'the CHECK constraints reference the rule function, so the table must go first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_notifications RESTRICT/);
});

test('CONTRACT.md records the refusals the code actually raises', () => {
  for (const code of [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
    'malformed-instant',
    'foreign-concern',
    'malformed-record',
    'invalid-channel',
    'invalid-priority',
    'invalid-status',
    'invalid-attempt-status',
    'duplicate-channel-id',
    'duplicate-channel-provider',
    'duplicate-notification-id',
    'duplicate-attempt-id',
    'idempotency-key-reuse',
    'no-such-channel',
    'channel-disabled',
    'no-such-notification',
    'nested-transaction',
  ]) {
    assert.ok(CONTRACT.includes(`\`${code}\``), `CONTRACT.md does not document ${code}`);
  }
});
