/**
 * Payload fingerprinting for fixture validation (FND-002d correction).
 *
 * K-08 fingerprints every event payload with SHA-256 at append, and the fingerprint is the evidence
 * that the payload was never edited. A fixture that writes an event row writes both — and if it
 * writes them inconsistently, it has seeded a row whose own evidence contradicts it. Nothing
 * downstream would notice until a consumer compared them, which is to say: at the worst possible
 * moment, in code that had no part in creating the problem.
 *
 * So the fixture validator recomputes rather than trusts. This is the algorithm, and it must stay
 * identical to `fingerprintPayload` in `kernel/event-infrastructure/service.ts`.
 *
 * **Why it is duplicated rather than imported.** `platform/` sits below `kernel/`, and the
 * layer-direction rule forbids an upward import (MODULE_MAP.md §10.1) — the platform substrate
 * cannot depend on a kernel component, and making it do so to save nine lines would invert the
 * dependency the whole architecture is arranged around. The duplication is guarded instead:
 * `tests/seed-fingerprint.test.ts` runs both implementations over a corpus, including every payload
 * in the real fixtures, and fails if they ever disagree. A divergence is caught by a test rather
 * than by a consumer.
 *
 * Owned by: FND-002d (data foundation).
 */

import { createHash } from 'node:crypto';

/**
 * SHA-256 over a payload in canonical form.
 *
 * Keys sorted, each rendered as `"key":value` with `JSON.stringify` on both halves, joined with
 * commas inside braces. Sorting is what makes the fingerprint independent of key order: two
 * payloads that differ only in how their JSON was written are the same payload, and must not
 * produce different evidence.
 */
export function fingerprintPayload(payload: Readonly<Record<string, unknown>>): string {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(payload[key] ?? null)}`)
    .join(',');
  return createHash('sha256').update(`{${canonical}}`).digest('hex');
}

/** A fingerprint is 64 lower-case hex characters, and the database `CHECK` says so too. */
export const FINGERPRINT_FORMAT = /^[0-9a-f]{64}$/;
