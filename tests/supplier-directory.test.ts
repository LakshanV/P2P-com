/**
 * M-48 Supplier & Merchant Directory — the network the sourcing ladder searches.
 *
 * The module the ladder was built against and did not have. Three properties carry this suite, in
 * order of how much damage their absence would do:
 *
 *   * **Category is a gate.** A supplier with no category in common is not a weak match; they are
 *     not asked. Asking a cement supplier about laptops is the single behaviour that trains people
 *     to ignore a platform, and a search with no category at all is refused outright rather than
 *     answered with everybody.
 *   * **Registration is not activation.** A new entry is `pending` and invisible to the rungs. A
 *     platform where signing up put you straight into the market would give the first tender to
 *     whoever registered fastest.
 *   * **Claims are separated from facts.** Everything here is what a supplier says. Whether they
 *     are verified is M-02's, and what they have actually delivered is M-11's — and the foreign
 *     field table refuses both by name, because a directory holding a stale copy of either is a
 *     second answer to a question somebody else already answers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIRECTORY_TRANSITIONS,
  DirectoryError,
  DirectoryService,
  InMemoryDirectoryRepository,
  type DirectoryProfile,
} from '../modules/supplier-directory/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CEMENT_ACCOUNT = 'acct_01HR0DIRparty001';
const FLANGE_ACCOUNT = 'acct_01HR0DIRparty002';
const SHOP_ACCOUNT = 'acct_01HR0DIRparty003';

const NOW = '2026-07-01T09:00:00.000000Z';
const MIDDAY = '2026-07-01T12:00:00.000000Z';
const LATER = '2026-07-01T15:30:00.000000Z';

interface Harness {
  readonly service: DirectoryService;
  readonly repository: InMemoryDirectoryRepository;
}

function build(): Harness {
  const repository = new InMemoryDirectoryRepository();
  return { service: new DirectoryService(repository), repository };
}

interface PartyOptions {
  readonly tag?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly displayName?: string;
  readonly categories?: readonly string[];
  readonly districts?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly brands?: readonly string[];
  readonly activate?: boolean;
}

/** A registered, activated, open supplier that has declared what it does. */
async function aParty(harness: Harness, options: PartyOptions = {}): Promise<string> {
  const tag = options.tag ?? '0001';
  const supplierId = `sup_01HR0DIR${tag}`;

  await harness.service.registerSupplier({
    supplierId,
    accountId: options.accountId ?? CEMENT_ACCOUNT,
    kind: options.kind ?? 'supplier',
    displayName: options.displayName ?? 'Matale Cement Works',
    registeredAt: NOW,
    correlationId: `corr_01HR0DIR${tag}`,
    idempotencyKey: `idem_01HR0DIR${tag}`,
    eventId: `dev_01HR0DIR${tag}reg`,
  });

  let facet = 0;
  const declare = async (kind: string, values: readonly string[]): Promise<void> => {
    for (const value of values) {
      facet += 1;
      await harness.service.declareFacet({
        facetId: `fac_01HR0DIR${tag}${String(facet).padStart(2, '0')}`,
        supplierId,
        kind,
        value,
        declaredAt: NOW,
        correlationId: `corr_01HR0DIR${tag}f${String(facet)}`,
        idempotencyKey: `idem_01HR0DIR${tag}f${String(facet)}`,
      });
    }
  };

  await declare('category', options.categories ?? ['cement']);
  await declare('district', options.districts ?? ['matale']);
  await declare('capability', options.capabilities ?? []);
  await declare('brand', options.brands ?? []);

  if (options.activate !== false) {
    await harness.service.activateSupplier({
      supplierId,
      reason: 'documents checked and the account is in good standing',
      occurredAt: MIDDAY,
      correlationId: `corr_01HR0DIR${tag}act`,
      idempotencyKey: `idem_01HR0DIR${tag}act`,
      eventId: `dev_01HR0DIR${tag}act`,
    });
    await harness.service.setAvailability({
      supplierId,
      acceptsOrders: true,
      dailyCapacity: 100,
      occurredAt: MIDDAY,
      correlationId: `corr_01HR0DIR${tag}av`,
      idempotencyKey: `idem_01HR0DIR${tag}av`,
    });
  }

  return supplierId;
}

