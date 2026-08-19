/**
 * K-02 against a live PostgreSQL server (FND-004c) — opt-in, and honestly skipped otherwise.
 *
 * Everything else about K-02 is proved against an injected repository, including the races: the
 * in-memory reference implementation checks uniqueness at commit against the store as it stands,
 * precisely so those proofs mean something. What it cannot do is be PostgreSQL. Five claims are
 * claims *about the server*:
 *
 *   - that **no column can hold a secret** — the `token_hash` `CHECK` refuses a raw session secret,
 *     and a full sign-in, rotation and revocation leaves neither the presented token nor the
 *     verifier's proof material anywhere in any row of any of the three tables;
 *   - that the guarded updates are guarded **by the `WHERE` clause and not by a read**, so two
 *     rotations racing on one connection pool have exactly one winner and the loser is refused;
 *   - that the write-once triggers refuse what the port has no operation for: rewriting a binding
 *     or an evidence row, deleting a session, rotating a revoked session back into use, or
 *     rewriting a revocation that already happened;
 *   - that a failed transaction leaves **neither** the evidence nor the session — an evidence row
 *     with no session would consume an assertion and hand back nothing;
 *   - that an enlisted write commits and rolls back with the caller's transaction while being
 *     unable to control it.
 *
 * The K-01 dependency is wired to the **real** `IdentityService` on the same server, so the
 * subject a binding names is one K-01 actually recorded rather than one a stub agreed to.
 *
 * Everything here runs inside the guarded derived `_test` database created and dropped by the
 * harness. The development database is configuration input only, and is asserted untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticationService,
  BINDING_TABLE,
  EVIDENCE_TABLE,
  PostgresAuthenticationRepository,
  ProviderRegistry,
  SESSION_TABLE,
  enlistedClient,
  hashToken,
  type AuthenticationBinding,
  type AuthenticationError,
} from '../../kernel/authentication/index.ts';
import { IdentityService, PostgresIdentityRepository } from '../../kernel/identity/index.ts';
import type { Database } from '../../platform/db/client.ts';
import { migrateUp } from '../../platform/db/runner.ts';

import {
  BINDING_REFERENCE,
  FixedClock,
  PROVIDER,
  SequenceEntropy,
  StubVerifier,
  authenticateRequest,
  bindRequest,
} from '../helpers/authentication-fixtures.ts';
import { createRequest } from '../helpers/identity-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

const codeOf = (error: unknown): string | undefined => {
  const candidate = error as Partial<AuthenticationError> | null;
  return typeof candidate?.code === 'string' ? candidate.code : undefined;
};

/**
 * The proof handed to the verifier, and the one string that must never appear in the database.
 *
 * Distinctive on purpose: the scan below looks for it in every column of every row, and a value
 * that could plausibly be part of an identifier would make a pass meaningless.
 */
const PROOF_MATERIAL = 'raw-proof-material-that-must-never-be-persisted';

/** Instants carry microseconds so a value written and read back compares character for character. */
const NOW = '2026-04-01T12:00:00.123456Z';
const LATER = '2026-04-01T12:10:00.123456Z';

interface Wiring {
  readonly service: AuthenticationService;
  readonly clock: FixedClock;
  /** Kept so a test can ask what the verifier was actually asked, and how often. */
  readonly verifier: StubVerifier;
}

/** A real K-01 subject, and K-02 wired to the real K-01 service, both on this database. */
async function wire(database: Database, subjectId: string): Promise<Wiring> {
  const identity = new IdentityService(new PostgresIdentityRepository(database));
  await identity.create(
    createRequest({ subjectId, idempotencyKey: `idem_${subjectId.slice(-10)}` }),
  );

  const clock = new FixedClock(NOW);
  const entropy = new SequenceEntropy();
  const verifier = new StubVerifier({
    verifiedAt: '2026-04-01T11:59:30.654321Z',
    expiresAt: '2026-04-01T12:01:00.654321Z',
  });

  const service = new AuthenticationService({
    repository: new PostgresAuthenticationRepository(database),
    providers: new ProviderRegistry([
      {
        provider: PROVIDER,
        description: 'A stub provider used by the K-02 suites; verifies nothing in production.',
      },
    ]),
    verifiers: [verifier],
    subjects: identity,
    clock,
    entropy,
  });

  return { service, clock, verifier };
}

interface SignInIds {
  readonly subject: string;
  readonly binding: string;
  readonly evidence: string;
  readonly session: string;
  readonly key: string;
}

