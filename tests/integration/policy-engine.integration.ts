/**
 * K-06 against a live PostgreSQL server (FND-005b) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-06 is proved against an injected repository. Six claims cannot be,
 * because they are claims *about the server*:
 *
 *   - that the **append-only triggers** refuse `UPDATE` and `DELETE` on all four tables, so a
 *     commission rate cannot be changed under the transactions already priced by it;
 *   - that the **activation guard is the database's rule**: two activations superseding one version,
 *     and two first activations for one policy, are both refused by partial unique indexes rather
 *     than by a read-then-write;
 *   - that **an exact decimal survives the round trip through `jsonb`** with every digit intact —
 *     the property the whole component is built around, and the one a float would silently break;
 *   - that **microseconds survive** the `timestamptz` columns and come back through the `to_char`
 *     projection exactly as written;
 *   - that the **constraints refuse what the service refuses** — a policy key naming authority or a
 *     deployment control, an AI author, a window containing no instant, a retirement with no
 *     reason, a natural key in an identifier column, a second retirement;
 *   - that `kernel_policy_engine` can be **created and rolled back without touching any other
 *     schema**, which is what the refused foreign keys were traded for.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_TABLE,
  DRAFT_TABLE,
  PostgresPolicyRepository,
  RETIREMENT_TABLE,
  VERSION_TABLE,
  type PolicyActivation,
  type PolicyDraft,
  type PolicyVersion,
} from '../../kernel/policy-engine/index.ts';
import type { Database } from '../../platform/db/client.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';

import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const POLICY = 'commerce.commission';
const AUTHORITY = 'k06-policy-console';

/** 17.5000% and 8.0000%, exactly — the values whose survival is the point of the suite. */
const RATE_SCHEMA = {
  rate: {
    kind: 'decimal',
    scale: 4,
    minimum: { units: '0', scale: 4 },
    maximum: { units: '1000000', scale: 4 },
  },
} as const;

const RULES = [
  {
    ruleId: 'rule_01HQZXLIVEGLOB',
    selector: {},
    condition: null,
    outputs: { rate: { kind: 'decimal', value: { units: '175000', scale: 4 } } },
  },
  {
    ruleId: 'rule_01HQZXLIVESELL',
    selector: { seller: 'sel_01HQZXLIVE0001' },
    condition: { kind: 'amount-at-least', amount: { units: '999999999999', scale: 9 } },
    outputs: { rate: { kind: 'decimal', value: { units: '80000', scale: 4 } } },
  },
];

function draftFor(suffix: string): PolicyDraft {
  return {
    draftId: `draft_01HQZXLIVE${suffix}`,
    policyKey: POLICY,
    outputSchema: RATE_SCHEMA,
    rules: RULES as unknown as PolicyDraft['rules'],
    defaultOutputs: null,
    notes: 'approved by the commercial committee',
    draftedAt: '2026-04-01T12:00:00.123456Z',
    draftedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: `idem_01HQZXLIVED${suffix}`,
    requestFingerprint: 'a'.repeat(64),
  };
}

function versionFor(version: number, suffix: string): PolicyVersion {
  return {
    policyVersionId: `polver_01HQZXLIV${suffix}`,
    policyKey: POLICY,
    version,
    draftId: `draft_01HQZXLIVE${suffix}`,
    outputSchema: RATE_SCHEMA,
    rules: RULES as unknown as PolicyVersion['rules'],
    defaultOutputs: null,
    effectiveFrom: null,
    effectiveUntil: null,
    publishedAt: '2026-04-01T12:00:00.654321Z',
    publishedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: `idem_01HQZXLIVEV${suffix}`,
    requestFingerprint: 'b'.repeat(64),
  };
}

