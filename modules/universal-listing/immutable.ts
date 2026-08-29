/**
 * M-04 Universal Listing — slice A immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Listing versions, media and declarations are append-only; the listing
 * row itself is updated only through the service's lifecycle operations. The only defence against
 * silent mutation at the boundary is to make mutation throw.
 *
 * Owned by: M-04 Universal Listing.
 */

import type { Listing, ListingDeclaration, ListingMedia, ListingVersion } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealRecord));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of a listing. */
export function sealListing(listing: Listing): Listing {
  return Object.freeze({ ...listing });
}

/** A deep, frozen copy of a listing version. */
export function sealListingVersion(version: ListingVersion): ListingVersion {
  return Object.freeze({
    versionId: version.versionId,
    listingId: version.listingId,
    versionNumber: version.versionNumber,
    title: version.title,
    description: version.description,
    unitPriceMinor: version.unitPriceMinor,
    currency: version.currency,
    quantityAvailable: version.quantityAvailable,
    attributes: sealRecord(version.attributes) as Readonly<Record<string, unknown>>,
    publishedAt: version.publishedAt,
    correlationId: version.correlationId,
    idempotencyKey: version.idempotencyKey,
  });
}

/** A deep, frozen copy of a media reference. */
export function sealListingMedia(media: ListingMedia): ListingMedia {
  return Object.freeze({ ...media });
}

/** A deep, frozen copy of a declaration. */
export function sealListingDeclaration(declaration: ListingDeclaration): ListingDeclaration {
  return Object.freeze({ ...declaration });
}

/** Frozen copies of a list of listings. */
export function sealListings(listings: readonly Listing[]): readonly Listing[] {
  return Object.freeze(listings.map(sealListing));
}

/** Frozen copies of a list of listing versions. */
export function sealListingVersions(
  versions: readonly ListingVersion[],
): readonly ListingVersion[] {
  return Object.freeze(versions.map(sealListingVersion));
}

/** Frozen copies of a list of media references. */
export function sealListingMedias(medias: readonly ListingMedia[]): readonly ListingMedia[] {
  return Object.freeze(medias.map(sealListingMedia));
}

/** Frozen copies of a list of declarations. */
export function sealListingDeclarations(
  declarations: readonly ListingDeclaration[],
): readonly ListingDeclaration[] {
  return Object.freeze(declarations.map(sealListingDeclaration));
}

/** Is this listing sealed? */
export function isListingSealed(listing: Listing): boolean {
  return Object.isFrozen(listing);
}

/** Is this listing version sealed? */
export function isListingVersionSealed(version: ListingVersion): boolean {
  return Object.isFrozen(version) && Object.isFrozen(version.attributes);
}

/** Is this media reference sealed? */
export function isListingMediaSealed(media: ListingMedia): boolean {
  return Object.isFrozen(media);
}

/** Is this declaration sealed? */
export function isListingDeclarationSealed(declaration: ListingDeclaration): boolean {
  return Object.isFrozen(declaration);
}
