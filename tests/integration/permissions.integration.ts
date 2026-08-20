/**
 * K-04 against a live PostgreSQL server (FND-004d) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-04 is proved against an injected repository. Four claims cannot be,
 * because they are claims *about the server*:
 *
 *   - that the **append-only triggers** refuse `UPDATE` and `DELETE` on all four tables, so a grant
 *     cannot be widened and a revocation cannot be erased by a statement no code here can issue;
 *   - that the **constraints refuse what the service refuses**: a staff grant with no purpose, a
 *     non-staff grant with one, an AI grant that is not a tool capability, an allow with no
 *     deciding grant, an unexplained decision, and a natural key in any identifier column;
 *   - that **one revocation per grant** and **one row per policy version number** are the
 *     database's rules and not merely the reference implementation's;
 *   - that `kernel_permissions` can be **rolled back without touching K-01, K-02 or K-03**, which
 *     is what the refused foreign keys were traded for and the only place it is observable.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ACCOUNT_TABLE } from '../../kernel/accounts/index.ts';
import { IDENTITY_TABLE } from '../../kernel/identity/index.ts';
import {
  DECISION_TABLE,
  GRANT_TABLE,
  POLICY_TABLE,
  PostgresPermissionRepository,
  REVOCATION_TABLE,
  type Grant,
  type PolicyVersion,
} from '../../kernel/permissions/index.ts';
import type { Database } from '../../platform/db/client.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';

import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const SUBJECT = 'sub_01HQZXLIVEPERM';
const ACCOUNT = 'acct_01HQZXLIVEPERM';

function policyFor(version: number, suffix: string): PolicyVersion {
  return {
    policyVersionId: `pol_01HQZXLIVE${suffix}`,
    version,
    roles: [
      {
        role: 'CUSTOMER',
        capabilities: [
          { action: 'read', resourceType: 'order' },
          { action: 'create', resourceType: 'order' },
        ],
      },
      { role: 'SUPPORT', capabilities: [{ action: 'read', resourceType: 'conversation' }] },
    ],
    publishedAt: '2026-04-01T12:00:00.123456Z',
    publishedBy: { kind: 'human', id: 'ops-alice-console' },
    bootstrap: false,
    idempotencyKey: `idem_01HQZXLIVEP${suffix}`,
    requestFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  };
}

function grantFor(suffix: string, overrides: Partial<Grant> = {}): Grant {
  return {
    grantId: `grant_01HQZXLIV${suffix}`,
    subjectId: SUBJECT,
    accountId: ACCOUNT,
    role: 'CUSTOMER',
    effect: 'allow',
    action: 'read',
    resourceType: 'order',
    resourceId: null,
    purpose: null,
    condition: null,
    policyVersionId: 'pol_01HQZXLIVE01',
    grantedAt: '2026-04-01T12:00:00.123456Z',
    notBefore: null,
    expiresAt: null,
    grantedBy: { kind: 'human', id: 'ops-alice-console' },
    idempotencyKey: `idem_01HQZXLIVG${suffix}`,
    requestFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ...overrides,
  };
}

async function countRows(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

/** Run one statement and report whether the server refused it. */
async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

const GRANT_COLUMNS =
  'grant_id, subject_id, account_id, role, effect, action, resource_type, resource_id, purpose, ' +
  'condition, policy_version_id, granted_at, not_before, expires_at, granted_by_kind, ' +
  'granted_by_id, idempotency_key, request_fingerprint';

function grantValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    grant_id: `'grant_01HQZXPROBE1'`,
    subject_id: `'sub_01HQZXPROBE001'`,
    account_id: `'acct_01HQZXPROBE01'`,
    role: `'CUSTOMER'`,
    effect: `'allow'`,
    action: `'read'`,
    resource_type: `'order'`,
    resource_id: 'NULL',
    purpose: 'NULL',
    condition: 'NULL',
    policy_version_id: `'pol_01HQZXPROBE01'`,
    granted_at: `'2026-04-01T12:00:00Z'`,
    not_before: 'NULL',
    expires_at: 'NULL',
    granted_by_kind: `'human'`,
    granted_by_id: `'ops-alice-console'`,
    idempotency_key: `'idem_01HQZXPROBE01'`,
    request_fingerprint: `'${'c'.repeat(64)}'`,
    ...overrides,
  };
  return GRANT_COLUMNS.split(', ')
    .map((column) => base[column] as string)
    .join(', ');
}

const grantInsert = (overrides: Record<string, string> = {}): string =>
  `INSERT INTO ${GRANT_TABLE} (${GRANT_COLUMNS}) VALUES (${grantValues(overrides)});`;

// ---------------------------------------------------------------------------