/** Bind, then authenticate, against the live schema. Returns the secret presented exactly once. */
async function signIn(
  wiring: Wiring,
  ids: SignInIds,
): Promise<{ sessionId: string; secret: string; assertionId: string }> {
  await wiring.service.bind(
    bindRequest({
      bindingId: ids.binding,
      subjectId: ids.subject,
      idempotencyKey: `${ids.key}-bind`,
    }),
  );
  const result = await wiring.service.authenticate(
    authenticateRequest({
      evidenceId: ids.evidence,
      sessionId: ids.session,
      idempotencyKey: ids.key,
      proof: { kind: 'opaque', material: PROOF_MATERIAL },
    }),
  );
  return {
    sessionId: result.session.sessionId,
    secret: result.token.reveal(),
    assertionId: result.evidence.assertionId,
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

/** Every row of a table, exactly as the server holds it — no projection, nothing filtered out. */
async function allRows(database: Database, table: string): Promise<readonly unknown[]> {
  const client = await database.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT * FROM ${table};`);
    return result.rows;
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

/** A binding an enlisted write can insert without going near the service. */
function bindingFor(suffix: string): AuthenticationBinding {
  return {
    bindingId: `bind_01HQZXENLIST${suffix}`,
    subjectId: `sub_01HQZXENLIST${suffix}`,
    provider: PROVIDER,
    providerReference: `ref_01HQZXENLIST${suffix}`,
    createdAt: '2026-04-01T12:00:00Z',
    idempotencyKey: `idem_01HQZXENLIST${suffix}`,
  };
}

/** One session row, as columns rather than as a decoded record. */
async function sessionRowOf(
  database: Database,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const client = await database.connect();
  try {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${SESSION_TABLE} WHERE session_id = $1;`,
      [sessionId],
    );
    const row = result.rows[0];
    assert.ok(row !== undefined, `no session row for ${sessionId}`);
    return row;
  } finally {
    await client.release();
  }
}

// ---------------------------------------------------------------------------
// The schema holds what the component writes
// ---------------------------------------------------------------------------

test(
  'a binding, its evidence and its session survive the real schema exactly',
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

      const wiring = await wire(database, 'sub_01HQZXLIVE0001');
      const { sessionId, secret, assertionId } = await signIn(wiring, {
        subject: 'sub_01HQZXLIVE0001',
        binding: 'bind_01HQZXLIVE0001',
        evidence: 'evid_01HQZXLIVE0001',
        session: 'sess_01HQZXLIVE0001',
        key: 'idem_01HQZXLIVE0001',
      });

      assert.equal(await countRows(database, BINDING_TABLE), 1);
      assert.equal(await countRows(database, EVIDENCE_TABLE), 1);
      assert.equal(await countRows(database, SESSION_TABLE), 1);

      // The verifier decided, and the row records what it said rather than what anybody asked for.
      assert.equal(wiring.verifier.challenges.length, 1, 'the verifier was asked exactly once');
      assert.equal(wiring.verifier.challenges[0]?.providerReference, BINDING_REFERENCE);
      const evidenceRows = await allRows(database, EVIDENCE_TABLE);
      const evidenceRow = evidenceRows[0] as Record<string, unknown>;
      assert.equal(evidenceRow.assertion_id, assertionId);
      assert.equal(evidenceRow.provider, PROVIDER);
      assert.equal(evidenceRow.assurance, 'single-factor');
      assert.deepEqual(evidenceRow.factors, ['possession']);

      // Read back through the adapter's own decoder: microseconds survived the timestamptz column
      // rather than being rounded by the driver, and the hash is the hash of the one secret.
      const session = await wiring.service.findSession(sessionId);
      assert.equal(session?.issuedAt, NOW);
      assert.equal(session?.absoluteExpiresAt, '2026-04-02T00:00:00.123456Z');
      assert.equal(session?.idleExpiresAt, '2026-04-01T12:30:00.123456Z');
      assert.equal(session?.rotationCount, 0);
      assert.equal(session?.revokedAt, null);
      assert.equal(session?.tokenHash, hashToken(secret));
      assert.deepEqual([...(session?.factors ?? [])], ['possession']);

      // And the binding K-01's subject reaches.
      const bindings = await wiring.service.bindingsForSubject('sub_01HQZXLIVE0001');
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]?.bindingId, 'bind_01HQZXLIVE0001');
      assert.equal(bindings[0]?.providerReference, BINDING_REFERENCE);
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
  'no column anywhere holds the presented secret or the verifier’s proof',
  liveTestOptions,
  async () => {
    // The claim the whole component exists for, made against real storage rather than a fake: a
    // database read yields no usable token, and the proof material never arrived in the first
    // place. Every row of every table, every column, including the ones nothing projects.
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const wiring = await wire(database, 'sub_01HQZXLIVE0002');
      const { sessionId, secret } = await signIn(wiring, {
        subject: 'sub_01HQZXLIVE0002',
        binding: 'bind_01HQZXLIVE0002',
        evidence: 'evid_01HQZXLIVE0002',
        session: 'sess_01HQZXLIVE0002',
        key: 'idem_01HQZXLIVE0002',
      });

      wiring.clock.set(LATER);
      const rotated = await wiring.service.rotate({ sessionId, presentedToken: secret });
      const nextSecret = rotated.token.reveal();
      await wiring.service.revoke({ sessionId, reason: 'signed-out' });

      const dumped = JSON.stringify([
        await allRows(database, BINDING_TABLE),
        await allRows(database, EVIDENCE_TABLE),
        await allRows(database, SESSION_TABLE),
      ]);

      assert.ok(!dumped.includes(secret), 'the first session secret reached storage');
      assert.ok(!dumped.includes(nextSecret), 'the rotated session secret reached storage');
      assert.ok(!dumped.includes(PROOF_MATERIAL), 'the verifier’s proof material reached storage');
      // Fragments too: a truncated secret in a column is a shorter secret, not a safe one.
      assert.ok(!dumped.includes(secret.slice(0, 24)), 'a fragment of a session secret survived');
      assert.ok(!dumped.includes(PROOF_MATERIAL.slice(0, 24)), 'a fragment of the proof survived');

      // What is there instead: the hash of the secret that was current when the session ended.
      const row = await sessionRowOf(database, sessionId);
      assert.equal(row.token_hash, hashToken(nextSecret));
      assert.match(String(row.token_hash), /^[0-9a-f]{64}$/);
    });
  },
);

