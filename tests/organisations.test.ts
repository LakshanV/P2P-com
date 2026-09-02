/**
 * M-49 Organisations — the business, and who may act for it.
 *
 * Before this module, every commercial record in the platform belonged to a **person's** account.
 * That is true of a sole trader and false of every business with two people in it, and the shape
 * this suite is really testing is the one that makes the difference safe: an organisation is an
 * account of its own, and a membership is the only thing that lets a person act in it.
 *
 * The properties, in the order of how much damage their absence would do:
 *
 *   * **A membership is scoped, always.** A FINANCE role at one business confers nothing at
 *     another, because it is a different row. Anything else would make one bookkeeping job into a
 *     key to every business the person has ever worked for.
 *   * **Nobody confers what they do not hold**, and nobody decides their own place. An ADMIN who
 *     could make themselves an OWNER, or change their own roles, is an ADMIN who is an OWNER.
 *   * **Suspension takes effect immediately, everywhere.** The check is in the one function every
 *     operation goes through, not in each of them.
 *   * **A business always has an owner.** The last one cannot be suspended, removed, demoted or
 *     walk out — because the way back from a business nobody owns is an operator editing rows.
 *   * **Joining is agreed to.** An invitation confers nothing until the invited person accepts it,
 *     and only they can.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  InMemoryOrganisationRepository,
  MEMBERSHIP_TRANSITIONS,
  OrganisationError,
  OrganisationService,
  type MembershipRole,
} from '../modules/organisations/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CEMENT_ACCOUNT = 'acct_01HR0ORGcement01';
const HARDWARE_ACCOUNT = 'acct_01HR0ORGhardwar1';

const FOUNDER = 'sub_01HR0ORGfounder1';
const FOUNDER_ACCOUNT = 'acct_01HR0ORGfounder';
const CLERK = 'sub_01HR0ORGclerk001';
const CLERK_ACCOUNT = 'acct_01HR0ORGclerk01';
const RIVAL = 'sub_01HR0ORGrival001';
const RIVAL_ACCOUNT = 'acct_01HR0ORGrival01';

const NOW = '2026-07-01T09:00:00.000000Z';
const MIDDAY = '2026-07-01T12:00:00.000000Z';
/** An invitation and its acceptance are different moments, and the history reads in that order. */
const AFTERNOON = '2026-07-01T14:00:00.000000Z';
const LATER = '2026-07-01T15:30:00.000000Z';

interface Harness {
  readonly service: OrganisationService;
  readonly repository: InMemoryOrganisationRepository;
}

function build(): Harness {
  const repository = new InMemoryOrganisationRepository();
  return { service: new OrganisationService(repository), repository };
}

const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof OrganisationError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

interface OrganisationOptions {
  readonly tag?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly ownerSubjectId?: string;
  readonly ownerAccountId?: string;
}

async function anOrganisation(
  harness: Harness,
  options: OrganisationOptions = {},
): Promise<{ organisationId: string; ownerMembershipId: string }> {
  const tag = options.tag ?? '0001';
  const organisationId = `org_01HR0ORG${tag}`;
  const ownerMembershipId = `mem_01HR0ORG${tag}own`;

  await harness.service.createOrganisation({
    organisationId,
    accountId: options.accountId ?? CEMENT_ACCOUNT,
    kind: options.kind ?? 'supplier',
    displayName: `Business ${tag}`,
    ownerSubjectId: options.ownerSubjectId ?? FOUNDER,
    ownerAccountId: options.ownerAccountId ?? FOUNDER_ACCOUNT,
    membershipId: ownerMembershipId,
    createdAt: NOW,
    correlationId: `corr_01HR0ORG${tag}`,
    idempotencyKey: `idem_01HR0ORG${tag}`,
    eventId: `oev_01HR0ORG${tag}`,
    membershipEventId: `mev_01HR0ORG${tag}`,
  });

  return { organisationId, ownerMembershipId };
}

interface MemberOptions {
  readonly tag?: string;
  readonly personSubjectId?: string;
  readonly personAccountId?: string;
  readonly roles?: readonly string[];
  readonly actorSubjectId?: string;
  readonly accept?: boolean;
}

