/**
 * K-13 AI Gateway — graduated authority and the kill switch.
 *
 * The claim under test is narrow and worth stating precisely, because the surrounding architecture
 * makes a broader one easy to imagine and wrong to believe.
 *
 * K-13 executes models. It does not execute business actions, and it cannot: the financial authority
 * zone is forbidden from importing it at all, enforced by `npm run check:boundaries`. So what an
 * authority model can honestly promise here is a **ceiling**: a task runs only at a level a human
 * granted it, only while it is not suspended, and the level it ran under is recorded on the run.
 *
 * What a caller does with a level-3 answer is the caller's contract to keep. These tests pin down the
 * part K-13 can actually enforce, and one of them pins down the part it cannot, so nobody reads more
 * into the gate than it does.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AIGatewayError,
  AIGatewayService,
  AUTHORITY_LEVELS,
  AUTHORITY_MEANINGS,
  InMemoryAIGatewayRepository,
} from '../kernel/ai-gateway/index.ts';

import {
  executeTaskRequest,
  grantAuthorityRequest,
  registerModelRequest,
  registerTaskRequest,
  resolveMockProvider,
} from './helpers/ai-gateway-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AIGatewayError ? error.code : undefined;

function service(): AIGatewayService {
  return new AIGatewayService(new InMemoryAIGatewayRepository(), resolveMockProvider);
}

/** A registered task and a capable binding, with no authority granted to it yet. */
async function unauthorisedTask(svc: AIGatewayService): Promise<string> {
  const task = await svc.registerTask(registerTaskRequest());
  await svc.registerModel(registerModelRequest());
  return task.task.taskId;
}

// ---------------------------------------------------------------------------
// The scale itself
// ---------------------------------------------------------------------------

test('the scale is ordinal, contiguous and named end to end', () => {
  assert.deepEqual([...AUTHORITY_LEVELS], [0, 1, 2, 3, 4]);
  for (const level of AUTHORITY_LEVELS) {
    assert.equal(
      typeof AUTHORITY_MEANINGS[level],
      'string',
      `level ${level} must have a name, or a refusal cannot say what was refused`,
    );
  }
  assert.equal(AUTHORITY_MEANINGS[0], 'observe');
  assert.equal(AUTHORITY_MEANINGS[4], 'manage-with-exceptions');
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a task nobody has granted anything does not run, even at level 0', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);

  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: 0 })),
    (error: unknown) => codeOf(error) === 'no-authority-grant',
    'observing is still doing something; an ungranted task does not get to do it',
  );
});

test('a task runs at or below its ceiling', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 2 }));

  for (const level of [0, 1, 2] as const) {
    const result = await svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: level }));
    assert.equal(result.run.authorityLevel, level);
  }
});

test('a task refuses to run above its ceiling', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 2 }));

  for (const level of [3, 4] as const) {
    await assert.rejects(
      svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: level })),
      (error: unknown) => codeOf(error) === 'authority-exceeded',
      `level ${level} is above the granted ceiling of 2 and must be refused`,
    );
  }
});

test('the refusal names both levels, so an operator can see the gap without reading code', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 1 }));

  await assert.rejects(
    svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: 4 })),
    (error: unknown) =>
      error instanceof AIGatewayError &&
      /level 4/.test(error.message) &&
      /manage-with-exceptions/.test(error.message) &&
      /level 1/.test(error.message) &&
      /recommend/.test(error.message),
  );
});

test('an authority level outside the scale is refused before anything runs', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 4 }));

  for (const level of [-1, 5, 1.5]) {
    await assert.rejects(
      svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: level as unknown as 0 })),
      (error: unknown) => codeOf(error) === 'invalid-authority-level',
      `${level} is not on the scale`,
    );
  }
});

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