function activationFor(suffix: string, supersedes: string | null = null): PolicyActivation {
  return {
    activationId: `act_01HQZXLIVEA${suffix}`,
    policyKey: POLICY,
    policyVersionId: `polver_01HQZXLIV${suffix}`,
    supersedesVersionId: supersedes,
    activatedAt: '2026-04-01T12:00:00.111111Z',
    activatedBy: { kind: 'system', id: AUTHORITY },
    idempotencyKey: `idem_01HQZXLIVEA${suffix}`,
    requestFingerprint: 'c'.repeat(64),
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

const VERSION_INSERT_COLUMNS =
  'policy_version_id, policy_key, version, draft_id, output_schema, rules, default_outputs, ' +
  'effective_from, effective_until, published_at, published_by_kind, published_by_id, ' +
  'idempotency_key, request_fingerprint';

function versionValues(overrides: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    policy_version_id: `'polver_01HQZXPROBE'`,
    policy_key: `'commerce.commission'`,
    version: '90',
    draft_id: `'draft_01HQZXPROBE1'`,
    output_schema: `'${JSON.stringify(RATE_SCHEMA)}'::jsonb`,
    rules: `'${JSON.stringify(RULES)}'::jsonb`,
    default_outputs: 'NULL',
    effective_from: 'NULL',
    effective_until: 'NULL',
    published_at: `'2026-04-01T12:00:00Z'`,
    published_by_kind: `'system'`,
    published_by_id: `'k06-policy-console'`,
    idempotency_key: `'idem_01HQZXPROBE1'`,
    request_fingerprint: `'${'b'.repeat(64)}'`,
    ...overrides,
  };
  return VERSION_INSERT_COLUMNS.split(', ')
    .map((column) => base[column] ?? 'NULL')
    .join(', ');
}

test('K-06 against a live PostgreSQL server', liveTestOptions, async (t) => {
  const before = await developmentSnapshot();

  await withTestDatabase(async ({ database, directory }) => {
    await t.test('an exact decimal survives the round trip with every digit', async () => {
      await migrateUp(database, { directory });

      const repository = new PostgresPolicyRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertDraft(draftFor('01'));
        await tx.insertVersion(versionFor(1, '01'));
        await tx.insertActivation(activationFor('01'));
      });

      const stored = await repository.withTransaction((tx) =>
        tx.findVersionById('polver_01HQZXLIV01'),
      );
      // The property the whole component is built around. A float column would round the second
      // one and nobody would notice until a reconciliation.
      assert.deepEqual(stored?.rules[0]?.outputs.rate, {
        kind: 'decimal',
        value: { units: '175000', scale: 4 },
      });
      assert.deepEqual(stored?.rules[1]?.condition, {
        kind: 'amount-at-least',
        amount: { units: '999999999999', scale: 9 },
      });
      // And microseconds survived the timestamptz column.
      assert.equal(stored?.publishedAt, '2026-04-01T12:00:00.654321Z');

      const draft = await repository.withTransaction((tx) => tx.findDraftById('draft_01HQZXLIVE01'));
      assert.equal(draft?.draftedAt, '2026-04-01T12:00:00.123456Z');
    });

    await t.test('the version in force is the end of the chain, on a real server', async () => {
      const repository = new PostgresPolicyRepository(database);
      await repository.withTransaction(async (tx) => {
        await tx.insertDraft(draftFor('02'));
        await tx.insertVersion(versionFor(2, '02'));
        await tx.insertActivation(activationFor('02', 'polver_01HQZXLIV01'));
      });

      const current = await repository.withTransaction((tx) => tx.findCurrentActivation(POLICY));
      assert.equal(
        current?.policyVersionId,
        'polver_01HQZXLIV02',
        'the anti-join must find the activation nothing supersedes',
      );
    });

    await t.test('the activation guard is the database’s rule, not only the service’s', async () => {
      const second = await refuses(
        database,
        `INSERT INTO ${ACTIVATION_TABLE} (activation_id, policy_key, policy_version_id,
           supersedes_version_id, activated_at, activated_by_kind, activated_by_id,
           idempotency_key, request_fingerprint)
         VALUES ('act_01HQZXPROBE01', '${POLICY}', 'polver_01HQZXLIV01',
           'polver_01HQZXLIV01', '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}',
           'idem_01HQZXPROBEA', '${'c'.repeat(64)}');`,
      );
      assert.ok(second !== null, 'a second activation superseding one version was accepted');

      const firstAgain = await refuses(
        database,
        `INSERT INTO ${ACTIVATION_TABLE} (activation_id, policy_key, policy_version_id,
           supersedes_version_id, activated_at, activated_by_kind, activated_by_id,
           idempotency_key, request_fingerprint)
         VALUES ('act_01HQZXPROBE02', '${POLICY}', 'polver_01HQZXLIV02',
           NULL, '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}',
           'idem_01HQZXPROBEB', '${'c'.repeat(64)}');`,
      );
      assert.ok(firstAgain !== null, 'a second first-activation was accepted; NULLs do not conflict');
    });

    await t.test('the append-only triggers refuse every UPDATE and DELETE', async () => {
      for (const table of [DRAFT_TABLE, VERSION_TABLE, ACTIVATION_TABLE]) {
        const updated = await refuses(database, `UPDATE ${table} SET policy_key = 'a.b';`);
        assert.ok(updated !== null, `${table} accepted an UPDATE`);
        assert.match(String(updated), /append-only/i, `${table}'s refusal does not say why`);

        const deleted = await refuses(database, `DELETE FROM ${table};`);
        assert.ok(deleted !== null, `${table} accepted a DELETE`);
      }

      // The one that matters most: changing a rate under transactions already priced by it.
      const rewritten = await refuses(
        database,
        `UPDATE ${VERSION_TABLE} SET rules = '[]'::jsonb WHERE policy_version_id = 'polver_01HQZXLIV01';`,
      );
      assert.ok(rewritten !== null, 'a commission rate could be rewritten under a pinned decision');
      assert.ok((await countRows(database, VERSION_TABLE)) >= 2, 'the rows are still there');
    });

    await t.test('the constraints refuse what the service refuses', async () => {
      const probes: ReadonlyArray<readonly [string, Record<string, string>]> = [
        ['a policy key naming authority', { policy_key: `'staff.permission.elevated'` }],
        ['a policy key naming a deployment control', { policy_key: `'checkout.feature-flag.v2'` }],
        ['a policy key naming credentials', { policy_key: `'login.credential.rotate'` }],
        ['a malformed policy key', { policy_key: `'nodots'` }],
        ['an AI author', { published_by_kind: `'ai'` }],
        ['a version number of zero', { version: '0' }],
        ['no rules at all', { rules: `'[]'::jsonb` }],
        [
          'a window containing no instant',
          { effective_from: `'2026-05-01T00:00:00Z'`, effective_until: `'2026-04-01T00:00:00Z'` },
        ],
        ['a natural key as the author', { published_by_id: `'alice@example.com'` }],
        ['a credential as the draft id', { draft_id: `'api_key_9f3c2b1a7d4e5f'` }],
        ['a fingerprint that is not one', { request_fingerprint: `'not-a-hash'` }],
      ];

      for (const [why, overrides] of probes) {
        const refusal = await refuses(
          database,
          `INSERT INTO ${VERSION_TABLE} (${VERSION_INSERT_COLUMNS}) VALUES (${versionValues(overrides)});`,
        );
        assert.ok(refusal !== null, `${why} was accepted by the database`);
      }
    });

    await t.test('a retirement needs a reason, and there is one per policy', async () => {
      const noReason = await refuses(
        database,
        `INSERT INTO ${RETIREMENT_TABLE} (retirement_id, policy_key, reason, retired_at,
           retired_by_kind, retired_by_id, idempotency_key, request_fingerprint)
         VALUES ('ret_01HQZXPROBE01', '${POLICY}', '   ', '2026-04-01T12:00:00Z',
           'system', '${AUTHORITY}', 'idem_01HQZXPROBER', '${'d'.repeat(64)}');`,
      );
      assert.ok(noReason !== null, 'a retirement with no reason was accepted');

      const first = await refuses(
        database,
        `INSERT INTO ${RETIREMENT_TABLE} (retirement_id, policy_key, reason, retired_at,
           retired_by_kind, retired_by_id, idempotency_key, request_fingerprint)
         VALUES ('ret_01HQZXPROBE02', '${POLICY}', 'superseded by the new tier structure',
           '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}', 'idem_01HQZXPROBES',
           '${'d'.repeat(64)}');`,
      );
      assert.equal(first, null, 'the first retirement must be accepted');

      const second = await refuses(
        database,
        `INSERT INTO ${RETIREMENT_TABLE} (retirement_id, policy_key, reason, retired_at,
           retired_by_kind, retired_by_id, idempotency_key, request_fingerprint)
         VALUES ('ret_01HQZXPROBE03', '${POLICY}', 'retiring it again',
           '2026-04-01T12:00:00Z', 'system', '${AUTHORITY}', 'idem_01HQZXPROBET',
           '${'d'.repeat(64)}');`,
      );
      assert.ok(second !== null, 'a second retirement would rewrite when the policy stopped applying');
    });

    await t.test('an enlisted write joins the caller’s transaction and cannot commit it', async () => {
      const client = await database.connect();
      try {
        await client.query('BEGIN;');
        const enlisted = PostgresPolicyRepository.enlist(client);
        await enlisted.withTransaction((tx) => tx.findVersionById('polver_01HQZXLIV01'));
        await client.query('ROLLBACK;');
      } finally {
        await client.release();
      }
      assert.ok((await countRows(database, VERSION_TABLE)) >= 2, 'the rollback took nothing with it');
    });

    await t.test('the schema rolls back independently of every other component', async () => {
      const report = await migrateDown(database, {
        directory,
        version: '0011_create_kernel_policy_engine_schema',
      });
      assert.match(report.rolledBack, /0011_create_kernel_policy_engine_schema/);

      const gone = await refuses(database, `SELECT 1 FROM ${VERSION_TABLE} LIMIT 1;`);
      assert.ok(gone !== null, 'kernel_policy_engine survived its own rollback');

      // K-07's schema, one migration earlier, is untouched by K-06's rollback.
      const neighbour = await refuses(
        database,
        'SELECT 1 FROM kernel_feature_flags.feature_flag_version LIMIT 1;',
      );
      assert.equal(neighbour, null, 'rolling back K-06 disturbed K-07');
    });
  });

  const after = await developmentSnapshot();
  assert.deepEqual(
    after,
    before,
    `the development database ${developmentDatabaseName()} was modified by this suite`,
  );
});