/** Invite somebody and, unless told otherwise, have them accept. */
async function aMember(
  harness: Harness,
  organisationId: string,
  options: MemberOptions = {},
): Promise<string> {
  const tag = options.tag ?? 'clerk1';
  const membershipId = `mem_01HR0ORG${tag}`;
  const person = options.personSubjectId ?? CLERK;

  await harness.service.inviteMember({
    membershipId,
    organisationId,
    personSubjectId: person,
    personAccountId: options.personAccountId ?? CLERK_ACCOUNT,
    roles: options.roles ?? ['SALES'],
    actorSubjectId: options.actorSubjectId ?? FOUNDER,
    invitedAt: MIDDAY,
    correlationId: `corr_01HR0ORG${tag}inv`,
    idempotencyKey: `idem_01HR0ORG${tag}inv`,
    eventId: `mev_01HR0ORG${tag}inv`,
  });

  if (options.accept !== false) {
    await harness.service.acceptMembership({
      membershipId,
      actorSubjectId: person,
      acceptedAt: AFTERNOON,
      correlationId: `corr_01HR0ORG${tag}acc`,
      idempotencyKey: `idem_01HR0ORG${tag}acc`,
      eventId: `mev_01HR0ORG${tag}acc`,
    });
  }

  return membershipId;
}

// ---------------------------------------------------------------------------
// Creating a business
// ---------------------------------------------------------------------------

void test('a business is created with its owner, in one transaction', async () => {
  const harness = build();
  const { organisationId, ownerMembershipId } = await anOrganisation(harness);
  const afterCreation = harness.repository.transactionsCommitted;

  const organisation = await harness.service.getOrganisation(organisationId);
  assert.equal(
    organisation?.status,
    'pending',
    'creating a business is not being admitted to the market: a supplier with ten employees and ' +
      'no admission is still not sourceable',
  );
  assert.equal(organisation?.accountId, CEMENT_ACCOUNT);

  const owner = await harness.service.getMembership(ownerMembershipId);
  assert.equal(owner?.status, 'active', 'the founder does not accept an invitation they sent');
  assert.deepEqual(owner?.roles, ['OWNER']);
  assert.equal(owner?.invitedBy, null, 'nobody invited the founder');

  assert.equal(
    afterCreation,
    1,
    'both rows in one transaction. Two calls would leave a window in which a business exists that ' +
      'nobody can administer',
  );
});

void test('a failed creation leaves neither the business nor its owner', async () => {
  const harness = build();
  await anOrganisation(harness);

  // The same account, which the commit-time check refuses. The membership in the same transaction
  // must go with it.
  await assert.rejects(anOrganisation(harness, { tag: '0002' }));

  assert.equal(harness.repository.organisations().length, 1);
  assert.equal(harness.repository.memberships().length, 1);
});

void test('one account trades as one business', async () => {
  const harness = build();
  await anOrganisation(harness);

  assert.equal(
    await codeOf(() => anOrganisation(harness, { tag: '0002' })),
    'account-already-organisation',
  );
});

void test('a retried creation converges rather than founding a second business', async () => {
  const harness = build();
  await anOrganisation(harness);
  await anOrganisation(harness);

  assert.equal(harness.repository.organisations().length, 1);
  assert.equal(harness.repository.memberships().length, 1);
});

// ---------------------------------------------------------------------------
// Joining is agreed to
// ---------------------------------------------------------------------------

void test('an invitation confers nothing until it is accepted', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId, { accept: false });

  const invited = await harness.service.getMembership(membershipId);
  assert.equal(invited?.status, 'invited');
  assert.equal(invited?.acceptedAt, null);

  assert.equal(
    await harness.service.findActingMembership(organisationId, CLERK),
    null,
    'an invitation that took effect on its own would put somebody’s name on acts they never ' +
      'agreed to',
  );
});

void test('only the invited person may accept', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId, { accept: false });

  assert.equal(
    await codeOf(() =>
      harness.service.acceptMembership({
        membershipId,
        actorSubjectId: FOUNDER,
        acceptedAt: LATER,
        correlationId: 'corr_01HR0ORGacc002',
        idempotencyKey: 'idem_01HR0ORGacc002',
        eventId: 'mev_01HR0ORGacc002',
      }),
    ),
    'not-your-invitation',
  );
});

