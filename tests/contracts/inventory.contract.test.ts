/**
 * Inventory interface contract test.
 *
 * This suite is parameterised over an implementation so a replacement inventory module can be
 * plugged in without editing this file. To plug in a replacement, implement `InventoryUnderTest`
 * and call `runInventoryContract(subject)` from a small driver file.
 *
 * The contract pins the behaviour that makes the inventory interface replaceable: availability is
 * derived from an append-only movement log, the snapshot always agrees with the log, reservations
 * are derived from movements, and no operation can silently violate the invariant.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { OutboxEntry } from '../../platform/outbox/types.ts';
import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
  type InventoryAvailability,
  type InventoryMovement,
  type InventorySnapshot,
} from '../../modules/universal-listing/index.ts';

const ACCOUNT = 'acct_01HQZXA0001';
const UNIT_TYPE = 'cut_01HQZXA0001';

export interface ReceiveRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface AdjustRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly kind: 'adjust-up' | 'adjust-down';
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReserveRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReleaseRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface CommitRequest {
  readonly movementId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly reservationId: string;
  readonly quantity: bigint;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export interface ReceiveResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface AdjustResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface ReserveResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface ReleaseResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

export interface CommitResult {
  readonly movement: InventoryMovement;
  readonly availability: InventoryAvailability;
  readonly replayed: boolean;
}

/** Operations that run inside an existing transaction, used for concurrency tests. */
export interface InventoryTransaction {
  readonly insertMovement: (movement: InventoryMovement) => Promise<void>;
  readonly getAvailability: (
    listingId: string,
    versionId: string,
  ) => Promise<InventoryAvailability>;
}

/** High-level operations and inspection hooks a harness must provide. */
export interface InventoryOperations {
  readonly receive: (request: ReceiveRequest) => Promise<ReceiveResult>;
  readonly adjust: (request: AdjustRequest) => Promise<AdjustResult>;
  readonly reserve: (request: ReserveRequest) => Promise<ReserveResult>;
  readonly release: (request: ReleaseRequest) => Promise<ReleaseResult>;
  readonly commit: (request: CommitRequest) => Promise<CommitResult>;
  readonly getAvailability: (
    listingId: string,
    versionId: string,
  ) => Promise<InventoryAvailability>;
}

export interface InventoryHarness {
  readonly name: string;
  /** Create a listing and publish one version so inventory operations have a target. */
  readonly setup: (listingId: string, versionId: string) => Promise<void>;
  readonly operations: InventoryOperations;
  /** Run `body` inside one transaction; the supplied ops are the low-level transaction operations. */
  readonly withTransaction: <T>(body: (tx: InventoryTransaction) => Promise<T>) => Promise<T>;
  readonly movements: () => readonly InventoryMovement[];
  readonly snapshots: () => readonly InventorySnapshot[];
  readonly outbox: () => readonly OutboxEntry[];
}

export interface InventoryUnderTest {
  readonly name: string;
  /** A fresh, empty implementation plus whatever fixtures the suite needs to drive it. */
  readonly create: () => Promise<InventoryHarness>;
}

/**
 * The refusal code, read structurally rather than by error class.
 *
 * A contract that tested `error instanceof UniversalListingError` would only ever be passable by
 * M-04, which defeats the point of writing it: a replacement inventory module brings its own error
 * type. What the contract requires is that a refusal carries a **string `code` naming the reason** —
 * that is the part callers branch on and the part a replacement must honour.
 */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw new Error(
      `an implementation refused with an error carrying no string "code": ${String(error)}. ` +
        'A refusal a caller cannot branch on is not a refusal it can act on.',
      { cause: error },
    );
  }
  throw new Error('expected a refusal, and the call succeeded');
};

/** Build a reserve movement for low-level transaction tests. */
function reserveMovement(
  listingId: string,
  versionId: string,
  reservationId: string,
  quantity: bigint,
  occurredAt: string,
  movementId: string,
  idempotencyKey: string,
): InventoryMovement {
  return {
    movementId,
    listingId,
    versionId,
    kind: 'reserve',
    quantity,
    reservationId,
    reason: 'reserved through contract test',
    occurredAt,
    correlationId: 'corr_contract_0001',
    idempotencyKey,
  };
}

