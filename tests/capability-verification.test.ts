/**
 * M-02 Capability & Verification — service behaviour.
 *
 * The module's central claim is that it records **how far anybody checked**, and never what they
 * checked. So the cases here fall into two halves: the lifecycle of a case, and the refusals that
 * keep a document number, a tax number or a bank account out of a verification row. The second half
 * matters more. A verification record outlives the thing it verifies, and a natural key written into
 * one is disclosed for as long as the platform exists.
 *
 * Live-PostgreSQL properties — the partial unique index, the append-only triggers, the
 * status/timestamp CHECK and the opacity rule on `evidence.reference` — are in
 * `tests/integration/capability-verification.integration.ts`, because a constraint that has never
 * refused anything is not evidence of anything.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CASE_STATUSES,
  CapabilityVerificationError,
  EVIDENCE_KINDS,
  FOREIGN_FIELDS,
  VERIFICATION_LEVELS,
  compareVerificationLevels,
} from '../modules/capability-verification/index.ts';

import {
  ACCOUNT,
  build,
  entriesOfKind,
  evaluateRequest,
  evidenceRequest,
  eventTypes,
  rejectRequest,
  startRequest,
} from './helpers/capability-verification-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'capability-verification');

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

/** Open a case and return its id. */
async function openCase(
  harness: ReturnType<typeof build>,
  overrides: Parameters<typeof startRequest>[0] = {},
): Promise<string> {
  const request = startRequest(overrides);
  await harness.service.startVerification(request);
  return request.caseId;
}

// ---------------------------------------------------------------------------
// The level vocabulary is ordered
// ---------------------------------------------------------------------------

test('verification levels are ordered, and compared by that order rather than as strings', () => {
  assert.deepEqual([...VERIFICATION_LEVELS], ['none', 'basic', 'standard', 'enhanced', 'full']);

  assert.ok(compareVerificationLevels('none', 'basic') < 0);
  assert.ok(compareVerificationLevels('full', 'enhanced') > 0);
  assert.equal(compareVerificationLevels('standard', 'standard'), 0);

  // The point of the helper: alphabetically 'basic' < 'none' < 'standard', which is not the order
  // that matters. A string comparison here would make "none" outrank "basic".
  assert.ok(
    compareVerificationLevels('basic', 'none') > 0,
    'basic outranks none by verification order, whatever the alphabet says',
  );
});

// ---------------------------------------------------------------------------
// Opening a case
// ---------------------------------------------------------------------------

test('starting a verification writes the case, the first level record and both outbox entries', async () => {
  const harness = build();
  const request = startRequest({ purpose: 'seller-onboarding', requestedLevel: 'standard' });

  const result = await harness.service.startVerification(request);

  assert.equal(result.replayed, false);
  assert.equal(result.verificationCase.status, 'open');
  assert.equal(result.verificationCase.achievedLevel, 'none');
  assert.equal(result.verificationCase.requestedLevel, 'standard');
  assert.equal(result.verificationCase.decidedAt, null);
  assert.equal(result.record?.fromLevel, null);
  assert.equal(result.record?.toLevel, 'none');

  assert.equal(entriesOfKind(harness.repository, 'event').length, 1);
  assert.equal(entriesOfKind(harness.repository, 'audit').length, 1);

  const envelope = entriesOfKind(harness.repository, 'event')[0]?.payload as {
    type: string;
    payload: Record<string, unknown>;
  };
  assert.equal(envelope.type, 'verification.started');
  assert.deepEqual(envelope.payload, {
    case_id: request.caseId,
    account_id: ACCOUNT,
    purpose: 'seller-onboarding',
    requested_level: 'standard',
    opened_at: request.openedAt,
    idempotency_key: request.idempotencyKey,
  });
});

test('a replay with the same key and the same content changes nothing', async () => {
  const harness = build();
  const request = startRequest();

  const first = await harness.service.startVerification(request);
  const second = await harness.service.startVerification(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.verificationCase, first.verificationCase);
  assert.equal((await harness.service.listCases(ACCOUNT)).length, 1);
  assert.equal(entriesOfKind(harness.repository, 'event').length, 1);
});

