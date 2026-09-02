/**
 * M-49 Organisations against a live PostgreSQL server — opt-in, honestly skipped.
 *
 * Migration 0058 declares four things TypeScript cannot, and each is proved here by issuing the
 * offending statement rather than by asserting that the service does not issue it. The service has
 * no path that would try, which is exactly the case a constraint exists for: the defence has to
 * survive somebody writing SQL by hand.
 *
 *   * **One account, one business.** Two organisations on one account would be two sets of books
 *     under one name, and every listing, order and wallet naming that account would be ambiguous
 *     about whose it is.
 *   * **One person, one place, per business.** Two memberships would be two answers to "what may
 *     they do here", with nothing to say which applies.
 *   * **A business always has an active owner.** `membership_keeps_an_owner` is a **deferred**
 *     constraint trigger, and both halves of that matter: it refuses the last owner leaving, and it
 *     permits founding a business — where the organisation and its owner are written in one
 *     transaction and a per-statement trigger would refuse the first of the two.
 *   * **Both histories are append-only.** What happened to somebody's place in a business is what
 *     an argument about it is settled from.
 *
 * The suite also covers what no in-memory test structurally can: roles survive as a real `text[]`
 * rather than as a string that happens to round-trip, and microsecond instants survive `timestamptz`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryOrganisationRepository,
  OrganisationError,
  OrganisationService,
  PostgresOrganisationRepository,
} from '../../modules/organisations/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { parseInstant } from '../../platform/time/instant.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const CEMENT_ACCOUNT = 'acct_live_orgcement1';
const HARDWARE_ACCOUNT = 'acct_live_orghardwr1';

const FOUNDER = 'sub_live_orgfounder1';
const FOUNDER_ACCOUNT = 'acct_live_orgfounder';
const CLERK = 'sub_live_orgclerk001';
const CLERK_ACCOUNT = 'acct_live_orgclerk01';

const NOW = '2026-07-01T09:00:00.123456Z';
const MIDDAY = '2026-07-01T12:00:00.000000Z';
/** An invitation and its acceptance are different moments, and the history reads in that order. */
const AFTERNOON = '2026-07-01T14:00:00.000000Z';
const LATER = '2026-07-01T15:30:00.000000Z';

function serviceFor(database: Database): OrganisationService {
  return new OrganisationService(new PostgresOrganisationRepository(database));
}

/** The error message when the statement is refused, or null when it succeeded. */
async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

async function rows(database: Database, sql: string): Promise<readonly Record<string, unknown>[]> {
  const client = await database.connect();
  try {
    const result = await client.query<Record<string, unknown>>(sql);
    return result.rows;
  } finally {
    await client.release();
  }
}

interface OrganisationOptions {
  readonly tag?: string;
  readonly accountId?: string;
  readonly kind?: string;
  readonly ownerSubjectId?: string;
  readonly ownerAccountId?: string;
}

async function anOrganisation(
  service: OrganisationService,
  options: OrganisationOptions = {},
): Promise<{ organisationId: string; ownerMembershipId: string }> {
  const tag = options.tag ?? '0001';
  const organisationId = `org_live_org${tag}`;
  const ownerMembershipId = `mem_live_org${tag}own`;

  await service.createOrganisation({
    organisationId,
    accountId: options.accountId ?? CEMENT_ACCOUNT,
    kind: options.kind ?? 'supplier',
    displayName: `Business ${tag}`,
    ownerSubjectId: options.ownerSubjectId ?? FOUNDER,
    ownerAccountId: options.ownerAccountId ?? FOUNDER_ACCOUNT,
    membershipId: ownerMembershipId,
    createdAt: NOW,
    correlationId: `corr_live_org${tag}`,
    idempotencyKey: `idem_live_org${tag}`,
    eventId: `oev_live_org${tag}`,
    membershipEventId: `mev_live_org${tag}`,
  });

  return { organisationId, ownerMembershipId };
}

