/**
 * M-49 — creating a business, and deciding who may act for it.
 *
 * Six rules carry this module. Every one of them exists because the alternative is a way for
 * somebody to end up holding authority nobody meant to give them.
 *
 * **A business is created with an owner, atomically.** There is no window in which an organisation
 * exists that nobody can administer, and no operator has to bind the founder by hand. The two rows
 * are written in one transaction or neither is.
 *
 * **Creating a business is not being admitted to one.** A new organisation is `pending`. Admission
 * is somebody else's act — it is `admit` at the HTTP edge, held by no trading role — and having
 * staff does not imply it. A supplier with ten employees and no admission is still not sourceable.
 *
 * **Joining is agreed to.** An invitation puts a person at `invited` and confers nothing. Only that
 * person can accept it. An invitation that took effect on its own would let anybody attach anybody
 * else's name to a business's acts.
 *
 * **Nobody confers what they do not hold.** OWNER and ADMIN may build a team; only an OWNER may
 * make another OWNER, because ownership is the authority to dispose of the business. A MANAGER who
 * could hand out ADMIN could promote themselves through a colleague.
 *
 * **Nobody decides their own place.** Changing your own roles, suspending yourself or revoking
 * yourself is refused — the one exception being *leaving*, which is a person's own to do and which
 * nobody should need permission for.
 *
 * **An organisation always has an active owner.** The last one cannot be suspended, revoked,
 * demoted, or walk out. A business nobody owns is a business nobody can administer, and the only
 * way back would be an operator editing rows.
 *
 * Owned by: M-49 Organisations.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  sealMembership,
  sealMembershipEvents,
  sealMemberships,
  sealOrganisation,
  sealOrganisationEvents,
} from './immutable.ts';
import {
  makeMembershipAction,
  makeMembershipEvent,
  makeOrganisationAction,
  makeOrganisationEvent,
} from './outbox.ts';
import {
  FOREIGN_FIELDS,
  assertOrganisationIdentifier,
  assertReason,
  assertRoles,
} from './registry.ts';
import type { OrganisationRepository, OrganisationTransaction } from './repository.ts';
import {
  ACTING_STATUSES,
  MAY_CONFER_OWNERSHIP,
  MAY_INVITE,
  MEMBERSHIP_TRANSITIONS,
  ORGANISATION_TRANSITIONS,
  OrganisationError,
  type MembershipRole,
  type MembershipStatus,
  type Organisation,
  type OrganisationMembership,
  type OrganisationStatus,
} from './types.ts';
import {
  validateMembership,
  validateMembershipEvent,
  validateOrganisation,
  validateOrganisationEvent,
} from './validate.ts';

export interface CreateOrganisationRequest {
  readonly organisationId: string;
  /** The K-03 account the business trades under. Opened by the caller, never by this module. */
  readonly accountId: string;
  readonly kind: string;
  readonly displayName: string;
  /** The founder. Becomes OWNER in the same transaction. */
  readonly ownerSubjectId: string;
  readonly ownerAccountId: string;
  readonly membershipId: string;
  readonly createdAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  /** Opaque id for this transition, so a retry converges on the outbox row already written. */
  readonly eventId: string;
  readonly membershipEventId: string;
}

export interface OrganisationResult {
  readonly organisation: Organisation;
  readonly replayed: boolean;
}

