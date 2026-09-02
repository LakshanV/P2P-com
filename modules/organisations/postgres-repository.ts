/**
 * M-49 — the PostgreSQL adapter.
 *
 * Two things here are worth reading before the statements.
 *
 * **Roles are a `text[]` column, and they come back as an array.** A comma-joined string would be a
 * list nobody can query — "who are the owners of this business" is a question an operator will ask,
 * and `'OWNER' = ANY(roles)` answers it while `LIKE '%OWNER%'` matches `DRIVER_MANAGER` in a schema
 * that later gains a role with `OWNER` inside it.
 *
 * **`organisation_id` and `person_subject_id` never change on a membership.** They are absent from
 * every `SET` list: a membership that could be moved between businesses, or reassigned to another
 * person, would make every audit record naming it a record about somebody else.
 *
 * Every `timestamptz` is projected as UTC text through `to_char`, so the driver never parses a
 * timestamp into a `Date` and rounds it to the millisecond. No statement names another unit's
 * schema, and there is no foreign key out of `module_organisations`.
 *
 * Owned by: M-49 Organisations.
 */

import { databaseErrorDetail } from '../../platform/db/client.ts';
import type { Database, DatabaseClient } from '../../platform/db/client.ts';
import type { OutboxEntry } from '../../platform/outbox/types.ts';

import {
  sealMembership,
  sealMembershipEvent,
  sealOrganisation,
  sealOrganisationEvent,
} from './immutable.ts';
import type { OrganisationRepository, OrganisationTransaction } from './repository.ts';
import {
  OrganisationError,
  type MembershipEvent,
  type Organisation,
  type OrganisationErrorCode,
  type OrganisationEvent,
  type OrganisationMembership,
} from './types.ts';
import {
  validateMembership,
  validateMembershipEvent,
  validateOrganisation,
  validateOrganisationEvent,
} from './validate.ts';

export const ORGANISATION_SCHEMA = 'module_organisations';
export const ORGANISATION_TABLE = `${ORGANISATION_SCHEMA}.organisation`;
export const MEMBERSHIP_TABLE = `${ORGANISATION_SCHEMA}.organisation_membership`;
export const MEMBERSHIP_EVENT_TABLE = `${ORGANISATION_SCHEMA}.membership_event`;
export const ORGANISATION_EVENT_TABLE = `${ORGANISATION_SCHEMA}.organisation_event`;
export const OUTBOX_TABLE = `${ORGANISATION_SCHEMA}.outbox`;

/** SQLSTATE 23505. The only driver code this adapter interprets. */
const UNIQUE_VIOLATION = '23505';

const CONSTRAINT_MEANINGS: Readonly<
  Record<string, { readonly code: OrganisationErrorCode; readonly explanation: string }>
> = {
  organisation_pkey: {
    code: 'duplicate-organisation-id',
    explanation: 'an organisation with this id already exists',
  },
  organisation_account_unique: {
    code: 'account-already-organisation',
    explanation:
      'this account already trades as an organisation. One account, one business: two would be ' +
      'two sets of books under one name',
  },
  organisation_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already created an organisation',
  },
  organisation_membership_pkey: {
    code: 'duplicate-membership-id',
    explanation: 'a membership with this id already exists',
  },
  organisation_membership_one_per_person: {
    code: 'already-a-member',
    explanation:
      'that person already holds a place in this business. Two memberships would be two answers ' +
      'to "what may they do here", and nothing would say which one applies',
  },
  organisation_membership_idempotency_unique: {
    code: 'idempotency-key-reuse',
    explanation: 'this idempotency key has already created a membership',
  },
  membership_event_pkey: {
    code: 'malformed-record',
    explanation: 'a membership change with this id has already been recorded',
  },
  organisation_event_pkey: {
    code: 'malformed-record',
    explanation: 'an organisation change with this id has already been recorded',
  },
};

function normalizeDatabaseError(error: unknown): unknown {
  if (error instanceof OrganisationError) return error;

  const detail = databaseErrorDetail(error);
  if (detail.code !== UNIQUE_VIOLATION) return error;

  const message = error instanceof Error ? error.message : String(error);
  const named =
    detail.constraint ??
    Object.keys(CONSTRAINT_MEANINGS).find((constraint) => message.includes(constraint));
  const meaning = named === undefined ? undefined : CONSTRAINT_MEANINGS[named];
  if (meaning === undefined) return error;

  return new OrganisationError(meaning.code, meaning.explanation);
}

function utcText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
}