async function aMember(
  service: OrganisationService,
  organisationId: string,
  options: {
    readonly tag?: string;
    readonly roles?: readonly string[];
    readonly personSubjectId?: string;
  } = {},
): Promise<string> {
  const tag = options.tag ?? 'clerk1';
  const membershipId = `mem_live_org${tag}`;
  const person = options.personSubjectId ?? CLERK;

  await service.inviteMember({
    membershipId,
    organisationId,
    personSubjectId: person,
    personAccountId: CLERK_ACCOUNT,
    roles: options.roles ?? ['SALES'],
    actorSubjectId: FOUNDER,
    invitedAt: MIDDAY,
    correlationId: `corr_live_org${tag}inv`,
    idempotencyKey: `idem_live_org${tag}inv`,
    eventId: `mev_live_org${tag}inv`,
  });
  await service.acceptMembership({
    membershipId,
    actorSubjectId: person,
    acceptedAt: AFTERNOON,
    correlationId: `corr_live_org${tag}acc`,
    idempotencyKey: `idem_live_org${tag}acc`,
    eventId: `mev_live_org${tag}acc`,
  });

  return membershipId;
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

void test(
  'a business and its owner round-trip through PostgreSQL, roles intact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      const { organisationId, ownerMembershipId } = await anOrganisation(service);

      const organisation = await service.getOrganisation(organisationId);
      assert.equal(organisation?.status, 'pending');
      assert.equal(organisation?.accountId, CEMENT_ACCOUNT);
      assert.equal(
        parseInstant(organisation?.createdAt ?? '').epochMicros,
        parseInstant(NOW).epochMicros,
        'microseconds survive the timestamptz round trip',
      );

      const owner = await service.getMembership(ownerMembershipId);
      assert.deepEqual(
        owner?.roles,
        ['OWNER'],
        'roles come back as an array. A comma-joined string would be a list nobody can query, and ' +
          '"who owns this business" is a question an operator will ask',
      );

      // Several roles, ordered by the vocabulary, so a retry compares equal.
      const membershipId = await aMember(service, organisationId, {
        roles: ['SALES', 'ADMIN', 'SALES'],
      });
      const member = await service.getMembership(membershipId);
      assert.deepEqual(member?.roles, ['ADMIN', 'SALES']);

      // And the query the header is about actually works against the column.
      const owners = await rows(
        database,
        `SELECT membership_id FROM module_organisations.organisation_membership
          WHERE organisation_id = '${organisationId}' AND 'OWNER' = ANY(roles)`,
      );
      assert.deepEqual(
        owners.map((row) => row.membership_id),
        [ownerMembershipId],
      );
    });
  },
);

// ---------------------------------------------------------------------------
// One account, one business
// ---------------------------------------------------------------------------

void test('the database refuses a second business on one account', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    await anOrganisation(service);

    await assert.rejects(
      anOrganisation(service, { tag: '0002' }),
      (error: unknown) =>
        error instanceof OrganisationError && error.code === 'account-already-organisation',
    );

    const message = await refuses(
      database,
      `INSERT INTO module_organisations.organisation
         (organisation_id, account_id, kind, display_name, status, created_at, updated_at,
          correlation_id, idempotency_key)
       VALUES ('org_live_orgsecond', '${CEMENT_ACCOUNT}', 'merchant', 'The same account again',
               'pending', '${NOW}', '${NOW}', 'corr_live_orgsecond', 'idem_live_orgsecond')`,
    );
    assert.ok(message !== null, 'a raw second business on one account must be refused');
    assert.match(message, /organisation_account_unique/);
  });
});

