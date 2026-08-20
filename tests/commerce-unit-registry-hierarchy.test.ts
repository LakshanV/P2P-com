/**
 * K-11 Commerce Unit Registry — the hierarchy, and the isolation rule (FND-005c).
 *
 * This file is about the failures a category tree produces silently.
 *
 * A **cycle** either never terminates or, with a naive visited-set, makes a type its own ancestor —
 * so a risk pack written for the parent matches the child that contains it. A **missing parent**
 * resolved as a root silently promotes a subcategory to a top-level one, which is how a rule
 * written for "electronics" stops applying to "mobile phones" with nothing in any log. A
 * **cross-tenant edge** lets one tenant's retirement stop a second tenant's listings, and neither
 * of them can see the relationship.
 *
 * None of those is a crash. Each produces a plausible answer that is wrong, which is why every one
 * of them is a refusal here rather than a best guess: everything downstream believes what a
 * registry says.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  MAX_DEPTH,
  resolveAncestry,
  type UnitTypeVersion,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  BRANCH,
  LEAF,
  OTHER_TENANT,
  ROOT,
  TENANT,
  build,
  nextId,
  publishRequest,
  tenantRegistrar,
  withActiveType,
  withLineage,
} from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

/** A bare version, for the pure cases that are about `hierarchy.ts` rather than the service. */
function version(typeKey: string, parentTypeKey: string | null): UnitTypeVersion {
  return {
    typeVersionId: `typever_01HQZX${typeKey.replace(/[^a-z]/g, '').slice(0, 6).padEnd(6, 'x')}`,
    typeKey,
    version: 1,
    kind: 'new-product',
    owner: { kind: 'platform' },
    parentTypeKey,
    measures: [{ family: 'goods', unit: 'each' }],
    riskPolicyKey: null,
    effectiveFrom: null,
    effectiveUntil: null,
    publishedAt: '2026-04-01T12:00:00Z',
    publishedBy: { kind: 'system', id: 'k11-registry-console' },
    idempotencyKey: `idem_01HQZX${typeKey.replace(/[^a-z]/g, '').slice(0, 8).padEnd(8, 'x')}`,
    requestFingerprint: 'a'.repeat(64),
  };
}

const lookupOf = (versions: readonly UnitTypeVersion[]) => (key: string) => {
  const found = versions.find((entry) => entry.typeKey === key);
  return found === undefined ? undefined : { version: found, riskPolicyVersionId: null };
};

// ---------------------------------------------------------------------------
// Ancestry
// ---------------------------------------------------------------------------

test('a lineage resolves from the immediate parent outwards to the root', async () => {
  const { harness } = await withLineage();

  const leaf = await harness.service.resolve({ typeKey: LEAF });
  assert.deepEqual(leaf.ancestry, [BRANCH, ROOT], 'nearest first, root last');
  assert.match(leaf.explanation, /depth 3/);
  assert.match(leaf.explanation, new RegExp(`${BRANCH} → ${ROOT}`));

  const branch = await harness.service.resolve({ typeKey: BRANCH });
  assert.deepEqual(branch.ancestry, [ROOT]);

  const root = await harness.service.resolve({ typeKey: ROOT });
  assert.deepEqual(root.ancestry, [], 'a root descends from nothing');
  assert.match(root.explanation, /a root type/);
});

test('a cycle is refused as a cycle, and names the path', async () => {
  // Pure, because the service refuses to activate the second half of a cycle — this proves the
  // resolver would catch one that reached the store by any other route.
  const cycle = [version(ROOT, LEAF), version(BRANCH, ROOT), version(LEAF, BRANCH)];

  assert.throws(
    () => resolveAncestry(cycle[2] as UnitTypeVersion, lookupOf(cycle), '2026-04-01T12:00:00Z'),
    (error: unknown) => {
      assert.equal(codeOf(error), 'hierarchy-cycle');
      assert.match((error as Error).message, /reaches .* twice/);
      assert.match((error as Error).message, /→/, 'the path is named, so it can be broken');
      return true;
    },
    'a type that is its own ancestor would match every rule written for what contains it',
  );
});

