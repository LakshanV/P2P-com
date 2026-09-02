/**
 * A whole identity stack, so an API test can sign a person in and then call the API as them.
 *
 * Everything here is the **real** component: K-01 mints the subject, K-03 opens the account, K-02
 * holds a scrypt hash and issues the session, K-04 publishes the policy and evaluates the grants.
 * Nothing is stubbed. That matters because the thing under test is precisely whether those four
 * agree with each other, and four stubs that agree prove nothing.
 *
 * The one concession to speed is `TEST_ONLY_FAST_PARAMETERS`: production scrypt costs ~128 MB and a
 * few hundred milliseconds per verification, and a suite that signed twenty people in at that cost
 * would be a suite somebody deletes.
 *
 * The first administration grant is written straight through the repository port, exactly as
 * `tests/helpers/permission-fixtures.ts` does and for the same reason: bootstrap installs the rules
 * and hands nobody authority under them, so somebody has to write the first grant out of band. An
 * operator does this once. It is visible here rather than behind a service method that anybody could
 * call.
 */

import { AccountService, InMemoryAccountRepository } from '../../kernel/accounts/index.ts';
import {
  AuthenticationService,
  InMemoryAuthenticationRepository,
  InMemoryPasswordCredentialStore,
  PasswordVerifier,
  ProviderRegistry,
  TEST_ONLY_FAST_PARAMETERS,
} from '../../kernel/authentication/index.ts';
import { IdentityService, InMemoryIdentityRepository } from '../../kernel/identity/index.ts';
import {
  InMemoryPermissionRepository,
  PermissionService,
  fingerprintAdministrationRequest,
  type BootstrapAuthority,
  type PermissionRepository,
  type Grant,
} from '../../kernel/permissions/index.ts';
import { JAYA_V1_ROLES, jayaV1PolicyRequest } from '../../apps/api/policy.ts';
import type { ApiAccess } from '../../apps/api/app.ts';

/** The clock the whole stack shares. A test moves it by hand when it wants a session to expire. */
export class MovableClock {
  #now: string;

  constructor(now: string) {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }

  set(instant: string): void {
    this.#now = instant;
  }
}

export interface SignedIn {
  readonly subjectId: string;
  readonly accountId: string;
  readonly sessionId: string;
  /** The bearer token, revealed once by K-02 and held here for the test to send. */
  readonly token: string;
}

export interface IdentityStack extends ApiAccess {
  readonly identity: IdentityService;
  readonly authentication: AuthenticationService;
  /**
   * The same object as `accounts`, at its concrete type.
   *
   * `ApiAccess` needs only K-04's `AccountLookup`; registration needs to *open* an account, which
   * is a wider surface. Exposed rather than re-created so a suite cannot end up with two account
   * services that disagree about who exists.
   */
  readonly accountService: AccountService;
  /** Enrolling a password. Registration sets one; the verifier only ever checks them. */
  readonly passwords: PasswordVerifier;
  /**
   * The administrator's session secret.
   *
   * K-04 has no bootstrap path for a grant, so self-service registration is made under somebody's
   * authority. In a suite that somebody is this fixture's administrator; in production it is a
   * credential the deployment configures.
   */
  readonly administratorToken: string;
  readonly permissionRepository: PermissionRepository;
  readonly clock: MovableClock;
  readonly policyVersionId: string;
  /**
   * Create a person, open their account, set a password, grant them roles, and sign them in.
   *
   * Returns what a client would hold after signing in: a token, and nothing else it did not earn.
   */
  register(options: {
    readonly handle: string;
    readonly password?: string;
    /** Roles to grant, scoped to this person's own account. Empty means a session with no authority. */
    readonly roles?: readonly string[];
    /**
     * Use these identifiers rather than ones derived from the handle.
     *
     * For a suite that already names the accounts its fixtures trade between: the account has to be
     * a real K-03 account owned by a real K-01 subject before anybody can be authorised within it,
     * and inventing a second set of ids would mean the person signing in and the account on the
     * order were different things.
     */
    readonly accountId?: string;
    readonly subjectId?: string;
  }): Promise<SignedIn>;
  /** Sign an existing person in again, for a test about two live sessions. */
  signIn(handle: string, password?: string): Promise<SignedIn>;
}