test('an account may hold one open case per purpose, and cases for other purposes at the same time', async () => {
  const harness = build();
  await openCase(harness, { purpose: 'seller-onboarding' });

  const code = await codeOf(() =>
    harness.service.startVerification(
      startRequest({ purpose: 'seller-onboarding', caseId: 'case_01HQZVZ0002' }),
    ),
  );
  assert.equal(code, 'case-already-open');

  // A different purpose is a different effort and is not blocked.
  await harness.service.startVerification(
    startRequest({ purpose: 'driver-onboarding', caseId: 'case_01HQZVZ0003' }),
  );
  assert.equal((await harness.service.listCases(ACCOUNT)).length, 2);
});

test('a decided case does not block the next attempt at the same purpose', async () => {
  const harness = build();
  const first = await openCase(harness, { purpose: 'seller-onboarding' });
  await harness.service.rejectVerification(rejectRequest(first));

  // This is the whole reason the index is partial rather than a plain UNIQUE: an account that
  // failed in March has to be able to try again in June.
  const second = await harness.service.startVerification(
    startRequest({ purpose: 'seller-onboarding', caseId: 'case_01HQZVZ0004' }),
  );
  assert.equal(second.verificationCase.status, 'open');
  assert.equal((await harness.service.listCases(ACCOUNT)).length, 2);
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

test('submitting evidence appends it, moves the case under review, and emits', async () => {
  const harness = build();
  const caseId = await openCase(harness);
  const request = evidenceRequest(caseId, { kind: 'identity-document' });

  const result = await harness.service.submitEvidence(request);

  assert.equal(result.replayed, false);
  assert.equal(result.evidence.status, 'submitted');
  assert.equal(result.evidence.kind, 'identity-document');
  assert.equal(result.evidence.reference, request.reference);
  assert.equal(result.verificationCase.status, 'under-review');

  const evidence = await harness.service.listEvidence(caseId);
  assert.equal(evidence.length, 1);

  assert.deepEqual(eventTypes(harness.repository), [
    'verification.started',
    'verification.evidence_submitted',
  ]);
});

test('every evidence kind in the vocabulary is accepted', async () => {
  const harness = build();
  const caseId = await openCase(harness);

  for (const kind of EVIDENCE_KINDS) {
    await harness.service.submitEvidence(evidenceRequest(caseId, { kind }));
  }
  assert.equal((await harness.service.listEvidence(caseId)).length, EVIDENCE_KINDS.length);
});

test('evidence against an unknown or closed case is refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.submitEvidence(evidenceRequest('case_01HQZVZ0404'))),
    'case-not-found',
  );

  const caseId = await openCase(harness);
  await harness.service.rejectVerification(rejectRequest(caseId));
  assert.equal(
    await codeOf(() => harness.service.submitEvidence(evidenceRequest(caseId))),
    'case-not-open',
  );
});

// ---------------------------------------------------------------------------
// The evidence reference is a handle, never the artefact
// ---------------------------------------------------------------------------

test('an evidence reference that is a natural key or a credential is refused', async () => {
  const harness = build();
  const caseId = await openCase(harness);

  // Each of these is a real thing somebody would be tempted to put here, and each is exactly what
  // must never reach a verification row.
  const refused: readonly string[] = [
    'holder@example.com', // an email address
    'N1234567890123', // a long digit run: a national id or a passport number
    'GB29NWBK60161331926819', // an IBAN
    'https://docs.example.com/passport.png', // a URL to the artefact itself
    'api_key_9f2b7c1d4e', // a credential
    'short', // too short to be an opaque handle
  ];

  for (const reference of refused) {
    const code = await codeOf(() =>
      harness.service.submitEvidence(evidenceRequest(caseId, { reference })),
    );
    assert.ok(
      [
        'malformed-reference',
        'malformed-identifier',
        'natural-identifier',
        'secret-bearing-input',
      ].includes(code),
      `"${reference}" was accepted as an evidence reference with code ${code}; this module stores ` +
        'a handle to an artefact, never the artefact and never its natural key',
    );
  }

  assert.deepEqual(
    await harness.service.listEvidence(caseId),
    [],
    'a refused reference must leave no evidence row behind',
  );
});

// ---------------------------------------------------------------------------
// Evaluating the level
// ---------------------------------------------------------------------------

