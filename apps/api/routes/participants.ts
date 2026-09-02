/**
 * How a real person joins JAYA, signs in, and takes on what they do here.
 *
 * Everything above this file assumed somebody already existed. K-01 minted subjects, K-03 opened
 * accounts and K-04 granted roles — in tests, by a fixture, and in production by an operator running
 * statements by hand. **No person could join this platform.** These are the routes that change that.
 *
 * Four decisions worth reading before the code.
 *
 * **Registration collects a password and nothing else.** No email address, no telephone number, no
 * name. Not an omission: K-01 and K-03 deliberately hold no personal data, every identifier in this
 * platform is refused if it looks like a natural one, and a registration form that asked for an
 * email would be the first place personal data entered a schema built to have none. The person is
 * handed an opaque **participant reference** — their sign-in handle — and the platform learns who
 * they are only when they choose to tell it something, in a module that records the consent.
 *
 * **Registration and signing in are separate calls.** K-02 reveals a session secret exactly once, so
 * a retried registration cannot hand back a second one. A route that tried would answer a retry with
 * a spent token and no explanation. Registering returns the reference; `POST /v1/sessions` returns a
 * session, as often as somebody signs in.
 *
 * **One identity, several roles.** Becoming a supplier does not make a second person. The same
 * subject, the same account, the same history — a new capability on the account and a new set of
 * grants. Anything else would split the record of what somebody bought from the record of what they
 * sold, and those are the same person's dealings with the same platform.
 *
 * **Only some roles may be taken on by asking.** CUSTOMER and SUPPLIER, because taking them on
 * grants nothing that matters yet: a supplier is a directory entry, and a directory entry starts
 * pending and invisible until an operator admits it. DRIVER and every staff role are not on the
 * list — a driver takes custody of somebody else's goods, and staff reach other parties' records.
 *
 * Owned by: apps/api.
 */

import type { AccountService } from '../../../kernel/accounts/index.ts';
import { AuthenticationError } from '../../../kernel/authentication/index.ts';
import type { AuthenticationService } from '../../../kernel/authentication/index.ts';
import type { IdentityService } from '../../../kernel/identity/index.ts';
import type { UniversalAccountService } from '../../../modules/universal-account/index.ts';
import type { RequestContext } from '../../../platform/http/context.ts';
import type { Route, Router } from '../../../platform/http/router.ts';
import { json, type HttpRequest, type HttpResponse } from '../../../platform/http/types.ts';

import { ApiError } from '../errors.ts';
import { readString } from '../reading.ts';
import { SELF_ASSUMABLE_ROLES, type RoleGrantor } from '../registrar.ts';

/** Setting a password. Narrower than the verifier, because verifying and enrolling differ. */
export interface PasswordEnroller {
  setPassword(providerReference: string, password: string): Promise<void>;
}

export interface ParticipantRoutesOptions {
  readonly identity: IdentityService;
  readonly accounts: AccountService;
  readonly authentication: AuthenticationService;
  readonly passwords: PasswordEnroller;
  /** M-01, which owns what an account does here. Not the same thing as a K-04 role. */
  readonly capabilities: UniversalAccountService;
  readonly grantor: RoleGrantor;
  readonly contextFor: (request: HttpRequest) => RequestContext;
  readonly accountFor: (request: HttpRequest) => string;
  readonly subjectFor: (request: HttpRequest) => string;
}

/**
 * The shortest password this platform accepts.
 *
 * Length rather than a composition rule, because composition rules produce `Password1!` and length
 * produces passphrases. K-02 holds a scrypt hash and nothing else, so the only defence against a
 * guessed password is that it is hard to guess.
 */
const MINIMUM_PASSWORD_LENGTH = 12;
const MAXIMUM_PASSWORD_LENGTH = 256;

/**
 * Fields a registration may not carry.
 *
 * The identity tables hold no personal data, and this is the door somebody would put it through.
 * Refused by name rather than ignored, so the caller is told where it belongs instead of believing
 * the platform stored it.
 */
const PERSONAL_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  email: 'no component stores an email address; a contact channel is recorded with its consent',
  emailAddress: 'no component stores an email address',
  phone: 'no component stores a telephone number',
  phoneNumber: 'no component stores a telephone number',
  mobile: 'no component stores a telephone number',
  name: 'a person’s name is not held here; a business name is a directory entry’s displayName',
  fullName: 'a person’s name is not held here',
  nic: 'a national identity number is verification evidence, and M-02 owns evidence',
  address: 'an address is not held here; a directory location carries a district',
  dateOfBirth: 'a date of birth is verification evidence, and M-02 owns evidence',
});

/** Fields a caller may not send because the platform decides them. */
const ASSERTED_FIELDS: readonly string[] = [
  'subjectId',
  'subject_id',
  'accountId',
  'account_id',
  'participantReference',
  'reference',
  'roles',
  'capabilities',
  'grants',
];