test('the schema refuses a raw secret in the hash column', liveTestOptions, async () => {
  // A `CHECK` rather than a convention: the column that would hold a stolen session if anything
  // ever wrote a secret to it cannot hold one, whatever writes it.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const columns =
      'session_id, binding_id, subject_id, evidence_id, assurance, factors, token_hash, ' +
      'issued_at, absolute_expires_at, idle_expires_at, rotation_count, revoked_at, ' +
      'revocation_reason, idempotency_key';
    const values = (tokenHash: string): string =>
      `'sess_01HQZXPROBE001', 'bind_01HQZXPROBE001', 'sub_01HQZXPROBE001', 'evid_01HQZXPROBE001', ` +
      `'single-factor', ARRAY['possession']::text[], '${tokenHash}', '2026-04-01T12:00:00Z', ` +
      `'2026-04-02T00:00:00Z', '2026-04-01T12:30:00Z', 0, NULL, NULL, 'idem_01HQZXPROBE001'`;
    const insert = (tokenHash: string): string =>
      `INSERT INTO ${SESSION_TABLE} (${columns}) VALUES (${values(tokenHash)});`;

    // 43 base64url characters: the shape of a secret this component issues.
    const rawSecret = 'S3cr3t-looking-value-that-is-forty-three-ch';
    const refusal = await refuses(database, insert(rawSecret));
    assert.ok(refusal !== null, 'a raw secret in token_hash must be refused by the database');
    assert.match(refusal, /token_is_hash|check constraint/i);
    assert.equal(await countRows(database, SESSION_TABLE), 0);

    // The same row with a real hash is accepted, so the refusal above was about the secret.
    assert.equal(await refuses(database, insert(hashToken(rawSecret))), null);
    assert.equal(await countRows(database, SESSION_TABLE), 1);
  });
});

// ---------------------------------------------------------------------------
// The session lifecycle, against the server
// ---------------------------------------------------------------------------

