/**
 * K-01 Identity — the immutability boundary (FND-004a).
 *
 * One function, applied at every point a subject crosses a boundary: the service's results, every
 * in-memory seed, read and write, and the PostgreSQL decoder. One boundary rather than a freeze at
 * each site, because a rule applied in six places is a rule that will be applied in five after the
 * next change — which is how K-09 shipped with a frozen record whose `actor` was still writable
 * (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * `sealSubject` both **clones and freezes**. The two halves do different work:
 *
 *   - *Cloning* severs the caller's reference. A shallow `{ ...subject }` produces a new top level
 *     over the *same* `origin` object, so storing a caller's subject and then letting the caller
 *     edit its origin edits what was stored, after the fact, with nothing to see.
 *   - *Freezing* makes the attempt throw rather than fail silently, which is the difference between
 *     a caller learning it did something wrong and a caller believing it worked.
 *
 * Owned by: K-01 Identity.
 */

import type { IdentityOrigin, IdentitySubject } from './types.ts';

/**
 * A deep, frozen copy of a subject.
 *
 * `origin` is the only nested object; everything else is a scalar. Idempotent, so callers may seal
 * defensively without checking whether somebody already did.
 */
export function sealSubject(subject: IdentitySubject): IdentitySubject {
  return Object.freeze({
    ...subject,
    origin: sealOrigin(subject.origin),
  });
}

/** The same for a list. */
export function sealSubjects(subjects: readonly IdentitySubject[]): readonly IdentitySubject[] {
  return Object.freeze(subjects.map(sealSubject));
}

export function sealOrigin(origin: IdentityOrigin): IdentityOrigin {
  return Object.freeze({ ...origin });
}

/**
 * Is this subject sealed all the way down?
 *
 * Exported so a test can assert the property directly rather than by attempting one mutation and
 * hoping that attempt was representative of the rest.
 */
export function isSealed(subject: IdentitySubject): boolean {
  return Object.isFrozen(subject) && Object.isFrozen(subject.origin);
}