test('a type naming itself as its parent is refused as self-parenting, not as a cycle', async () => {
  // A distinct code, because the fix is different: a cycle needs somebody to work out which edge
  // to cut, and this needs one field corrected.
  const harness = build();
  await assert.rejects(
    harness.service.publish(publishRequest({ typeKey: ROOT, parentTypeKey: ROOT })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'self-parent');
      assert.match((error as Error).message, /one thing containing itself/);
      return true;
    },
  );
});

test('a missing parent is refused rather than resolved as a root', async () => {
  const harness = build();
  const published = await harness.service.publish(
    publishRequest({ typeKey: BRANCH, parentTypeKey: ROOT }),
  );

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: published.version.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-parent');
      assert.match((error as Error).message, /must not be resolved as though it were a root/);
      return true;
    },
    'promoting a subcategory to a root is how a rule stops applying with nothing in any log',
  );
});

test('a retired ancestor breaks the lineage rather than vanishing from it', async () => {
  const { harness } = await withLineage();
  await harness.service.retire({
    retirementId: nextId('ret'),
    typeKey: BRANCH,
    reason: 'the electronics tier was folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.resolve({ typeKey: LEAF }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-parent');
      return true;
    },
    'a leaf whose parent was retired must not silently become a child of the root',
  );

  // The root is unaffected: retiring a branch is not retiring the tree.
  assert.deepEqual((await harness.service.resolve({ typeKey: ROOT })).ancestry, []);
});

test('a chain deeper than the bound is refused, and says how deep it got', async () => {
  const harness = build();
  const keys = Array.from({ length: MAX_DEPTH + 1 }, (_, index) => `deep${index}`);

  for (const [index, typeKey] of keys.entries()) {
    const parentTypeKey = index === 0 ? null : (keys[index - 1] as string);
    const published = await harness.service.publish(publishRequest({ typeKey, parentTypeKey }));
    const activate = harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: published.version.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    });

    if (index < MAX_DEPTH) {
      await activate;
      continue;
    }
    await assert.rejects(
      activate,
      (error: unknown) => {
        assert.equal(codeOf(error), 'hierarchy-too-deep');
        assert.match((error as Error).message, new RegExp(`deeper than ${MAX_DEPTH}`));
        return true;
      },
      'a lineage nobody can hold in their head is one nobody can confirm is right',
    );
  }
});