void test('the database refuses a second membership for one person', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const { organisationId } = await anOrganisation(service);
    await aMember(service, organisationId);

    const message = await refuses(
      database,
      `INSERT INTO module_organisations.organisation_membership
         (membership_id, organisation_id, person_subject_id, person_account_id, roles, status,
          invited_by, invited_at, accepted_at, correlation_id, idempotency_key)
       VALUES ('mem_live_orgdouble', '${organisationId}', '${CLERK}', '${CLERK_ACCOUNT}',
               ARRAY['OWNER']::text[], 'active', '${FOUNDER}', '${MIDDAY}', '${MIDDAY}',
               'corr_live_orgdouble', 'idem_live_orgdouble')`,
    );
    assert.ok(message !== null, 'a second place for one person must be refused');
    assert.match(message, /organisation_membership_one_per_person/);
  });
});

// ---------------------------------------------------------------------------
// A business always has an owner — and founding one still works
// ---------------------------------------------------------------------------

void test('founding a business passes the deferred owner trigger', liveTestOptions, async () => {
  // The half of the rule that a per-statement trigger would break. The organisation and its owner
  // are written in one transaction; a trigger that fired on the first statement would find no
  // owner yet and refuse the business at the moment of its creation.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const { organisationId } = await anOrganisation(service);
    assert.ok(await service.getOrganisation(organisationId));
  });
});

void test(
  'the database refuses to leave a business without an owner',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      const { organisationId, ownerMembershipId } = await anOrganisation(service);
      await aMember(service, organisationId, { roles: ['ADMIN'] });

      // The service refuses it with advice: make somebody else an owner first.
      await assert.rejects(
        service.leaveOrganisation({
          membershipId: ownerMembershipId,
          actorSubjectId: FOUNDER,
          reason: 'walking away from the business entirely',
          occurredAt: LATER,
          correlationId: 'corr_live_orglast01',
          idempotencyKey: 'idem_live_orglast01',
          eventId: 'mev_live_orglast01',
        }),
        (error: unknown) => error instanceof OrganisationError && error.code === 'last-owner',
      );

      // And so does the database, for somebody writing SQL by hand.
      const revoked = await refuses(
        database,
        `UPDATE module_organisations.organisation_membership
          SET status = 'revoked', ended_at = '${LATER}'
        WHERE membership_id = '${ownerMembershipId}'`,
      );
      assert.ok(revoked !== null, 'revoking the only owner must be refused');
      assert.match(revoked, /no active owner/);

      const demoted = await refuses(
        database,
        `UPDATE module_organisations.organisation_membership
          SET roles = ARRAY['ADMIN']::text[]
        WHERE membership_id = '${ownerMembershipId}'`,
      );
      assert.ok(demoted !== null, 'demoting the only owner must be refused');
      assert.match(demoted, /no active owner/);

      const deleted = await refuses(
        database,
        `DELETE FROM module_organisations.organisation_membership
        WHERE membership_id = '${ownerMembershipId}'`,
      );
      assert.ok(deleted !== null, 'deleting the only owner must be refused');
    });
  },
);

void test('a second owner frees the first, in the database too', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const { organisationId, ownerMembershipId } = await anOrganisation(service);
    await aMember(service, organisationId, { roles: ['OWNER'] });

    const left = await service.leaveOrganisation({
      membershipId: ownerMembershipId,
      actorSubjectId: FOUNDER,
      reason: 'handing the business over and stepping away',
      occurredAt: LATER,
      correlationId: 'corr_live_orghand01',
      idempotencyKey: 'idem_live_orghand01',
      eventId: 'mev_live_orghand01',
    });
    assert.equal(left.membership.status, 'left');
  });
});

// ---------------------------------------------------------------------------
// The histories cannot be rewritten
// ---------------------------------------------------------------------------

