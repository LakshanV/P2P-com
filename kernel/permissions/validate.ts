/**
 * K-04 Permissions — one validator per record, for requests and for stored rows (FND-004d).
 *
 * The same function judges a candidate record on the way in and a row on the way out. K-01 needed
 * a correction to reach that shape (CURRENT_IMPLEMENTATION_STATUS §11.22) because a row written
 * around the service decoded cleanly and was then acted upon; K-04 starts there, and the stakes
 * are higher — a malformed grant row that decodes is an authority nobody granted.
 *
 * Fail-closed everywhere: a record that cannot be judged is refused, never coerced. A grant whose
 * `effect` is unreadable is not "probably deny", it is `malformed-record`, because a component
 * that guesses at authority is a component whose denials cannot be trusted either.
 *
 * Owned by: K-04 Permissions.
 */

import { InvalidInstantError, compareInstants, parseInstant } from '../../platform/time/instant.ts';

import { REQUEST_FINGERPRINT } from './fingerprint.ts';
import {
  assertAction,
  assertAiMayHold,
  assertPermissionIdentifier,
  assertPredicate,
  assertPurpose,
  assertResourceType,
  assertRole,
} from './registry.ts';
import {
  DECISION_REASONS,
  EFFECTS,
  PermissionError,
  REVOCATION_REASONS,
  isStaffRole,
  type Capability,
  type Decision,
  type Effect,
  type Grant,
  type Origin,
  type PolicyVersion,
  type Revocation,
  type RoleDefinition,
} from './types.ts';

/** Where a record came from, which decides what a refusal should tell the reader. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'deciding authority on the strength of a malformed row';

function inSource<T>(source: RecordSource, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (source === 'request' || !(error instanceof PermissionError)) throw error;
    if (error.message.includes(STORED_ROW_NOTE)) throw error;
    throw new PermissionError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/** Run a decode so that whatever it refuses says the row came from the database. */
export function inStoredRow<T>(body: () => T): T {
  return inSource('stored row', body);
}

const POLICY_FIELDS = [
  'policyVersionId',
  'version',
  'roles',
  'publishedAt',
  'publishedBy',
  'idempotencyKey',
];
const GRANT_FIELDS = [
  'grantId',
  'subjectId',
  'accountId',
  'role',
  'effect',
  'action',
  'resourceType',
  'resourceId',
  'purpose',
  'condition',
  'policyVersionId',
  'grantedAt',
  'notBefore',
  'expiresAt',
  'grantedBy',
  'idempotencyKey',
];
const REVOCATION_FIELDS = [
  'revocationId',
  'grantId',
  'revokedAt',
  'reason',
  'revokedBy',
  'idempotencyKey',
];
const DECISION_FIELDS = [
  'decisionId',
  'subjectId',
  'accountId',
  'sessionId',
  'action',
  'resourceType',
  'resourceId',
  'effect',
  'reason',
  'explanation',
  'decidingGrantId',
  'policyVersionId',
  'purpose',
  'decidedAt',
  'idempotencyKey',
  'requestFingerprint',
];