const found = (profiles: readonly DirectoryProfile[]): readonly string[] =>
  profiles.map((one) => one.entry.supplierId);

// ---------------------------------------------------------------------------
// Registering
// ---------------------------------------------------------------------------

test('a registered party is not yet in the market', async () => {
  // The difference between signing up and being open. A platform that skipped it would give the
  // first tender to whoever registered fastest.
  const harness = build();
  const supplierId = await aParty(harness, { activate: false });

  const entry = await harness.service.getSupplier(supplierId);
  assert.equal(entry?.status, 'pending');
  assert.equal(entry?.acceptsOrders, false, 'and not open, which is a separate fact');

  assert.deepEqual(
    found(await harness.service.findSuppliers({ categories: ['cement'] })),
    [],
    'the rungs do not see a pending entry',
  );
});

test('activating puts a supplier in the market, and only then', async () => {
  const harness = build();
  const supplierId = await aParty(harness);

  const profiles = await harness.service.findSuppliers({ categories: ['cement'] });
  assert.deepEqual(found(profiles), [supplierId]);
  assert.deepEqual(profiles[0]?.categories, ['cement']);
  assert.deepEqual(profiles[0]?.districts, ['matale']);
});

test('one account trades under one entry', async () => {
  // Two would make "who supplies this" ambiguous for the same business, and a buyer receiving two
  // invitations from one supplier is a platform that does not know who its suppliers are.
  const harness = build();
  await aParty(harness, { tag: '0002' });

  await assert.rejects(
    harness.service.registerSupplier({
      supplierId: 'sup_01HR0DIR0003',
      accountId: CEMENT_ACCOUNT,
      kind: 'merchant',
      displayName: 'The same business, twice',
      registeredAt: LATER,
      correlationId: 'corr_01HR0DIR0003',
      idempotencyKey: 'idem_01HR0DIR0003',
      eventId: 'dev_01HR0DIR0003reg',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'already-registered',
  );
});

test('a retried registration converges rather than creating a second entry', async () => {
  const harness = build();
  await aParty(harness, { tag: '0004' });

  // A retry arrives later with a fresh correlation id by definition. Neither may defeat
  // convergence — reporting one as key reuse makes the caller send a new key and register twice.
  const again = await harness.service.registerSupplier({
    supplierId: 'sup_01HR0DIR0004',
    accountId: CEMENT_ACCOUNT,
    kind: 'supplier',
    displayName: 'Matale Cement Works',
    registeredAt: LATER,
    correlationId: 'corr_01HR0DIR0004retry',
    idempotencyKey: 'idem_01HR0DIR0004',
    eventId: 'dev_01HR0DIR0004reg',
  });

  assert.equal(again.replayed, true);
  assert.equal(again.entry.registeredAt, NOW, 'the stored entry keeps its original instant');
});

test('a different registration under an existing key is refused', async () => {
  const harness = build();
  await aParty(harness, { tag: '0005' });

  await assert.rejects(
    harness.service.registerSupplier({
      supplierId: 'sup_01HR0DIR0006',
      accountId: FLANGE_ACCOUNT,
      kind: 'supplier',
      displayName: 'A different business entirely',
      registeredAt: LATER,
      correlationId: 'corr_01HR0DIR0006',
      idempotencyKey: 'idem_01HR0DIR0005',
      eventId: 'dev_01HR0DIR0006reg',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'idempotency-key-reuse',
  );
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a supplier with no category in common is not asked', async () => {
  // Not scored poorly — excluded. No amount of geographic convenience makes asking a cement
  // supplier about laptops less wrong.
  const harness = build();
  await aParty(harness, { tag: '0007', categories: ['cement'] });
  const flanges = await aParty(harness, {
    tag: '0008',
    accountId: FLANGE_ACCOUNT,
    categories: ['titanium-flange'],
    displayName: 'Kandy Machining',
  });

  assert.deepEqual(
    found(await harness.service.findSuppliers({ categories: ['titanium-flange'] })),
    [flanges],
  );
});

test('a search with no category is refused rather than answered', async () => {
  const harness = build();
  await aParty(harness, { tag: '0009' });

  await assert.rejects(
    harness.service.findSuppliers({ categories: [] }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'ungated-query',
  );
});

test('a supplier who has not said where they serve is still asked', async () => {
  // "They have not said" is not "nowhere". Excluding them would make an incomplete profile a
  // penalty, which is how a directory empties itself.
  const harness = build();
  const silent = await aParty(harness, { tag: '0010', districts: [] });
  const elsewhere = await aParty(harness, {
    tag: '0011',
    accountId: FLANGE_ACCOUNT,
    districts: ['galle'],
  });

  const profiles = await harness.service.findSuppliers({
    categories: ['cement'],
    districts: ['matale'],
  });

  assert.deepEqual(found(profiles), [silent], 'the silent one stays; the distant one does not');
  assert.ok(!found(profiles).includes(elsewhere));
});

test('a closed or suspended supplier is not in the market', async () => {
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0012' });

  await harness.service.suspendSupplier({
    supplierId,
    reason: 'three late deliveries in a row, pending review',
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0012sus',
    idempotencyKey: 'idem_01HR0DIR0012sus',
    eventId: 'dev_01HR0DIR0012sus',
  });

  assert.deepEqual(found(await harness.service.findSuppliers({ categories: ['cement'] })), []);

  // And back again: suspension is reversible, which is what makes it different from closing.
  await harness.service.activateSupplier({
    supplierId,
    reason: 'review completed and the deliveries were explained',
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0012re',
    idempotencyKey: 'idem_01HR0DIR0012re',
    eventId: 'dev_01HR0DIR0012re',
  });
  await harness.service.setAvailability({
    supplierId,
    acceptsOrders: true,
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0012av2',
    idempotencyKey: 'idem_01HR0DIR0012av2',
  });
  assert.deepEqual(found(await harness.service.findSuppliers({ categories: ['cement'] })), [
    supplierId,
  ]);
});

test('a supplier who is closed for the week is not asked, and has not lost their capacity', async () => {
  // Two facts, deliberately. "Closed" and "capacity zero" are different answers to a buyer asking
  // why they were not invited.
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0013' });

  await harness.service.setAvailability({
    supplierId,
    acceptsOrders: false,
    dailyCapacity: 100,
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0013av',
    idempotencyKey: 'idem_01HR0DIR0013av',
  });

  assert.deepEqual(found(await harness.service.findSuppliers({ categories: ['cement'] })), []);
  const entry = await harness.service.getSupplier(supplierId);
  assert.equal(entry?.status, 'active', 'they are not suspended');
  assert.equal(entry?.dailyCapacity, 100n, 'and their capacity is what it was');
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

test('withdrawing a claim keeps the row, and declaring it again moves the same one', async () => {
  // A dispute about an order placed in March is judged against what the supplier said in March, and
  // a deleted row cannot say.
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0014', brands: ['tokyo-cement'] });

  const withdrawn = await harness.service.withdrawFacet({
    supplierId,
    kind: 'brand',
    value: 'tokyo-cement',
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0014w',
    idempotencyKey: 'idem_01HR0DIR0014w',
  });
  assert.equal(withdrawn.facet.status, 'withdrawn');
  assert.equal(withdrawn.facet.withdrawnAt, LATER);

  const profile = await harness.service.getProfile(supplierId);
  assert.deepEqual(profile?.brands, [], 'a withdrawn claim is not a current one');

  const again = await harness.service.declareFacet({
    facetId: 'fac_01HR0DIRnewrow01',
    supplierId,
    kind: 'brand',
    value: 'tokyo-cement',
    declaredAt: '2026-07-02T09:00:00.000000Z',
    correlationId: 'corr_01HR0DIR0014d2',
    idempotencyKey: 'idem_01HR0DIR0014d2',
  });

  assert.equal(
    again.facet.facetId,
    withdrawn.facet.facetId,
    'the same row moved back, rather than a second row appearing beside it',
  );
  assert.equal(again.facet.status, 'active');
  assert.equal(harness.repository.facets().filter((one) => one.kind === 'brand').length, 1);
});

test('declaring a claim that is already active converges', async () => {
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0015' });

  const again = await harness.service.declareFacet({
    facetId: 'fac_01HR0DIRdupe0001',
    supplierId,
    kind: 'category',
    value: 'cement',
    declaredAt: LATER,
    correlationId: 'corr_01HR0DIR0015d',
    idempotencyKey: 'idem_01HR0DIR0015d',
  });

  assert.equal(again.replayed, true);
  assert.equal(harness.repository.facets().filter((one) => one.kind === 'category').length, 1);
});

test('withdrawing something never declared is refused rather than ignored', async () => {
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0016' });

  await assert.rejects(
    harness.service.withdrawFacet({
      supplierId,
      kind: 'category',
      value: 'laptops',
      occurredAt: LATER,
      correlationId: 'corr_01HR0DIR0016w',
      idempotencyKey: 'idem_01HR0DIR0016w',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'facet-not-found',
  );
});

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

test('a merchant has branches, and exactly one of them is primary', async () => {
  const harness = build();
  const merchantId = await aParty(harness, {
    tag: '0017',
    accountId: SHOP_ACCOUNT,
    kind: 'merchant',
    displayName: 'Kandy Hardware',
  });

  await harness.service.addLocation({
    locationId: 'loc_01HR0DIR00170001',
    supplierId: merchantId,
    name: 'Kandy high street',
    district: 'kandy',
    primary: true,
    openedAt: NOW,
    correlationId: 'corr_01HR0DIR0017l1',
    idempotencyKey: 'idem_01HR0DIR0017l1',
  });

  await assert.rejects(
    harness.service.addLocation({
      locationId: 'loc_01HR0DIR00170002',
      supplierId: merchantId,
      name: 'A second main branch',
      district: 'matale',
      primary: true,
      openedAt: NOW,
      correlationId: 'corr_01HR0DIR0017l2',
      idempotencyKey: 'idem_01HR0DIR0017l2',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'primary-location-exists',
  );

  // A second branch that is not primary is fine, which is the ordinary case.
  const second = await harness.service.addLocation({
    locationId: 'loc_01HR0DIR00170003',
    supplierId: merchantId,
    name: 'Matale branch',
    district: 'matale',
    openedAt: NOW,
    correlationId: 'corr_01HR0DIR0017l3',
    idempotencyKey: 'idem_01HR0DIR0017l3',
  });
  assert.equal(second.location.primary, false);

  const locations = await harness.service.listLocations(merchantId);
  assert.equal(locations.length, 2);
  assert.equal(locations[0]?.primary, true, 'the primary one is listed first');
});

test('a closed branch is not the primary one', async () => {
  const harness = build();
  const merchantId = await aParty(harness, {
    tag: '0018',
    accountId: SHOP_ACCOUNT,
    kind: 'merchant',
  });

  await harness.service.addLocation({
    locationId: 'loc_01HR0DIR00180001',
    supplierId: merchantId,
    name: 'Kandy high street',
    district: 'kandy',
    primary: true,
    openedAt: NOW,
    correlationId: 'corr_01HR0DIR0018l1',
    idempotencyKey: 'idem_01HR0DIR0018l1',
  });

  const closed = await harness.service.closeLocation({
    locationId: 'loc_01HR0DIR00180001',
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0018c',
    idempotencyKey: 'idem_01HR0DIR0018c',
  });

  assert.equal(closed.location.status, 'withdrawn');
  assert.equal(
    closed.location.primary,
    false,
    '"show the buyer the main branch" must not answer with a shop that has shut',
  );
});

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

test('closing is terminal, and the record stays', async () => {
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0019' });

  await harness.service.closeSupplier({
    supplierId,
    reason: 'the business has stopped trading',
    occurredAt: LATER,
    correlationId: 'corr_01HR0DIR0019c',
    idempotencyKey: 'idem_01HR0DIR0019c',
    eventId: 'dev_01HR0DIR0019c',
  });

  const entry = await harness.service.getSupplier(supplierId);
  assert.equal(entry?.status, 'closed');
  assert.equal(entry?.acceptsOrders, false, 'a closed party is shut as well as ended');
  assert.equal(entry?.closureReason, 'the business has stopped trading');

  await assert.rejects(
    harness.service.activateSupplier({
      supplierId,
      reason: 'reopening a business that has closed',
      occurredAt: '2026-07-03T09:00:00.000000Z',
      correlationId: 'corr_01HR0DIR0019r',
      idempotencyKey: 'idem_01HR0DIR0019r',
      eventId: 'dev_01HR0DIR0019r',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'supplier-closed',
  );
});

test('every status change says why', async () => {
  // A suspended supplier is entitled to know, and "suspended" is not a reason.
  const harness = build();
  const supplierId = await aParty(harness, { tag: '0020' });

  await assert.rejects(
    harness.service.suspendSupplier({
      supplierId,
      reason: 'bad',
      occurredAt: LATER,
      correlationId: 'corr_01HR0DIR0020s',
      idempotencyKey: 'idem_01HR0DIR0020s',
      eventId: 'dev_01HR0DIR0020s',
    }),
    (error: unknown) => error instanceof DirectoryError && error.code === 'malformed-reason',
  );

  const history = await harness.service.listHistory(supplierId);
  assert.deepEqual(
    history.map((one) => one.toStatus),
    ['pending', 'active'],
    'and the history reads as a sequence',
  );
  assert.ok(history.every((one) => one.reason.length >= 8));
});

test('every terminal status is terminal in the transition table', () => {
  assert.deepEqual(DIRECTORY_TRANSITIONS.closed, []);
  assert.deepEqual(DIRECTORY_TRANSITIONS.pending, ['active', 'closed']);
  assert.deepEqual(DIRECTORY_TRANSITIONS.active, ['suspended', 'closed']);
  assert.deepEqual(DIRECTORY_TRANSITIONS.suspended, ['active', 'closed']);
});

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

test('a claim about verification or delivery record is refused by name', async () => {
  // Both are answered by another module. A directory holding a stale copy of either would be a
  // second answer to a question somebody else already answers.
  const harness = build();

  for (const field of [
    'verified',
    'verificationLevel',
    'reliabilityPerMille',
    'rating',
    'address',
  ]) {
    await assert.rejects(
      harness.service.registerSupplier({
        supplierId: 'sup_01HR0DIRforeign1',
        accountId: FLANGE_ACCOUNT,
        kind: 'supplier',
        displayName: 'A supplier asserting something that is not theirs',
        registeredAt: NOW,
        correlationId: 'corr_01HR0DIRforeign',
        idempotencyKey: 'idem_01HR0DIRforeign',
        eventId: 'dev_01HR0DIRforeign',
        [field]: 'anything',
      }),
      (error: unknown) =>
        error instanceof DirectoryError &&
        error.code === 'foreign-concern' &&
        error.message.includes(field),
      `${field} must be refused`,
    );
  }
});

test('no declaration travels in an event', async () => {
  // What a business sells is useful to its competitors, and the event log is read by every
  // subscriber and kept indefinitely.
  const harness = build();
  await aParty(harness, { tag: '0021', categories: ['cement'], brands: ['tokyo-cement'] });

  const published = JSON.stringify(
    harness.repository
      .outbox()
      .entries()
      .filter((entry) => entry.kind === 'event')
      .map((entry) => entry.payload),
  );

  assert.ok(!published.includes('tokyo-cement'), 'a brand must not travel');
  assert.ok(!published.includes('cement'), 'nor a category');
  assert.ok(published.includes('supplier.registered'));
  assert.ok(published.includes('supplier.activated'), 'the status does, so a consumer can route');
});

test('the audit record carries the name and the reason', async () => {
  const harness = build();
  await aParty(harness, { tag: '0022', displayName: 'Matale Cement Works' });

  const audits = JSON.stringify(
    harness.repository
      .outbox()
      .entries()
      .filter((entry) => entry.kind === 'audit')
      .map((entry) => entry.payload),
  );

  assert.ok(audits.includes('Matale Cement Works'));
  assert.ok(
    audits.includes('documents checked'),
    'the audit trail is where a supplier’s "why" survives',
  );
});

test('the database enforces one entry per account, and one primary branch', () => {
  // Defence at the layer that survives a refactor. The service could gain a path that skips its own
  // check; these would still refuse.
  const migration = readFileSync(
    path.join(REPO_ROOT, 'db/migrations/0057_create_module_supplier_directory_schema.up.sql'),
    'utf8',
  );

  assert.match(migration, /directory_entry_account_unique UNIQUE \(account_id\)/);
  assert.match(
    migration,
    /supplier_facet_once_per_value UNIQUE \(supplier_id, facet_kind, value\)/,
  );
  assert.match(migration, /supplier_location_one_primary_idx/);
  assert.match(migration, /directory_entry_closed_is_shut/);
  assert.match(
    migration,
    /supplier_facet_value_is_code/,
    'a category that was somebody’s email address would publish it into every invitation',
  );
  assert.match(
    migration,
    /position\('@' in value\) = 0/,
    'and the code rule is where that is refused, since it is not the identifier rule',
  );
});

test('the module reads no clock and generates no randomness', () => {
  const directory = path.join(REPO_ROOT, 'modules/supplier-directory');
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /crypto\.randomUUID\(/];

  for (const file of [
    'service.ts',
    'repository.ts',
    'validate.ts',
    'registry.ts',
    'outbox.ts',
    'immutable.ts',
    'postgres-repository.ts',
  ]) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        pattern.exec(source) === null,
        `${file} uses ${String(pattern)}; the caller supplies every instant and identifier`,
      );
    }
  }
});

void test('CONTRACT.md documents every refusal the code can raise', () => {
  // A refusal table that has fallen behind the code is worse than none: a caller reads it, handles
  // the four codes it lists, and is surprised in production by the fifth. The codes are read from
  // the source rather than restated here, so adding one to types.ts fails this test until the
  // document catches up.
  const contract = readFileSync(
    path.join(REPO_ROOT, 'modules/supplier-directory/CONTRACT.md'),
    'utf8',
  );
  const types = readFileSync(path.join(REPO_ROOT, 'modules/supplier-directory/types.ts'), 'utf8');

  const declaration = /export type DirectoryErrorCode =([\s\S]*?);\n/.exec(types);
  assert.ok(declaration !== null, 'DirectoryErrorCode is no longer declared as a union');

  const codes = [...String(declaration[1]).matchAll(/'([a-z-]+)'/g)].map((match) =>
    String(match[1]),
  );
  assert.ok(
    codes.length >= 20,
    `only ${String(codes.length)} codes were found; the regex is stale`,
  );

  for (const code of codes) {
    assert.ok(contract.includes('`' + code + '`'), `CONTRACT.md does not document ${code}`);
  }

  // And that it names the schema and the migration it actually has, because a contract pointing at
  // the wrong migration sends a reader to a file that does not describe these tables.
  assert.ok(contract.includes('module_supplier_directory'), 'CONTRACT.md does not name the schema');
  assert.ok(
    contract.includes('0057_create_module_supplier_directory_schema'),
    'CONTRACT.md does not name the migration that creates the schema',
  );
});

void test('CONTRACT.md names every operation the service exposes', () => {
  // The other half of the same drift: a method added without a line in the contract is a method
  // nobody outside this module knows exists.
  const contract = readFileSync(
    path.join(REPO_ROOT, 'modules/supplier-directory/CONTRACT.md'),
    'utf8',
  );
  const source = readFileSync(
    path.join(REPO_ROOT, 'modules/supplier-directory/service.ts'),
    'utf8',
  );

  const methods = [...source.matchAll(/^ {2}async ([a-zA-Z]+)\(/gm)].map((match) =>
    String(match[1]),
  );
  assert.ok(
    methods.length >= 12,
    `only ${String(methods.length)} methods found; the regex is stale`,
  );

  for (const method of methods) {
    assert.ok(contract.includes(method + '('), `CONTRACT.md does not document ${method}()`);
  }
});
