/**
 * M-02 Capability & Verification — the persistence port's reference implementation.
 *
 * The in-memory repository is the specification the PostgreSQL adapter has to meet, so the cases
 * that matter here are the ones a single caller never reaches: uniqueness checked **at commit
 * against the store as it stands**, not against the snapshot the transaction opened with.
 *
 * M-02's version of that has one rule the kernel components did not: `findOpenCaseByAccountAndPurpose`
 * is a *conditional* uniqueness — the store may hold any number of decided cases for one account and
 * purpose, and at most one that is still running.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapabilityVerificationError,
  InMemoryCapabilityVerificationRepository,
} from '../modules/capability-verification/index.ts';

import {
  ACCOUNT,
  caseRecord,
  evidenceRecord,
  levelRecord,
} from './helpers/capability-verification-fixtures.ts';

/** The refusal code, or a rethrow when it is not one of M-02's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof CapabilityVerificationError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('a committed case is found by id, by idempotency key and by account', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord({ purpose: 'seller-onboarding' });

  await repository.withTransaction(async (tx) => {
    await tx.insertCase(record);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findCaseById(record.caseId), record);
    assert.deepEqual(await tx.findCaseByIdempotencyKey(record.idempotencyKey), record);
    assert.deepEqual(await tx.findCasesByAccountId(ACCOUNT), [record]);

    assert.equal(await tx.findCaseById('case_01HQZW00404'), null);
    assert.equal(await tx.findCaseByIdempotencyKey('idem_absent_0001'), null);
    assert.deepEqual(await tx.findCasesByAccountId('acct_01HQZW00404'), []);
  });
});

test('evidence and level records are found by id, by key and by case', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const evidence = evidenceRecord();
  const record = levelRecord({ caseId: evidence.caseId });

  await repository.withTransaction(async (tx) => {
    await tx.insertEvidence(evidence);
    await tx.insertLevelRecord(record);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findEvidenceById(evidence.evidenceId), evidence);
    assert.deepEqual(await tx.findEvidenceByIdempotencyKey(evidence.idempotencyKey), evidence);
    assert.deepEqual(await tx.findEvidenceByCaseId(evidence.caseId), [evidence]);

    assert.deepEqual(await tx.findLevelRecordById(record.recordId), record);
    assert.deepEqual(await tx.findLevelRecordByIdempotencyKey(record.idempotencyKey), record);
    assert.deepEqual(await tx.findLevelRecordsByCaseId(record.caseId), [record]);
    assert.deepEqual(await tx.findLevelRecordsByAccountId(ACCOUNT), [record]);
  });
});

test('findOpenCaseByAccountAndPurpose ignores decided and withdrawn cases', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();

  await repository.withTransaction(async (tx) => {
    for (const status of ['approved', 'rejected', 'withdrawn'] as const) {
      await tx.insertCase(
        caseRecord({
          purpose: 'seller-onboarding',
          status,
          decidedAt: status === 'withdrawn' ? null : '2026-05-04T09:00:00Z',
        }),
      );
    }
  });

  await repository.withTransaction(async (tx) => {
    assert.equal(
      await tx.findOpenCaseByAccountAndPurpose(ACCOUNT, 'seller-onboarding'),
      null,
      'three closed cases for one purpose, and none of them is the open one',
    );
  });

  const open = caseRecord({ purpose: 'seller-onboarding', status: 'under-review' });
  await repository.withTransaction(async (tx) => {
    await tx.insertCase(open);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findOpenCaseByAccountAndPurpose(ACCOUNT, 'seller-onboarding'), open);
    assert.equal(await tx.findOpenCaseByAccountAndPurpose(ACCOUNT, 'driver-onboarding'), null);
  });
});

test('reads inside a transaction see that transaction’s own uncommitted writes', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord();

  await repository.withTransaction(async (tx) => {
    assert.equal(await tx.findCaseById(record.caseId), null);
    await tx.insertCase(record);
    assert.deepEqual(
      await tx.findCaseById(record.caseId),
      record,
      'a transaction that cannot read its own write forces the service to track state itself',
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test('a failed transaction leaves no case, no evidence, no record and no outbox entry', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord();

  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertCase(record);
      await tx.insertEvidence(evidenceRecord({ caseId: record.caseId }));
      await tx.insertLevelRecord(levelRecord({ caseId: record.caseId }));
      await tx.insertOutbox({
        outboxId: 'M-02:rolled-back',
        idempotencyKey: 'M-02:rolled-back',
        kind: 'event',
        payload: {},
        recordedAt: '2026-05-01T09:00:00Z',
        producer: 'M-02',
        correlationId: 'corr_01HQZW00001',
        causationId: null,
        processedAt: null,
        retryCount: 0,
        lastError: null,
        nextAttemptAt: null,
        deadLetteredAt: null,
        deadLetterReason: null,
      });
      throw new Error('the reviewer changed their mind');
    }),
    /changed their mind/,
  );

  assert.deepEqual(repository.cases(), []);
  assert.deepEqual(repository.evidences(), []);
  assert.deepEqual(repository.records(), []);
  assert.deepEqual(repository.outbox().entries(), []);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

// ---------------------------------------------------------------------------
// Conflict detection at commit, not at read
// ---------------------------------------------------------------------------

test('two transactions that both read "no such case" do not both win', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord({ caseId: 'case_01HQZW10001' });

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findCaseById(record.caseId), null);

      await repository.withTransaction(async (other) => {
        await other.insertCase(record);
      });

      await tx.insertCase(record);
    }),
  );

  assert.equal(code, 'duplicate-case-id');
  assert.equal(repository.cases().length, 1);
});

test('an idempotency key taken by another transaction is refused at commit', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const key = 'idem_contested_0001';

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findCaseByIdempotencyKey(key), null);

      await repository.withTransaction(async (other) => {
        await other.insertCase(caseRecord({ caseId: 'case_01HQZW20001', idempotencyKey: key }));
      });

      await tx.insertCase(caseRecord({ caseId: 'case_01HQZW20002', idempotencyKey: key }));
    }),
  );

  assert.equal(code, 'idempotency-key-reuse');
  assert.equal(repository.cases().length, 1);
});

test('an evidence id and a level-record id taken by another transaction are refused at commit', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();

  const evidenceCode = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findEvidenceById('evid_01HQZW30001'), null);
      await repository.withTransaction(async (other) => {
        await other.insertEvidence(evidenceRecord({ evidenceId: 'evid_01HQZW30001' }));
      });
      await tx.insertEvidence(evidenceRecord({ evidenceId: 'evid_01HQZW30001' }));
    }),
  );
  assert.equal(evidenceCode, 'duplicate-evidence-id');

  const recordCode = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findLevelRecordById('rec_01HQZW40001'), null);
      await repository.withTransaction(async (other) => {
        await other.insertLevelRecord(levelRecord({ recordId: 'rec_01HQZW40001' }));
      });
      await tx.insertLevelRecord(levelRecord({ recordId: 'rec_01HQZW40001' }));
    }),
  );
  assert.equal(recordCode, 'duplicate-record-id');

  assert.equal(repository.evidences().length, 1);
  assert.equal(repository.records().length, 1);
});

// ---------------------------------------------------------------------------
// Updates and sealing
// ---------------------------------------------------------------------------

test('updateCase replaces the row rather than appending a second one', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertCase(record);
  });
  await repository.withTransaction(async (tx) => {
    await tx.updateCase({
      ...record,
      status: 'approved',
      achievedLevel: 'standard',
      decidedAt: '2026-05-03T09:00:00Z',
      updatedAt: '2026-05-03T09:00:00Z',
    });
  });

  const held = repository.cases();
  assert.equal(held.length, 1);
  assert.equal(held[0]?.status, 'approved');
  assert.equal(held[0]?.achievedLevel, 'standard');
});

test('records handed out by the repository are sealed and severed from the store', async () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertCase(record);
  });

  assert.throws(() => {
    (repository.cases()[0] as unknown as { status: string }).status = 'approved';
  }, TypeError);

  await repository.withTransaction(async (tx) => {
    const found = await tx.findCaseById(record.caseId);
    assert.notEqual(found, null);
    assert.throws(() => {
      (found as unknown as { status: string }).status = 'approved';
    }, TypeError);
  });
});

test('seed accepts a starting point without going through a transaction', () => {
  const repository = new InMemoryCapabilityVerificationRepository();
  const record = caseRecord();

  repository.seed({ cases: [record] });

  assert.deepEqual(repository.cases(), [record]);
  assert.equal(
    repository.transactionsCommitted,
    0,
    'seeding is not a transaction, and must not be counted as one',
  );
});