const START = '2026-07-01T09:00:00.000000Z';
const DEFAULT_PASSWORD = 'a-password-long-enough-to-be-accepted';

/** The operator authority that permits the one bootstrap publication. A real deployment injects its own. */
const BOOTSTRAP: BootstrapAuthority = Object.freeze({
  authorityId: 'jaya-api-test-bootstrap',
  permitsBootstrap: () => true,
});

/**
 * Opaque, deterministic identifiers derived from a handle.
 *
 * K-01 refuses anything that looks like a natural identifier, so a handle is folded into an opaque
 * suffix rather than used directly — which is also what stops a test's fixture names leaking into
 * records that a person's data would sit next to.
 */
function opaque(prefix: string, handle: string, width: number): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  let hash = 0x811c9dc5;
  for (let index = 0; index < handle.length; index += 1) {
    hash = Math.imul(hash ^ handle.charCodeAt(index), 0x01000193) >>> 0;
  }
  let out = '';
  let value = hash;
  for (let index = 0; index < width; index += 1) {
    out += alphabet[value % alphabet.length] ?? 'A';
    value = Math.floor(value / alphabet.length) + index + 1;
  }
  return `${prefix}_01HR${out}`;
}

/**
 * Repositories to use instead of the in-memory ones.
 *
 * The integration suite passes PostgreSQL-backed repositories, so the guard it exercises is the one
 * a deployment runs: real sessions read back out of a real database, over a real socket.
 */
export interface StackRepositories {
  readonly identity: ConstructorParameters<typeof IdentityService>[0];
  readonly accounts: ConstructorParameters<typeof AccountService>[0];
  readonly authentication: ConstructorParameters<typeof AuthenticationService>[0]['repository'];
  readonly permissions: ConstructorParameters<typeof PermissionService>[0]['repository'];
}

export interface StackOptions {
  readonly now?: string;
  readonly repositories?: StackRepositories;
  /**
   * A discriminator folded into every identifier the stack mints.
   *
   * The integration suite runs against a database that survives between tests, so two runs that
   * derived the same subject id from the same handle would collide on the second.
   */
  readonly namespace?: string;
}