export interface OrganisationTransitionRequest {
  readonly organisationId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface InviteMemberRequest {
  readonly membershipId: string;
  readonly organisationId: string;
  readonly personSubjectId: string;
  readonly personAccountId: string;
  readonly roles: readonly string[];
  /** Who is inviting. Their own membership decides whether they may, and with which roles. */
  readonly actorSubjectId: string;
  readonly invitedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface MembershipResult {
  readonly membership: OrganisationMembership;
  readonly replayed: boolean;
}

export interface AcceptMembershipRequest {
  readonly membershipId: string;
  readonly actorSubjectId: string;
  readonly acceptedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface ChangeRolesRequest {
  readonly membershipId: string;
  readonly roles: readonly string[];
  readonly actorSubjectId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface MembershipTransitionRequest {
  readonly membershipId: string;
  readonly actorSubjectId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

const CREATE_KEYS: readonly string[] = [
  'organisationId',
  'accountId',
  'kind',
  'displayName',
  'ownerSubjectId',
  'ownerAccountId',
  'membershipId',
  'createdAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
  'membershipEventId',
];

const ORGANISATION_TRANSITION_KEYS: readonly string[] = [
  'organisationId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const INVITE_KEYS: readonly string[] = [
  'membershipId',
  'organisationId',
  'personSubjectId',
  'personAccountId',
  'roles',
  'actorSubjectId',
  'invitedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const ACCEPT_KEYS: readonly string[] = [
  'membershipId',
  'actorSubjectId',
  'acceptedAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const CHANGE_ROLES_KEYS: readonly string[] = [
  'membershipId',
  'roles',
  'actorSubjectId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

const MEMBERSHIP_TRANSITION_KEYS: readonly string[] = [
  'membershipId',
  'actorSubjectId',
  'reason',
  'occurredAt',
  'correlationId',
  'idempotencyKey',
  'eventId',
];

export class OrganisationService {
  readonly #repository: OrganisationRepository;

  constructor(repository: OrganisationRepository) {
    this.#repository = repository;
  }

  /**
   * Create a business, and make its founder the owner, in one transaction.
   *
   * The atomicity is the point. Two calls would leave a window in which an organisation exists that
   * nobody can administer, and the only way out of that window is an operator writing rows.
   */
  async createOrganisation(request: CreateOrganisationRequest): Promise<OrganisationResult> {
    assertNoForeignConcerns(request, CREATE_KEYS, 'createOrganisation');

    const organisation = validateOrganisation(
      {
        organisationId: request.organisationId,
        accountId: request.accountId,
        kind: request.kind,
        displayName: request.displayName,
        // Created, and not yet vouched for. Admission is somebody else's act.
        status: 'pending' as OrganisationStatus,
        createdAt: request.createdAt,
        updatedAt: request.createdAt,
        closedAt: null,
        closureReason: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    const owner = validateMembership(
      {
        membershipId: request.membershipId,
        organisationId: organisation.organisationId,
        personSubjectId: request.ownerSubjectId,
        personAccountId: request.ownerAccountId,
        roles: ['OWNER'],
        // Active immediately, and this is the one membership that is: the founder is not somebody
        // who has to accept an invitation they sent themselves.
        status: 'active' as MembershipStatus,
        invitedBy: null,
        invitedAt: request.createdAt,
        acceptedAt: request.createdAt,
        suspendedAt: null,
        endedAt: null,
        correlationId: request.correlationId,
        idempotencyKey: request.membershipId,
      },
      'request',
    );

    const reason = 'the business was created by its owner';

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findOrganisationByIdempotencyKey(organisation.idempotencyKey);
        if (byKey !== null) {
          if (!organisationEquals(byKey, organisation)) {
            throw new OrganisationError(
              'idempotency-key-reuse',
              `idempotency key "${organisation.idempotencyKey}" has already created a different ` +
                'organisation',
            );
          }
          return { organisation: sealOrganisation(byKey), replayed: true };
        }

        const byAccount = await tx.findOrganisationByAccountId(organisation.accountId);
        if (byAccount !== null) {
          throw new OrganisationError(
            'account-already-organisation',
            `account ${organisation.accountId} already trades as ${byAccount.organisationId}. ` +
              'One account, one business: two would be two sets of books under one name',
          );
        }

        await tx.insertOrganisation(organisation);
        await tx.insertOrganisationEvent(
          validateOrganisationEvent(
            {
              eventId: request.eventId,
              organisationId: organisation.organisationId,
              fromStatus: null,
              toStatus: 'pending',
              reason,
              occurredAt: organisation.createdAt,
              correlationId: organisation.correlationId,
              idempotencyKey: organisation.idempotencyKey,
            },
            'request',
          ),
        );

        await tx.insertMembership(owner);
        await tx.insertMembershipEvent(
          validateMembershipEvent(
            {
              eventId: request.membershipEventId,
              membershipId: owner.membershipId,
              organisationId: owner.organisationId,
              fromStatus: null,
              toStatus: 'active',
              roles: owner.roles,
              actorSubjectId: owner.personSubjectId,
              reason: 'founded the business, and owns it',
              occurredAt: owner.invitedAt,
              correlationId: owner.correlationId,
              idempotencyKey: owner.idempotencyKey,
            },
            'request',
          ),
        );

        await tx.insertOutbox(makeOrganisationEvent(organisation, request.eventId));
        await tx.insertOutbox(makeOrganisationAction(organisation, reason, request.eventId));
        await tx.insertOutbox(makeMembershipEvent(owner, request.membershipEventId));
        await tx.insertOutbox(
          makeMembershipAction(
            owner,
            owner.personSubjectId,
            'founded the business, and owns it',
            request.membershipEventId,
          ),
        );

        return { organisation: sealOrganisation(organisation), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findOrganisationByIdempotencyKey(organisation.idempotencyKey);
        if (byKey === null || !organisationEquals(byKey, organisation)) return null;
        return { organisation: sealOrganisation(byKey), replayed: true };
      },
    );
  }

  /** Admitted: the platform vouches for this business. Never the business's own act. */
  activateOrganisation(request: OrganisationTransitionRequest): Promise<OrganisationResult> {
    return this.#organisationTransition(request, 'active');
  }

  /** Temporarily not in good standing. Reversible, and distinct from closing. */
  suspendOrganisation(request: OrganisationTransitionRequest): Promise<OrganisationResult> {
    return this.#organisationTransition(request, 'suspended');
  }

  /** Stopped. Terminal, and the record stays: the orders it filled still name it. */
  closeOrganisation(request: OrganisationTransitionRequest): Promise<OrganisationResult> {
    return this.#organisationTransition(request, 'closed');
  }

  /**
   * Ask somebody to act for the business.
   *
   * They hold nothing until they accept, and the actor's own membership decides both whether they
   * may invite at all and which roles they may confer.
   */
  async inviteMember(request: InviteMemberRequest): Promise<MembershipResult> {
    assertNoForeignConcerns(request, INVITE_KEYS, 'inviteMember');
    const roles = assertRoles(request.roles, 'roles');
    const actorSubjectId = assertOrganisationIdentifier(request.actorSubjectId, 'actorSubjectId');

    const candidate = validateMembership(
      {
        membershipId: request.membershipId,
        organisationId: request.organisationId,
        personSubjectId: request.personSubjectId,
        personAccountId: request.personAccountId,
        roles,
        status: 'invited' as MembershipStatus,
        invitedBy: actorSubjectId,
        invitedAt: request.invitedAt,
        acceptedAt: null,
        suspendedAt: null,
        endedAt: null,
        correlationId: request.correlationId,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    return this.#converge(
      async (tx) => {
        const byKey = await tx.findMembershipByIdempotencyKey(candidate.idempotencyKey);
        if (byKey !== null) {
          if (!membershipEquals(byKey, candidate)) {
            throw new OrganisationError(
              'idempotency-key-reuse',
              `idempotency key "${candidate.idempotencyKey}" has already invited somebody else, ` +
                'or invited this person to something different',
            );
          }
          return { membership: sealMembership(byKey), replayed: true };
        }

        const organisation = await requireOrganisation(tx, candidate.organisationId);
        if (organisation.status === 'closed') {
          throw new OrganisationError(
            'organisation-closed',
            'this business has closed, so there is nothing to join',
          );
        }

        const actor = await requireActingMembership(
          tx,
          organisation.organisationId,
          actorSubjectId,
        );
        assertMayInvite(actor, roles);

        const existing = await tx.findMembership(
          candidate.organisationId,
          candidate.personSubjectId,
        );
        if (existing !== null) {
          throw new OrganisationError(
            'already-a-member',
            `that person already holds membership ${existing.membershipId} in this business, at ` +
              `status ${existing.status}. Change what they do rather than inviting them twice: two ` +
              'memberships would be two answers to "what may they do here"',
          );
        }

        await tx.insertMembership(candidate);
        await tx.insertMembershipEvent(
          validateMembershipEvent(
            {
              eventId: request.eventId,
              membershipId: candidate.membershipId,
              organisationId: candidate.organisationId,
              fromStatus: null,
              toStatus: 'invited',
              roles,
              actorSubjectId,
              reason: 'invited to act for the business',
              occurredAt: candidate.invitedAt,
              correlationId: candidate.correlationId,
              idempotencyKey: candidate.idempotencyKey,
            },
            'request',
          ),
        );
        await tx.insertOutbox(makeMembershipEvent(candidate, request.eventId));
        await tx.insertOutbox(
          makeMembershipAction(
            candidate,
            actorSubjectId,
            'invited to act for the business',
            request.eventId,
          ),
        );

        return { membership: sealMembership(candidate), replayed: false };
      },
      async (tx) => {
        const byKey = await tx.findMembershipByIdempotencyKey(candidate.idempotencyKey);
        if (byKey === null || !membershipEquals(byKey, candidate)) return null;
        return { membership: sealMembership(byKey), replayed: true };
      },
    );
  }

  /**
   * Accept an invitation.
   *
   * Only the invited person may. An acceptance anybody could make on somebody's behalf is an
   * invitation that took effect on its own, wearing a second call.
   */
  async acceptMembership(request: AcceptMembershipRequest): Promise<MembershipResult> {
    assertNoForeignConcerns(request, ACCEPT_KEYS, 'acceptMembership');
    const actorSubjectId = assertOrganisationIdentifier(request.actorSubjectId, 'actorSubjectId');
    const acceptedAt = assertInstant(request.acceptedAt, 'acceptedAt');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireMembership(tx, request.membershipId);
      if (before.status === 'active') {
        return { membership: sealMembership(before), replayed: true };
      }
      if (before.personSubjectId !== actorSubjectId) {
        throw new OrganisationError(
          'not-your-invitation',
          'an invitation is accepted by the person it was sent to, and by nobody else. Anything ' +
            'looser would put somebody’s name on acts they never agreed to',
        );
      }
      assertMembershipTransition(before.status, 'active');

      const after = validateMembership(
        { ...before, status: 'active', acceptedAt, suspendedAt: null, endedAt: null },
        'request',
      );

      await this.#writeMembership(tx, before, after, {
        actorSubjectId,
        reason: 'accepted the invitation to act for the business',
        occurredAt: acceptedAt,
        eventId: request.eventId,
      });

      return { membership: sealMembership(after), replayed: false };
    });
  }

  /** Change what somebody does for the business. Never your own, and never above your own. */
  async changeRoles(request: ChangeRolesRequest): Promise<MembershipResult> {
    assertNoForeignConcerns(request, CHANGE_ROLES_KEYS, 'changeRoles');
    const roles = assertRoles(request.roles, 'roles');
    const actorSubjectId = assertOrganisationIdentifier(request.actorSubjectId, 'actorSubjectId');
    const reason = assertReason(request.reason, 'reason');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireMembership(tx, request.membershipId);
      if (sameRoles(before.roles, roles)) {
        return { membership: sealMembership(before), replayed: true };
      }

      const actor = await requireActingMembership(tx, before.organisationId, actorSubjectId);
      if (actor.membershipId === before.membershipId) {
        throw new OrganisationError(
          'not-your-decision',
          'nobody changes their own roles. An ADMIN who could would be an OWNER by one call, and ' +
            'the distinction between the two would mean nothing',
        );
      }
      // Only an owner may act on an owner — the same rule removal enforces, and it belongs here
      // too. Demotion is the quiet way to take a business: nothing about "change their roles" looks
      // like removing anybody, and an ADMIN who could demote the owner and then promote themselves
      // through a colleague would own the company without a single call that reads as a takeover.
      if (before.roles.includes('OWNER') && !actor.roles.includes('OWNER')) {
        throw new OrganisationError(
          'not-permitted-in-organisation',
          'only an owner may change what another owner does for the business',
        );
      }
      assertMayInvite(actor, roles);

      // Losing ownership is the case that can strand a business, so it is checked here as well as
      // on removal: demoting the last owner leaves nobody who can administer anything.
      if (before.roles.includes('OWNER') && !roles.includes('OWNER')) {
        await assertNotLastOwner(tx, before);
      }

      const after = validateMembership({ ...before, roles }, 'request');
      await this.#writeMembership(tx, before, after, {
        actorSubjectId,
        reason,
        occurredAt,
        eventId: request.eventId,
      });

      return { membership: sealMembership(after), replayed: false };
    });
  }

