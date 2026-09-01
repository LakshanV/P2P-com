/**
 * Establishing a stock reservation for an order line, instead of believing the client about one.
 *
 * The defect this closes: `POST /v1/orders/{id}/items` read `reservationId` **out of the request
 * body**. A client could send any string and M-11 recorded it, so an order line could claim stock
 * that nothing was holding — and the order would then be placed, paid for and fulfilled against
 * inventory that had never been set aside. It is the same shape as the webhook route that read
 * `signatureVerified` from its caller: the layer above let the attacker answer the question.
 *
 * **The authoritative reservation identifier is minted here and never accepted from a caller.** A
 * body that carries `reservationId` is refused by name, in the same way K-04 refuses a caller who
 * says `allowed: true`. Whoever asserts the check has not done it.
 *
 * **Whether a line needs a reservation is a property of the offer, not of the request.** M-04's
 * version carries an `inventoryMode`; `requiresReservation` answers the only question this layer
 * has. A service, a made-to-order part, a supplier-direct machine and a digital entitlement each
 * take a different path and none of them holds JAYA stock, so demanding a reservation for them
 * would make the platform unable to sell them. Equally, *not* demanding one for a tracked good is
 * how stock gets sold twice. Neither is a client's decision.
 *
 * **A caller may present an existing reservation, and it is verified rather than trusted.** The
 * normal purchase flow does not use this — the server creates the reservation — but a reservation
 * held from a quote or a cart is a real case, and the seven checks below are what make presenting
 * one safe. Each one is a way somebody else's reservation, or a stale one, or one for a different
 * thing entirely, could otherwise be attached to an order.
 *
 * Owned by: apps/api.
 */

import type { OrderService } from '../../modules/orders/index.ts';
import {
  requiresReservation,
  type ListingVersion,
  type UniversalListingService,
} from '../../modules/universal-listing/index.ts';

import { ApiError } from './errors.ts';

/**
 * Fields a caller may not send on an order line.
 *
 * `reservationId` is the one that mattered. The rest are the shapes somebody reaches for next when
 * the first is refused, and refusing them by name is cheaper than discovering which one a client
 * guessed.
 */
const ASSERTED_RESERVATION_FIELDS: readonly string[] = [
  'reservationId',
  'reservation_id',
  'reserved',
  'stockReserved',
  'inventoryReserved',
];

export function assertDoesNotAssertReservation(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  for (const field of ASSERTED_RESERVATION_FIELDS) {
    if (field in (body as Record<string, unknown>)) {
      throw new ApiError(
        400,
        'caller-asserted-reservation',
        `"${field}" is not a field a caller may send. Whether stock is held for this line is ` +
          'established here, against M-04, and a client that could assert it would be a client ' +
          'that could order goods nothing was holding.',
      );
    }
  }
}

/** What the line needs, and what was done about it. */
export interface LineReservation {
  /** The authoritative reservation, or null when this offer holds no JAYA stock. */
  readonly reservationId: string | null;
  /** The version the line is pinned to, read back from M-04 rather than taken from the request. */
  readonly version: ListingVersion;
  /** True when this call created the reservation, false when an existing one was verified. */
  readonly created: boolean;
}