export async function identityStack(
  nowOrOptions: string | StackOptions = START,
): Promise<IdentityStack> {
  const options: StackOptions =
    typeof nowOrOptions === 'string' ? { now: nowOrOptions } : nowOrOptions;
  const now = options.now ?? START;
  const clock = new MovableClock(now);
  const salt = options.namespace ?? '';

  const identity = new IdentityService(
    options.repositories?.identity ?? new InMemoryIdentityRepository(),
  );
  const accounts = new AccountService(
    options.repositories?.accounts ?? new InMemoryAccountRepository(),
    identity,
  );
  const credentials = new InMemoryPasswordCredentialStore();

  // Every identifier this stack mints carries the namespace, so an integration run against a
  // database that outlives the test does not collide with the run before it.
  const id = (prefix: string, of: string, width = 9): string =>
    opaque(prefix, `${salt}:${of}`, width);
  const ADMIN_SUBJECT = id('sub', 'admin', 10);
  const ADMIN_ACCOUNT = id('acct', 'admin');
  const POLICY_VERSION = id('pol', 'v1-policy');
  const ADMIN_REFERENCE = id('pref', 'admin');

  let assertionCounter = 0;
  const passwords = new PasswordVerifier({
    store: credentials,
    now: () => clock.now(),
    newAssertionId: () => {
      assertionCounter += 1;
      return `asrt_01HR0API${String(assertionCounter).padStart(6, '0')}`;
    },
    parameters: TEST_ONLY_FAST_PARAMETERS,
  });

  let tokenCounter = 0;
  const authentication = new AuthenticationService({
    repository: options.repositories?.authentication ?? new InMemoryAuthenticationRepository(),
    providers: new ProviderRegistry([
      { provider: 'password', description: 'A password, verified against a scrypt hash by K-02.' },
    ]),
    verifiers: [passwords],
    subjects: identity,
    clock,
    entropy: {
      token: () => {
        tokenCounter += 1;
        // Deterministic, and past K-02's 43-character floor — it refuses a shorter secret rather
        // than issuing a guessable session, which is the right refusal and worth not tripping over.
        // A suite that generated real entropy would be a suite whose failures could not be
        // reproduced.
        return `tok${'S'.repeat(44)}${String(tokenCounter).padStart(4, '0')}`;
      },
    },
  });

  const permissionRepository =
    options.repositories?.permissions ?? new InMemoryPermissionRepository();
  const permissions = new PermissionService({
    repository: permissionRepository,
    sessions: authentication,
    accounts,
    clock,
    bootstrap: BOOTSTRAP,
  });

  // Bootstrap: the rules, then the first administrator who can grant under them.
  await permissions.publishPolicy(
    jayaV1PolicyRequest({
      policyVersionId: POLICY_VERSION,
      version: 1,
      idempotencyKey: id('idem', 'policy'),
    }),
  );

  await identity.create({
    subjectId: ADMIN_SUBJECT,
    kind: 'person',
    createdAt: now,
    origin: { kind: 'system', id: 'K-01-identity-service' },
    idempotencyKey: id('idem', 'admin-subject'),
  });
  await accounts.open({
    accountId: ADMIN_ACCOUNT,
    subjectId: ADMIN_SUBJECT,
    createdAt: now,
    origin: { kind: 'system', id: 'K-03-account-service' },
    idempotencyKey: id('idem', 'admin-account'),
  });

  const firstGrant: Grant = {
    grantId: id('grant', 'first-admin'),
    subjectId: ADMIN_SUBJECT,
    accountId: ADMIN_ACCOUNT,
    role: 'ADMIN',
    effect: 'allow',
    action: 'grant-permission',
    resourceType: 'permission',
    resourceId: null,
    purpose: 'system-maintenance',
    condition: null,
    policyVersionId: POLICY_VERSION,
    grantedAt: now,
    notBefore: null,
    expiresAt: null,
    grantedBy: { kind: 'system', id: BOOTSTRAP.authorityId },
    idempotencyKey: id('idem', 'first-grant'),
    requestFingerprint: fingerprintAdministrationRequest({
      operation: 'grant',
      recordId: id('grant', 'first-admin'),
      actorSubjectId: BOOTSTRAP.authorityId,
      actorSessionId: BOOTSTRAP.authorityId,
      actorAccountId: BOOTSTRAP.authorityId,
      bootstrap: false,
      purpose: 'system-maintenance',
      content: 'first-administrator',
    }),
  };
  await permissionRepository.withTransaction((tx) => tx.insertGrant(firstGrant));

  // The administrator's own session, used to make every grant below. Grants are made *by* somebody
  // K-04 can name, which is why this exists rather than more writes through the repository.
  await passwords.setPassword(ADMIN_REFERENCE, DEFAULT_PASSWORD);
  await authentication.bind({
    bindingId: id('bind', 'admin'),
    subjectId: ADMIN_SUBJECT,
    provider: 'password',
    providerReference: ADMIN_REFERENCE,
    idempotencyKey: id('idem', 'admin-bind'),
  });
  const adminSignIn = await authentication.authenticate({
    evidenceId: id('evid', 'admin'),
    sessionId: id('sess', 'admin'),
    provider: 'password',
    providerReference: ADMIN_REFERENCE,
    proof: DEFAULT_PASSWORD,
    idempotencyKey: id('idem', 'admin-signin'),
  });
  const adminToken = adminSignIn.token.reveal();

  let sequence = 0;
  const nextKey = (): string => {
    sequence += 1;
    return id('idem', `seq:${String(sequence)}`, 12);
  };

  // Handle → the identifiers that person was registered under, so signing in again lands on the
  // same subject and account rather than on ones re-derived from the handle.
  const registered = new Map<string, { subjectId: string; accountId: string }>();

  const signInAs = async (handle: string, password: string): Promise<SignedIn> => {
    const known = registered.get(handle);
    const subjectId = known?.subjectId ?? id('sub', handle, 10);
    const accountId = known?.accountId ?? id('acct', handle);
    sequence += 1;
    const signedIn = await authentication.authenticate({
      evidenceId: id('evid', `${handle}:${String(sequence)}`),
      sessionId: id('sess', `${handle}:${String(sequence)}`),
      provider: 'password',
      providerReference: id('pref', handle),
      proof: password,
      idempotencyKey: nextKey(),
    });
    return {
      subjectId,
      accountId,
      sessionId: signedIn.session.sessionId,
      token: signedIn.token.reveal(),
    };
  };

  return {
    permissions,
    sessions: authentication,
    accounts,
    identity,
    authentication,
    permissionRepository,
    clock,
    policyVersionId: POLICY_VERSION,
    accountService: accounts,
    passwords,
    administratorToken: adminToken,

    async register(options): Promise<SignedIn> {
      const password = options.password ?? DEFAULT_PASSWORD;
      const subjectId = options.subjectId ?? id('sub', options.handle, 10);
      const accountId = options.accountId ?? id('acct', options.handle);
      const reference = id('pref', options.handle);
      registered.set(options.handle, { subjectId, accountId });

      await identity.create({
        subjectId,
        kind: 'person',
        createdAt: clock.now(),
        origin: { kind: 'system', id: 'K-01-identity-service' },
        idempotencyKey: nextKey(),
      });
      await accounts.open({
        accountId,
        subjectId,
        createdAt: clock.now(),
        origin: { kind: 'system', id: 'K-03-account-service' },
        idempotencyKey: nextKey(),
      });
      await passwords.setPassword(reference, password);
      await authentication.bind({
        bindingId: id('bind', options.handle),
        subjectId,
        provider: 'password',
        providerReference: reference,
        idempotencyKey: nextKey(),
      });

      // One grant per capability, made by the administrator through K-04's own surface. A role is
      // not authority: `grant` is what turns "a CUSTOMER may read an order" into "this person may".
      for (const role of options.roles ?? ['CUSTOMER']) {
        for (const capability of capabilitiesOf(role)) {
          await permissions.grant({
            grantId: id(
              'grant',
              `${options.handle}:${role}:${capability.action}:${capability.resourceType}`,
              8,
            ),
            subjectId,
            accountId,
            role,
            effect: 'allow',
            action: capability.action,
            resourceType: capability.resourceType,
            presentedToken: adminToken,
            // A staff role reaches another party's records, so K-04 refuses a grant of one with no
            // purpose, and is right to. `safety-review` is the closest declared word for deciding
            // whether a business may trade; the vocabulary has no term for market admission, which
            // is recorded as a gap rather than worked around by leaving the field off.
            ...(STAFF_PURPOSE[role] === undefined ? {} : { purpose: STAFF_PURPOSE[role] }),
            administrationPurpose: 'system-maintenance',
            idempotencyKey: nextKey(),
          });
        }
      }

      return signInAs(options.handle, password);
    },

    signIn(handle, password = DEFAULT_PASSWORD): Promise<SignedIn> {
      return signInAs(handle, password);
    },
  };
}

/**
 * Why a staff role is granted, per role.
 *
 * K-04 refuses a grant of a staff role with no purpose (v3 §5.3), and refuses a purpose on a
 * non-staff one — so this is keyed by role rather than applied to everybody. Only the roles the
 * suites actually grant are listed; a suite that grants another staff role will fail loudly here
 * rather than silently granting unpurposed authority.
 */
const STAFF_PURPOSE: Readonly<Record<string, string | undefined>> = Object.freeze({
  OPERATIONS: 'safety-review',
});

function capabilitiesOf(
  role: string,
): ReadonlyArray<{ readonly action: string; readonly resourceType: string }> {
  const entry = JAYA_V1_ROLES.find((candidate) => candidate.role === role);
  if (entry === undefined) throw new Error(`the fixture knows no role "${role}"`);
  return entry.capabilities;
}