  /** Suspend somebody's place. Reversible, and not the same as removing them. */
  suspendMembership(request: MembershipTransitionRequest): Promise<MembershipResult> {
    return this.#membershipTransition(request, 'suspended', { bySomebodyElse: true });
  }

  /** Reinstate a suspended member. */
  reinstateMembership(request: MembershipTransitionRequest): Promise<MembershipResult> {
    return this.#membershipTransition(request, 'active', { bySomebodyElse: true });
  }

  /** Remove somebody. Terminal: the record stays, because what they did still names them. */
  revokeMembership(request: MembershipTransitionRequest): Promise<MembershipResult> {
    return this.#membershipTransition(request, 'revoked', { bySomebodyElse: true });
  }

  /**
   * Leave a business.
   *
   * The one transition somebody makes about themselves, because needing permission to stop working
   * somewhere is not a thing a platform should impose. The last owner still cannot: they would
   * leave a business nobody can administer, and the way out is to make somebody else an owner first.
   */
  leaveOrganisation(request: MembershipTransitionRequest): Promise<MembershipResult> {
    return this.#membershipTransition(request, 'left', { bySomebodyElse: false });
  }

  async getOrganisation(organisationId: string): Promise<Organisation | null> {
    assertOrganisationIdentifier(organisationId, 'organisationId');
    return this.#repository.withTransaction(async (tx) => {
      const found = await tx.findOrganisationById(organisationId);
      return found === null ? null : sealOrganisation(found);
    });
  }

  async getOrganisationForAccount(accountId: string): Promise<Organisation | null> {
    assertOrganisationIdentifier(accountId, 'accountId');
    return this.#repository.withTransaction(async (tx) => {
      const found = await tx.findOrganisationByAccountId(accountId);
      return found === null ? null : sealOrganisation(found);
    });
  }

  async getMembership(membershipId: string): Promise<OrganisationMembership | null> {
    assertOrganisationIdentifier(membershipId, 'membershipId');
    return this.#repository.withTransaction(async (tx) => {
      const found = await tx.findMembershipById(membershipId);
      return found === null ? null : sealMembership(found);
    });
  }

  /**
   * What this person may do for this business, right now.
   *
   * The question the authorisation path asks, and the reason it is one call: a guard that had to
   * list somebody's memberships and filter them would be a guard with the filter in it.
   */
  async findActingMembership(
    organisationId: string,
    personSubjectId: string,
  ): Promise<OrganisationMembership | null> {
    assertOrganisationIdentifier(organisationId, 'organisationId');
    assertOrganisationIdentifier(personSubjectId, 'personSubjectId');
    return this.#repository.withTransaction(async (tx) => {
      const found = await tx.findMembership(organisationId, personSubjectId);
      if (found === null || !ACTING_STATUSES.includes(found.status)) return null;
      return sealMembership(found);
    });
  }

  async listMembers(organisationId: string): Promise<readonly OrganisationMembership[]> {
    assertOrganisationIdentifier(organisationId, 'organisationId');
    return this.#repository.withTransaction(async (tx) =>
      sealMemberships(await tx.findMembershipsForOrganisation(organisationId)),
    );
  }

  async listMembershipsForPerson(
    personSubjectId: string,
  ): Promise<readonly OrganisationMembership[]> {
    assertOrganisationIdentifier(personSubjectId, 'personSubjectId');
    return this.#repository.withTransaction(async (tx) =>
      sealMemberships(await tx.findMembershipsForPerson(personSubjectId)),
    );
  }

  async listMembershipHistory(membershipId: string) {
    assertOrganisationIdentifier(membershipId, 'membershipId');
    return this.#repository.withTransaction(async (tx) =>
      sealMembershipEvents(await tx.findMembershipEvents(membershipId)),
    );
  }

  async listOrganisationHistory(organisationId: string) {
    assertOrganisationIdentifier(organisationId, 'organisationId');
    return this.#repository.withTransaction(async (tx) =>
      sealOrganisationEvents(await tx.findOrganisationEvents(organisationId)),
    );
  }

  async #organisationTransition(
    request: OrganisationTransitionRequest,
    to: OrganisationStatus,
  ): Promise<OrganisationResult> {
    assertNoForeignConcerns(request, ORGANISATION_TRANSITION_KEYS, `${to} transition`);
    const reason = assertReason(request.reason, 'reason');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireOrganisation(tx, request.organisationId);
      if (before.status === to) return { organisation: sealOrganisation(before), replayed: true };

      const allowed = ORGANISATION_TRANSITIONS[before.status];
      if (!allowed.includes(to)) {
        throw new OrganisationError(
          allowed.length === 0 ? 'organisation-closed' : 'illegal-transition',
          `a ${before.status} business cannot become ${to}` +
            (allowed.length === 0
              ? '. It has closed, and the orders it filled still name it'
              : `; from ${before.status} it may become ${allowed.join(', ')}`),
        );
      }

      const after = validateOrganisation(
        {
          ...before,
          status: to,
          updatedAt: occurredAt,
          closedAt: to === 'closed' ? occurredAt : null,
          closureReason: to === 'closed' ? reason : null,
        },
        'request',
      );

      await tx.updateOrganisation(after);
      await tx.insertOrganisationEvent(
        validateOrganisationEvent(
          {
            eventId: request.eventId,
            organisationId: after.organisationId,
            fromStatus: before.status,
            toStatus: to,
            reason,
            occurredAt,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
          },
          'request',
        ),
      );
      await tx.insertOutbox(makeOrganisationEvent(after, request.eventId));
      await tx.insertOutbox(makeOrganisationAction(after, reason, request.eventId));

      return { organisation: sealOrganisation(after), replayed: false };
    });
  }

  async #membershipTransition(
    request: MembershipTransitionRequest,
    to: MembershipStatus,
    options: { readonly bySomebodyElse: boolean },
  ): Promise<MembershipResult> {
    assertNoForeignConcerns(request, MEMBERSHIP_TRANSITION_KEYS, `${to} transition`);
    const actorSubjectId = assertOrganisationIdentifier(request.actorSubjectId, 'actorSubjectId');
    const reason = assertReason(request.reason, 'reason');
    const occurredAt = assertInstant(request.occurredAt, 'occurredAt');

    return this.#repository.withTransaction(async (tx) => {
      const before = await requireMembership(tx, request.membershipId);
      if (before.status === to) return { membership: sealMembership(before), replayed: true };
      assertMembershipTransition(before.status, to);

      if (options.bySomebodyElse) {
        if (before.personSubjectId === actorSubjectId) {
          throw new OrganisationError(
            'not-your-decision',
            'nobody suspends, reinstates or removes themselves. Leaving is the transition a ' +
              'person makes about their own place, and it is a separate call for that reason',
          );
        }
        const actor = await requireActingMembership(tx, before.organisationId, actorSubjectId);
        // Removing somebody who outranks you is conferring authority in reverse: an ADMIN who could
        // revoke an OWNER could take the business by removing everybody above them.
        if (before.roles.includes('OWNER') && !actor.roles.includes('OWNER')) {
          throw new OrganisationError(
            'not-permitted-in-organisation',
            'only an owner may suspend or remove another owner',
          );
        }
        if (!actor.roles.some((role) => MAY_INVITE.includes(role))) {
          throw new OrganisationError(
            'not-permitted-in-organisation',
            `acting as ${actor.roles.join(', ')} does not permit changing somebody else’s place ` +
              `in this business; that is for ${MAY_INVITE.join(' or ')}`,
          );
        }
      } else if (before.personSubjectId !== actorSubjectId) {
        throw new OrganisationError(
          'not-your-decision',
          'leaving is something a person does themselves. Removing somebody else is revoking them',
        );
      }

      // Whichever way the place ends or pauses, an owner going leaves the business behind.
      if (before.roles.includes('OWNER') && to !== 'active') {
        await assertNotLastOwner(tx, before);
      }

      const ends = to === 'revoked' || to === 'left';
      const after = validateMembership(
        {
          ...before,
          status: to,
          suspendedAt: to === 'suspended' ? occurredAt : null,
          endedAt: ends ? occurredAt : null,
        },
        'request',
      );

      await this.#writeMembership(tx, before, after, {
        actorSubjectId,
        reason,
        occurredAt,
        eventId: request.eventId,
      });

      return { membership: sealMembership(after), replayed: false };
    });
  }

  async #writeMembership(
    tx: OrganisationTransaction,
    before: OrganisationMembership,
    after: OrganisationMembership,
    change: {
      readonly actorSubjectId: string;
      readonly reason: string;
      readonly occurredAt: string;
      readonly eventId: string;
    },
  ): Promise<void> {
    await tx.updateMembership(after);
    await tx.insertMembershipEvent(
      validateMembershipEvent(
        {
          eventId: change.eventId,
          membershipId: after.membershipId,
          organisationId: after.organisationId,
          fromStatus: before.status,
          toStatus: after.status,
          roles: after.roles,
          actorSubjectId: change.actorSubjectId,
          reason: change.reason,
          occurredAt: change.occurredAt,
          correlationId: after.correlationId,
          idempotencyKey: after.idempotencyKey,
        },
        'request',
      ),
    );
    await tx.insertOutbox(makeMembershipEvent(after, change.eventId));
    await tx.insertOutbox(
      makeMembershipAction(after, change.actorSubjectId, change.reason, change.eventId),
    );
  }

  async #converge<T>(
    operation: (tx: OrganisationTransaction) => Promise<T>,
    recover: (tx: OrganisationTransaction) => Promise<T | null>,
  ): Promise<T> {
    try {
      return await this.#repository.withTransaction(operation);
    } catch (error) {
      const conflicted =
        error instanceof OrganisationError &&
        (error.code === 'idempotency-key-reuse' ||
          error.code === 'duplicate-organisation-id' ||
          error.code === 'duplicate-membership-id');
      if (!conflicted) throw error;

      const recovered = await this.#repository.withTransaction(recover);
      if (recovered === null) throw error;
      return recovered;
    }
  }
}