const ORGANISATION_PROJECTION = [
  'organisation_id',
  'account_id',
  'kind',
  'display_name',
  'status',
  utcText('created_at'),
  utcText('updated_at'),
  utcText('closed_at'),
  'closure_reason',
  'correlation_id',
  'idempotency_key',
].join(', ');

const MEMBERSHIP_PROJECTION = [
  'membership_id',
  'organisation_id',
  'person_subject_id',
  'person_account_id',
  'roles',
  'status',
  'invited_by',
  utcText('invited_at'),
  utcText('accepted_at'),
  utcText('suspended_at'),
  utcText('ended_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const MEMBERSHIP_EVENT_PROJECTION = [
  'event_id',
  'membership_id',
  'organisation_id',
  'from_status',
  'to_status',
  'roles',
  'actor_subject_id',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const ORGANISATION_EVENT_PROJECTION = [
  'event_id',
  'organisation_id',
  'from_status',
  'to_status',
  'reason',
  utcText('occurred_at'),
  'correlation_id',
  'idempotency_key',
].join(', ');

const OUTBOX_COLUMNS = [
  'outbox_id',
  'idempotency_key',
  'kind',
  'payload',
  'recorded_at',
  'producer',
  'correlation_id',
  'processed_at',
  'retry_count',
  'last_error',
].join(', ');

/**
 * The driver returns a `text[]` as a JavaScript array. Anything else is a schema that changed
 * without this adapter, and presenting it as a role list would be inventing authority.
 */
function readRoles(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new OrganisationError(
      'malformed-record',
      `${what} came back as ${value === null ? 'null' : typeof value} rather than an array of ` +
        'roles. A role list read as anything else is authority nobody can check',
    );
  }
  return value as readonly string[];
}

function toOrganisation(row: Record<string, unknown>): Organisation {
  return sealOrganisation(
    validateOrganisation(
      {
        organisationId: row.organisation_id,
        accountId: row.account_id,
        kind: row.kind,
        displayName: row.display_name,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at ?? null,
        closureReason: row.closure_reason ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toMembership(row: Record<string, unknown>): OrganisationMembership {
  return sealMembership(
    validateMembership(
      {
        membershipId: row.membership_id,
        organisationId: row.organisation_id,
        personSubjectId: row.person_subject_id,
        personAccountId: row.person_account_id,
        roles: readRoles(row.roles, 'a membership’s roles'),
        status: row.status,
        invitedBy: row.invited_by ?? null,
        invitedAt: row.invited_at,
        acceptedAt: row.accepted_at ?? null,
        suspendedAt: row.suspended_at ?? null,
        endedAt: row.ended_at ?? null,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toMembershipEvent(row: Record<string, unknown>): MembershipEvent {
  return sealMembershipEvent(
    validateMembershipEvent(
      {
        eventId: row.event_id,
        membershipId: row.membership_id,
        organisationId: row.organisation_id,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        roles: readRoles(row.roles, 'a membership event’s roles'),
        actorSubjectId: row.actor_subject_id,
        reason: row.reason,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

function toOrganisationEvent(row: Record<string, unknown>): OrganisationEvent {
  return sealOrganisationEvent(
    validateOrganisationEvent(
      {
        eventId: row.event_id,
        organisationId: row.organisation_id,
        fromStatus: row.from_status ?? null,
        toStatus: row.to_status,
        reason: row.reason,
        occurredAt: row.occurred_at,
        correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key,
      },
      'stored row',
    ),
  );
}

class PostgresOrganisationTransaction implements OrganisationTransaction {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = client;
  }

  async insertOutbox(entry: OutboxEntry): Promise<void> {
    await this.#client.query(
      `INSERT INTO ${OUTBOX_TABLE} (${OUTBOX_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        entry.outboxId,
        entry.idempotencyKey,
        entry.kind,
        JSON.stringify(entry.payload),
        entry.recordedAt,
        entry.producer,
        entry.correlationId,
        entry.processedAt,
        entry.retryCount,
        entry.lastError,
      ],
    );
  }

  async findOrganisationById(organisationId: string): Promise<Organisation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORGANISATION_PROJECTION} FROM ${ORGANISATION_TABLE} WHERE organisation_id = $1;`,
      [organisationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrganisation(row);
  }

  async findOrganisationByAccountId(accountId: string): Promise<Organisation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORGANISATION_PROJECTION} FROM ${ORGANISATION_TABLE} WHERE account_id = $1;`,
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrganisation(row);
  }

  async findOrganisationByIdempotencyKey(idempotencyKey: string): Promise<Organisation | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORGANISATION_PROJECTION} FROM ${ORGANISATION_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOrganisation(row);
  }

  async insertOrganisation(organisation: Organisation): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORGANISATION_TABLE}
           (organisation_id, account_id, kind, display_name, status, created_at, updated_at,
            closed_at, closure_reason, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          organisation.organisationId,
          organisation.accountId,
          organisation.kind,
          organisation.displayName,
          organisation.status,
          organisation.createdAt,
          organisation.updatedAt,
          organisation.closedAt,
          organisation.closureReason,
          organisation.correlationId,
          organisation.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Change what can change.
   *
   * `account_id`, `kind` and `created_at` are not in the SET list. A business belongs to one account
   * for its whole life: an organisation that could change accounts would make every order, wallet
   * and listing naming that account ambiguous about whose they are.
   */
  async updateOrganisation(organisation: Organisation): Promise<void> {
    const result = await this.#client.query(
      `UPDATE ${ORGANISATION_TABLE}
          SET display_name = $2,
              status = $3,
              updated_at = $4,
              closed_at = $5,
              closure_reason = $6
        WHERE organisation_id = $1;`,
      [
        organisation.organisationId,
        organisation.displayName,
        organisation.status,
        organisation.updatedAt,
        organisation.closedAt,
        organisation.closureReason,
      ],
    );
    if (result.rowCount === 0) {
      throw new OrganisationError(
        'organisation-not-found',
        `organisation ${organisation.organisationId} does not exist`,
      );
    }
  }

  async findMembershipById(membershipId: string): Promise<OrganisationMembership | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_PROJECTION} FROM ${MEMBERSHIP_TABLE} WHERE membership_id = $1;`,
      [membershipId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMembership(row);
  }

  async findMembership(
    organisationId: string,
    personSubjectId: string,
  ): Promise<OrganisationMembership | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_PROJECTION} FROM ${MEMBERSHIP_TABLE}
        WHERE organisation_id = $1 AND person_subject_id = $2;`,
      [organisationId, personSubjectId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMembership(row);
  }

  async findMembershipByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<OrganisationMembership | null> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_PROJECTION} FROM ${MEMBERSHIP_TABLE} WHERE idempotency_key = $1;`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMembership(row);
  }

  async findMembershipsForOrganisation(
    organisationId: string,
  ): Promise<readonly OrganisationMembership[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_PROJECTION} FROM ${MEMBERSHIP_TABLE}
        WHERE organisation_id = $1
        ORDER BY invited_at, membership_id;`,
      [organisationId],
    );
    return Object.freeze(result.rows.map(toMembership));
  }

  async findMembershipsForPerson(
    personSubjectId: string,
  ): Promise<readonly OrganisationMembership[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_PROJECTION} FROM ${MEMBERSHIP_TABLE}
        WHERE person_subject_id = $1
        ORDER BY invited_at, membership_id;`,
      [personSubjectId],
    );
    return Object.freeze(result.rows.map(toMembership));
  }

  async insertMembership(membership: OrganisationMembership): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MEMBERSHIP_TABLE}
           (membership_id, organisation_id, person_subject_id, person_account_id, roles, status,
            invited_by, invited_at, accepted_at, suspended_at, ended_at, correlation_id,
            idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
          membership.membershipId,
          membership.organisationId,
          membership.personSubjectId,
          membership.personAccountId,
          [...membership.roles],
          membership.status,
          membership.invitedBy,
          membership.invitedAt,
          membership.acceptedAt,
          membership.suspendedAt,
          membership.endedAt,
          membership.correlationId,
          membership.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  /**
   * Change what can change.
   *
   * Not `organisation_id`, and not `person_subject_id`. A membership that could be moved between
   * businesses, or reassigned to another person, would turn every audit record naming it into a
   * record about somebody else — retrospectively, and silently.
   */
  async updateMembership(membership: OrganisationMembership): Promise<void> {
    const result = await this.#client.query(
      `UPDATE ${MEMBERSHIP_TABLE}
          SET roles = $2,
              status = $3,
              accepted_at = $4,
              suspended_at = $5,
              ended_at = $6
        WHERE membership_id = $1;`,
      [
        membership.membershipId,
        [...membership.roles],
        membership.status,
        membership.acceptedAt,
        membership.suspendedAt,
        membership.endedAt,
      ],
    );
    if (result.rowCount === 0) {
      throw new OrganisationError(
        'membership-not-found',
        `membership ${membership.membershipId} does not exist`,
      );
    }
  }

  /**
   * The history, oldest first.
   *
   * Ordered by the instant, with `event_id` breaking ties so the sequence is at least **stable**.
   * A tie means the caller supplied the same instant for two changes, which is a caller telling the
   * platform that an invitation and its acceptance happened at the same microsecond — and when
   * somebody says that, no ordering here can recover which came first. The in-memory reference
   * returns insertion order, so a suite that ties would pass there and disagree here; that is how
   * this tie-break came to be written down rather than assumed.
   */
  async findMembershipEvents(membershipId: string): Promise<readonly MembershipEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${MEMBERSHIP_EVENT_PROJECTION} FROM ${MEMBERSHIP_EVENT_TABLE}
        WHERE membership_id = $1
        ORDER BY occurred_at, event_id;`,
      [membershipId],
    );
    return Object.freeze(result.rows.map(toMembershipEvent));
  }

  async insertMembershipEvent(event: MembershipEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${MEMBERSHIP_EVENT_TABLE}
           (event_id, membership_id, organisation_id, from_status, to_status, roles,
            actor_subject_id, reason, occurred_at, correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);`,
        [
          event.eventId,
          event.membershipId,
          event.organisationId,
          event.fromStatus,
          event.toStatus,
          [...event.roles],
          event.actorSubjectId,
          event.reason,
          event.occurredAt,
          event.correlationId,
          event.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  async findOrganisationEvents(organisationId: string): Promise<readonly OrganisationEvent[]> {
    const result = await this.#client.query<Record<string, unknown>>(
      `SELECT ${ORGANISATION_EVENT_PROJECTION} FROM ${ORGANISATION_EVENT_TABLE}
        WHERE organisation_id = $1
        ORDER BY occurred_at, event_id;`,
      [organisationId],
    );
    return Object.freeze(result.rows.map(toOrganisationEvent));
  }

  async insertOrganisationEvent(event: OrganisationEvent): Promise<void> {
    try {
      await this.#client.query(
        `INSERT INTO ${ORGANISATION_EVENT_TABLE}
           (event_id, organisation_id, from_status, to_status, reason, occurred_at,
            correlation_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
        [
          event.eventId,
          event.organisationId,
          event.fromStatus,
          event.toStatus,
          event.reason,
          event.occurredAt,
          event.correlationId,
          event.idempotencyKey,
        ],
      );
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * A repository that writes inside somebody else's transaction.
 *
 * The same shape M-48 uses, and for the same reason: a consumer that has to record an organisation
 * change alongside its own write needs both in one transaction, and a repository that opened its
 * own would make "both or neither" impossible.
 */
class EnlistedOrganisationRepository implements OrganisationRepository {
  readonly #client: DatabaseClient;

  constructor(client: DatabaseClient) {
    this.#client = enlistedClient(client);
  }

  withTransaction<T>(body: (tx: OrganisationTransaction) => Promise<T>): Promise<T> {
    return body(new PostgresOrganisationTransaction(this.#client));
  }
}

/** Refuses the three statements that would end the caller's transaction under them. */
function enlistedClient(client: DatabaseClient): DatabaseClient {
  const forbidden = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i;
  return {
    query<QueryRow>(sql: string, params?: readonly unknown[]) {
      if (forbidden.test(sql)) {
        return Promise.reject(
          new OrganisationError(
            'malformed-record',
            `an enlisted organisation write may not issue ` +
              `"${sql.trim().split(/\s+/, 2).join(' ')}". The transaction belongs to the caller`,
          ),
        );
      }
      return client.query<QueryRow>(sql, params);
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

export class PostgresOrganisationRepository implements OrganisationRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  static enlist(client: DatabaseClient): OrganisationRepository {
    return new EnlistedOrganisationRepository(client);
  }

  async withTransaction<T>(body: (tx: OrganisationTransaction) => Promise<T>): Promise<T> {
    const client = await this.#database.connect();
    try {
      await client.query('BEGIN;');
      try {
        const result = await body(new PostgresOrganisationTransaction(client));
        await client.query('COMMIT;');
        return result;
      } catch (error) {
        await client.query('ROLLBACK;');
        throw error;
      }
    } finally {
      await client.release();
    }
  }
}

export {
  EnlistedOrganisationRepository,
  toMembership,
  toMembershipEvent,
  toOrganisation,
  toOrganisationEvent,
};