test('reaching the requested level approves the case and records the decision', async () => {
  const harness = build();
  const caseId = await openCase(harness, { requestedLevel: 'standard' });
  await harness.service.submitEvidence(evidenceRequest(caseId));

  const request = evaluateRequest(caseId, { level: 'standard' });
  const result = await harness.service.evaluateLevel(request);

  assert.equal(result.verificationCase.status, 'approved');
  assert.equal(result.verificationCase.achievedLevel, 'standard');
  assert.equal(result.verificationCase.decidedAt, request.decidedAt);
  assert.equal(result.record?.fromLevel, 'none');
  assert.equal(result.record?.toLevel, 'standard');

  const history = await harness.service.getLevelHistory(caseId);
  assert.deepEqual(
    history.map((record) => [record.fromLevel, record.toLevel]),
    [
      [null, 'none'],
      ['none', 'standard'],
    ],
  );
});

test('a level short of the requested one records progress without approving', async () => {
  const harness = build();
  const caseId = await openCase(harness, { requestedLevel: 'enhanced' });

  const result = await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'basic' }));

  assert.equal(result.verificationCase.achievedLevel, 'basic');
  assert.notEqual(
    result.verificationCase.status,
    'approved',
    'basic is below the requested enhanced, so the case is not decided',
  );
  assert.equal(result.verificationCase.decidedAt, null);
});

test('a level above the requested one still approves', async () => {
  const harness = build();
  const caseId = await openCase(harness, { requestedLevel: 'basic' });

  const result = await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'full' }));

  assert.equal(result.verificationCase.status, 'approved');
  assert.equal(result.verificationCase.achievedLevel, 'full');
});

test('a level is never taken away by evaluateLevel', async () => {
  const harness = build();
  const caseId = await openCase(harness, { requestedLevel: 'full' });
  await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'enhanced' }));

  const code = await codeOf(() =>
    harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'basic' })),
  );
  assert.equal(
    code,
    'level-regression',
    'removing standing is a new case with its own evidence and its own decision, not an edit to ' +
      'the record that granted it',
  );

  const current = await harness.service.getCase(caseId);
  assert.equal(current?.achievedLevel, 'enhanced');
});

test('evaluating an unknown or closed case is refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.evaluateLevel(evaluateRequest('case_01HQZVZ0404'))),
    'case-not-found',
  );

  const caseId = await openCase(harness, { requestedLevel: 'basic' });
  await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'basic' }));
  assert.equal(
    await codeOf(() => harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'full' }))),
    'case-not-open',
  );
});

// ---------------------------------------------------------------------------
// seller.verified
// ---------------------------------------------------------------------------

test('approving a seller-onboarding case at standard or above emits seller.verified', async () => {
  const harness = build();
  const caseId = await openCase(harness, {
    purpose: 'seller-onboarding',
    requestedLevel: 'standard',
  });
  const request = evaluateRequest(caseId, { level: 'standard' });
  await harness.service.evaluateLevel(request);

  assert.deepEqual(eventTypes(harness.repository), [
    'verification.started',
    'verification.level_changed',
    'seller.verified',
  ]);

  const verified = entriesOfKind(harness.repository, 'event').at(-1)?.payload as {
    payload: Record<string, unknown>;
  };
  assert.deepEqual(verified.payload, {
    case_id: caseId,
    account_id: ACCOUNT,
    achieved_level: 'standard',
    decided_at: request.decidedAt,
    idempotency_key: request.idempotencyKey,
  });
});