void test('both histories are append-only in the database', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const { organisationId } = await anOrganisation(service);
    const membershipId = await aMember(service, organisationId);

    await service.suspendMembership({
      membershipId,
      actorSubjectId: FOUNDER,
      reason: 'under review after a stock discrepancy',
      occurredAt: LATER,
      correlationId: 'corr_live_orgsus01',
      idempotencyKey: 'idem_live_orgsus01',
      eventId: 'mev_live_orgsus01',
    });

    for (const statement of [
      `UPDATE module_organisations.membership_event SET reason = 'an administrative matter'
        WHERE membership_id = '${membershipId}'`,
      `DELETE FROM module_organisations.membership_event WHERE membership_id = '${membershipId}'`,
      `UPDATE module_organisations.organisation_event SET reason = 'an administrative matter'
        WHERE organisation_id = '${organisationId}'`,
      `DELETE FROM module_organisations.organisation_event
        WHERE organisation_id = '${organisationId}'`,
    ]) {
      const message = await refuses(database, statement);
      assert.ok(message !== null, statement);
      assert.match(message, /append-only/);
    }

    const history = await service.listMembershipHistory(membershipId);
    assert.deepEqual(
      history.map((event) => event.toStatus),
      ['invited', 'active', 'suspended'],
    );
    assert.equal(history[1]?.actorSubjectId, CLERK, 'they accepted, themselves');
  });
});

// ---------------------------------------------------------------------------
// Scoping, against real rows
// ---------------------------------------------------------------------------

void test('a role at one business confers nothing at another', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const cement = await anOrganisation(service, { tag: '0001', accountId: CEMENT_ACCOUNT });
    const hardware = await anOrganisation(service, {
      tag: '0002',
      accountId: HARDWARE_ACCOUNT,
      ownerSubjectId: 'sub_live_orgother001',
      ownerAccountId: 'acct_live_orgother01',
    });

    await aMember(service, cement.organisationId, { roles: ['FINANCE'] });

    assert.deepEqual((await service.findActingMembership(cement.organisationId, CLERK))?.roles, [
      'FINANCE',
    ]);
    assert.equal(
      await service.findActingMembership(hardware.organisationId, CLERK),
      null,
      'a bookkeeping job at one company is not a key to every company the person has worked for',
    );
  });
});

// ---------------------------------------------------------------------------
// The adapter and the reference agree
// ---------------------------------------------------------------------------

void test(
  'the adapter and the in-memory reference refuse the same things',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const live = serviceFor(database);
      const reference = new OrganisationService(new InMemoryOrganisationRepository());

      for (const service of [live, reference]) {
        await anOrganisation(service);
        const organisationId = 'org_live_org0001';
        await aMember(service, organisationId, { roles: ['MANAGER'] });

        // A manager may not build a team.
        const invited = await service
          .inviteMember({
            membershipId: 'mem_live_orgnope001',
            organisationId,
            personSubjectId: 'sub_live_orgnope0001',
            personAccountId: 'acct_live_orgnope01',
            roles: ['SALES'],
            actorSubjectId: CLERK,
            invitedAt: LATER,
            correlationId: 'corr_live_orgnope01',
            idempotencyKey: 'idem_live_orgnope01',
            eventId: 'mev_live_orgnope01',
          })
          .then(
            () => 'permitted',
            (error: unknown) => (error instanceof OrganisationError ? error.code : 'other'),
          );
        assert.equal(invited, 'not-permitted-in-organisation');

        // And one account still trades as one business.
        const second = await service
          .createOrganisation({
            organisationId: 'org_live_orgdup001',
            accountId: CEMENT_ACCOUNT,
            kind: 'merchant',
            displayName: 'The same account again',
            ownerSubjectId: FOUNDER,
            ownerAccountId: FOUNDER_ACCOUNT,
            membershipId: 'mem_live_orgdup001',
            createdAt: NOW,
            correlationId: 'corr_live_orgdup01',
            idempotencyKey: 'idem_live_orgdup01',
            eventId: 'oev_live_orgdup01',
            membershipEventId: 'mev_live_orgdup01',
          })
          .then(
            () => 'permitted',
            (error: unknown) => (error instanceof OrganisationError ? error.code : 'other'),
          );
        assert.equal(second, 'account-already-organisation');
      }
    });
  },
);