export function runInventoryContract(subject: InventoryUnderTest): void {
  test(`${subject.name}: availability of an untouched listing is all zeroes`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0001', 'ver_contract_0001');

    const availability = await harness.operations.getAvailability(
      'lst_contract_0001',
      'ver_contract_0001',
    );

    assert.deepEqual(availability, {
      onHand: 0n,
      reserved: 0n,
      committed: 0n,
      available: 0n,
    });
  });

  test(`${subject.name}: receive raises onHand and available by the quantity`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0002', 'ver_contract_0002');

    const result = await harness.operations.receive({
      movementId: 'mov_contract_0001',
      listingId: 'lst_contract_0002',
      versionId: 'ver_contract_0002',
      quantity: 50n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0003',
      idempotencyKey: 'idem_receive_0001',
    });

    assert.equal(result.availability.onHand, 50n);
    assert.equal(result.availability.reserved, 0n);
    assert.equal(result.availability.committed, 0n);
    assert.equal(result.availability.available, 50n);
    assert.equal(harness.movements().length, 1);
  });

  test(`${subject.name}: reserve lowers available and raises reserved, leaving onHand alone`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0003', 'ver_contract_0003');
    await harness.operations.receive({
      movementId: 'mov_contract_0002',
      listingId: 'lst_contract_0003',
      versionId: 'ver_contract_0003',
      quantity: 50n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0004',
      idempotencyKey: 'idem_receive_0002',
    });

    const result = await harness.operations.reserve({
      movementId: 'mov_contract_0003',
      listingId: 'lst_contract_0003',
      versionId: 'ver_contract_0003',
      reservationId: 'res_contract_0001',
      quantity: 20n,
      reason: 'hold for buyer',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0005',
      idempotencyKey: 'idem_reserve_0001',
    });

    assert.equal(result.availability.onHand, 50n);
    assert.equal(result.availability.reserved, 20n);
    assert.equal(result.availability.committed, 0n);
    assert.equal(result.availability.available, 30n);
  });

  test(`${subject.name}: reserving more than available is refused and changes nothing`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0004', 'ver_contract_0004');
    await harness.operations.receive({
      movementId: 'mov_contract_0004',
      listingId: 'lst_contract_0004',
      versionId: 'ver_contract_0004',
      quantity: 10n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0006',
      idempotencyKey: 'idem_receive_0003',
    });
    const outboxAfterReceive = harness.outbox().length;

    const code = await codeOf(() =>
      harness.operations.reserve({
        movementId: 'mov_contract_0005',
        listingId: 'lst_contract_0004',
        versionId: 'ver_contract_0004',
        reservationId: 'res_contract_0002',
        quantity: 11n,
        reason: 'too much',
        occurredAt: '2026-06-01T10:00:00Z',
        correlationId: 'corr_contract_0007',
        idempotencyKey: 'idem_reserve_0002',
      }),
    );

    assert.equal(code, 'insufficient-stock');
    assert.equal(harness.movements().length, 1);
    assert.equal(harness.outbox().length, outboxAfterReceive);
    const availability = await harness.operations.getAvailability(
      'lst_contract_0004',
      'ver_contract_0004',
    );
    assert.equal(availability.available, 10n);
  });

  test(`${subject.name}: two reservations that together exceed availability are refused through interleaved transactions`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0005', 'ver_contract_0005');
    await harness.operations.receive({
      movementId: 'mov_contract_0006',
      listingId: 'lst_contract_0005',
      versionId: 'ver_contract_0005',
      quantity: 10n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0008',
      idempotencyKey: 'idem_receive_0004',
    });

    const code = await codeOf(() =>
      harness.withTransaction(async (tx) => {
        // This transaction reads availability before the competing transaction commits.
        const availability = await tx.getAvailability('lst_contract_0005', 'ver_contract_0005');
        assert.equal(availability.available, 10n);

        await harness.withTransaction(async (other) => {
          await other.insertMovement(
            reserveMovement(
              'lst_contract_0005',
              'ver_contract_0005',
              'res_contract_0003',
              6n,
              '2026-06-01T10:00:00Z',
              'mov_contract_0007',
              'idem_reserve_0003',
            ),
          );
        });

        await tx.insertMovement(
          reserveMovement(
            'lst_contract_0005',
            'ver_contract_0005',
            'res_contract_0004',
            6n,
            '2026-06-01T10:01:00Z',
            'mov_contract_0008',
            'idem_reserve_0004',
          ),
        );
      }),
    );

    assert.equal(code, 'insufficient-stock');
    assert.equal(harness.movements().length, 2);
  });

  test(`${subject.name}: release returns stock exactly`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0006', 'ver_contract_0006');
    await harness.operations.receive({
      movementId: 'mov_contract_0009',
      listingId: 'lst_contract_0006',
      versionId: 'ver_contract_0006',
      quantity: 50n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0009',
      idempotencyKey: 'idem_receive_0005',
    });
    await harness.operations.reserve({
      movementId: 'mov_contract_0010',
      listingId: 'lst_contract_0006',
      versionId: 'ver_contract_0006',
      reservationId: 'res_contract_0005',
      quantity: 20n,
      reason: 'hold for buyer',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0010',
      idempotencyKey: 'idem_reserve_0005',
    });

    const result = await harness.operations.release({
      movementId: 'mov_contract_0011',
      listingId: 'lst_contract_0006',
      versionId: 'ver_contract_0006',
      reservationId: 'res_contract_0005',
      quantity: 20n,
      reason: 'buyer cancelled',
      occurredAt: '2026-06-01T11:00:00Z',
      correlationId: 'corr_contract_0011',
      idempotencyKey: 'idem_release_0001',
    });

    assert.equal(result.availability.onHand, 50n);
    assert.equal(result.availability.reserved, 0n);
    assert.equal(result.availability.committed, 0n);
    assert.equal(result.availability.available, 50n);
  });

  test(`${subject.name}: commit moves stock from reserved to committed and lowers onHand`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0007', 'ver_contract_0007');
    await harness.operations.receive({
      movementId: 'mov_contract_0012',
      listingId: 'lst_contract_0007',
      versionId: 'ver_contract_0007',
      quantity: 50n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0012',
      idempotencyKey: 'idem_receive_0006',
    });
    await harness.operations.reserve({
      movementId: 'mov_contract_0013',
      listingId: 'lst_contract_0007',
      versionId: 'ver_contract_0007',
      reservationId: 'res_contract_0006',
      quantity: 20n,
      reason: 'hold for buyer',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0013',
      idempotencyKey: 'idem_reserve_0006',
    });

    const result = await harness.operations.commit({
      movementId: 'mov_contract_0014',
      listingId: 'lst_contract_0007',
      versionId: 'ver_contract_0007',
      reservationId: 'res_contract_0006',
      quantity: 20n,
      reason: 'sale completed',
      occurredAt: '2026-06-01T11:00:00Z',
      correlationId: 'corr_contract_0014',
      idempotencyKey: 'idem_commit_0001',
    });

    assert.equal(result.availability.onHand, 30n);
    assert.equal(result.availability.reserved, 0n);
    assert.equal(result.availability.committed, 20n);
    assert.equal(result.availability.available, 30n);

    const releaseCode = await codeOf(() =>
      harness.operations.release({
        movementId: 'mov_contract_0015',
        listingId: 'lst_contract_0007',
        versionId: 'ver_contract_0007',
        reservationId: 'res_contract_0006',
        quantity: 20n,
        reason: 'cannot release sold stock',
        occurredAt: '2026-06-01T12:00:00Z',
        correlationId: 'corr_contract_0015',
        idempotencyKey: 'idem_release_0002',
      }),
    );
    assert.equal(releaseCode, 'reservation-not-open');
  });

  test(`${subject.name}: releasing or committing an unknown or settled reservation is refused`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0008', 'ver_contract_0008');

    const releaseUnknown = await codeOf(() =>
      harness.operations.release({
        movementId: 'mov_contract_0016',
        listingId: 'lst_contract_0008',
        versionId: 'ver_contract_0008',
        reservationId: 'res_contract_0007',
        quantity: 10n,
        reason: 'release unknown',
        occurredAt: '2026-06-01T10:00:00Z',
        correlationId: 'corr_contract_0016',
        idempotencyKey: 'idem_release_0003',
      }),
    );
    assert.equal(releaseUnknown, 'reservation-not-found');

    const commitUnknown = await codeOf(() =>
      harness.operations.commit({
        movementId: 'mov_contract_0017',
        listingId: 'lst_contract_0008',
        versionId: 'ver_contract_0008',
        reservationId: 'res_contract_0008',
        quantity: 10n,
        reason: 'commit unknown',
        occurredAt: '2026-06-01T10:00:00Z',
        correlationId: 'corr_contract_0017',
        idempotencyKey: 'idem_commit_0002',
      }),
    );
    assert.equal(commitUnknown, 'reservation-not-found');

    await harness.operations.receive({
      movementId: 'mov_contract_0018',
      listingId: 'lst_contract_0008',
      versionId: 'ver_contract_0008',
      quantity: 10n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0018',
      idempotencyKey: 'idem_receive_0007',
    });
    await harness.operations.reserve({
      movementId: 'mov_contract_0019',
      listingId: 'lst_contract_0008',
      versionId: 'ver_contract_0008',
      reservationId: 'res_contract_0009',
      quantity: 10n,
      reason: 'hold',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0019',
      idempotencyKey: 'idem_reserve_0007',
    });
    await harness.operations.release({
      movementId: 'mov_contract_0020',
      listingId: 'lst_contract_0008',
      versionId: 'ver_contract_0008',
      reservationId: 'res_contract_0009',
      quantity: 10n,
      reason: 'released',
      occurredAt: '2026-06-01T11:00:00Z',
      correlationId: 'corr_contract_0020',
      idempotencyKey: 'idem_release_0004',
    });

    const releaseAgain = await codeOf(() =>
      harness.operations.release({
        movementId: 'mov_contract_0021',
        listingId: 'lst_contract_0008',
        versionId: 'ver_contract_0008',
        reservationId: 'res_contract_0009',
        quantity: 10n,
        reason: 'release again',
        occurredAt: '2026-06-01T12:00:00Z',
        correlationId: 'corr_contract_0021',
        idempotencyKey: 'idem_release_0005',
      }),
    );
    assert.equal(releaseAgain, 'reservation-not-open');
  });

  test(`${subject.name}: adjust down below reserved + committed is refused`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0009', 'ver_contract_0009');
    await harness.operations.receive({
      movementId: 'mov_contract_0022',
      listingId: 'lst_contract_0009',
      versionId: 'ver_contract_0009',
      quantity: 100n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0022',
      idempotencyKey: 'idem_receive_0008',
    });
    await harness.operations.reserve({
      movementId: 'mov_contract_0023',
      listingId: 'lst_contract_0009',
      versionId: 'ver_contract_0009',
      reservationId: 'res_contract_0010',
      quantity: 30n,
      reason: 'hold',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0023',
      idempotencyKey: 'idem_reserve_0008',
    });
    await harness.operations.commit({
      movementId: 'mov_contract_0024',
      listingId: 'lst_contract_0009',
      versionId: 'ver_contract_0009',
      reservationId: 'res_contract_0010',
      quantity: 20n,
      reason: 'sale',
      occurredAt: '2026-06-01T11:00:00Z',
      correlationId: 'corr_contract_0024',
      idempotencyKey: 'idem_commit_0003',
    });

    // onHand=80, reserved=10, committed=20. reserved+committed=30. Adjust down by 51 -> onHand=29 < 30.
    const code = await codeOf(() =>
      harness.operations.adjust({
        movementId: 'mov_contract_0025',
        listingId: 'lst_contract_0009',
        versionId: 'ver_contract_0009',
        kind: 'adjust-down',
        quantity: 51n,
        reason: 'damaged stock',
        occurredAt: '2026-06-01T12:00:00Z',
        correlationId: 'corr_contract_0025',
        idempotencyKey: 'idem_adjust_0001',
      }),
    );
    assert.equal(code, 'insufficient-stock');

    // Adjust down by 50 -> onHand=30 == 30, allowed.
    const ok = await harness.operations.adjust({
      movementId: 'mov_contract_0026',
      listingId: 'lst_contract_0009',
      versionId: 'ver_contract_0009',
      kind: 'adjust-down',
      quantity: 50n,
      reason: 'damaged stock',
      occurredAt: '2026-06-01T12:01:00Z',
      correlationId: 'corr_contract_0026',
      idempotencyKey: 'idem_adjust_0002',
    });
    assert.equal(ok.availability.onHand, 30n);
  });

  test(`${subject.name}: the snapshot always equals the movement sum`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0010', 'ver_contract_0010');

    await harness.operations.receive({
      movementId: 'mov_contract_0027',
      listingId: 'lst_contract_0010',
      versionId: 'ver_contract_0010',
      quantity: 100n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0027',
      idempotencyKey: 'idem_receive_0009',
    });
    await harness.operations.reserve({
      movementId: 'mov_contract_0028',
      listingId: 'lst_contract_0010',
      versionId: 'ver_contract_0010',
      reservationId: 'res_contract_0011',
      quantity: 30n,
      reason: 'hold',
      occurredAt: '2026-06-01T10:00:00Z',
      correlationId: 'corr_contract_0028',
      idempotencyKey: 'idem_reserve_0009',
    });
    await harness.operations.commit({
      movementId: 'mov_contract_0029',
      listingId: 'lst_contract_0010',
      versionId: 'ver_contract_0010',
      reservationId: 'res_contract_0011',
      quantity: 20n,
      reason: 'sale',
      occurredAt: '2026-06-01T11:00:00Z',
      correlationId: 'corr_contract_0029',
      idempotencyKey: 'idem_commit_0004',
    });

    const movements = harness
      .movements()
      .filter((m) => m.listingId === 'lst_contract_0010' && m.versionId === 'ver_contract_0010');
    const snapshot = harness
      .snapshots()
      .find((s) => s.listingId === 'lst_contract_0010' && s.versionId === 'ver_contract_0010');
    assert.ok(snapshot !== undefined, 'snapshot must exist');

    let onHand = 0n;
    let reserved = 0n;
    let committed = 0n;
    for (const movement of movements.sort(
      (a, b) =>
        a.occurredAt.localeCompare(b.occurredAt) || a.movementId.localeCompare(b.movementId),
    )) {
      switch (movement.kind) {
        case 'receive':
        case 'adjust-up':
          onHand += movement.quantity;
          break;
        case 'adjust-down':
          onHand -= movement.quantity;
          break;
        case 'reserve':
          reserved += movement.quantity;
          break;
        case 'release':
          reserved -= movement.quantity;
          break;
        case 'commit':
          onHand -= movement.quantity;
          reserved -= movement.quantity;
          committed += movement.quantity;
          break;
      }
    }

    assert.equal(snapshot.onHand, onHand);
    assert.equal(snapshot.reserved, reserved);
    assert.equal(snapshot.committed, committed);
  });

  test(`${subject.name}: every operation is idempotent by its key`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0011', 'ver_contract_0011');

    const outboxEventsBefore = harness.outbox().filter((e) => e.kind === 'event').length;

    const receiveRequest: ReceiveRequest = {
      movementId: 'mov_contract_0030',
      listingId: 'lst_contract_0011',
      versionId: 'ver_contract_0011',
      quantity: 50n,
      reason: 'initial stock',
      occurredAt: '2026-06-01T09:00:00Z',
      correlationId: 'corr_contract_0030',
      idempotencyKey: 'idem_receive_0010',
    };
    const first = await harness.operations.receive(receiveRequest);
    const second = await harness.operations.receive(receiveRequest);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.availability, first.availability);
    assert.equal(harness.movements().length, 1);
    assert.equal(harness.outbox().filter((e) => e.kind === 'event').length, outboxEventsBefore + 1);
  });

  test(`${subject.name}: a refused operation leaves no movement, snapshot change or outbox entry`, async () => {
    const harness = await subject.create();
    await harness.setup('lst_contract_0012', 'ver_contract_0012');
    const outboxBefore = harness.outbox().length;

    await assert.rejects(
      harness.operations.reserve({
        movementId: 'mov_contract_0031',
        listingId: 'lst_contract_0012',
        versionId: 'ver_contract_0012',
        reservationId: 'res_contract_0012',
        quantity: 10n,
        reason: 'no stock',
        occurredAt: '2026-06-01T10:00:00Z',
        correlationId: 'corr_contract_0031',
        idempotencyKey: 'idem_reserve_0010',
      }),
    );

    assert.equal(harness.movements().length, 0);
    assert.equal(harness.snapshots().length, 0);
    assert.equal(harness.outbox().length, outboxBefore);
  });
}

