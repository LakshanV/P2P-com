/**
 * M-02 Capability & Verification against a live PostgreSQL server — opt-in, and honestly skipped
 * otherwise.
 *
 * Migration 0025 declares four things TypeScript cannot enforce: a **partial** unique index allowing
 * one open case per (account, purpose) while leaving decided ones free, append-only triggers on
 * `evidence` and `level_record`, a CHECK tying `status` to `decided_at`, and the opacity rule on
 * `evidence.reference` that keeps a document number out of a verification row.
 *
 * Each of those is proved here by issuing the offending statement, not by asserting that the service
 * does not. A constraint that has never refused anything is not evidence of anything.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapabilityVerificationService,
  PostgresCapabilityVerificationRepository,
} from '../../modules/capability-verification/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  ACCOUNT,
  evaluateRequest,
  evidenceRequest,
  rejectRequest,
  startRequest,
} from '../helpers/capability-verification-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  rollBackTo,
  withTestDatabase,
} from './harness.ts';

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

/** The error message when the statement is refused, or null when it succeeded. */
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

const CASE_COLUMNS =
  '(case_id, account_id, purpose, status, requested_level, achieved_level, opened_at, ' +
  'decided_at, attributes, created_at, updated_at, correlation_id, idempotency_key)';

const EVIDENCE_COLUMNS =
  '(evidence_id, case_id, account_id, kind, status, reference, note, submitted_at, ' +
  'correlation_id, idempotency_key)';

/** An open case row, ready to be interpolated after `VALUES`. */
function openCaseValues(caseId: string, purpose: string, suffix: string): string {
  return (
    `('${caseId}', '${ACCOUNT}', '${purpose}', 'open', 'standard', 'none', ` +
    `'2026-05-01T09:00:00Z', NULL, '{}', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z', ` +
    `'corr_live_${suffix}', 'idem_live_${suffix}')`
  );
}

test(
  'opens, evidences, approves and rejects end-to-end against the real schema',
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

      const service = new CapabilityVerificationService(
        new PostgresCapabilityVerificationRepository(database),
      );

      const opened = startRequest({ purpose: 'seller-onboarding', requestedLevel: 'standard' });
      const started = await service.startVerification(opened);
      assert.equal(started.replayed, false);
      assert.equal(
        started.verificationCase.openedAt,
        opened.openedAt,
        'an instant projected through to_char comes back as the string that went in',
      );

      await service.submitEvidence(evidenceRequest(opened.caseId, { kind: 'identity-document' }));
      const approved = await service.evaluateLevel(
        evaluateRequest(opened.caseId, { level: 'standard' }),
      );
      assert.equal(approved.verificationCase.status, 'approved');
      assert.equal(approved.verificationCase.achievedLevel, 'standard');
      assert.equal(await service.currentLevel(ACCOUNT), 'standard');

      // A decided case does not block the next attempt at the same purpose — the partial index at
      // work, and the reason it is partial.
      const retry = startRequest({ purpose: 'seller-onboarding', caseId: 'case_live_retry_001' });
      await service.startVerification(retry);
      await service.rejectVerification(rejectRequest(retry.caseId));

      assert.equal(
        await count(database, 'module_capability_verification.verification_case'),
        2,
        'one approved case and one rejected case for the same account and purpose',
      );
      assert.equal(await count(database, 'module_capability_verification.evidence'), 1);
      assert.equal(
        await count(database, 'module_capability_verification.level_record'),
        3,
        'two case openings and one level change; the rejection appends no level record',
      );
      assert.equal(
        await count(database, 'module_capability_verification.outbox'),
        12,
        'six facts — two started, one evidence, one level change, one seller.verified, one ' +
          'rejected — each emitting an event and an audit record',
      );
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
  'the partial index refuses a second open case and permits one after a decision',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const first = await refuses(
        database,
        `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
         VALUES ${openCaseValues('case_live_open_001', 'seller-onboarding', 'open_001')};`,
      );
      assert.equal(first, null, 'the first open case must be accepted');

      const second = await refuses(
        database,
        `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
         VALUES ${openCaseValues('case_live_open_002', 'seller-onboarding', 'open_002')};`,
      );
      assert.ok(second !== null, 'a second open case for the same purpose must be refused');
      assert.match(second, /verification_case_one_open_per_purpose_idx|unique/i);

      // Decide the first, and the same insert now succeeds. This is the whole point of the index
      // being partial: an account that failed in March can try again in June.
      const client = await database.connect();
      try {
        await client.query(
          `UPDATE module_capability_verification.verification_case
              SET status = 'rejected', decided_at = '2026-05-04T09:00:00Z'
            WHERE case_id = 'case_live_open_001';`,
        );
      } finally {
        await client.release();
      }

      const third = await refuses(
        database,
        `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
         VALUES ${openCaseValues('case_live_open_003', 'seller-onboarding', 'open_003')};`,
      );
      assert.equal(
        third,
        null,
        'a decided case must not block the next attempt; that is why the index is partial',
      );
    });
  },
);