async function requireOrganisation(
  tx: OrganisationTransaction,
  organisationId: string,
): Promise<Organisation> {
  assertOrganisationIdentifier(organisationId, 'organisationId');
  const found = await tx.findOrganisationById(organisationId);
  if (found === null) {
    throw new OrganisationError(
      'organisation-not-found',
      `no organisation with id ${organisationId}`,
    );
  }
  return found;
}

async function requireMembership(
  tx: OrganisationTransaction,
  membershipId: string,
): Promise<OrganisationMembership> {
  assertOrganisationIdentifier(membershipId, 'membershipId');
  const found = await tx.findMembershipById(membershipId);
  if (found === null) {
    throw new OrganisationError('membership-not-found', `no membership with id ${membershipId}`);
  }
  return found;
}

/**
 * The actor's own place in the business, and it must be one that can act.
 *
 * A suspended member is refused here, which is what makes "suspended loses access immediately"
 * true of every operation rather than only of the ones somebody remembered to check.
 */
async function requireActingMembership(
  tx: OrganisationTransaction,
  organisationId: string,
  actorSubjectId: string,
): Promise<OrganisationMembership> {
  const found = await tx.findMembership(organisationId, actorSubjectId);
  if (found === null) {
    throw new OrganisationError(
      'not-permitted-in-organisation',
      'you hold no place in this business',
    );
  }
  if (!ACTING_STATUSES.includes(found.status)) {
    throw new OrganisationError(
      'not-permitted-in-organisation',
      `your membership is ${found.status}, so it does not act for this business`,
    );
  }
  return found;
}

