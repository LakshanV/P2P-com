/**
 * Shared fixtures for the M-04 Universal Listing suites.
 *
 * Every identifier and every instant is supplied here rather than read from a clock, so a replayed
 * request produces a byte-identical record and the suites need no fake timers. Money is `bigint`
 * minor units throughout — a fixture that used a JavaScript number would quietly teach the suites a
 * habit the module refuses.
 */

import {
  InMemoryUniversalListingRepository,
  UniversalListingService,
  type AddDeclarationRequest,
  type AddMediaRequest,
  type CreateListingRequest,
  type Listing,
  type ListingDeclaration,
  type ListingMedia,
  type ListingVersion,
  type PublishListingRequest,
  type SuspendListingRequest,
  type WithdrawListingRequest,
} from '../../modules/universal-listing/index.ts';

export interface Harness {
  readonly service: UniversalListingService;
  readonly repository: InMemoryUniversalListingRepository;
}

export function build(): Harness {
  const repository = new InMemoryUniversalListingRepository();
  return { service: new UniversalListingService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

/** A stable supplying account, so several listings can be made by one supplier. */
export const ACCOUNT = 'acct_01HQZXA0001';

/** A stable K-11 commerce unit type. */
export const UNIT_TYPE = 'cut_01HQZXA0001';

export function createRequest(overrides: Partial<CreateListingRequest> = {}): CreateListingRequest {
  const n = seq();
  return {
    listingId: `lst_01HQZXA${n}`,
    accountId: ACCOUNT,
    commerceUnitTypeId: UNIT_TYPE,
    createdAt: '2026-06-01T09:00:00Z',
    updatedAt: '2026-06-01T09:00:00Z',
    correlationId: `corr_01HQZXA${n}`,
    idempotencyKey: `idem_create_${n}`,
    recordId: `rec_01HQZXA${n}`,
    ...overrides,
  };
}

export function publishRequest(
  listingId: string,
  overrides: Partial<PublishListingRequest> = {},
): PublishListingRequest {
  const n = seq();
  return {
    versionId: `ver_01HQZXP${n}`,
    listingId,
    title: 'Ceylon cinnamon, Alba grade, 500g',
    description: 'Hand-rolled quills from a single estate in Matale, harvested this season.',
    unitPriceMinor: 249_500n,
    currency: 'LKR',
    quantityAvailable: 40n,
    // Cinnamon on a shelf: ordinary physical stock. Fixtures that mean something else say so.
    inventoryMode: 'tracked',
    attributes: { grade: 'alba', originDistrict: 'matale' },
    publishedAt: '2026-06-02T09:00:00Z',
    correlationId: `corr_01HQZXP${n}`,
    idempotencyKey: `idem_publish_${n}`,
    ...overrides,
  };
}

export function mediaRequest(
  listingId: string,
  versionId: string,
  overrides: Partial<AddMediaRequest> = {},
): AddMediaRequest {
  const n = seq();
  return {
    mediaId: `med_01HQZXM${n}`,
    listingId,
    versionId,
    kind: 'image',
    reference: `mediaref_01HQZXM${n}`,
    position: 0,
    caption: 'The quills, photographed against a plain background',
    addedAt: '2026-06-02T10:00:00Z',
    correlationId: `corr_01HQZXM${n}`,
    idempotencyKey: `idem_media_${n}`,
    ...overrides,
  };
}

export function declarationRequest(
  listingId: string,
  versionId: string,
  overrides: Partial<AddDeclarationRequest> = {},
): AddDeclarationRequest {
  const n = seq();
  return {
    declarationId: `dec_01HQZXD${n}`,
    listingId,
    versionId,
    kind: 'origin',
    statement: 'Grown and processed in Matale district, Sri Lanka, on a single estate.',
    declaredAt: '2026-06-02T10:30:00Z',
    correlationId: `corr_01HQZXD${n}`,
    idempotencyKey: `idem_decl_${n}`,
    ...overrides,
  };
}

export function suspendRequest(
  listingId: string,
  overrides: Partial<SuspendListingRequest> = {},
): SuspendListingRequest {
  const n = seq();
  return {
    listingId,
    reason: 'the supplier asked for the offer to be paused during a stock count',
    occurredAt: '2026-06-05T09:00:00Z',
    correlationId: `corr_01HQZXS${n}`,
    idempotencyKey: `idem_suspend_${n}`,
    recordId: `rec_01HQZXS${n}`,
    ...overrides,
  };
}

export function withdrawRequest(
  listingId: string,
  overrides: Partial<WithdrawListingRequest> = {},
): WithdrawListingRequest {
  const n = seq();
  return {
    listingId,
    reason: 'the estate sold its whole season to one buyer',
    occurredAt: '2026-06-06T09:00:00Z',
    correlationId: `corr_01HQZXW${n}`,
    idempotencyKey: `idem_withdraw_${n}`,
    recordId: `rec_01HQZXW${n}`,
    ...overrides,
  };
}

export function listingRecord(overrides: Partial<Listing> = {}): Listing {
  const n = seq();
  return {
    listingId: `lst_01HQZXL${n}`,
    accountId: ACCOUNT,
    commerceUnitTypeId: UNIT_TYPE,
    status: 'draft',
    currentVersion: 0,
    createdAt: '2026-06-01T09:00:00Z',
    updatedAt: '2026-06-01T09:00:00Z',
    publishedAt: null,
    withdrawnAt: null,
    correlationId: `corr_01HQZXL${n}`,
    idempotencyKey: `idem_lrec_${n}`,
    ...overrides,
  };
}

export function versionRecord(overrides: Partial<ListingVersion> = {}): ListingVersion {
  const n = seq();
  return {
    versionId: `ver_01HQZXV${n}`,
    listingId: `lst_01HQZXV${n}`,
    versionNumber: 1,
    title: 'Ceylon cinnamon, Alba grade, 500g',
    description: 'Hand-rolled quills from a single estate.',
    unitPriceMinor: 249_500n,
    currency: 'LKR',
    quantityAvailable: 40n,
    // Cinnamon on a shelf: ordinary physical stock. Fixtures that mean something else say so.
    inventoryMode: 'tracked',
    attributes: {},
    publishedAt: '2026-06-02T09:00:00Z',
    correlationId: `corr_01HQZXV${n}`,
    idempotencyKey: `idem_vrec_${n}`,
    ...overrides,
  };
}

export function mediaRecord(overrides: Partial<ListingMedia> = {}): ListingMedia {
  const n = seq();
  return {
    mediaId: `med_01HQZXN${n}`,
    listingId: `lst_01HQZXN${n}`,
    versionId: `ver_01HQZXN${n}`,
    kind: 'image',
    reference: `mediaref_01HQZXN${n}`,
    position: 0,
    caption: 'A photograph of the goods',
    addedAt: '2026-06-02T10:00:00Z',
    correlationId: `corr_01HQZXN${n}`,
    idempotencyKey: `idem_mrec_${n}`,
    ...overrides,
  };
}

export function declarationRecord(overrides: Partial<ListingDeclaration> = {}): ListingDeclaration {
  const n = seq();
  return {
    declarationId: `dec_01HQZXE${n}`,
    listingId: `lst_01HQZXE${n}`,
    versionId: `ver_01HQZXE${n}`,
    kind: 'condition',
    statement: 'New, unopened, in the original packaging.',
    declaredAt: '2026-06-02T10:30:00Z',
    correlationId: `corr_01HQZXE${n}`,
    idempotencyKey: `idem_drec_${n}`,
    ...overrides,
  };
}

/** The outbox entries of one kind, oldest first, as the relay would read them. */
export function entriesOfKind(
  repository: InMemoryUniversalListingRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}

/** The `type` of every event entry, oldest first. */
export function eventTypes(repository: InMemoryUniversalListingRepository): readonly string[] {
  return entriesOfKind(repository, 'event').map(
    (entry) => (entry.payload as { type: string }).type,
  );
}

/** The business payload of the most recent event. */
export function lastEventPayload(
  repository: InMemoryUniversalListingRepository,
): Record<string, unknown> {
  const entry = entriesOfKind(repository, 'event').at(-1);
  return (entry?.payload as { payload: Record<string, unknown> }).payload;
}
