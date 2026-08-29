/**
 * K-11 Commerce Unit Registry — what the service believes about the store (FND-005c).
 *
 * The repository is an **injected port**. The PostgreSQL adapter validates what it decodes and the
 * in-memory one enforces the same uniqueness a server would, but neither of those is what the
 * service is written against: it is written against an interface, and a deployment supplies the
 * implementation. So this file asks the question the adapter tests cannot — *what does the service
 * do when the repository lies to it?*
 *
 * The answer matters because of what the in-force set is. It is the claim about which definition
 * describes every listing on the platform, and the service turns it into a map that the ancestry
 * walk, the effective-window check and the risk-pack pin all read without re-deriving anything. A
 * `new Map(rows.map(…))` believed every row, and each way of lying to it produced a *successful*
 * answer rather than an error:
 *
 *   - an unvalidated version row is a category nobody registered, copied into every listing
 *     created under it;
 *   - an activation paired with a version it does not name files one category's definition under
 *     another's name — and the type that should have been there disappears from the set, which
 *     reads back as `no-such-type`, a category that was never registered;
 *   - two rows for one key are resolved by `Map.set` keeping the last, so which of two definitions
 *     described a listing depends on row order;
 *   - one activation or one version appearing twice is a history nothing can be resolved against.
 *
 * Every case here is run through **both** paths that build the map — `resolve`, on the read side,
 * and `activate`, which walks the lineage against what is in force before it writes — because a
 * boundary enforced on one of them is a boundary with a way round it. The activation cases also
 * assert that nothing was written: a malformed store must refuse the write, not half-do it.
 *
 * The malicious repository is a wrapper, not a stub. Every other operation runs against the real
 * in-memory store, so each test publishes and activates through the genuine service first and the
 * lie is confined to one method — otherwise a refusal would prove only that a broken double is
 * broken.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  CommerceUnitRegistryService,
  InMemoryCommerceUnitRepository,
  type CommerceUnitRepository,
  type CommerceUnitTransaction,
  type UnitTypeActivation,
  type UnitTypeVersion,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  BRANCH,
  FixedClock,
  LEAF,
  PLATFORM_REGISTRAR,
  ROOT,
  StubConfiguration,
  StubPolicy,
  nextId,
  publishRequest,
} from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

/** One row of the in-force set, as the port declares it. */
type InForceRow = { readonly activation: UnitTypeActivation; readonly version: UnitTypeVersion };

/** Nothing is being tampered with: the real store answers. */
const HONEST = Symbol('honest');

/**
 * A repository that answers `listInForce` with whatever a test tells it to.
 *
 * Every other method delegates to a real `InMemoryCommerceUnitRepository`, so publication,
 * activation, retirement, idempotency and the activation guard all behave exactly as they do
 * anywhere else. One method lies, which is the shape a real fault takes: a restored dump, a
 * migration run half-way, an adapter somebody wrote against the port later.
 */
class TamperingRepository implements CommerceUnitRepository {
  readonly store = new InMemoryCommerceUnitRepository();
  #answer: unknown = HONEST;

  /** Answer the next in-force reads with this, whatever it is. */
  answerInForceWith(rows: unknown): void {
    this.#answer = rows;
  }

  /** The rows the real store would return, for a test that wants to corrupt genuine records. */
  genuineInForce(): Promise<readonly InForceRow[]> {
    return this.store.withTransaction((tx) => tx.listInForce());
  }

  withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T> {
    return this.store.withTransaction((tx) => body(this.#wrap(tx)));
  }

  #wrap(tx: CommerceUnitTransaction): CommerceUnitTransaction {
    const answer = this.#answer;
    return {
      findVersionById: (id) => tx.findVersionById(id),
      findVersionByIdempotencyKey: (key) => tx.findVersionByIdempotencyKey(key),
      highestVersion: (key) => tx.highestVersion(key),
      insertVersion: (version) => tx.insertVersion(version),
      findCurrentActivation: (key) => tx.findCurrentActivation(key),
      findActivationByIdempotencyKey: (key) => tx.findActivationByIdempotencyKey(key),
      insertActivation: (activation) => tx.insertActivation(activation),
      findRetirement: (key) => tx.findRetirement(key),
      findRetirementByIdempotencyKey: (key) => tx.findRetirementByIdempotencyKey(key),
      insertRetirement: (retirement) => tx.insertRetirement(retirement),
      insertOutbox: (entry) => tx.insertOutbox(entry),
      listInForce: () =>
        answer === HONEST
          ? tx.listInForce()
          : // The lie, typed as the port declares it. Nothing else in the repository can produce
            // this value, which is the whole point: the service may not assume otherwise.
            Promise.resolve(answer as readonly InForceRow[]),
    };
  }
}

interface Scenario {
  readonly repository: TamperingRepository;
  readonly service: CommerceUnitRegistryService;
  /** The genuine in-force rows: goods and goods.electronics, both activated for real. */
  readonly rows: readonly InForceRow[];
  /** A published version of goods.electronics.mobile-phone that nothing has activated yet. */
  readonly pendingVersionId: string;
}

/**
 * Two activated types and one published-but-not-activated version.
 *
 * The pending version is what gives the activation path something real to do: `activate` reads the
 * version, checks the retirement, then builds the in-force map to walk the lineage — so a test can
 * arm the lie and know the map is reached before anything is written.
 */
async function scenario(): Promise<Scenario> {
  const repository = new TamperingRepository();
  const service = new CommerceUnitRegistryService({
    repository,
    clock: new FixedClock(),
    configuration: new StubConfiguration(),
    policy: new StubPolicy(),
    registrar: PLATFORM_REGISTRAR,
  });

  for (const [typeKey, parentTypeKey] of [
    [ROOT, null],
    [BRANCH, ROOT],
  ] as const) {
    const published = await service.publish(publishRequest({ typeKey, parentTypeKey }));
    await service.activate({
      activationId: nextId('act'),
      typeVersionId: published.version.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    });
  }

  const pending = await service.publish(publishRequest({ typeKey: LEAF, parentTypeKey: BRANCH }));
  const rows = await repository.genuineInForce();
  assert.equal(rows.length, 2, 'the fixture must start from a store that is not already broken');

  return { repository, service, rows, pendingVersionId: pending.version.typeVersionId };
}

const activatePending = (found: Scenario): Promise<unknown> =>
  found.service.activate({
    activationId: nextId('act'),
    typeVersionId: found.pendingVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

/** A lie, and what the service must say about it. */
interface Tamper {
  readonly why: string;
  readonly forge: (rows: readonly InForceRow[]) => unknown;
  readonly code: string;
  readonly says: RegExp;
}

const rowOf = (rows: readonly InForceRow[], typeKey: string): InForceRow => {
  const found = rows.find((row) => row.version.typeKey === typeKey);
  assert.ok(found !== undefined, `the fixture has no row for ${typeKey}`);
  return found;
};

const TAMPERS: readonly Tamper[] = [
  {
    why: 'a version row this component did not write',
    forge: (rows) => {
      const row = rowOf(rows, ROOT);
      return [{ ...row, version: { ...row.version, requestFingerprint: 'not-a-hash' } }];
    },
    code: 'malformed-record',
    says: /requestFingerprint|was not written by this component/,
  },
  {
    why: 'a version whose kind is not one of v3 §11’s ten',
    forge: (rows) => {
      const row = rowOf(rows, ROOT);
      return [{ ...row, version: { ...row.version, kind: 'crypto-token' } }];
    },
    code: 'unsupported-kind',
    says: /was not written by this component/,
  },
  {
    why: 'an activation an agent authored',
    forge: (rows) => {
      const row = rowOf(rows, ROOT);
      return [
        { ...row, activation: { ...row.activation, activatedBy: { kind: 'ai', id: 'agent-01' } } },
      ];
    },
    code: 'malformed-record',
    says: /No agent registers a commerce unit type/,
  },
  {
    why: 'a pair whose halves name different versions',
    // Both halves are genuine records, straight out of the store and individually valid. Only the
    // pairing is a lie, which is the case a per-record validator cannot see.
    forge: (rows) => [
      { activation: rowOf(rows, ROOT).activation, version: rowOf(rows, BRANCH).version },
    ],
    code: 'malformed-record',
    says: /paired with version/,
  },
  {
    why: 'a pair whose halves name different types',
    forge: (rows) => {
      const root = rowOf(rows, ROOT);
      return [{ activation: { ...root.activation, typeKey: BRANCH }, version: root.version }];
    },
    code: 'malformed-record',
    says: /another one’s definition/,
  },
  {
    why: 'two rows for one type key',
    // Two different versions of goods, both claiming to be in force. Each row is a well-formed
    // pair — the second is a root type in its own right — so nothing but the set itself is wrong.
    forge: (rows) => {
      const root = rowOf(rows, ROOT);
      const branch = rowOf(rows, BRANCH);
      return [
        root,
        {
          activation: { ...branch.activation, typeKey: ROOT },
          version: { ...branch.version, typeKey: ROOT, parentTypeKey: null },
        },
      ];
    },
    code: 'malformed-record',
    says: /appears twice in the in-force set/,
  },
  {
    why: 'one activation putting two versions in force',
    forge: (rows) => {
      const root = rowOf(rows, ROOT);
      const branch = rowOf(rows, BRANCH);
      return [
        root,
        {
          ...branch,
          activation: { ...branch.activation, activationId: root.activation.activationId },
        },
      ];
    },
    code: 'malformed-record',
    says: /activation .* appears twice/,
  },
  {
    why: 'one version in force for two type keys',
    forge: (rows) => {
      const root = rowOf(rows, ROOT);
      const branch = rowOf(rows, BRANCH);
      return [
        root,
        {
          activation: { ...branch.activation, typeVersionId: root.version.typeVersionId },
          version: { ...root.version, typeKey: BRANCH },
        },
      ];
    },
    code: 'malformed-record',
    says: /in force for .* and for .* at once/,
  },
  {
    why: 'a row that is not a row',
    forge: () => [null],
    code: 'malformed-record',
    says: /holds null where a version and the activation putting it in force belong/,
  },
  {
    why: 'an in-force set that is not a list',
    forge: () => ({ goods: 'in force, trust me' }),
    code: 'malformed-record',
    says: /not a list of rows/,
  },
];

// ---------------------------------------------------------------------------
// The control: the wrapper itself changes nothing
// ---------------------------------------------------------------------------

test('through the wrapper, an untampered store resolves and activates exactly as before', async () => {
  const found = await scenario();

  const resolved = await found.service.resolve({ typeKey: BRANCH });
  assert.equal(resolved.typeKey, BRANCH);
  assert.deepEqual(resolved.ancestry, [ROOT], 'the lineage is walked, not asserted');

  await activatePending(found);
  const leaf = await found.service.resolve({ typeKey: LEAF });
  assert.deepEqual(leaf.ancestry, [BRANCH, ROOT], 'three levels, from the parent outwards');
  assert.equal(found.repository.store.activations().length, 3);
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

for (const tamper of TAMPERS) {
  test(`resolve refuses ${tamper.why}`, async () => {
    const found = await scenario();
    found.repository.answerInForceWith(tamper.forge(found.rows));

    const error = await found.service.resolve({ typeKey: ROOT }).then(
      (resolved) => assert.fail(`resolve answered with ${JSON.stringify(resolved)}`),
      (thrown: unknown) => thrown,
    );

    assert.equal(codeOf(error), tamper.code);
    assert.match(error instanceof Error ? error.message : '', tamper.says);
  });
}

test('a mismatched pair is refused, and never reported as a category nobody registered', async () => {
  // The failure this replaces, stated as the thing a caller would have acted on: the map was keyed
  // by the *version's* type key, so a pair claiming to be goods while carrying goods.electronics'
  // definition filed the entry under goods.electronics — and goods, which is genuinely in force,
  // was absent. `no-such-type` is a true-sounding answer meaning "never registered", and every
  // listing already created under goods holds a version id that says otherwise.
  const found = await scenario();
  const root = rowOf(found.rows, ROOT);
  found.repository.answerInForceWith([
    { activation: { ...root.activation, typeKey: BRANCH }, version: root.version },
  ]);

  const error = await found.service.resolve({ typeKey: ROOT }).then(
    () => assert.fail('a mismatched pair resolved'),
    (thrown: unknown) => thrown,
  );

  assert.equal(codeOf(error), 'malformed-record');
  assert.notEqual(codeOf(error), 'no-such-type');
});

// ---------------------------------------------------------------------------
// The write path, which walks the same set before it writes
// ---------------------------------------------------------------------------

for (const tamper of TAMPERS) {
  test(`activation refuses ${tamper.why}, and writes nothing`, async () => {
    const found = await scenario();
    const before = found.repository.store.activations().length;
    found.repository.answerInForceWith(tamper.forge(found.rows));

    const error = await activatePending(found).then(
      (result) => assert.fail(`activation succeeded: ${JSON.stringify(result)}`),
      (thrown: unknown) => thrown,
    );

    assert.equal(codeOf(error), tamper.code);
    assert.match(error instanceof Error ? error.message : '', tamper.says);
    // A malformed store refuses the write outright. `malformed-record` is deliberately not one of
    // the codes `#write` converges on: a retry against a store that contradicts itself must not
    // be handed back somebody else's activation as though it were its own.
    assert.equal(
      found.repository.store.activations().length,
      before,
      'an activation landed despite the in-force set being refused',
    );
    assert.equal(found.repository.store.transactionsRolledBack, 1);
  });
}

// ---------------------------------------------------------------------------
// What the boundary must not have broken
// ---------------------------------------------------------------------------

test('the refusal is about the set, not about the type being asked for', async () => {
  // The tampered row names goods.electronics; the question is about goods. Validating only the row
  // the caller asked about would let a corrupt neighbour sit in the set — and the ancestry walk
  // reads neighbours, which is exactly how a lineage picks up a definition nobody registered.
  const found = await scenario();
  const branch = rowOf(found.rows, BRANCH);
  found.repository.answerInForceWith([
    rowOf(found.rows, ROOT),
    { ...branch, version: { ...branch.version, requestFingerprint: 'not-a-hash' } },
  ]);

  await assert.rejects(
    found.service.resolve({ typeKey: ROOT }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('a store that answers honestly still walks a three-level lineage after activation', async () => {
  // Every check added at this boundary is on the path of every listing read. This is the case that
  // would notice if one of them started refusing a set that is merely large or merely deep.
  const found = await scenario();
  found.repository.answerInForceWith(await found.repository.genuineInForce());

  await assert.rejects(
    found.service.resolve({ typeKey: LEAF }),
    (error: unknown) => codeOf(error) === 'no-such-type',
    'the pending version is published and not activated, so it is not in force',
  );

  found.repository.answerInForceWith(HONEST);
  await activatePending(found);
  assert.deepEqual((await found.service.resolve({ typeKey: LEAF })).ancestry, [BRANCH, ROOT]);
});