test('a suspended task refuses every level, including observe', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 4 }));

  // The kill switch is a new version, not an edit.
  await svc.grantAuthority(
    grantAuthorityRequest({
      taskId,
      maxAuthority: 4,
      suspended: true,
      rationale: 'Producing wrong interpretations in production.',
      grantedAt: '2026-04-01T11:30:00Z',
    }),
  );

  for (const level of AUTHORITY_LEVELS) {
    await assert.rejects(
      svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: level })),
      (error: unknown) => codeOf(error) === 'authority-suspended',
      `a suspended task must refuse level ${level}`,
    );
  }
});

test('suspension can be lifted by a later grant, and the task runs again', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 3, suspended: true }));
  await svc.grantAuthority(
    grantAuthorityRequest({
      taskId,
      maxAuthority: 3,
      suspended: false,
      rationale: 'Fixed and re-reviewed.',
      grantedAt: '2026-04-01T11:45:00Z',
    }),
  );

  const result = await svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: 3 }));
  assert.equal(result.run.authorityLevel, 3);
});

// ---------------------------------------------------------------------------
// Grants are versions
// ---------------------------------------------------------------------------

test('the grant in force is the latest one at or before the instant, not the newest overall', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);

  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 1, grantedAt: '2026-04-01T10:00:00Z' }),
  );
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 4, grantedAt: '2026-04-01T14:00:00Z' }),
  );

  const early = await svc.resolveAuthority(taskId, '2026-04-01T12:00:00Z');
  const late = await svc.resolveAuthority(taskId, '2026-04-01T15:00:00Z');
  assert.equal(early?.maxAuthority, 1, 'at noon only the 10:00 grant had happened');
  assert.equal(late?.maxAuthority, 4);

  const before = await svc.resolveAuthority(taskId, '2026-04-01T09:00:00Z');
  assert.equal(before, null, 'before the first grant, nothing was permitted');
});

test('a run is gated by the grant in force when it started, not by the newest grant', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 1, grantedAt: '2026-04-01T10:00:00Z' }),
  );
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 4, grantedAt: '2026-04-01T14:00:00Z' }),
  );

  // A run that started at noon is governed by the 10:00 ceiling of 1.
  await assert.rejects(
    svc.executeTask(
      executeTaskRequest({
        taskId,
        requestedAuthority: 3,
        startedAt: '2026-04-01T12:00:00Z',
        finishedAt: '2026-04-01T12:00:01Z',
      }),
    ),
    (error: unknown) => codeOf(error) === 'authority-exceeded',
  );
});

test('raising a ceiling does not rewrite the grant that was in force before it', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  const first = await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 1, grantedAt: '2026-04-01T10:00:00Z' }),
  );
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 4, grantedAt: '2026-04-01T14:00:00Z' }),
  );

  const asItWas = await svc.resolveAuthority(taskId, '2026-04-01T13:59:59Z');
  assert.equal(asItWas?.authorityId, first.authority.authorityId);
  assert.equal(asItWas?.maxAuthority, 1);
});

test('a grant must explain itself', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);

  for (const bad of ['', '   ']) {
    await assert.rejects(
      svc.grantAuthority(grantAuthorityRequest({ taskId, rationale: bad })),
      (error: unknown) => codeOf(error) === 'malformed-record',
      'a grant nobody explained is a grant nobody can review',
    );
  }
});

test('authority cannot be granted to a task that does not exist', async () => {
  const svc = service();
  await assert.rejects(
    svc.grantAuthority(grantAuthorityRequest({ taskId: 'need.nothing_answers' })),
    (error: unknown) => codeOf(error) === 'no-such-task',
  );
});

test('granting is idempotent for an identical request, and refuses a changed one', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  const request = grantAuthorityRequest({ taskId, maxAuthority: 2 });

  const first = await svc.grantAuthority(request);
  const second = await svc.grantAuthority(request);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.authority.authorityId, second.authority.authorityId);

  await assert.rejects(
    svc.grantAuthority({ ...request, maxAuthority: 4 }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'a retry that quietly raises the ceiling is the failure mode this guards',
  );
});