test(
  'a session validates, rotates and stops validating once revoked',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const wiring = await wire(database, 'sub_01HQZXLIVE0003');
      const { sessionId, secret } = await signIn(wiring, {
        subject: 'sub_01HQZXLIVE0003',
        binding: 'bind_01HQZXLIVE0003',
        evidence: 'evid_01HQZXLIVE0003',
        session: 'sess_01HQZXLIVE0003',
        key: 'idem_01HQZXLIVE0003',
      });

      const live = await wiring.service.validate(secret);
      assert.equal(live.sessionId, sessionId);

      wiring.clock.set(LATER);
      const rotated = await wiring.service.rotate({ sessionId, presentedToken: secret });
      const nextSecret = rotated.token.reveal();

      assert.notEqual(nextSecret, secret);
      assert.equal(rotated.session.rotationCount, 1);
      assert.equal(
        rotated.session.absoluteExpiresAt,
        '2026-04-02T00:00:00.123456Z',
        'the absolute expiry is the hard stop, and rotation never moves it',
      );
      assert.equal(rotated.session.idleExpiresAt, '2026-04-01T12:40:00.123456Z');

      const row = await sessionRowOf(database, sessionId);
      assert.equal(row.token_hash, hashToken(nextSecret));
      assert.equal(Number(row.rotation_count), 1);

      await wiring.service.validate(nextSecret);
      await assert.rejects(
        wiring.service.validate(secret),
        (error: unknown) => codeOf(error) === 'invalid-token',
        'the secret that was rotated away must stop working immediately',
      );

      const revoked = await wiring.service.revoke({ sessionId, reason: 'operator-revoked' });
      assert.equal(revoked.revokedAt, LATER);
      assert.equal(revoked.revocationReason, 'operator-revoked');

      const revokedRow = await sessionRowOf(database, sessionId);
      assert.notEqual(revokedRow.revoked_at, null);
      assert.equal(revokedRow.revocation_reason, 'operator-revoked');

      await assert.rejects(
        wiring.service.validate(nextSecret),
        (error: unknown) => codeOf(error) === 'session-revoked',
      );
      assert.equal(await countRows(database, SESSION_TABLE), 1, 'one session throughout');
    });
  },
);

test('a failed transaction leaves neither evidence nor session', liveTestOptions, async () => {
  // Evidence and session are written together on purpose: an evidence row with no session would
  // consume the assertion and hand back nothing. The rollback is the server's, not a bookkeeping
  // step in the reference implementation.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const repository = new PostgresAuthenticationRepository(database);

    await assert.rejects(
      repository.withTransaction(async (tx) => {
        await tx.insertEvidence({
          evidenceId: 'evid_01HQZXROLLBK1',
          bindingId: 'bind_01HQZXROLLBK1',
          subjectId: 'sub_01HQZXROLLBK1',
          provider: PROVIDER,
          assertionId: 'asrt_01HQZXROLLBK1',
          factors: ['possession'],
          assurance: 'single-factor',
          verifiedAt: '2026-04-01T11:59:30Z',
          recordedAt: '2026-04-01T12:00:00Z',
          idempotencyKey: 'idem_01HQZXROLLBK1',
        });
        await tx.insertSession({
          sessionId: 'sess_01HQZXROLLBK1',
          bindingId: 'bind_01HQZXROLLBK1',
          subjectId: 'sub_01HQZXROLLBK1',
          evidenceId: 'evid_01HQZXROLLBK1',
          assurance: 'single-factor',
          factors: ['possession'],
          tokenHash: hashToken('rollback-secret-that-is-forty-three-chars-x'),
          issuedAt: '2026-04-01T12:00:00Z',
          absoluteExpiresAt: '2026-04-02T00:00:00Z',
          idleExpiresAt: '2026-04-01T12:30:00Z',
          rotationCount: 0,
          revokedAt: null,
          revocationReason: null,
          idempotencyKey: 'idem_01HQZXROLLBK1',
        });
        throw new Error('something went wrong after both rows were written');
      }),
      /something went wrong/,
    );

    assert.equal(await countRows(database, EVIDENCE_TABLE), 0, 'the ROLLBACK reached the server');
    assert.equal(await countRows(database, SESSION_TABLE), 0, 'and took the session with it');
  });
});

