/**
 * M-48 — the immutability boundary.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

import type {
  DirectoryEntry,
  DirectoryEvent,
  DirectoryProfile,
  SupplierFacet,
  SupplierLocation,
} from './types.ts';

export function sealEntry(entry: DirectoryEntry): DirectoryEntry {
  return Object.freeze({ ...entry });
}

export function sealEntries(entries: readonly DirectoryEntry[]): readonly DirectoryEntry[] {
  return Object.freeze(entries.map(sealEntry));
}

export function sealFacet(facet: SupplierFacet): SupplierFacet {
  return Object.freeze({ ...facet });
}

export function sealFacets(facets: readonly SupplierFacet[]): readonly SupplierFacet[] {
  return Object.freeze(facets.map(sealFacet));
}

export function sealLocation(location: SupplierLocation): SupplierLocation {
  return Object.freeze({ ...location });
}

export function sealLocations(locations: readonly SupplierLocation[]): readonly SupplierLocation[] {
  return Object.freeze(locations.map(sealLocation));
}

export function sealDirectoryEvent(event: DirectoryEvent): DirectoryEvent {
  return Object.freeze({ ...event });
}

export function sealDirectoryEvents(events: readonly DirectoryEvent[]): readonly DirectoryEvent[] {
  return Object.freeze(events.map(sealDirectoryEvent));
}

/**
 * A profile carries four arrays of declared codes, so a shallow freeze would hand a caller a frozen
 * wrapper around a mutable list of what a supplier said they do — and a match explanation is judged
 * against exactly that list.
 */
export function sealProfile(profile: DirectoryProfile): DirectoryProfile {
  return Object.freeze({
    entry: sealEntry(profile.entry),
    categories: Object.freeze([...profile.categories]),
    brands: Object.freeze([...profile.brands]),
    capabilities: Object.freeze([...profile.capabilities]),
    districts: Object.freeze([...profile.districts]),
  });
}

export function sealProfiles(profiles: readonly DirectoryProfile[]): readonly DirectoryProfile[] {
  return Object.freeze(profiles.map(sealProfile));
}