test('a grant id cannot be reused for different content', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  const authorityId = 'auth_01HQZXFIXEDID1';

  await svc.grantAuthority(grantAuthorityRequest({ taskId, authorityId, maxAuthority: 1 }));
  await assert.rejects(
    svc.grantAuthority(grantAuthorityRequest({ taskId, authorityId, maxAuthority: 4 })),
    (error: unknown) => codeOf(error) === 'duplicate-authority-id',
  );
});

// ---------------------------------------------------------------------------
// What the run records
// ---------------------------------------------------------------------------

test('the run records the level it ran under, and a later grant does not change it', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(
    grantAuthorityRequest({ taskId, maxAuthority: 2, grantedAt: '2026-04-01T10:00:00Z' }),
  );

  const result = await svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: 2 }));
  assert.equal(result.run.authorityLevel, 2);

  // The ceiling comes down afterwards. The run still says what it was allowed to do at the time.
  await svc.grantAuthority(
    grantAuthorityRequest({
      taskId,
      maxAuthority: 0,
      rationale: 'Restricted after review.',
      grantedAt: '2026-04-01T16:00:00Z',
    }),
  );

  const stored = await svc.executeTask(
    executeTaskRequest({
      taskId,
      runId: result.run.runId,
      input: result.run.input,
      startedAt: result.run.startedAt,
      finishedAt: result.run.finishedAt,
      correlationId: result.run.correlationId,
      idempotencyKey: result.run.idempotencyKey,
      requestedAuthority: 2,
    }),
  );
  assert.equal(stored.deduplicated, true);
  assert.equal(stored.run.authorityLevel, 2, 'history is not rewritten by a later restriction');
});

test('the authority grant is emitted to the outbox as both an event and an audit record', async () => {
  const repository = new InMemoryAIGatewayRepository();
  const svc = new AIGatewayService(repository, resolveMockProvider);
  const task = await svc.registerTask(registerTaskRequest());
  await svc.grantAuthority(grantAuthorityRequest({ taskId: task.task.taskId, maxAuthority: 3 }));

  const entries = repository.outbox().entries();
  const events = entries.filter((entry) => entry.kind === 'event');
  const audits = entries.filter((entry) => entry.kind === 'audit');
  assert.equal(events.length, 1);
  assert.equal(audits.length, 1);

  const audit = audits[0]?.payload as { readonly evidence: Record<string, unknown> };
  assert.equal(audit.evidence.max_authority, 3);
  assert.equal(audit.evidence.suspended, false);
  assert.equal(
    audit.evidence.rationale,
    'Test fixture grant.',
    'the reason travels with the record, or the audit cannot answer why',
  );
});

test('a grant returned by the service is frozen', async () => {
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  const { authority } = await svc.grantAuthority(grantAuthorityRequest({ taskId }));
  assert.ok(Object.isFrozen(authority));
});

// ---------------------------------------------------------------------------
// The limit of the claim
// ---------------------------------------------------------------------------

test('the gate caps what a task may be invoked at; it does not police what the caller then does', async () => {
  // Pinned deliberately. K-13 hands back an answer and a recorded level. Nothing in K-13 can stop a
  // caller acting on a level-1 recommendation as though it were a level-3 instruction, and no test
  // here should be read as claiming otherwise. What makes that safe is elsewhere: the financial
  // authority zone cannot import K-13 at all, which `npm run check:boundaries` enforces.
  const svc = service();
  const taskId = await unauthorisedTask(svc);
  await svc.grantAuthority(grantAuthorityRequest({ taskId, maxAuthority: 1 }));

  const result = await svc.executeTask(executeTaskRequest({ taskId, requestedAuthority: 1 }));

  assert.equal(result.run.authorityLevel, 1);
  assert.equal(result.run.status, 'success');
  assert.ok(
    Object.keys(result.run.output).length > 0,
    'a level-1 run still returns a usable answer — the level is a record, not a redaction',
  );
});