test(
  'an enlisted write commits and rolls back with the caller, and cannot control the transaction',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      // Committed together.
      const committing = await database.connect();
      try {
        await committing.query('BEGIN;');
        await PostgresAuthenticationRepository.enlist(committing).withTransaction((tx) =>
          tx.insertBinding(bindingFor('01')),
        );
        await committing.query('COMMIT;');
      } finally {
        await committing.release();
      }
      assert.equal(await countRows(database, BINDING_TABLE), 1);

      // Rolled back together: the caller's ROLLBACK must undo the enlisted write.
      const rolling = await database.connect();
      try {
        await rolling.query('BEGIN;');
        await PostgresAuthenticationRepository.enlist(rolling).withTransaction((tx) =>
          tx.insertBinding(bindingFor('02')),
        );
        await rolling.query('ROLLBACK;');
      } finally {
        await rolling.release();
      }
      assert.equal(
        await countRows(database, BINDING_TABLE),
        1,
        "the caller's rollback undid the enlisted write",
      );

      // And the transaction is not the enlisted path's to end. A COMMIT issued through the guarded
      // client would commit rows its caller had not finished writing.
      const owned = await database.connect();
      try {
        await owned.query('BEGIN;');
        const guarded = enlistedClient(owned);
        for (const statement of ['BEGIN;', 'COMMIT;', 'ROLLBACK;', 'SAVEPOINT s1;']) {
          await assert.rejects(
            guarded.query(statement),
            (error: unknown) => codeOf(error) === 'nested-transaction',
            `an enlisted write may not issue ${statement}`,
          );
        }
        // The connection underneath is unharmed: the caller still owns its transaction.
        await PostgresAuthenticationRepository.enlist(owned).withTransaction((tx) =>
          tx.insertBinding(bindingFor('03')),
        );
        await owned.query('COMMIT;');
      } finally {
        await owned.release();
      }
      assert.equal(await countRows(database, BINDING_TABLE), 2);
    });
  },
);

// ---------------------------------------------------------------------------
// Races, decided by the server
// ---------------------------------------------------------------------------

test('two rotations of one session race, and exactly one wins', liveTestOptions, async () => {
  // The guard is the `WHERE` clause, so the loser's UPDATE matches no rows however the two
  // interleave. A guard evaluated by a read this transaction did earlier would let both through.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const wiring = await wire(database, 'sub_01HQZXLIVERACE');
    const { sessionId, secret } = await signIn(wiring, {
      subject: 'sub_01HQZXLIVERACE',
      binding: 'bind_01HQZXLIVERACE',
      evidence: 'evid_01HQZXLIVERACE',
      session: 'sess_01HQZXLIVERACE',
      key: 'idem_01HQZXLIVERACE',
    });

    const outcomes = await Promise.allSettled([
      wiring.service.rotate({ sessionId, presentedToken: secret }),
      wiring.service.rotate({ sessionId, presentedToken: secret }),
    ]);

    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    assert.equal(won.length, 1, 'two rotations of one secret cannot both succeed');
    assert.equal(lost.length, 1);
    assert.ok(
      ['stale-session-state', 'invalid-token'].includes(String(codeOf(lost[0]?.reason))),
      `the loser was refused with ${String(codeOf(lost[0]?.reason))} rather than failing closed`,
    );

    const row = await sessionRowOf(database, sessionId);
    assert.equal(Number(row.rotation_count), 1, 'the loser did not stack a second rotation on top');

    const winner = won[0];
    assert.ok(winner !== undefined && winner.status === 'fulfilled');
    const winningSecret = winner.value.token.reveal();
    assert.equal(row.token_hash, hashToken(winningSecret));
    const live = await wiring.service.validate(winningSecret);
    assert.equal(live.rotationCount, 1);
  });
});

test('two revocations race, and the first one is the one recorded', liveTestOptions, async () => {
  // Driven at the port, because the service converges a second revocation on the first. What is
  // being proved here is the layer underneath: `revoked_at IS NULL` in the `WHERE` means exactly
  // one UPDATE affects a row, so the instant and the reason cannot be rewritten by a late caller.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const wiring = await wire(database, 'sub_01HQZXLIVEREVO');
    const { sessionId } = await signIn(wiring, {
      subject: 'sub_01HQZXLIVEREVO',
      binding: 'bind_01HQZXLIVEREVO',
      evidence: 'evid_01HQZXLIVEREVO',
      session: 'sess_01HQZXLIVEREVO',
      key: 'idem_01HQZXLIVEREVO',
    });

    const repository = new PostgresAuthenticationRepository(database);
    const answers = await Promise.all([
      repository.withTransaction((tx) =>
        tx.revokeSession({ sessionId, revokedAt: NOW, reason: 'signed-out' }),
      ),
      repository.withTransaction((tx) =>
        tx.revokeSession({ sessionId, revokedAt: LATER, reason: 'operator-revoked' }),
      ),
    ]);

    assert.equal(
      answers.filter((answered) => answered).length,
      1,
      'exactly one revocation may affect a row; the other must be told it affected none',
    );

    const row = await sessionRowOf(database, sessionId);
    assert.notEqual(row.revoked_at, null);
    assert.ok(
      ['signed-out', 'operator-revoked'].includes(String(row.revocation_reason)),
      'the reason stored is one of the two that were attempted',
    );

    // A third revocation, after the fact, still changes nothing.
    const late = await repository.withTransaction((tx) =>
      tx.revokeSession({ sessionId, revokedAt: LATER, reason: 'security-event' }),
    );
    assert.equal(late, false);
    const unchanged = await sessionRowOf(database, sessionId);
    assert.equal(unchanged.revocation_reason, row.revocation_reason);
    assert.deepEqual(unchanged.revoked_at, row.revoked_at, 'a revocation is final');
  });
});