export interface ReservationOptions {
  readonly listings: UniversalListingService;
  readonly orders: OrderService;
  /** The account the caller's session resolved to. Never read from the request. */
  readonly accountId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly quantity: bigint;
  /** Identifiers derived from the request context, so a retry converges on the same reservation. */
  readonly reservationId: string;
  readonly movementId: string;
  readonly now: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * Establish the reservation for one order line.
 *
 * Reads the pinned version from M-04 first, because everything after depends on what was actually
 * offered rather than on what the request said about it.
 */
export async function reserveForLine(options: ReservationOptions): Promise<LineReservation> {
  const version = await requireVersion(options);

  if (!requiresReservation(version.inventoryMode)) {
    // A service, a made-to-order part, a supplier-direct machine or a digital entitlement. There is
    // no JAYA stock to hold, and holding none is the correct answer rather than a missing step.
    return { reservationId: null, version, created: false };
  }

  try {
    await options.listings.reserveInventory({
      movementId: options.movementId,
      listingId: options.listingId,
      versionId: options.versionId,
      // Minted from the request context, never from the body. This is the whole fix.
      reservationId: options.reservationId,
      quantity: options.quantity,
      reason: 'order-line',
      occurredAt: options.now,
      correlationId: options.correlationId,
      idempotencyKey: options.idempotencyKey,
    });
  } catch (error) {
    throw asReservationError(error, options);
  }

  return { reservationId: options.reservationId, version, created: true };
}

/**
 * The pinned version, or a refusal.
 *
 * Read back from M-04 rather than believed. A request naming a version that belongs to a different
 * listing, or one that has been superseded, is refused here rather than reserved against.
 */
async function requireVersion(options: ReservationOptions): Promise<ListingVersion> {
  const version = await options.listings.getVersion(options.versionId);
  if (version === null || version.listingId !== options.listingId) {
    // Absent and mismatched are answered identically: telling a caller which of the two it was
    // would confirm that some other listing owns that version.
    throw new ApiError(
      404,
      'no-such-version',
      'No such listing version. A line is pinned to the exact terms it was offered under, so the ' +
        'version must belong to the listing named.',
    );
  }
  return version;
}

/**
 * Turn an M-04 refusal into an HTTP one.
 *
 * `insufficient-stock` is a 409 rather than a 422: it is a conflict with the current state of the
 * world, and it may well succeed on a retry after somebody else's order is cancelled. A client that
 * saw 422 would reasonably stop trying.
 */
function asReservationError(error: unknown, options: ReservationOptions): unknown {
  const code = (error as { code?: unknown }).code;
  if (code === 'insufficient-stock') {
    return new ApiError(
      409,
      'insufficient-stock',
      `There is not enough stock of that version to reserve ${String(options.quantity)}. The line ` +
        'was not added and nothing was held.',
    );
  }
  if (code === 'version-not-current') {
    return new ApiError(
      409,
      'version-not-current',
      'That version has been superseded. An order line pins the terms it was offered under, so a ' +
        'line against an old version is refused rather than quietly moved to the new one.',
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// Presenting an existing reservation
// ---------------------------------------------------------------------------

/**
 * What a caller must satisfy to attach a reservation it already holds.
 *
 * The normal purchase flow does not go through here: the server creates the reservation, and that
 * is the path to prefer. This exists because a reservation held from a quote or a cart is real, and
 * because "we will support it later" tends to mean "we will support it later without the checks".
 *
 * Every one of these is a distinct way somebody else's reservation could be attached to an order:
 *
 *   1. it exists at all;
 *   2. it belongs to the caller's own account;
 *   3. it is against the exact listing and version this line pins;
 *   4. it covers at least the quantity being ordered;
 *   5. it is still open — not released, not already committed;
 *   6. it has not expired;
 *   7. no other order line has already consumed it.
 *
 * Missing any one of them turns "present your reservation" into "name any reservation".
 */
export interface PresentedReservation {
  readonly reservationId: string;
  readonly accountId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly quantity: bigint;
}

export type ReservationRefusalCode =
  | 'no-such-reservation'
  | 'reservation-not-yours'
  | 'reservation-wrong-item'
  | 'reservation-too-small'
  | 'reservation-not-open'
  | 'reservation-expired'
  | 'reservation-already-used';

/**
 * Verify a presented reservation against the line it is being attached to.
 *
 * Every refusal is the **same** status and a distinct code. The status is deliberately uniform:
 * "that reservation is not yours" and "there is no such reservation" must not be distinguishable by
 * status, or the endpoint becomes a way to discover which reservation identifiers exist.
 */
export async function verifyPresentedReservation(options: {
  readonly held: PresentedReservation | null;
  readonly accountId: string;
  readonly listingId: string;
  readonly versionId: string;
  readonly quantity: bigint;
  readonly status: 'open' | 'released' | 'committed';
  readonly expiresAt: string | null;
  readonly now: string;
  /** Whether any order line already names this reservation. */
  readonly alreadyUsed: boolean;
}): Promise<void> {
  const refuse = (code: ReservationRefusalCode, detail: string): never => {
    throw new ApiError(409, code, detail);
  };

  if (options.held === null) {
    refuse('no-such-reservation', 'That reservation cannot be used for this line.');
  }
  const held = options.held as PresentedReservation;

  if (held.accountId !== options.accountId) {
    // Same status, different code, and a detail that says nothing about whose it is.
    refuse('reservation-not-yours', 'That reservation cannot be used for this line.');
  }
  if (held.listingId !== options.listingId || held.versionId !== options.versionId) {
    refuse(
      'reservation-wrong-item',
      'That reservation is against different terms from the line it would be attached to.',
    );
  }
  if (held.quantity < options.quantity) {
    refuse(
      'reservation-too-small',
      `That reservation holds ${String(held.quantity)} and the line is for ` +
        `${String(options.quantity)}.`,
    );
  }
  if (options.status !== 'open') {
    refuse(
      'reservation-not-open',
      `That reservation has been ${options.status} and no longer holds anything.`,
    );
  }
  if (options.expiresAt !== null && Date.parse(options.expiresAt) <= Date.parse(options.now)) {
    refuse('reservation-expired', 'That reservation has expired and no longer holds anything.');
  }
  if (options.alreadyUsed) {
    // The one that turns a reservation into a coupon: without it, one held quantity could be
    // attached to line after line and every one of them would look reserved.
    refuse('reservation-already-used', 'That reservation has already been used by another line.');
  }

  return Promise.resolve();
}