function assertNoPersonalData(body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const fields = body as Record<string, unknown>;

  for (const [field, why] of Object.entries(PERSONAL_FIELDS)) {
    if (field in fields) {
      throw new ApiError(
        400,
        'personal-data-refused',
        `"${field}" is not a field this platform stores at registration: ${why}. Registering ` +
          'collects a password and nothing else, and you are handed an opaque reference to sign ' +
          'in with.',
      );
    }
  }

  for (const field of ASSERTED_FIELDS) {
    if (field in fields) {
      throw new ApiError(
        400,
        'caller-asserted-party',
        `"${field}" is not a field a caller may send. Identifiers and authority are the ` +
          'platform’s to decide; a caller who could name either would be registering as somebody.',
      );
    }
  }
}

function readPassword(body: unknown): string {
  const password = readString(body, 'password');
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new ApiError(
      400,
      'weak-password',
      `A password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters. A length rule ` +
        'rather than a composition rule, because composition rules produce one predictable ' +
        'password and length produces a passphrase.',
    );
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    throw new ApiError(
      400,
      'malformed-field',
      `A password may be at most ${String(MAXIMUM_PASSWORD_LENGTH)} characters.`,
    );
  }
  return password;
}

/** M-01's word for what a K-04 role does here. Two vocabularies, and this is where they meet. */
const CAPABILITY_FOR_ROLE: Readonly<Record<string, string>> = Object.freeze({
  CUSTOMER: 'buyer',
  SUPPLIER: 'seller',
});

export function participantRoutes(options: ParticipantRoutesOptions): readonly Route[] {
  const { identity, accounts, authentication, passwords, capabilities, grantor } = options;
  const { contextFor, accountFor, subjectFor } = options;

  /**
   * Give an account a role: the K-04 grants that let it call things, and the M-01 capability that
   * records what it does here.
   *
   * Both, because they are different facts. K-04 answers "may this request proceed"; M-01 answers
   * "what is this account for", which is what a cockpit reads and what a capability history
   * explains. A platform with only the first could not tell somebody why they are a supplier.
   */
  async function assume(
    context: RequestContext,
    subjectId: string,
    accountId: string,
    role: string,
  ): Promise<void> {
    await grantor.grantRole({
      subjectId,
      accountId,
      role,
      idempotencyKey: context.idempotencyKey,
      derivedId: (prefix, discriminator) => context.derivedId(prefix, discriminator),
    });

    const capability = CAPABILITY_FOR_ROLE[role];
    if (capability === undefined) return;

    await capabilities.activateCapability({
      capabilityId: context.derivedId('cap', `${role}:${capability}`),
      accountId,
      capability,
      attributes: {},
      activatedAt: context.now,
      createdAt: context.now,
      updatedAt: context.now,
      correlationId: context.correlationId,
      idempotencyKey: context.derivedId('idem', `capability:${capability}`),
      stateId: context.derivedId('cst', `${role}:${capability}`),
      reason: `the account took on the ${role} role`,
    });
  }

  return [
    {
      method: 'POST',
      path: '/v1/participants',
      summary: 'Join. Collects a password and nothing else, and hands back a sign-in reference.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        assertNoPersonalData(request.body);
        const password = readPassword(request.body);

        // Every identifier is derived from the idempotency key, so a retry converges on the person
        // the first attempt created rather than creating a second one. A registration that made two
        // people out of one retry would be the worst kind of duplicate: two histories, one person,
        // and no way to say which is theirs.
        const subjectId = context.derivedId('sub', 'participant');
        const accountId = context.derivedId('acct', 'participant');
        const reference = context.derivedId('pref', 'participant');

        await identity.create({
          subjectId,
          kind: 'person',
          createdAt: context.now,
          origin: { kind: 'system', id: 'apps.api:registration' },
          idempotencyKey: context.derivedId('idem', 'subject'),
        });
        await accounts.open({
          accountId,
          subjectId,
          createdAt: context.now,
          origin: { kind: 'system', id: 'apps.api:registration' },
          idempotencyKey: context.derivedId('idem', 'account'),
        });

        // The password reaches K-02's verifier and nothing else. It is hashed there, and no field
        // of it is echoed in the response or in anything this route logs.
        await passwords.setPassword(reference, password);
        await authentication.bind({
          bindingId: context.derivedId('bind', 'participant'),
          subjectId,
          provider: 'password',
          providerReference: reference,
          idempotencyKey: context.derivedId('idem', 'binding'),
        });

        await assume(context, subjectId, accountId, 'CUSTOMER');

        return json(201, {
          participantReference: reference,
          accountId,
          // Said plainly, because the reference is the only way back in and there is nothing else
          // on record — no email to send a reset to, by design.
          note:
            'This reference is how you sign in, and the platform holds nothing else that ' +
            'identifies you. Keep it: there is no address to send a recovery link to.',
        });
      },
    },

    {
      method: 'POST',
      path: '/v1/sessions',
      summary: 'Sign in with a participant reference and a password. Returns a session, once.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const reference = readString(request.body, 'participantReference');
        const password = readString(request.body, 'password');

        // **Every failure is one refusal.** K-02 goes to real trouble here — it hashes against a
        // decoy when the reference is unknown, so the response time does not answer "does this
        // account exist?" — and an API that reported `no-binding` differently from a wrong password
        // would rebuild that oracle in the response body, for free, for anybody who asks.
        //
        // Only K-02's own error is caught. A driver failure is not an authentication failure, and
        // answering 401 for a database that is merely down would hide an outage behind a login
        // screen.
        let result;
        try {
          result = await authentication.authenticate({
            evidenceId: context.derivedId('evid', 'sign-in'),
            sessionId: context.derivedId('sess', 'sign-in'),
            provider: 'password',
            providerReference: reference,
            proof: password,
            idempotencyKey: context.idempotencyKey,
          });
        } catch (error) {
          if (!(error instanceof AuthenticationError)) throw error;
          throw new ApiError(
            401,
            'authentication-failed',
            'That reference and password do not sign anybody in.',
          );
        }

        if (result.deduplicated) {
          // K-02 reveals a secret once. A retry gets the session it already issued and no second
          // token, and saying so is better than returning a token that throws when read.
          throw new ApiError(
            409,
            'session-already-issued',
            'This idempotency key already issued a session, and a session secret is revealed ' +
              'exactly once. Sign in again with a new key to get a new session.',
          );
        }

        return json(201, {
          token: result.token.reveal(),
          sessionId: result.session.sessionId,
          // Both stops, because they mean different things to a client: the absolute one never
          // moves, and the idle one moves forward when the session is rotated. A client shown only
          // one of them cannot tell whether to rotate or to sign in again.
          absoluteExpiresAt: result.session.absoluteExpiresAt,
          idleExpiresAt: result.session.idleExpiresAt,
        });
      },
    },

    {
      method: 'GET',
      path: '/v1/participants/me',
      summary: 'Who the caller is here: their account, and what it does on this platform.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const accountId = accountFor(request);
        return json(200, {
          accountId,
          capabilities: await capabilities.listCapabilities(accountId),
        });
      },
    },

    {
      method: 'POST',
      path: '/v1/participants/me/roles',
      summary: 'Take on a role — supplier, customer — on the same identity, not a second one.',
      handler: async (request: HttpRequest): Promise<HttpResponse> => {
        const context = contextFor(request);
        const role = readString(request.body, 'role');

        if (!SELF_ASSUMABLE_ROLES.includes(role)) {
          throw new ApiError(
            403,
            'role-not-self-assumable',
            `"${role}" is not a role anybody takes on by asking. ` +
              `Self-assumable: ${SELF_ASSUMABLE_ROLES.join(', ')}. A driver takes custody of ` +
              'somebody else’s goods and a staff role reaches another party’s records; both are ' +
              'granted by an operator, deliberately.',
          );
        }

        const accountId = accountFor(request);
        await assume(context, subjectFor(request), accountId, role);

        return json(200, {
          accountId,
          capabilities: await capabilities.listCapabilities(accountId),
        });
      },
    },
  ];
}