test(
  'the database refuses every change the port has no operation for',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const wiring = await wire(database, 'sub_01HQZXLIVE0004');
      const { sessionId, secret } = await signIn(wiring, {
        subject: 'sub_01HQZXLIVE0004',
        binding: 'bind_01HQZXLIVE0004',
        evidence: 'evid_01HQZXLIVE0004',
        session: 'sess_01HQZXLIVE0004',
        key: 'idem_01HQZXLIVE0004',
      });

      // Bindings and evidence are write-once. These are statements no code here can issue, which is
      // exactly the case the triggers exist for.
      for (const [why, sql] of [
        [
          'repointing a binding at another subject',
          `UPDATE ${BINDING_TABLE} SET subject_id = 'sub_01HQZXSOMEONE' WHERE binding_id = 'bind_01HQZXLIVE0004';`,
        ],
        [
          'deleting a binding',
          `DELETE FROM ${BINDING_TABLE} WHERE binding_id = 'bind_01HQZXLIVE0004';`,
        ],
        [
          'editing evidence',
          `UPDATE ${EVIDENCE_TABLE} SET assurance = 'hardware-backed' WHERE evidence_id = 'evid_01HQZXLIVE0004';`,
        ],
        [
          'deleting evidence',
          `DELETE FROM ${EVIDENCE_TABLE} WHERE evidence_id = 'evid_01HQZXLIVE0004';`,
        ],
      ] as const) {
        const refusal = await refuses(database, sql);
        assert.ok(refusal !== null, `${why} must be refused`);
        assert.match(refusal, /write-once/i, why);
      }

      // A session accepts two changes and no others.
      for (const [why, sql, expected] of [
        [
          'lengthening a session',
          `UPDATE ${SESSION_TABLE} SET absolute_expires_at = '2027-01-01T00:00:00Z' WHERE session_id = '${sessionId}';`,
          /immutable/i,
        ],
        [
          'repointing a session at another subject',
          `UPDATE ${SESSION_TABLE} SET subject_id = 'sub_01HQZXSOMEONE' WHERE session_id = '${sessionId}';`,
          /immutable/i,
        ],
        [
          'raising the assurance of a session',
          `UPDATE ${SESSION_TABLE} SET assurance = 'hardware-backed' WHERE session_id = '${sessionId}';`,
          /immutable/i,
        ],
        [
          'deleting a session',
          `DELETE FROM ${SESSION_TABLE} WHERE session_id = '${sessionId}';`,
          /never deleted/i,
        ],
      ] as const) {
        const refusal = await refuses(database, sql);
        assert.ok(refusal !== null, `${why} must be refused`);
        assert.match(refusal, expected, why);
      }

      // And once revoked, a session cannot be rotated back into use or re-revoked.
      await wiring.service.revoke({ sessionId, reason: 'security-event' });
      const rotatedBack = await refuses(
        database,
        `UPDATE ${SESSION_TABLE} SET token_hash = '${'a'.repeat(64)}' WHERE session_id = '${sessionId}';`,
      );
      assert.ok(rotatedBack !== null, 'a revoked session must not be rotated back into use');
      assert.match(rotatedBack, /revoked session cannot be rotated/i);

      const rewritten = await refuses(
        database,
        `UPDATE ${SESSION_TABLE} SET revoked_at = '2027-01-01T00:00:00Z' WHERE session_id = '${sessionId}';`,
      );
      assert.ok(rewritten !== null, 'a revocation may not be rewritten');
      assert.match(rewritten, /revocation is final/i);

      // The port agrees, without any of it having been a read-then-write.
      const repository = new PostgresAuthenticationRepository(database);
      const rotated = await repository.withTransaction((tx) =>
        tx.rotateSession({
          sessionId,
          expectedTokenHash: hashToken(secret),
          nextTokenHash: 'b'.repeat(64),
          nextIdleExpiresAt: '2026-04-01T13:00:00Z',
          nextRotationCount: 1,
        }),
      );
      assert.equal(rotated, false, 'rotating a revoked session affects no rows');
    });
  },
);
