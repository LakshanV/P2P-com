/**
 * K-04 Permissions — the three things this component refuses to determine itself (FND-004d).
 *
 * Each port exists because the alternative is that K-04 believes its caller:
 *
 *   - **`SessionValidator`** turns a presented session secret into an asserted subject. K-04 must
 *     not take a `subjectId` from a request, because a caller that could name the subject could
 *     authorise itself as anybody. K-02's `AuthenticationService.validate` satisfies this
 *     structurally, and `tests/permissions.test.ts` wires the real one to prove it.
 *   - **`AccountLookup`** turns a subject into the K-03 universal account authority is scoped to.
 *     Same reason: an `accountId` accepted from the caller is cross-account access with extra
 *     steps. K-03's `AccountService.findAccountForSubject` satisfies it structurally.
 *   - **`Clock`** supplies "now". Temporal validity, expiry and revocation are all functions of
 *     time, so a component that read the wall clock would have tests that pass in the morning.
 *
 * The session port is deliberately **provider-neutral**: it names no K-02 type and imports
 * nothing from K-02, so a different authentication component could satisfy it. What it does
 * require is enough to re-check the session's own claims — K-04 verifies expiry and revocation
 * itself rather than trusting that the validator did, because deny-by-default means not assuming
 * somebody else's check ran.
 *
 * Owned by: K-04 Permissions.
 */

import { PermissionError } from './types.ts';

/**
 * What a session validator asserts about a presented secret.
 *
 * Every field is re-checked here. A validator that returns a revoked or expired session is
 * refused rather than believed — the port is a source of claims, not a source of truth.
 */
export interface SessionAssertion {
  readonly sessionId: string;
  readonly subjectId: string;
  /** One of K-04's `ASSURANCE_LEVELS`. An unknown value is refused rather than ranked lowest. */
  readonly assurance: string;
  readonly factors: readonly string[];
  readonly issuedAt: string;
  readonly absoluteExpiresAt: string;
  readonly idleExpiresAt: string;
  readonly revokedAt: string | null;
}

/**
 * The authority on whether a presented session secret is good, and whose it is.
 *
 * A validator that throws has refused. K-04 normalises the throw into `invalid-session` **without
 * inspecting it**, because a session error can carry a fragment of the secret in its message and
 * this component has no business repeating one.
 */
export interface SessionValidator {
  validate(presentedToken: string): Promise<SessionAssertion>;
}

/** The K-03 account a subject holds, or null. Narrower than K-03's record on purpose. */
export interface AccountAssertion {
  readonly accountId: string;
  readonly subjectId: string;
}

export interface AccountLookup {
  findAccountForSubject(subjectId: string): Promise<AccountAssertion | null>;
}

/** "Now", as a canonical UTC instant. */
export interface Clock {
  now(): string;
}

/**
 * A validator that refuses every session, and the default when none is wired.
 *
 * Fails closed: a caller with no authentication component wired authorises nobody, rather than
 * quietly treating every request as anonymous-but-fine.
 */
export const NO_SESSIONS: SessionValidator = {
  validate(): Promise<SessionAssertion> {
    return Promise.reject(
      new PermissionError(
        'invalid-session',
        'no session validator is wired, so no session can be validated and nothing is authorised',
      ),
    );
  },
};

/**
 * A lookup that reports no account at all.
 *
 * The same fail-closed default. Authority is scoped to an account; a subject with no account has
 * nothing to be authorised within.
 */
export const NO_ACCOUNTS: AccountLookup = {
  findAccountForSubject(): Promise<AccountAssertion | null> {
    return Promise.resolve(null);
  },
};