function assertMayInvite(actor: OrganisationMembership, roles: readonly MembershipRole[]): void {
  if (!actor.roles.some((role) => MAY_INVITE.includes(role))) {
    throw new OrganisationError(
      'not-permitted-in-organisation',
      `acting as ${actor.roles.join(', ')} does not permit inviting or reassigning staff; that is ` +
        `for ${MAY_INVITE.join(' or ')}`,
    );
  }
  if (roles.includes('OWNER') && !actor.roles.some((role) => MAY_CONFER_OWNERSHIP.includes(role))) {
    throw new OrganisationError(
      'cannot-confer-role',
      'only an owner may make somebody else an owner. Ownership is the authority to dispose of ' +
        'the business, and an ADMIN who could confer it could take it',
    );
  }
}

/**
 * Refuse the change that would leave a business with nobody in charge.
 *
 * Counted over the committed rows in this transaction, so two owners leaving at once cannot both
 * pass: the second reads the first's row and finds itself alone.
 */
async function assertNotLastOwner(
  tx: OrganisationTransaction,
  membership: OrganisationMembership,
): Promise<void> {
  const members = await tx.findMembershipsForOrganisation(membership.organisationId);
  const otherOwners = members.filter(
    (one) =>
      one.membershipId !== membership.membershipId &&
      one.roles.includes('OWNER') &&
      ACTING_STATUSES.includes(one.status),
  );
  if (otherOwners.length === 0) {
    throw new OrganisationError(
      'last-owner',
      'this is the only owner acting for the business. Make somebody else an owner first: a ' +
        'business nobody owns is one nobody can administer, and the only way back would be an ' +
        'operator editing rows',
    );
  }
}