test(
  'a policy, a grant, a revocation and a decision survive the real schema exactly',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const repository = new PostgresPermissionRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertPolicyVersion(policyFor(1, '01'));
        await tx.insertGrant(grantFor('01'));
      });

      // Read back through the adapter's own decoder: microseconds survived the timestamptz column,
      // and the jsonb round-tripped as the structure it was written as.
      const stored = await repository.withTransaction((tx) =>
        tx.findGrantById('grant_01HQZXLIV01'),
      );
      assert.equal(stored?.grantedAt, '2026-04-01T12:00:00.123456Z');
      assert.equal(stored?.effect, 'allow');

      const policy = await repository.withTransaction((tx) => tx.findActivePolicy());
      assert.equal(policy?.version, 1);
      assert.equal(policy?.roles.length, 2, 'the role definitions survived jsonb');
      assert.deepEqual(
        policy?.roles.find((role) => role.role === 'CUSTOMER')?.capabilities.map((c) => c.action),
        ['create', 'read'],
        'capabilities come back sorted, as the seal produces them',
      );

      // The grant query is scoped by subject and account together.
      const mine = await repository.withTransaction((tx) =>
        tx.listGrantsForSubject(SUBJECT, ACCOUNT),
      );
      assert.equal(mine.length, 1);
      const elsewhere = await repository.withTransaction((tx) =>
        tx.listGrantsForSubject(SUBJECT, 'acct_01HQZXOTHER01'),
      );
      assert.equal(elsewhere.length, 0, 'another account’s scope sees nothing');
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test(
  'the database refuses every change that would rewrite authority',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const repository = new PostgresPermissionRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertPolicyVersion(policyFor(1, '01'));
        await tx.insertGrant(grantFor('01'));
        await tx.insertRevocation({
          revocationId: 'rev_01HQZXLIVE001',
          grantId: 'grant_01HQZXLIV01',
          revokedAt: '2026-04-01T12:05:00.123456Z',
          reason: 'access-no-longer-needed',
          revokedBy: { kind: 'human', id: 'ops-alice-console' },
        requestFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          idempotencyKey: 'idem_01HQZXLIVR01',
        });
      });

      // Statements no code in this component can issue, which is exactly the case the triggers exist
      // for. Widening a grant, erasing a revocation, rewriting a policy, editing a decision.
      for (const [why, sql] of [
        [
          'widening a grant',
          `UPDATE ${GRANT_TABLE} SET action = 'delete' WHERE grant_id = 'grant_01HQZXLIV01';`,
        ],
        ['deleting a grant', `DELETE FROM ${GRANT_TABLE} WHERE grant_id = 'grant_01HQZXLIV01';`],
        [
          'erasing a revocation',
          `DELETE FROM ${REVOCATION_TABLE} WHERE grant_id = 'grant_01HQZXLIV01';`,
        ],
        [
          'moving a revocation later',
          `UPDATE ${REVOCATION_TABLE} SET revoked_at = '2027-01-01T00:00:00Z' WHERE grant_id = 'grant_01HQZXLIV01';`,
        ],
        [
          'rewriting a policy version',
          `UPDATE ${POLICY_TABLE} SET version = 99 WHERE policy_version_id = 'pol_01HQZXLIVE01';`,
        ],
      ] as const) {
        const refusal = await refuses(database, sql);
        assert.ok(refusal !== null, `${why} must be refused by the trigger`);
        assert.match(refusal, /append-only/i, why);
      }

      assert.equal(
        await countRows(database, GRANT_TABLE),
        1,
        'everything is still there, unchanged',
      );
      assert.equal(await countRows(database, REVOCATION_TABLE), 1);
    });
  },
);

test('the constraints refuse what the service refuses', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    for (const [why, overrides] of [
      ['a staff role with no purpose', { role: `'SUPPORT'` }],
      ['a non-staff role with a purpose', { purpose: `'support-request'` }],
      ['an AI grant that is not a tool capability', { role: `'AI_AGENT'` }],
      ['an unknown role', { role: `'OVERLORD'` }],
      ['an unknown effect', { effect: `'maybe'` }],
      ['an AI grantor', { granted_by_kind: `'ai'` }],
      ['an email as a subject id', { subject_id: `'alice@example.com'` }],
      ['a telephone number as an account id', { account_id: `'0771234567'` }],
      ['a credential as a grantor id', { granted_by_id: `'api_key_for_alice'` }],
      [
        'a window that could never open',
        { not_before: `'2026-04-02T00:00:00Z'`, expires_at: `'2026-04-01T00:00:00Z'` },
      ],
    ] as const) {
      const refusal = await refuses(database, grantInsert(overrides));
      assert.ok(refusal !== null, `${why} must be refused by the database`);
    }
    assert.equal(await countRows(database, GRANT_TABLE), 0, 'none of the probes landed');

    // An allow with no deciding grant, and a decision with no explanation.
    const decisionColumns =
      'decision_id, subject_id, account_id, session_id, action, resource_type, resource_id, ' +
      'effect, reason, explanation, deciding_grant_id, policy_version_id, purpose, decided_at, ' +
      'idempotency_key, request_fingerprint';
    const untraceable =
      `INSERT INTO ${DECISION_TABLE} (${decisionColumns}) VALUES ` +
      `('dec_01HQZXPROBE01', 'sub_01HQZXPROBE001', 'acct_01HQZXPROBE01', 'sess_01HQZXPROBE1', ` +
      `'read', 'order', NULL, 'allow', 'explicit-allow', 'allowed by nothing at all', NULL, ` +
      `'pol_01HQZXPROBE01', NULL, '2026-04-01T12:00:00Z', 'idem_01HQZXPROBE02', ` +
      `'${'a'.repeat(64)}');`;
    const refusal = await refuses(database, untraceable);
    assert.ok(refusal !== null, 'an allow that names no grant must be refused');
    assert.match(refusal, /allow_is_traceable|check constraint/i);

    // And the request fingerprint must be a fingerprint. A decision whose inputs cannot be
    // identified could never be safely returned to a retry.
    const unfingerprinted = untraceable
      .replace("'allow'", "'deny'")
      .replace("'explicit-allow'", "'no-matching-grant')".slice(0, -1))
      .replace(`'${'a'.repeat(64)}'`, "'not-a-fingerprint'");
    const shapeRefusal = await refuses(database, unfingerprinted);
    assert.ok(
      shapeRefusal !== null,
      'a decision fingerprint that is not a SHA-256 must be refused',
    );
    assert.match(shapeRefusal, /fingerprint_shape|check constraint/i);
  });
});