void test('accepting makes the membership act, and a second accept converges', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId);

  const acting = await harness.service.findActingMembership(organisationId, CLERK);
  assert.equal(acting?.membershipId, membershipId);
  assert.deepEqual(acting?.roles, ['SALES']);

  const again = await harness.service.acceptMembership({
    membershipId,
    actorSubjectId: CLERK,
    acceptedAt: LATER,
    correlationId: 'corr_01HR0ORGacc003',
    idempotencyKey: 'idem_01HR0ORGacc003',
    eventId: 'mev_01HR0ORGacc003',
  });
  assert.equal(again.replayed, true);
});

// ---------------------------------------------------------------------------
// Nobody confers what they do not hold
// ---------------------------------------------------------------------------

void test('an ordinary member cannot invite anybody', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['MANAGER'] });

  assert.equal(
    await codeOf(() =>
      aMember(harness, organisationId, {
        tag: 'rival1',
        personSubjectId: RIVAL,
        personAccountId: RIVAL_ACCOUNT,
        actorSubjectId: CLERK,
      }),
    ),
    'not-permitted-in-organisation',
    'a MANAGER who could build a team could staff the business with people who answer to them',
  );
});

void test('an admin may build a team, and may not make an owner', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['ADMIN'] });

  // Building a team: permitted.
  await aMember(harness, organisationId, {
    tag: 'rival1',
    personSubjectId: RIVAL,
    personAccountId: RIVAL_ACCOUNT,
    roles: ['INVENTORY'],
    actorSubjectId: CLERK,
  });

  // Conferring ownership: not.
  assert.equal(
    await codeOf(() =>
      aMember(harness, organisationId, {
        tag: 'owner2',
        personSubjectId: 'sub_01HR0ORGsecond01',
        personAccountId: 'acct_01HR0ORGsecond1',
        roles: ['OWNER'],
        actorSubjectId: CLERK,
      }),
    ),
    'cannot-confer-role',
    'ownership is the authority to dispose of the business, and an ADMIN who could confer it ' +
      'could take it',
  );
});

void test('nobody changes their own roles', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId, { roles: ['ADMIN'] });

  assert.equal(
    await codeOf(() =>
      harness.service.changeRoles({
        membershipId,
        roles: ['OWNER'],
        actorSubjectId: CLERK,
        reason: 'promoting myself, which should not be possible',
        occurredAt: LATER,
        correlationId: 'corr_01HR0ORGrol001',
        idempotencyKey: 'idem_01HR0ORGrol001',
        eventId: 'mev_01HR0ORGrol001',
      }),
    ),
    'not-your-decision',
  );
});

void test('an admin cannot remove an owner', async () => {
  const harness = build();
  const { organisationId, ownerMembershipId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['ADMIN'] });

  assert.equal(
    await codeOf(() =>
      harness.service.revokeMembership({
        membershipId: ownerMembershipId,
        actorSubjectId: CLERK,
        reason: 'removing the owner, which should not be possible',
        occurredAt: LATER,
        correlationId: 'corr_01HR0ORGrev001',
        idempotencyKey: 'idem_01HR0ORGrev001',
        eventId: 'mev_01HR0ORGrev001',
      }),
    ),
    'not-permitted-in-organisation',
    'an ADMIN who could revoke an OWNER could take the business by removing everybody above them',
  );
});

// ---------------------------------------------------------------------------
// Suspension and removal
// ---------------------------------------------------------------------------

void test('a suspended member stops acting immediately', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId, { roles: ['ADMIN'] });

  await harness.service.suspendMembership({
    membershipId,
    actorSubjectId: FOUNDER,
    reason: 'under review after a stock discrepancy',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGsus001',
    idempotencyKey: 'idem_01HR0ORGsus001',
    eventId: 'mev_01HR0ORGsus001',
  });

  assert.equal(await harness.service.findActingMembership(organisationId, CLERK), null);

  // And the check is in the one place every operation goes through, so it holds for operations
  // nobody thought to test individually.
  assert.equal(
    await codeOf(() =>
      aMember(harness, organisationId, {
        tag: 'rival1',
        personSubjectId: RIVAL,
        personAccountId: RIVAL_ACCOUNT,
        actorSubjectId: CLERK,
      }),
    ),
    'not-permitted-in-organisation',
  );
});