test('a version outside its window breaks a lineage but is reported as not effective when asked for', async () => {
  // The same fact, two codes, because the caller asked about different things: their own type
  // being out of window is `version-not-effective`, and an ancestor being out of window is a
  // lineage that cannot be stated.
  const harness = build();
  await withActiveType(harness, { typeKey: ROOT, effectiveUntil: '2026-04-01T13:00:00Z' });
  await withActiveType(harness, { typeKey: BRANCH, parentTypeKey: ROOT });

  harness.clock.set('2026-04-01T14:00:00Z');

  await assert.rejects(
    harness.service.resolve({ typeKey: ROOT }),
    (error: unknown) => codeOf(error) === 'version-not-effective',
  );
  await assert.rejects(
    harness.service.resolve({ typeKey: BRANCH }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-parent');
      assert.match((error as Error).message, /is not in force at/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

test('a tenant may extend the platform vocabulary', async () => {
  // v3 §11: "category adapters extend the common object rather than duplicating the platform."
  const repository = build().repository;
  const platform = build({ repository });
  await withActiveType(platform, { typeKey: ROOT });

  const tenant = build({ repository, registrar: tenantRegistrar() });
  await withActiveType(tenant, { typeKey: BRANCH, parentTypeKey: ROOT });

  const resolved = await tenant.service.resolve({ typeKey: BRANCH });
  assert.deepEqual(resolved.ancestry, [ROOT]);
  assert.deepEqual(resolved.owner, { kind: 'tenant', tenantId: TENANT });
});

test('a tenant may not extend another tenant’s type', async () => {
  const repository = build().repository;
  const first = build({ repository, registrar: tenantRegistrar(TENANT) });
  await withActiveType(first, { typeKey: ROOT });

  const second = build({ repository, registrar: tenantRegistrar(OTHER_TENANT) });
  const published = await second.service.publish(
    publishRequest({ typeKey: BRANCH, parentTypeKey: ROOT }),
  );

  await assert.rejects(
    second.service.activate({
      activationId: nextId('act'),
      typeVersionId: published.version.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'cross-owner-relationship');
      assert.match((error as Error).message, /break a second tenant/);
      return true;
    },
    'one tenant’s retirement must not be able to stop another tenant’s listings',
  );
});

test('a tenant may not retire the platform vocabulary, or another tenant’s type', async () => {
  const repository = build().repository;
  const platform = build({ repository });
  await withActiveType(platform, { typeKey: ROOT });

  const tenant = build({ repository, registrar: tenantRegistrar() });
  await assert.rejects(
    tenant.service.retire({
      retirementId: nextId('ret'),
      typeKey: ROOT,
      reason: 'we do not sell goods',
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'cross-owner-relationship');
      assert.match((error as Error).message, /may not retire/);
      return true;
    },
  );
  assert.equal(repository.retirements().length, 0);
});

test('a tenant registrar publishes as its own tenant, and cannot say otherwise', async () => {
  // The owner comes from the injected authority, so there is no field to forge. Supplying one is
  // an unknown field rather than a silently ignored one.
  const harness = build({ registrar: tenantRegistrar() });
  const published = await harness.service.publish(publishRequest());
  assert.deepEqual(published.version.owner, { kind: 'tenant', tenantId: TENANT });

  await assert.rejects(
    harness.service.publish(publishRequest({ owner: { kind: 'platform' } } as never)),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /does not accept the field "owner"/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The derived hierarchy is never supplied
// ---------------------------------------------------------------------------

test('a caller may not state the lineage it wants', async () => {
  const { harness } = await withLineage();
  for (const field of ['ancestry', 'ancestors', 'depth', 'path', 'root']) {
    await assert.rejects(
      harness.service.resolve({ typeKey: LEAF, [field]: [ROOT] } as never),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-outcome', field);
        assert.match((error as Error).message, /derived/);
        return true;
      },
      `resolve must refuse "${field}": a caller supplying it could invent a lineage`,
    );
  }
});

test('the explanation names versions and never a tenant handle', async () => {
  // An explanation is the thing most likely to be logged. One that carried a tenant handle would
  // put it into every log line that mentions the category.
  const repository = build().repository;
  await withActiveType(build({ repository }), { typeKey: ROOT });
  const tenant = build({ repository, registrar: tenantRegistrar() });
  await withActiveType(tenant, { typeKey: BRANCH, parentTypeKey: ROOT });

  const resolved = await tenant.service.resolve({ typeKey: BRANCH });
  assert.match(resolved.explanation, new RegExp(resolved.typeVersionId));
  assert.ok(
    !resolved.explanation.includes(TENANT),
    `the explanation quoted a tenant handle: "${resolved.explanation}"`,
  );
});

test('resolution is deterministic and writes nothing', async () => {
  const { harness } = await withLineage();
  const request = { typeKey: LEAF, at: '2026-04-01T12:00:00Z' };

  const first = await harness.service.resolve(request);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await harness.service.resolve(request), first, 'resolution is not stable');
  }

  const before = harness.repository.versions().length;
  await harness.service.resolve(request);
  assert.equal(harness.repository.versions().length, before);
  assert.equal(harness.repository.activations().length, 3);
});