/** Exactly these fields, no more and no fewer. An unexpected key is a record from elsewhere. */
function shapeOf(
  candidate: unknown,
  fields: readonly string[],
  what: string,
): Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new PermissionError(
      'malformed-record',
      `${what} must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }
  const record = candidate as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) {
      throw new PermissionError('malformed-record', `${what} carries an unknown field "${key}"`);
    }
  }
  for (const field of fields) {
    if (!(field in record)) {
      throw new PermissionError('malformed-record', `${what} is missing "${field}"`);
    }
  }
  return record;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PermissionError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new PermissionError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
  return value;
}

function optionalInstant(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : instant(value, field);
}

function effect(value: unknown): Effect {
  if (typeof value !== 'string' || !(EFFECTS as readonly string[]).includes(value)) {
    throw new PermissionError(
      'malformed-record',
      `effect is "${String(value)}"; expected one of ${EFFECTS.join(', ')}. A record whose effect ` +
        'cannot be read is refused rather than assumed to deny',
    );
  }
  return value as Effect;
}

function origin(value: unknown, field: string): Origin {
  if (value === null || typeof value !== 'object') {
    throw new PermissionError(`malformed-record`, `${field} must be an object with kind and id`);
  }
  const candidate = value as { kind?: unknown; id?: unknown };
  if (candidate.kind === 'ai') {
    throw new PermissionError(
      'ai-not-permitted',
      `${field}.kind is "ai". Authority over authority is not something AI may author (v3 §38): ` +
        'a human or a deterministic system owns every policy version, grant and revocation',
    );
  }
  if (candidate.kind !== 'human' && candidate.kind !== 'system') {
    throw new PermissionError(
      'malformed-record',
      `${field}.kind is "${String(candidate.kind)}"; expected human or system`,
    );
  }
  return Object.freeze({
    kind: candidate.kind,
    id: assertPermissionIdentifier(candidate.id, `${field}.id`),
  });
}

function capability(value: unknown, path: string): Capability {
  if (value === null || typeof value !== 'object') {
    throw new PermissionError('malformed-record', `${path} must be an object`);
  }
  const candidate = value as { action?: unknown; resourceType?: unknown };
  return Object.freeze({
    action: assertAction(candidate.action),
    resourceType: assertResourceType(candidate.resourceType),
  });
}

function roleDefinition(value: unknown, path: string): RoleDefinition {
  if (value === null || typeof value !== 'object') {
    throw new PermissionError('malformed-record', `${path} must be an object`);
  }
  const candidate = value as { role?: unknown; capabilities?: unknown };
  if (!Array.isArray(candidate.capabilities)) {
    throw new PermissionError('malformed-record', `${path}.capabilities must be an array`);
  }
  const seen = new Set<string>();
  const capabilities = candidate.capabilities.map((entry, index) => {
    const parsed = capability(entry, `${path}.capabilities[${index}]`);
    const key = `${parsed.action}@${parsed.resourceType}`;
    if (seen.has(key)) {
      throw new PermissionError(
        'malformed-record',
        `${path}.capabilities lists ${key} twice; a duplicated capability hides which one was meant`,
      );
    }
    seen.add(key);
    return parsed;
  });
  return Object.freeze({
    role: assertRole(candidate.role),
    capabilities: Object.freeze(capabilities),
  });
}

export function validatePolicyVersion(candidate: unknown, source: RecordSource): PolicyVersion {
  return inSource(source, () => {
    const fields = shapeOf(candidate, POLICY_FIELDS, 'a policy version');

    if (!Number.isSafeInteger(fields.version) || (fields.version as number) < 1) {
      throw new PermissionError(
        'malformed-record',
        `version is ${String(fields.version)}; expected a whole number of at least 1`,
      );
    }
    if (!Array.isArray(fields.roles) || fields.roles.length === 0) {
      throw new PermissionError(
        'malformed-record',
        'a policy version must define at least one role. A policy that defines nothing grants ' +
          'nothing, which is a denial nobody can distinguish from a mistake',
      );
    }

    const seen = new Set<string>();
    const roles = fields.roles.map((entry, index) => {
      const parsed = roleDefinition(entry, `roles[${index}]`);
      if (seen.has(parsed.role)) {
        throw new PermissionError(
          'malformed-record',
          `roles lists ${parsed.role} twice; which definition applies would be decided by array order`,
        );
      }
      seen.add(parsed.role);
      return parsed;
    });

    return {
      policyVersionId: assertPermissionIdentifier(fields.policyVersionId, 'policyVersionId'),
      version: fields.version as number,
      roles: Object.freeze(roles),
      publishedAt: instant(fields.publishedAt, 'publishedAt'),
      publishedBy: origin(fields.publishedBy, 'publishedBy'),
      idempotencyKey: assertPermissionIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

export function validateGrant(candidate: unknown, source: RecordSource): Grant {
  return inSource(source, () => {
    const fields = shapeOf(candidate, GRANT_FIELDS, 'a grant');

    const role = assertRole(fields.role);
    const purpose =
      fields.purpose === null || fields.purpose === undefined
        ? null
        : assertPurpose(fields.purpose);

    // A staff role reaches another party's data, so a grant to one without a purpose would be
    // exactly the unpurposed staff access v3 §5.3 forbids. A non-staff grant with a purpose is
    // refused too: it would read as though a purpose had been enforced when none applies.
    if (isStaffRole(role) && purpose === null) {
      throw new PermissionError(
        'missing-purpose',
        `a grant to ${role} must declare a purpose: staff access is role-based, purpose-based and ` +
          'audited (v3 §5.3), and a grant with no purpose is one nobody can review',
      );
    }
    if (!isStaffRole(role) && purpose !== null) {
      throw new PermissionError(
        'mismatched-purpose',
        `a grant to ${role} declares purpose "${purpose}", but purpose limitation applies to staff ` +
          'roles. A purpose recorded where none is enforced reads as a control that is not there',
      );
    }

    // The AI limits apply to a stored row as much as to a request: a grant written around the
    // service is exactly the case they exist to catch.
    assertAiMayHold(role, assertAction(fields.action), assertResourceType(fields.resourceType));

    const notBefore = optionalInstant(fields.notBefore, 'notBefore');
    const expiresAt = optionalInstant(fields.expiresAt, 'expiresAt');
    if (notBefore !== null && expiresAt !== null && compareInstants(expiresAt, notBefore) <= 0) {
      throw new PermissionError(
        'malformed-record',
        `expiresAt ${expiresAt} is not after notBefore ${notBefore}, so the grant could never apply`,
      );
    }

    return {
      grantId: assertPermissionIdentifier(fields.grantId, 'grantId'),
      subjectId: assertPermissionIdentifier(fields.subjectId, 'subjectId'),
      accountId: assertPermissionIdentifier(fields.accountId, 'accountId'),
      role,
      effect: effect(fields.effect),
      action: assertAction(fields.action),
      resourceType: assertResourceType(fields.resourceType),
      resourceId:
        fields.resourceId === null || fields.resourceId === undefined
          ? null
          : assertPermissionIdentifier(fields.resourceId, 'resourceId'),
      purpose,
      condition:
        fields.condition === null || fields.condition === undefined
          ? null
          : assertPredicate(fields.condition),
      policyVersionId: assertPermissionIdentifier(fields.policyVersionId, 'policyVersionId'),
      grantedAt: instant(fields.grantedAt, 'grantedAt'),
      notBefore,
      expiresAt,
      grantedBy: origin(fields.grantedBy, 'grantedBy'),
      idempotencyKey: assertPermissionIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

export function validateRevocation(candidate: unknown, source: RecordSource): Revocation {
  return inSource(source, () => {
    const fields = shapeOf(candidate, REVOCATION_FIELDS, 'a revocation');
    if (
      typeof fields.reason !== 'string' ||
      !(REVOCATION_REASONS as readonly string[]).includes(fields.reason)
    ) {
      throw new PermissionError(
        'malformed-record',
        `reason is "${String(fields.reason)}"; expected one of ${REVOCATION_REASONS.join(', ')}`,
      );
    }
    return {
      revocationId: assertPermissionIdentifier(fields.revocationId, 'revocationId'),
      grantId: assertPermissionIdentifier(fields.grantId, 'grantId'),
      revokedAt: instant(fields.revokedAt, 'revokedAt'),
      reason: fields.reason as Revocation['reason'],
      revokedBy: origin(fields.revokedBy, 'revokedBy'),
      idempotencyKey: assertPermissionIdentifier(fields.idempotencyKey, 'idempotencyKey'),
    };
  });
}

/**
 * The fingerprint over the decision’s own inputs.
 *
 * Shape-checked rather than recomputed here, because the validator does not hold the context that
 * went into it. What recomputes and compares is `authorize`, on every retry.
 */
function requestFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_FINGERPRINT.test(value)) {
    throw new PermissionError(
      'malformed-record',
      `requestFingerprint is "${String(value)}"; expected a SHA-256 in lower-case hex. A decision ` +
        'whose inputs cannot be identified can never be safely returned to a retry',
    );
  }
  return value;
}

export function validateDecision(candidate: unknown, source: RecordSource): Decision {
  return inSource(source, () => {
    const fields = shapeOf(candidate, DECISION_FIELDS, 'a decision');
    if (
      typeof fields.reason !== 'string' ||
      !(DECISION_REASONS as readonly string[]).includes(fields.reason)
    ) {
      throw new PermissionError(
        'malformed-record',
        `reason is "${String(fields.reason)}"; expected one of ${DECISION_REASONS.join(', ')}`,
      );
    }
    if (typeof fields.explanation !== 'string' || fields.explanation.trim().length < 10) {
      throw new PermissionError(
        'malformed-record',
        'explanation must say why the decision went the way it did. "Access denied" with no reason ' +
          'is unactionable for the person denied and unauditable for everybody else',
      );
    }
    return {
      decisionId: assertPermissionIdentifier(fields.decisionId, 'decisionId'),
      subjectId: assertPermissionIdentifier(fields.subjectId, 'subjectId'),
      accountId: assertPermissionIdentifier(fields.accountId, 'accountId'),
      sessionId: assertPermissionIdentifier(fields.sessionId, 'sessionId'),
      action: assertAction(fields.action),
      resourceType: assertResourceType(fields.resourceType),
      resourceId:
        fields.resourceId === null || fields.resourceId === undefined
          ? null
          : assertPermissionIdentifier(fields.resourceId, 'resourceId'),
      effect: effect(fields.effect),
      reason: fields.reason as Decision['reason'],
      explanation: fields.explanation,
      decidingGrantId:
        fields.decidingGrantId === null || fields.decidingGrantId === undefined
          ? null
          : assertPermissionIdentifier(fields.decidingGrantId, 'decidingGrantId'),
      policyVersionId: assertPermissionIdentifier(fields.policyVersionId, 'policyVersionId'),
      purpose:
        fields.purpose === null || fields.purpose === undefined
          ? null
          : assertPurpose(fields.purpose),
      decidedAt: instant(fields.decidedAt, 'decidedAt'),
      idempotencyKey: assertPermissionIdentifier(fields.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: requestFingerprint(fields.requestFingerprint),
    };
  });
}