void test('a suspended member can be reinstated, and a removed one cannot', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId);

  await harness.service.suspendMembership({
    membershipId,
    actorSubjectId: FOUNDER,
    reason: 'under review after a stock discrepancy',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGsus002',
    idempotencyKey: 'idem_01HR0ORGsus002',
    eventId: 'mev_01HR0ORGsus002',
  });
  await harness.service.reinstateMembership({
    membershipId,
    actorSubjectId: FOUNDER,
    reason: 'review closed and the discrepancy was the courier',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGrei001',
    idempotencyKey: 'idem_01HR0ORGrei001',
    eventId: 'mev_01HR0ORGrei001',
  });
  assert.ok(await harness.service.findActingMembership(organisationId, CLERK));

  await harness.service.revokeMembership({
    membershipId,
    actorSubjectId: FOUNDER,
    reason: 'left the company and the place has ended',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGrev002',
    idempotencyKey: 'idem_01HR0ORGrev002',
    eventId: 'mev_01HR0ORGrev002',
  });

  assert.equal(await harness.service.findActingMembership(organisationId, CLERK), null);
  assert.deepEqual(
    MEMBERSHIP_TRANSITIONS.revoked,
    [],
    'removal is terminal: what the person did still names them, and a place that could be ' +
      'resurrected would let somebody deny the gap',
  );
});

void test('leaving is a person’s own act, and removing somebody is not', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId);

  // Somebody else cannot "leave" on your behalf.
  assert.equal(
    await codeOf(() =>
      harness.service.leaveOrganisation({
        membershipId,
        actorSubjectId: FOUNDER,
        reason: 'deciding that somebody else has resigned',
        occurredAt: LATER,
        correlationId: 'corr_01HR0ORGlev001',
        idempotencyKey: 'idem_01HR0ORGlev001',
        eventId: 'mev_01HR0ORGlev001',
      }),
    ),
    'not-your-decision',
  );

  // And you cannot suspend yourself either: that is somebody else's decision about you.
  assert.equal(
    await codeOf(() =>
      harness.service.suspendMembership({
        membershipId,
        actorSubjectId: CLERK,
        reason: 'suspending myself for no particular reason',
        occurredAt: LATER,
        correlationId: 'corr_01HR0ORGsus003',
        idempotencyKey: 'idem_01HR0ORGsus003',
        eventId: 'mev_01HR0ORGsus003',
      }),
    ),
    'not-your-decision',
  );

  const left = await harness.service.leaveOrganisation({
    membershipId,
    actorSubjectId: CLERK,
    reason: 'taking a job somewhere else',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGlev002',
    idempotencyKey: 'idem_01HR0ORGlev002',
    eventId: 'mev_01HR0ORGlev002',
  });
  assert.equal(left.membership.status, 'left');
});

// ---------------------------------------------------------------------------
// A business always has an owner
// ---------------------------------------------------------------------------

void test('the last owner cannot be suspended, removed, demoted, or walk out', async () => {
  const harness = build();
  const { organisationId, ownerMembershipId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['ADMIN'] });

  const attempts: ReadonlyArray<[string, () => Promise<unknown>]> = [
    [
      'suspended',
      () =>
        harness.service.suspendMembership({
          membershipId: ownerMembershipId,
          actorSubjectId: CLERK,
          reason: 'suspending the only owner',
          occurredAt: LATER,
          correlationId: 'corr_01HR0ORGlast01',
          idempotencyKey: 'idem_01HR0ORGlast01',
          eventId: 'mev_01HR0ORGlast01',
        }),
    ],
    [
      'left',
      () =>
        harness.service.leaveOrganisation({
          membershipId: ownerMembershipId,
          actorSubjectId: FOUNDER,
          reason: 'walking away from the business entirely',
          occurredAt: LATER,
          correlationId: 'corr_01HR0ORGlast02',
          idempotencyKey: 'idem_01HR0ORGlast02',
          eventId: 'mev_01HR0ORGlast02',
        }),
    ],
  ];

  for (const [what, attempt] of attempts) {
    const code = await codeOf(attempt);
    assert.ok(
      code === 'last-owner' || code === 'not-permitted-in-organisation',
      `${what} was refused with ${code}; the business must keep an owner`,
    );
  }

  // Demotion is the quiet one: nothing about it looks like removing anybody.
  assert.equal(
    await codeOf(() =>
      harness.service.changeRoles({
        membershipId: ownerMembershipId,
        roles: ['ADMIN'],
        actorSubjectId: CLERK,
        reason: 'demoting the only owner to an administrator',
        occurredAt: LATER,
        correlationId: 'corr_01HR0ORGlast03',
        idempotencyKey: 'idem_01HR0ORGlast03',
        eventId: 'mev_01HR0ORGlast03',
      }),
    ),
    'not-permitted-in-organisation',
    'an ADMIN cannot demote an owner at all — and even an owner could not demote the last one',
  );
});

