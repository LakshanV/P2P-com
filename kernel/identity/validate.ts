/**
 * K-01 Identity — validation of a complete subject, wherever it came from (FND-004a correction).
 *
 * The first revision validated a *request* on the way in and a *row* on the way out, and the two
 * were not the same check. Creation refused a subject id that looked like an email, a telephone
 * number, a personal name or a credential; decoding asked only whether each column was non-empty
 * text and whether two of them held a known enum value. So a row written around the adapter — by
 * hand, by a restore, by a future migration script — decoded cleanly and was handed back as a real
 * party, carrying exactly the natural key the creation path exists to keep out.
 *
 * That asymmetry is the wrong way round. Validation on the way *in* protects the store from a
 * caller; validation on the way *out* protects every consumer from the store, and the store is the
 * thing this component has least control over. An identity is the root of attribution for
 * everything downstream, so a subject that reaches a consumer has to be one this component would
 * have written.
 *
 * Hence one function. `validateSubject` is called by the service on the subject it has just built,
 * and by the PostgreSQL decoder on the subject it has just decoded. There is no second list of
 * rules to keep in step, because there is no second list.
 *
 * It is deliberately **not** the same thing as the request check in service.ts. That one refuses
 * fields belonging to K-02, K-03 and K-04 by name, and only a *request* can carry them. This one
 * judges a finished subject.
 *
 * Owned by: K-01 Identity.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import { assertOpaqueIdentifier, requireSubjectKind } from './registry.ts';
import {
  IdentityError,
  ORIGIN_KINDS,
  type IdentityOrigin,
  type IdentitySubject,
  type OriginKind,
} from './types.ts';

/**
 * Where the subject came from.
 *
 * Only affects the wording of a refusal, and the wording matters: "this is invalid" sends a reader
 * to the validator, while "this row was not written by this component" sends them to the database,
 * which is where the problem actually is.
 */
export type SubjectSource = 'request' | 'stored row';

/** Exactly the fields a subject may carry. */
const SUBJECT_FIELDS: readonly string[] = [
  'subjectId',
  'kind',
  'createdAt',
  'origin',
  'idempotencyKey',
];

const ORIGIN_FIELDS: readonly string[] = ['kind', 'id'];

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'presenting it as a real party';

/**
 * Validate a complete subject, or refuse.
 *
 * Returns a new plain object built field by field from what was checked, so a candidate carrying a
 * getter, a prototype or an extra own property cannot smuggle any of it past this point. Sealing is
 * the caller's job (`sealSubject`), because the caller knows whether it is about to store the
 * result or return it.
 *
 * Order is deliberate and matches creation: kind, origin, subject id, idempotency key, instant. A
 * caller with two problems is told about the structural one first.
 */
export function validateSubject(candidate: unknown, source: SubjectSource): IdentitySubject {
  try {
    return check(candidate);
  } catch (error) {
    if (source === 'request' || !(error instanceof IdentityError)) throw error;
    // Same code, because it is the same guarantee. The added clause says where to look.
    throw new IdentityError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

function check(candidate: unknown): IdentitySubject {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new IdentityError(
      'malformed-record',
      `a subject must be an object, got ${candidate === null ? 'null' : typeof candidate}`,
    );
  }

  for (const key of Object.keys(candidate)) {
    if (!SUBJECT_FIELDS.includes(key)) {
      throw new IdentityError(
        'malformed-record',
        `a subject carried the unrecognised field "${key}"; the permitted fields are ` +
          `${SUBJECT_FIELDS.join(', ')}`,
      );
    }
  }

  const fields = candidate as Record<string, unknown>;
  const kind = requireSubjectKind(fields.kind).kind;
  const origin = checkOrigin(fields.origin);
  const subjectId = assertOpaqueIdentifier(fields.subjectId, 'subjectId');
  const idempotencyKey = assertOpaqueIdentifier(fields.idempotencyKey, 'idempotencyKey');
  const createdAt = checkInstant(fields.createdAt, 'createdAt');

  return { subjectId, kind, createdAt, origin, idempotencyKey };
}

/** The origin, validated, with AI refused by name. */
function checkOrigin(origin: unknown): IdentityOrigin {
  if (origin === null || typeof origin !== 'object' || Array.isArray(origin)) {
    throw new IdentityError(
      'malformed-record',
      `origin must be an object, got ${origin === null ? 'null' : typeof origin}`,
    );
  }
  for (const key of Object.keys(origin)) {
    if (!ORIGIN_FIELDS.includes(key)) {
      throw new IdentityError(
        'foreign-concern',
        `origin carried "${key}"; the permitted fields are ${ORIGIN_FIELDS.join(', ')}. ` +
          'An origin is who caused the creation, not a record of how they were authenticated — ' +
          'K-02 does not exist and nothing has verified anybody',
      );
    }
  }

  const fields = origin as { kind?: unknown; id?: unknown };
  if (
    typeof fields.kind !== 'string' ||
    !(ORIGIN_KINDS as readonly string[]).includes(fields.kind)
  ) {
    throw new IdentityError(
      'malformed-record',
      `origin.kind is "${String(fields.kind)}"; expected one of ${ORIGIN_KINDS.join(', ')}`,
    );
  }

  if (fields.kind === 'ai') {
    // AI may draft the request, prompt an operator, or propose that a party should exist. It may
    // not be the authority that says one does. An identity is the root of attribution for every
    // account, order and ledger entry that references it, so a fabricated one is
    // indistinguishable from a real party to everything downstream — including the financial
    // modules, where AI is barred from authority outright (MODULE_MAP §11).
    //
    // Checked here rather than only at creation, so a row that reached the table another way
    // cannot become a real party merely by being selected.
    throw new IdentityError(
      'ai-not-permitted',
      'origin.kind is "ai", and AI may not author an identity. An identity subject is the root ' +
        'of attribution for every account, order and ledger entry that references it; a ' +
        'fabricated one is indistinguishable from a real party to everything downstream. AI may ' +
        'prompt a human or a deterministic system to create it, and that actor owns the record',
    );
  }

  return {
    kind: fields.kind as Exclude<OriginKind, 'ai'>,
    id: assertOpaqueIdentifier(fields.id, 'origin.id'),
  };
}

/** Instants are validated in this component's own vocabulary, not the platform utility's. */
function checkInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new IdentityError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new IdentityError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}