test('seller.verified is not emitted below standard, nor for another purpose', async () => {
  const belowStandard = build();
  const basicCase = await openCase(belowStandard, {
    purpose: 'seller-onboarding',
    requestedLevel: 'basic',
  });
  await belowStandard.service.evaluateLevel(evaluateRequest(basicCase, { level: 'basic' }));
  assert.ok(
    !eventTypes(belowStandard.repository).includes('seller.verified'),
    'basic is not enough to call somebody a verified seller',
  );

  const otherPurpose = build();
  const driverCase = await openCase(otherPurpose, {
    purpose: 'driver-onboarding',
    requestedLevel: 'standard',
  });
  await otherPurpose.service.evaluateLevel(evaluateRequest(driverCase, { level: 'full' }));
  assert.ok(
    !eventTypes(otherPurpose.repository).includes('seller.verified'),
    'a fully verified driver is not a verified seller',
  );
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

test('rejecting a case closes it and emits, even though no level changed', async () => {
  const harness = build();
  const caseId = await openCase(harness);
  await harness.service.submitEvidence(evidenceRequest(caseId));
  const request = rejectRequest(caseId);

  const result = await harness.service.rejectVerification(request);

  assert.equal(result.verificationCase.status, 'rejected');
  assert.equal(result.verificationCase.decidedAt, request.decidedAt);
  assert.equal(
    result.verificationCase.achievedLevel,
    'none',
    'rejection closes the case; the level it reached is still true',
  );
  assert.equal(result.record, null, 'no level record: the level did not change');

  // The regression this test exists for: a rejection that emitted nothing would leave a refusal
  // visible only in a status column nobody is subscribed to.
  assert.deepEqual(eventTypes(harness.repository), [
    'verification.started',
    'verification.evidence_submitted',
    'verification.rejected',
  ]);
  assert.equal(entriesOfKind(harness.repository, 'audit').length, 3);

  const rejected = entriesOfKind(harness.repository, 'event').at(-1)?.payload as {
    payload: Record<string, unknown>;
  };
  assert.deepEqual(rejected.payload, {
    case_id: caseId,
    account_id: ACCOUNT,
    purpose: 'seller-onboarding',
    achieved_level: 'none',
    decided_at: request.decidedAt,
    reason: request.reason,
    idempotency_key: request.idempotencyKey,
  });
});

test('rejecting the same case twice at the same instant is a replay, not a second decision', async () => {
  const harness = build();
  const caseId = await openCase(harness);
  const request = rejectRequest(caseId);

  const first = await harness.service.rejectVerification(request);
  const second = await harness.service.rejectVerification(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(
    eventTypes(harness.repository).filter((type) => type === 'verification.rejected').length,
    1,
  );
});

test('rejecting an already-rejected case at a different instant is refused', async () => {
  const harness = build();
  const caseId = await openCase(harness);
  await harness.service.rejectVerification(rejectRequest(caseId));

  const code = await codeOf(() =>
    harness.service.rejectVerification(
      rejectRequest(caseId, { decidedAt: '2026-05-05T09:00:00Z' }),
    ),
  );
  assert.equal(code, 'case-not-open');
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('currentLevel is the highest level across the account’s approved cases', async () => {
  const harness = build();
  assert.equal(await harness.service.currentLevel(ACCOUNT), 'none');

  const basic = await openCase(harness, { purpose: 'buyer-checks', requestedLevel: 'basic' });
  await harness.service.evaluateLevel(evaluateRequest(basic, { level: 'basic' }));
  assert.equal(await harness.service.currentLevel(ACCOUNT), 'basic');

  const enhanced = await openCase(harness, {
    purpose: 'seller-onboarding',
    requestedLevel: 'enhanced',
  });
  await harness.service.evaluateLevel(enhancedRequest(enhanced));
  assert.equal(await harness.service.currentLevel(ACCOUNT), 'enhanced');

  // An unapproved case does not raise the account's level however far it got.
  const open = await openCase(harness, { purpose: 'host-checks', requestedLevel: 'full' });
  await harness.service.evaluateLevel(evaluateRequest(open, { level: 'standard' }));
  assert.equal(
    await harness.service.currentLevel(ACCOUNT),
    'enhanced',
    'a case still under way is not a level the platform has granted',
  );
});

function enhancedRequest(caseId: string): ReturnType<typeof evaluateRequest> {
  return evaluateRequest(caseId, { level: 'enhanced' });
}

test('currentLevel for an unknown account is none, not a refusal', async () => {
  const harness = build();
  assert.equal(await harness.service.currentLevel('acct_01HQZVZ0404'), 'none');
});

test('reads are scoped, sealed and return empty rather than refusing', async () => {
  const harness = build();
  const mine = await openCase(harness);
  await harness.service.startVerification(
    startRequest({ accountId: 'acct_01HQZVB0002', caseId: 'case_01HQZVB0002' }),
  );

  const cases = await harness.service.listCases(ACCOUNT);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.caseId, mine);

  assert.equal(await harness.service.getCase('case_01HQZVZ0404'), null);
  assert.deepEqual(await harness.service.listEvidence('case_01HQZVZ0404'), []);
  assert.deepEqual(await harness.service.getLevelHistory('case_01HQZVZ0404'), []);

  assert.throws(() => {
    (cases[0] as unknown as { status: string }).status = 'approved';
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Refusal by name
// ---------------------------------------------------------------------------

test('every field belonging to another unit is refused, by name, with its owner', async () => {
  const harness = build();

  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    const request = { ...startRequest(), [field]: 'anything' };
    const code = await codeOf(() => harness.service.startVerification(request));
    assert.equal(code, 'foreign-concern', `${field} was not refused as a foreign concern`);
    assert.match(
      owner,
      /K-\d\d|M-\d\d|profile core|document store/,
      `FOREIGN_FIELDS["${field}"] must name the unit that owns it, and says "${owner}"`,
    );
  }
});

test('M-01’s concern is refused by name: a capability is not a verification level', async () => {
  const harness = build();
  for (const field of ['capability', 'capabilities']) {
    assert.equal(
      await codeOf(() =>
        harness.service.startVerification({
          ...startRequest(),
          [field]: 'seller',
        }),
      ),
      'foreign-concern',
      `${field} must be refused: M-01 owns which roles an account holds, and M-02 and M-01 are the ` +
        'same layer',
    );
  }
});

test('a purpose that is not a vocabulary word is refused', async () => {
  const harness = build();
  for (const purpose of ['', 'Seller Onboarding', 'seller onboarding', 'x'.repeat(65), '9lives']) {
    assert.equal(
      await codeOf(() => harness.service.startVerification(startRequest({ purpose }))),
      'malformed-purpose',
      `"${purpose}" should be refused as a purpose`,
    );
  }
  await build().service.startVerification(startRequest({ purpose: 'business-purchaser-checks' }));
});

test('an unknown level, status and evidence kind are each refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.startVerification(startRequest({ requestedLevel: 'gold' }))),
    'unknown-level',
  );

  const caseId = await openCase(harness);
  assert.equal(
    await codeOf(() => harness.service.submitEvidence(evidenceRequest(caseId, { kind: 'vibes' }))),
    'unknown-evidence-kind',
  );

  assert.deepEqual(
    [...CASE_STATUSES],
    ['open', 'evidence-required', 'under-review', 'approved', 'rejected', 'withdrawn'],
    'the status vocabulary is closed, and the migration CHECK lists exactly these six',
  );
});

test('a reason or note that is empty, blank or too long is refused', async () => {
  for (const reason of ['', '   ', 'x'.repeat(501)]) {
    assert.equal(
      await codeOf(() => build().service.startVerification(startRequest({ reason }))),
      'malformed-reason',
      `reason of length ${reason.length} should be refused`,
    );
  }

  const harness = build();
  const caseId = await openCase(harness);
  for (const note of ['', '   ', 'x'.repeat(501)]) {
    const code = await codeOf(() =>
      harness.service.submitEvidence(evidenceRequest(caseId, { note })),
    );
    assert.match(code, /malformed-reason|malformed-record/, `note of length ${note.length}`);
  }
});

test('a malformed instant and a malformed identifier are each refused', async () => {
  const harness = build();
  assert.equal(
    await codeOf(() => harness.service.startVerification(startRequest({ openedAt: 'yesterday' }))),
    'malformed-instant',
  );
  assert.equal(
    await codeOf(() =>
      harness.service.startVerification(startRequest({ accountId: 'holder@example.com' })),
    ),
    'natural-identifier',
  );
  assert.equal(
    await codeOf(() => harness.service.startVerification(startRequest({ caseId: 'short' }))),
    'malformed-identifier',
  );
});

// ---------------------------------------------------------------------------
// Atomicity and determinism
// ---------------------------------------------------------------------------

test('a refused operation leaves no row and no outbox entry', async () => {
  const harness = build();

  await assert.rejects(() => harness.service.startVerification(startRequest({ reason: '' })));

  assert.deepEqual(await harness.service.listCases(ACCOUNT), []);
  assert.deepEqual(harness.repository.outbox().entries(), []);
});

test('outbox ids are unique per fact, so a case that changes twice does not collide', async () => {
  const harness = build();
  const caseId = await openCase(harness, { requestedLevel: 'full' });

  await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'basic' }));
  await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'standard' }));
  await harness.service.evaluateLevel(evaluateRequest(caseId, { level: 'full' }));

  const ids = harness.repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two outbox entries share an id, so the second would be refused by outbox_pkey in PostgreSQL. ' +
      'Ids derive from the append-only record a fact produced, never from the case id alone',
  );
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the caller supplies every identifier and every instant; a clock read here would make a ' +
      'replayed request produce a different record',
  );
});