void test('a second owner frees the first to leave', async () => {
  const harness = build();
  const { organisationId, ownerMembershipId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['OWNER'] });

  const left = await harness.service.leaveOrganisation({
    membershipId: ownerMembershipId,
    actorSubjectId: FOUNDER,
    reason: 'handing the business over and stepping away',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGhand01',
    idempotencyKey: 'idem_01HR0ORGhand01',
    eventId: 'mev_01HR0ORGhand01',
  });

  assert.equal(left.membership.status, 'left');
  assert.ok(await harness.service.findActingMembership(organisationId, CLERK));
});

// ---------------------------------------------------------------------------
// Scoping: the property the whole model exists for
// ---------------------------------------------------------------------------

void test('a role at one business confers nothing at another', async () => {
  const harness = build();
  const cement = await anOrganisation(harness, { tag: '0001', accountId: CEMENT_ACCOUNT });
  const hardware = await anOrganisation(harness, {
    tag: '0002',
    accountId: HARDWARE_ACCOUNT,
    ownerSubjectId: RIVAL,
    ownerAccountId: RIVAL_ACCOUNT,
  });

  // The same person, FINANCE at one business and nothing at the other.
  await aMember(harness, cement.organisationId, { roles: ['FINANCE'] });

  const atCement = await harness.service.findActingMembership(cement.organisationId, CLERK);
  const atHardware = await harness.service.findActingMembership(hardware.organisationId, CLERK);

  assert.deepEqual(atCement?.roles, ['FINANCE']);
  assert.equal(
    atHardware,
    null,
    'a bookkeeping job at one company is not a key to every company the person has worked for',
  );
});

void test('one person holds several places at once, each on its own terms', async () => {
  const harness = build();
  const cement = await anOrganisation(harness, { tag: '0001', accountId: CEMENT_ACCOUNT });
  const hardware = await anOrganisation(harness, {
    tag: '0002',
    accountId: HARDWARE_ACCOUNT,
    ownerSubjectId: RIVAL,
    ownerAccountId: RIVAL_ACCOUNT,
  });

  await aMember(harness, cement.organisationId, { tag: 'atcem', roles: ['OWNER', 'SALES'] });
  await aMember(harness, hardware.organisationId, {
    tag: 'athdw',
    roles: ['FINANCE'],
    actorSubjectId: RIVAL,
  });

  const held = await harness.service.listMembershipsForPerson(CLERK);
  assert.equal(held.length, 2);
  assert.deepEqual(
    held.map((one) => one.roles).sort(),
    [['FINANCE'], ['OWNER', 'SALES']].sort(),
    'three separate authorities under one identity is the point of the model',
  );
});

void test('a person is invited to one business once', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  await aMember(harness, organisationId);

  assert.equal(
    await codeOf(() => aMember(harness, organisationId, { tag: 'clerk2' })),
    'already-a-member',
    'two memberships would be two answers to "what may they do here"',
  );
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

void test('the history says who did what to whom, and why', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId);

  await harness.service.suspendMembership({
    membershipId,
    actorSubjectId: FOUNDER,
    reason: 'under review after a stock discrepancy',
    occurredAt: LATER,
    correlationId: 'corr_01HR0ORGhis001',
    idempotencyKey: 'idem_01HR0ORGhis001',
    eventId: 'mev_01HR0ORGhis001',
  });

  const history = await harness.service.listMembershipHistory(membershipId);
  assert.deepEqual(
    history.map((event) => event.toStatus),
    ['invited', 'active', 'suspended'],
  );
  assert.equal(history[0]?.actorSubjectId, FOUNDER, 'the founder invited them');
  assert.equal(history[1]?.actorSubjectId, CLERK, 'and they accepted, themselves');
  assert.match(history[2]?.reason ?? '', /stock discrepancy/);
});