// ---------------------------------------------------------------------------
// M-04 in-memory harness. A replacement plugs in here by providing its own
// InventoryUnderTest and calling runInventoryContract.
// ---------------------------------------------------------------------------

function buildM04Harness(): InventoryHarness {
  const repository = new InMemoryUniversalListingRepository();
  const service = new UniversalListingService(repository);

  return {
    name: 'M-04 in-memory',
    setup: async (listingId: string, versionId: string) => {
      await service.createListing({
        listingId,
        accountId: ACCOUNT,
        commerceUnitTypeId: UNIT_TYPE,
        createdAt: '2026-06-01T08:00:00Z',
        updatedAt: '2026-06-01T08:00:00Z',
        correlationId: 'corr_setup_0001',
        idempotencyKey: `idem_setup_${listingId}`,
        recordId: `rec_setup_${listingId}`,
      });
      await service.publishListing({
        versionId,
        listingId,
        title: 'Contract test listing',
        description: 'A listing created by the inventory contract test.',
        unitPriceMinor: 100n,
        currency: 'LKR',
        quantityAvailable: 0n,
        // The contract suite is about inventory movements, so its listings are the kind that has
        // inventory. A mode with no stock would make every reservation case vacuous.
        inventoryMode: 'tracked',
        attributes: {},
        publishedAt: '2026-06-01T08:01:00Z',
        correlationId: 'corr_setup_0002',
        idempotencyKey: `idem_publish_${versionId}`,
      });
    },
    operations: {
      receive: async (request) => {
        const result = await service.receiveInventory(request);
        return {
          movement: result.movement,
          availability: result.availability,
          replayed: result.replayed,
        };
      },
      adjust: async (request) => {
        const result = await service.adjustInventory(request);
        return {
          movement: result.movement,
          availability: result.availability,
          replayed: result.replayed,
        };
      },
      reserve: async (request) => {
        const result = await service.reserveInventory(request);
        return {
          movement: result.movement,
          availability: result.availability,
          replayed: result.replayed,
        };
      },
      release: async (request) => {
        const result = await service.releaseInventory(request);
        return {
          movement: result.movement,
          availability: result.availability,
          replayed: result.replayed,
        };
      },
      commit: async (request) => {
        const result = await service.commitInventory(request);
        return {
          movement: result.movement,
          availability: result.availability,
          replayed: result.replayed,
        };
      },
      getAvailability: (listingId, versionId) => service.getAvailability(listingId, versionId),
    },
    withTransaction: async <T>(body: (tx: InventoryTransaction) => Promise<T>): Promise<T> =>
      repository.withTransaction(async (tx) => {
        const transactionOps: InventoryTransaction = {
          insertMovement: (movement) => tx.insertInventoryMovement(movement),
          getAvailability: async (listingId, versionId) => {
            const snapshot = await tx.findInventorySnapshot(listingId, versionId);
            if (snapshot === null) {
              return { onHand: 0n, reserved: 0n, committed: 0n, available: 0n };
            }
            return {
              onHand: snapshot.onHand,
              reserved: snapshot.reserved,
              committed: snapshot.committed,
              available: snapshot.onHand - snapshot.reserved,
            };
          },
        };
        return body(transactionOps);
      }),
    movements: () => repository.movements(),
    snapshots: () => repository.snapshots(),
    outbox: () => repository.outbox().entries(),
  };
}

runInventoryContract({
  name: 'M-04 in-memory',
  create: () => Promise.resolve(buildM04Harness()),
});