function assertMembershipTransition(from: MembershipStatus, to: MembershipStatus): void {
  const allowed = MEMBERSHIP_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new OrganisationError(
      'illegal-transition',
      `a ${from} membership cannot become ${to}` +
        (allowed.length === 0
          ? '. It has ended, and what the person did still names them'
          : `; from ${from} it may become ${allowed.join(', ')}`),
    );
  }
}

function assertInstant(value: string, field: string): string {
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new OrganisationError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function sameRoles(a: readonly MembershipRole[], b: readonly MembershipRole[]): boolean {
  return a.length === b.length && a.every((role, index) => role === b[index]);
}

/**
 * Is this the same organisation, arriving twice?
 *
 * **Neither `correlationId` nor `createdAt` is compared.** A retry arrives later and carries a fresh
 * correlation id by definition, and comparing either would report an honest retry as key reuse —
 * advice which, followed, creates a second business.
 */
function organisationEquals(a: Organisation, b: Organisation): boolean {
  return (
    a.organisationId === b.organisationId &&
    a.accountId === b.accountId &&
    a.kind === b.kind &&
    a.displayName === b.displayName &&
    a.idempotencyKey === b.idempotencyKey
  );
}

function membershipEquals(a: OrganisationMembership, b: OrganisationMembership): boolean {
  return (
    a.membershipId === b.membershipId &&
    a.organisationId === b.organisationId &&
    a.personSubjectId === b.personSubjectId &&
    a.personAccountId === b.personAccountId &&
    sameRoles(a.roles, b.roles) &&
    a.idempotencyKey === b.idempotencyKey
  );
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  for (const key of Object.keys(request)) {
    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new OrganisationError('foreign-concern', `${operation} refuses "${key}": ${owner}`);
    }
    if (!permitted.includes(key)) {
      throw new OrganisationError(
        'foreign-concern',
        `${operation} does not accept "${key}". The permitted fields are ${permitted.join(', ')}`,
      );
    }
  }
}