void test('an event says a membership changed and never what it permits', async () => {
  // Who holds what authority in a company tells a competitor who to approach and who has just
  // left. The event log is read by every subscriber and kept indefinitely; the roles belong in the
  // audit record, which is not a subscription.
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['PROCUREMENT'] });

  const published = harness.repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === 'event');

  const serialised = JSON.stringify(published);
  assert.ok(
    published.length >= 3,
    'the creation and the two membership transitions were published',
  );
  assert.equal(
    serialised.includes('PROCUREMENT'),
    false,
    'no role travels in an event, however convenient it would be for a consumer',
  );
  assert.equal(
    serialised.includes(organisationId),
    true,
    'the business does, so a consumer routes',
  );
});

void test('the audit record carries the roles and the human who decided them', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  await aMember(harness, organisationId, { roles: ['PROCUREMENT'] });

  const audits = harness.repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === 'audit');
  const serialised = JSON.stringify(audits);

  assert.ok(serialised.includes('PROCUREMENT'), 'what was conferred is on the audit record');
  assert.ok(
    serialised.includes(FOUNDER),
    'and so is the human who conferred it. A business does not act; people act for it',
  );
});

// ---------------------------------------------------------------------------
// Refusals and hygiene
// ---------------------------------------------------------------------------

void test('a membership with no roles is refused', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);

  assert.equal(await codeOf(() => aMember(harness, organisationId, { roles: [] })), 'no-roles');
});

void test('roles are ordered and deduplicated, so a retry converges', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId, {
    roles: ['SALES', 'ADMIN', 'SALES'],
  });

  const membership = await harness.service.getMembership(membershipId);
  assert.deepEqual(
    membership?.roles,
    ['ADMIN', 'SALES'],
    'two memberships with the same roles compare equal however the caller listed them',
  );
});

void test('fields another component owns are refused by name', async () => {
  const harness = build();

  for (const field of ['verified', 'categories', 'grants', 'password', 'email', 'balance']) {
    const code = await codeOf(() =>
      harness.service.createOrganisation({
        organisationId: 'org_01HR0ORGforeign1',
        accountId: CEMENT_ACCOUNT,
        kind: 'supplier',
        displayName: 'A business asserting what is not its to say',
        ownerSubjectId: FOUNDER,
        ownerAccountId: FOUNDER_ACCOUNT,
        membershipId: 'mem_01HR0ORGforeign',
        createdAt: NOW,
        correlationId: 'corr_01HR0ORGforeign',
        idempotencyKey: 'idem_01HR0ORGforeign',
        eventId: 'oev_01HR0ORGforeign',
        membershipEventId: 'mev_01HR0ORGforeign',
        [field]: 'anything',
      }),
    );
    assert.equal(code, 'foreign-concern', `${field} must be refused`);
  }
});

void test('a returned membership cannot be edited into more authority', async () => {
  const harness = build();
  const { organisationId } = await anOrganisation(harness);
  const membershipId = await aMember(harness, organisationId);
  const membership = await harness.service.getMembership(membershipId);
  assert.ok(membership !== null);

  assert.throws(() => {
    (membership as { status: string }).status = 'active';
  });
  assert.throws(() => {
    (membership.roles as MembershipRole[]).push('OWNER');
  }, 'authority read from a mutable array is authority anybody holding the object can widen');
});

void test('the module reads no clock and generates no randomness', () => {
  const directory = path.join(REPO_ROOT, 'modules/organisations');
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /crypto\.randomUUID\(/];

  for (const file of [
    'service.ts',
    'repository.ts',
    'validate.ts',
    'registry.ts',
    'outbox.ts',
    'immutable.ts',
  ]) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        pattern.exec(source) === null,
        `${file} uses ${String(pattern)}; the caller supplies every instant and identifier`,
      );
    }
  }
});