test(
  'the database refuses a document number as an evidence reference',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const client = await database.connect();
      try {
        await client.query(
          `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
         VALUES ${openCaseValues('case_live_ref_001', 'seller-onboarding', 'ref_001')};`,
        );
      } finally {
        await client.release();
      }

      // Each of these is a real thing somebody would be tempted to store, and each is exactly what a
      // verification record must never hold: it outlives the thing it verifies.
      const forbidden: readonly string[] = [
        'holder@example.com',
        'N1234567890123',
        'GB29NWBK60161331926819',
        'https://docs.example.com/passport.png',
        'api_key_9f2b7c1d4e',
      ];

      for (const [index, reference] of forbidden.entries()) {
        const result = await refuses(
          database,
          `INSERT INTO module_capability_verification.evidence ${EVIDENCE_COLUMNS}
         VALUES ('evid_live_ref_00${index}', 'case_live_ref_001', '${ACCOUNT}',
                 'identity-document', 'submitted', '${reference}', 'a note',
                 '2026-05-02T09:00:00Z', 'corr_live_ref_00${index}', 'idem_live_ref_00${index}');`,
        );
        assert.ok(
          result !== null,
          `"${reference}" reached the evidence table; the opacity rule is in the schema precisely ` +
            'so TypeScript is not the only thing standing between a document number and a stored row',
        );
        assert.match(result, /evidence_reference_opaque/);
      }
    });
  },
);

test('the database refuses a status and a decided_at that disagree', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const openButDecided = await refuses(
      database,
      `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
       VALUES ('case_live_chk_001', '${ACCOUNT}', 'seller-onboarding', 'open', 'standard', 'none',
               '2026-05-01T09:00:00Z', '2026-05-04T09:00:00Z', '{}', '2026-05-01T09:00:00Z',
               '2026-05-01T09:00:00Z', 'corr_live_chk_001', 'idem_live_chk_001');`,
    );
    assert.ok(openButDecided !== null, 'an open case carrying a decision instant');
    assert.match(openButDecided, /decided_at_matches_status/);

    const approvedWithout = await refuses(
      database,
      `INSERT INTO module_capability_verification.verification_case ${CASE_COLUMNS}
       VALUES ('case_live_chk_002', '${ACCOUNT}', 'buyer-checks', 'approved', 'standard',
               'standard', '2026-05-01T09:00:00Z', NULL, '{}', '2026-05-01T09:00:00Z',
               '2026-05-01T09:00:00Z', 'corr_live_chk_002', 'idem_live_chk_002');`,
    );
    assert.ok(approvedWithout !== null, 'an approved case carrying no decision instant');
    assert.match(approvedWithout, /decided_at_matches_status/);
  });
});

test(
  'the database refuses to rewrite or delete evidence and level records',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new CapabilityVerificationService(
        new PostgresCapabilityVerificationRepository(database),
      );

      const opened = startRequest({ caseId: 'case_live_app_001', purpose: 'host-checks' });
      await service.startVerification(opened);
      await service.submitEvidence(evidenceRequest(opened.caseId));

      for (const table of ['evidence', 'level_record']) {
        const update = await refuses(
          database,
          `UPDATE module_capability_verification.${table}
            SET ${table === 'evidence' ? 'note' : 'reason'} = 'rewritten'
          WHERE case_id = '${opened.caseId}';`,
        );
        assert.ok(update !== null, `the append-only trigger must refuse an UPDATE on ${table}`);
        assert.match(update, /append-only/i);

        const remove = await refuses(
          database,
          `DELETE FROM module_capability_verification.${table}
          WHERE case_id = '${opened.caseId}';`,
        );
        assert.ok(remove !== null, `the append-only trigger must refuse a DELETE on ${table}`);
        assert.match(remove, /append-only/i);
      }

      assert.equal(await count(database, 'module_capability_verification.evidence'), 1);
      assert.equal(await count(database, 'module_capability_verification.level_record'), 1);
    });
  },
);

test('the database refuses a level record that changes nothing', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const result = await refuses(
      database,
      `INSERT INTO module_capability_verification.level_record
         (record_id, case_id, account_id, from_level, to_level, reason, occurred_at,
          correlation_id, idempotency_key)
       VALUES ('rec_live_noop_001', 'case_live_noop_001', '${ACCOUNT}', 'standard', 'standard',
               'nothing happened', '2026-05-03T09:00:00Z', 'corr_live_noop_001',
               'idem_live_noop_001');`,
    );
    assert.ok(result !== null, 'a record whose from and to are the same is not a level change');
    assert.match(result, /level_record_changes_level/);
  });
});

test('migration 0025 rolls back and leaves no trace of the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const present = await database.connect();
    try {
      const rows = await present.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_capability_verification';`,
      );
      assert.equal(Number(rows.rows[0]?.count ?? 0), 1);
    } finally {
      await present.release();
    }

    await rollBackTo(database, directory, '0025');

    const after = await database.connect();
    try {
      const rows = await after.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
          WHERE schema_name = 'module_capability_verification';`,
      );
      assert.equal(
        Number(rows.rows[0]?.count ?? 0),
        0,
        'the rollback dropped the tables but left the schema, so the migration is not reversible',
      );
    } finally {
      await after.release();
    }
  });
});