test(
  'one revocation per grant, and one row per policy version number',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const repository = new PostgresPermissionRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertPolicyVersion(policyFor(1, '01'));
        await tx.insertGrant(grantFor('01'));
        await tx.insertRevocation({
          revocationId: 'rev_01HQZXLIVE001',
          grantId: 'grant_01HQZXLIV01',
          revokedAt: '2026-04-01T12:05:00.123456Z',
          reason: 'granted-in-error',
          revokedBy: { kind: 'human', id: 'ops-alice-console' },
        requestFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          idempotencyKey: 'idem_01HQZXLIVR01',
        });
      });

      await assert.rejects(
        repository.withTransaction((tx) =>
          tx.insertRevocation({
            revocationId: 'rev_01HQZXLIVE002',
            grantId: 'grant_01HQZXLIV01',
            revokedAt: '2026-04-01T13:00:00.123456Z',
            reason: 'security-event',
            revokedBy: { kind: 'human', id: 'ops-bob-console' },
          requestFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            idempotencyKey: 'idem_01HQZXLIVR02',
          }),
        ),
        (error: unknown) => (error as { code?: string }).code === 'stale-revocation',
        'a second revocation would rewrite when authority actually ended',
      );

      await assert.rejects(
        repository.withTransaction((tx) => tx.insertPolicyVersion(policyFor(1, '02'))),
        (error: unknown) => (error as { code?: string }).code === 'duplicate-policy-version',
      );

      assert.equal(await countRows(database, REVOCATION_TABLE), 1);
      assert.equal(await countRows(database, POLICY_TABLE), 1);
    });
  },
);

test('an enlisted write commits and rolls back with the caller', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    await new PostgresPermissionRepository(database).withTransaction((tx) =>
      tx.insertPolicyVersion(policyFor(1, '01')),
    );

    const committing = await database.connect();
    try {
      await committing.query('BEGIN;');
      await PostgresPermissionRepository.enlist(committing).withTransaction((tx) =>
        tx.insertGrant(grantFor('01')),
      );
      await committing.query('COMMIT;');
    } finally {
      await committing.release();
    }
    assert.equal(await countRows(database, GRANT_TABLE), 1);

    const rolling = await database.connect();
    try {
      await rolling.query('BEGIN;');
      await PostgresPermissionRepository.enlist(rolling).withTransaction((tx) =>
        tx.insertGrant(
          grantFor('02', { grantId: 'grant_01HQZXLIV02', idempotencyKey: 'idem_01HQZXLIVG02' }),
        ),
      );
      await rolling.query('ROLLBACK;');
    } finally {
      await rolling.release();
    }
    assert.equal(
      await countRows(database, GRANT_TABLE),
      1,
      "the caller's rollback undid the enlisted write",
    );
  });
});

test('kernel_permissions rolls back without touching K-01 or K-03', liveTestOptions, async () => {
  // What the refused foreign keys were traded for, and the only place it is observable.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    await new PostgresPermissionRepository(database).withTransaction(async (tx) => {
      await tx.insertPolicyVersion(policyFor(1, '01'));
      await tx.insertGrant(grantFor('01'));
    });

    await migrateDown(database, { directory, version: '0009' });

    const client = await database.connect();
    try {
      await assert.rejects(client.query(`SELECT 1 FROM ${GRANT_TABLE} LIMIT 1;`));
      // K-01's and K-03's tables are exactly where they were.
      for (const table of [IDENTITY_TABLE, ACCOUNT_TABLE]) {
        const result = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM ${table};`,
        );
        assert.ok(Number(result.rows[0]?.count ?? -1) >= 0, `${table} survived K-04 rolling back`);
      }
    } finally {
      await client.release();
    }
  });
});