/**
 * The same four paths, in a deployment that offers no self-service registration.
 *
 * The route table is the same either way, deliberately. A deployment that simply left these paths
 * out would answer 404, which says "no such endpoint" when the truth is "this platform does not let
 * people join by themselves yet" — and a client cannot tell the difference between a feature that
 * is absent and a URL it got wrong.
 */
export function unavailableParticipantRoutes(reason: string): readonly Route[] {
  const refuse = (): Promise<HttpResponse> =>
    Promise.reject(
      new ApiError(
        503,
        'registration-unavailable',
        `Self-service registration is not configured in this deployment. ${reason}`,
      ),
    );

  return [
    {
      method: 'POST',
      path: '/v1/participants',
      summary: 'Join. Not configured in this deployment.',
      handler: refuse,
    },
    {
      method: 'POST',
      path: '/v1/sessions',
      summary: 'Sign in. Not configured in this deployment.',
      handler: refuse,
    },
    {
      method: 'GET',
      path: '/v1/participants/me',
      summary: 'Who the caller is here. Not configured in this deployment.',
      handler: refuse,
    },
    {
      method: 'POST',
      path: '/v1/participants/me/roles',
      summary: 'Take on a role. Not configured in this deployment.',
      handler: refuse,
    },
  ];
}

/** Register the participant routes on a router. */
export function addParticipantRoutes(router: Router, options: ParticipantRoutesOptions): Router {
  for (const route of participantRoutes(options)) router.add(route);
  return router;
}

/** Register the refusing stand-ins, so the paths exist and say why they do not work. */
export function addUnavailableParticipantRoutes(router: Router, reason: string): Router {
  for (const route of unavailableParticipantRoutes(reason)) router.add(route);
  return router;
}
