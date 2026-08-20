/**
 * K-11 Commerce Unit Registry — the vocabularies, and what a type may not carry (FND-005c).
 *
 * Four registries, each closing a way a shared vocabulary goes wrong.
 *
 * **Identifier rules are K-01's**, re-raised in this component's vocabulary exactly as K-02, K-03,
 * K-04, K-06 and K-07 do them. A type key and a tenant handle are copied into every listing, order
 * and invoice line that ever uses the type, so a natural key arriving as either would publish
 * personal data into rows nobody can enumerate afterwards — and these rows are kept forever,
 * because a record from last year still has to be readable.
 *
 * **Kinds and units are closed lists taken from the guide**, not free text. v3 §11 names ten kinds
 * and v3 §12 names the units; a registry that accepted anything would be a naming convention with
 * a database behind it, and the first two modules to use it would spell the same unit differently.
 *
 * **A unit must belong to a family its kind allows.** "Never hardcode commerce assumptions around
 * one category" (v3 §12) cuts both ways: the platform must not assume everything is a product, and
 * it must not let a vehicle be priced per night either. The kind-to-family table is the guide's own
 * grouping made executable.
 *
 * **Types carry no display text and no money.** There is no `title`, no `description`, no
 * `currency`, no `price`, no conversion factor and no translation. Each belongs to a component
 * that exists or will; putting any of them here would make K-11 the place two systems disagree.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import {
  CommerceUnitError,
  KIND_FAMILIES,
  MEASURE_FAMILIES,
  MEASURE_FAMILY_NAMES,
  UNIT_KINDS,
  type CommerceUnitErrorCode,
  type MeasureFamily,
  type OwnerScope,
  type UnitKind,
  type UnitOfMeasure,
} from './types.ts';

/** K-01's identifier refusals, in this component's vocabulary. The mapping is total and tested. */
export const IDENTITY_REFUSALS: Readonly<Record<string, CommerceUnitErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * An `IdentityError` this cannot translate is rethrown unchanged rather than mislabelled — an
 * error that lies about its own cause is worse than one naming an unexpected component.
 */
export function assertUnitIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new CommerceUnitError(code, error.message);
  }
}

/** The deepest a type hierarchy may go, root included. */
export const MAX_DEPTH = 6;

/** The most units of measure one type may permit. */
export const MAX_MEASURES = 16;

/** Type keys are dotted lowercase segments: `goods.electronics.mobile-phone`. */
const TYPE_KEY = /^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){0,3}$/;

/**
 * Fields by which a caller would state the answer, or state something another component owns.
 *
 * The first group is derived-hierarchy: `ancestry`, `depth` and `path` are computed by walking the
 * activation chain, and a caller that could supply one could describe a type as descending from
 * something it does not — which every downstream category rule would then believe.
 */
export const ASSERTED_OUTCOME_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  ancestry: 'derived by walking the parent chain; a caller supplying it could invent a lineage',
  ancestors: 'derived by walking the parent chain',
  depth: 'derived from the ancestry, and bounded by the registry rather than by the caller',
  path: 'derived from the ancestry',
  root: 'derived from the ancestry',
  children: 'derived by looking for types that name this one as parent',
  descendants: 'derived by looking for types that name this one as parent',
  explanation: 'the derived explanation, which names versions and never a tenant handle',
  resolvedAt: 'the instant the resolution was made, which comes from the injected clock',
  riskPolicyVersionId:
    'the K-06 version pinned at activation, which is whatever K-06 actually returned',
  price: 'money. K-10 Ledger foundation owns every amount; K-11 holds none',
  currency: 'money. K-10 Ledger foundation owns every currency; K-11 holds none',
  amount: 'money. K-10 Ledger foundation owns every amount; K-11 holds none',
  taxRate: 'a tax rule. K-06 Policy and the finance modules; never the vocabulary',
  conversionFactor:
    'arithmetic between units. K-10 Ledger foundation — a registry that converted would be a ' +
    'second place quantities are computed',
  title: 'display text. K-11 holds opaque handles; localization owns what a human reads',
  description: 'display text; localization owns what a human reads, not the vocabulary',
  label: 'display text; localization owns what a human reads, not the vocabulary',
  translations: 'display text. Localization owns every translation; K-11 holds handles',
  allowed: 'an authorisation. Ask K-04 Permissions',
  entitled: 'an entitlement. The Capability & Verification module',
});

/**
 * Fields a **resolution** may not carry, on top of the table above.
 *
 * These are legitimate inputs elsewhere: `publish` supplies the opaque id of the version it is
 * creating and `activate` names the version to put in force, exactly as every other component here
 * does. What a caller may never do is name the version its own resolution should return — that is
 * choosing which definition describes its listing, when the answer is whatever is in force.
 */
export const PINNED_VERSION_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  typeVersionId:
    'the version in force, which is read from the activation chain. A caller choosing it would ' +
    'be picking which definition describes its own listing',
  version: 'the version number, which is read from what is in force and never supplied',
});

/** Refuse a resolution that names the version it wants to be answered with. */
export function assertNoPinnedVersion(request: object): void {
  for (const field of Object.keys(request)) {
    const why = PINNED_VERSION_FIELDS[field];
    if (why === undefined) continue;
    throw new CommerceUnitError(
      'caller-asserted-outcome',
      `resolve refuses the field "${field}": it is ${why}`,
    );
  }
}

export function assertTypeKey(value: unknown, field = 'typeKey'): string {
  if (typeof value !== 'string') {
    throw new CommerceUnitError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }
  if (!TYPE_KEY.test(value)) {
    throw new CommerceUnitError(
      'malformed-identifier',
      `${field} "${value}" is not a type key. Keys are one to four dotted lowercase segments, ` +
        'like "goods.electronics.mobile-phone" — a namespace, so somebody reading a listing can ' +
        'tell what kind of thing it describes without resolving anything',
    );
  }
  return value;
}

export function assertKind(value: unknown, field = 'kind'): UnitKind {
  if (typeof value !== 'string' || !(UNIT_KINDS as readonly string[]).includes(value)) {
    throw new CommerceUnitError(
      'unsupported-kind',
      `${field} is "${String(value)}"; expected one of ${UNIT_KINDS.join(', ')}. These are v3 §11's ` +
        'ten kinds, and the list is closed: a kind nobody registered is a category the platform ' +
        'has no adapters, no risk pack and no fulfilment rules for',
    );
  }
  return value as UnitKind;
}

export function assertMeasureFamily(value: unknown, field: string): MeasureFamily {
  if (typeof value !== 'string' || !(MEASURE_FAMILY_NAMES as readonly string[]).includes(value)) {
    throw new CommerceUnitError(
      'unsupported-measure',
      `${field} is "${String(value)}"; expected one of ${MEASURE_FAMILY_NAMES.join(', ')}`,
    );
  }
  return value as MeasureFamily;
}

/** The whole of a unit of measure. There is no third field, and there is no room for one. */
const MEASURE_FIELDS: readonly string[] = ['family', 'unit'];

/** An owner scope is one field, or two when it names a tenant. Never three. */
const OWNER_FIELDS: readonly string[] = ['kind', 'tenantId'];

/** Who authored something: the kind of actor, and the opaque handle. */
const ORIGIN_FIELDS: readonly string[] = ['kind', 'id'];

/** What a canonical nested record is, in the words its own refusals should use. */
interface CanonicalRecordSpec {
  readonly code: CommerceUnitErrorCode;
  /** "A unit of measure", "An owner scope", "An origin". */
  readonly subject: string;
  /** The literal shape, as a reader would write it down. */
  readonly shape: string;
  /** Which own property names are permitted at all. */
  readonly fields: readonly string[];
  /** Why an extra field is refused rather than dropped, in this record's own terms. */
  readonly note: string;
  /** The closing clause of the non-enumerable refusal. */
  readonly declares: string;
}

/**
 * Refuse a nested record that is anything but a plain data record of exactly the fields it has.
 *
 * The three nested structures in this component — a measure, an owner scope, an origin — were each
 * read for the properties they declare and rebuilt from them, so anything else attached was
 * *dropped* rather than refused. Dropped is the dangerous one, in three ways that leave no trace:
 *
 *   - **A field nobody reads is a property somebody believes the record carries.** A caller who
 *     writes `{ family, unit, price: 500 }`, or an `owner` carrying `permissions`, has recorded
 *     that with the registry as far as any response tells them: no error came back. K-11 holds no
 *     price, no currency, no display text and no authority — every one of those belongs to a
 *     component that exists or will — so the belief is wrong and nothing in the stored type lets
 *     the next reader discover it.
 *   - **A misspelling is not an absence.** `familly` is a measure its author believes they
 *     qualified; `tennantId` is a scope its author believes they narrowed. The top-level request
 *     is already checked field-by-field so a typo cannot be ignored (`assertKnownFields`); the
 *     nested records were where it could.
 *   - **What is dropped is invisible to the fingerprint.** The canonical forms hash `family/unit`
 *     pairs and `ownerKey(owner)`, so two publications differing *only* in what a nested record
 *     secretly carried fingerprint identically — and a retry on the same idempotency key
 *     converges, handing back a type version id for a request that was not the one made. That is
 *     precisely the failure K-04 shipped (§11.27), reached through a nested object instead of
 *     through the key.
 *
 * An allowlist and not a denylist. A list of forbidden names — `price`, `role`, `label` — refuses
 * what somebody thought of and admits `unitPrice`; requiring exactly the fields the contract
 * defines refuses everything nobody has thought of yet, which is the set that matters.
 *
 * Every way of hiding a field is closed, not just the obvious one: inherited through a prototype,
 * defined as a getter, keyed by a symbol, or made non-enumerable — each is invisible to
 * `Object.keys`, and the first three are invisible to `JSON.stringify` too, so a review of the
 * request payload would not show them.
 *
 * Runs to completion **before any field is read**, so no property access this component makes can
 * reach a getter or a prototype. After it returns, the record is inert: reading a field is reading
 * a value that was there when it was checked.
 */
function assertCanonicalRecord(value: object, path: string, spec: CanonicalRecordSpec): void {
  if (Array.isArray(value)) {
    throw new CommerceUnitError(spec.code, `${path} is an array; expected ${spec.shape}`);
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CommerceUnitError(
      spec.code,
      `${path} is not a plain record: it inherits from something. ${spec.subject} carries what ` +
        'it declares and nothing a prototype supplies, because what a prototype supplies is not ' +
        'in the request anybody reviewed and not in the fingerprint anybody compared',
    );
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new CommerceUnitError(
      spec.code,
      `${path} carries ${symbols.length} symbol-keyed field(s). ${spec.subject} is ${spec.shape}` +
        ', and a key that cannot be written down is one no stored record can carry',
    );
  }

  for (const field of Object.getOwnPropertyNames(value)) {
    if (!spec.fields.includes(field)) {
      throw new CommerceUnitError(
        spec.code,
        `${path} carries the field "${field}". ${spec.subject} is exactly ${spec.shape}: ` +
          spec.note,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new CommerceUnitError(
        spec.code,
        `${path}.${field} is an accessor rather than a value. What it answers can differ between ` +
          'the read that validated it and the read that stored it, so the type recorded need not ' +
          'be the type checked',
      );
    }
    if (!descriptor.enumerable) {
      throw new CommerceUnitError(
        spec.code,
        `${path}.${field} is non-enumerable, so it is absent from the request as anybody reading ` +
          `it would see it. ${spec.declares}`,
      );
    }
  }
}

const MEASURE_RECORD: CanonicalRecordSpec = {
  code: 'unsupported-measure',
  subject: 'A unit of measure',
  shape: '{ family, unit }',
  fields: MEASURE_FIELDS,
  note:
    'this component holds no price, no currency, no conversion factor, no tax rule and no ' +
    'display text, and dropping the field silently would let a caller believe it had ' +
    'recorded one here',
  declares: 'A unit of measure declares both its fields plainly',
};

/**
 * An owner scope decides who may extend and who may retire a category, so a field smuggled into
 * one is a claim about authority sitting in the record every listing keys off.
 *
 * K-11 answers no authority question — that is K-04's, and the isolation rule here is `sameOwner`
 * over two fields and nothing else. An `owner` carrying `role`, `permissions` or `admin` is a
 * caller describing authority to a component that will never read it, which reads back as though
 * it had been accepted and reviewed.
 */
const OWNER_RECORD: CanonicalRecordSpec = {
  code: 'malformed-record',
  subject: 'An owner scope',
  shape: '{ kind } or { kind, tenantId }',
  fields: OWNER_FIELDS,
  note:
    'this component decides no authority and holds no attribute of a tenant beyond the handle. ' +
    'A permission, a role or a limit recorded here would be read by nobody and believed by ' +
    'whoever wrote it',
  declares: 'An owner scope declares every field it has plainly',
};

/**
 * An origin is who authored a record, permanently.
 *
 * The one thing it must never say is that an agent did (v3 §38), which is why `ai` is refused by
 * name below. A hidden field here is worse than an unread one: it is provenance nobody can audit
 * on a record that is never rewritten.
 */
const ORIGIN_RECORD: CanonicalRecordSpec = {
  code: 'malformed-record',
  subject: 'An origin',
  shape: '{ kind, id }',
  fields: ORIGIN_FIELDS,
  note:
    'authorship is the actor kind and the opaque handle, and nothing that travels beside them — ' +
    'a credential, a session, a role or a display name attached here would be permanent, ' +
    'unread, and copied wherever the record goes',
  declares: 'An origin declares both its fields plainly',
};

/**
 * Validate one unit of measure, qualified by its family.
 *
 * `hour` exists under both `service` and `rental` and means different things in each — an hour of
 * somebody's labour is not an hour of a machine's availability. The family is therefore required,
 * and an unqualified unit is refused rather than guessed at.
 *
 * The shape is checked before either field is read, so a non-canonical entry is refused before it
 * reaches the deduplication, the canonical sort or the fingerprint that decides whether a retry
 * converges.
 */
export function assertMeasure(value: unknown, path: string): UnitOfMeasure {
  if (value === null || typeof value !== 'object') {
    throw new CommerceUnitError(
      'unsupported-measure',
      `${path} is ${value === null ? 'null' : typeof value}; expected { family, unit }`,
    );
  }
  assertCanonicalRecord(value, path, MEASURE_RECORD);
  const candidate = value as { family?: unknown; unit?: unknown };
  const family = assertMeasureFamily(candidate.family, `${path}.family`);
  const permitted: readonly string[] = MEASURE_FAMILIES[family];

  if (typeof candidate.unit !== 'string' || !permitted.includes(candidate.unit)) {
    throw new CommerceUnitError(
      'unsupported-measure',
      `${path}.unit is "${String(candidate.unit)}", which the ${family} family does not contain. ` +
        `Permitted: ${permitted.join(', ')}. These are v3 §12's units, and a unit outside them is ` +
        'a pricing assumption somebody made locally',
    );
  }
  return Object.freeze({ family, unit: candidate.unit });
}

/** The measures a type permits: non-empty, deduplicated, and every one allowed by its kind. */
export function assertMeasures(
  value: unknown,
  kind: UnitKind,
  field = 'measures',
): readonly UnitOfMeasure[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CommerceUnitError(
      'unsupported-measure',
      `${field} must be a non-empty array. A type priced in no unit at all cannot describe a ` +
        'listing, which makes it a category nobody can sell in',
    );
  }
  if (value.length > MAX_MEASURES) {
    throw new CommerceUnitError(
      'unsupported-measure',
      `${field} holds ${value.length} units; at most ${MAX_MEASURES}`,
    );
  }

  const allowed = KIND_FAMILIES[kind];
  const measures = value.map((entry, index) => assertMeasure(entry, `${field}[${index}]`));
  const seen = new Set<string>();

  for (const measure of measures) {
    if (!allowed.includes(measure.family)) {
      throw new CommerceUnitError(
        'measure-not-permitted',
        `${field} permits ${measure.family}/${measure.unit}, but a ${kind} may only be priced in ` +
          `${allowed.join(' or ')}. v3 §12 groups the units by what they are for, and a ${kind} ` +
          `sold by the ${measure.unit} is a commerce assumption nobody should be able to make by ` +
          'accident',
      );
    }
    const key = `${measure.family}/${measure.unit}`;
    if (seen.has(key)) {
      throw new CommerceUnitError('unsupported-measure', `${field} lists ${key} twice`);
    }
    seen.add(key);
  }

  // Sorted, so two types permitting the same set compare and fingerprint equal whatever order the
  // author wrote them in.
  return Object.freeze(
    [...measures].sort((a, b) =>
      a.family === b.family ? a.unit.localeCompare(b.unit) : a.family.localeCompare(b.family),
    ),
  );
}

/**
 * An owner scope: the shared platform vocabulary, or one tenant's extension of it.
 *
 * The shape is checked before either field is read, against the union of what the two scopes may
 * carry; which of the two applies is then decided from `kind`, on a record already proven to be
 * inert data. That ordering matters — reading `kind` first to decide the allowlist would mean
 * reading a property before knowing it is not a getter answering one thing here and another thing
 * where the record is stored.
 */
export function assertOwner(value: unknown, field = 'owner'): OwnerScope {
  if (value === null || typeof value !== 'object') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected { kind } or { kind, tenantId }`,
    );
  }
  assertCanonicalRecord(value, field, OWNER_RECORD);

  const owner = value as { kind?: unknown; tenantId?: unknown };
  if (owner.kind === 'platform') {
    // The *field*, not its value. A platform scope declaring `tenantId: undefined` is a record
    // written as though it were a tenant one and left blank, and the difference between "this is
    // the platform" and "this is a tenant nobody named" is the whole isolation rule.
    if (Object.hasOwn(value, 'tenantId')) {
      throw new CommerceUnitError(
        'malformed-record',
        `${field} is the platform scope and also names a tenant; it can only be one of those`,
      );
    }
    return Object.freeze({ kind: 'platform' as const });
  }
  if (owner.kind !== 'tenant') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field}.kind is "${String(owner.kind)}"; expected "platform" or "tenant"`,
    );
  }
  return Object.freeze({
    kind: 'tenant' as const,
    tenantId: assertUnitIdentifier(owner.tenantId, `${field}.tenantId`),
  });
}

/** Refuse a request that carries the answer, or another component's subject matter. */
export function assertNoAssertedOutcome(request: object, operation: string): void {
  for (const field of Object.keys(request)) {
    const owner = ASSERTED_OUTCOME_FIELDS[field];
    if (owner === undefined) continue;
    throw new CommerceUnitError(
      'caller-asserted-outcome',
      `${operation} refuses the field "${field}": it is ${owner}`,
    );
  }
}

/** Refuse a field this component has no meaning for, so a typo is not silently ignored. */
export function assertKnownFields(
  request: object,
  known: readonly string[],
  operation: string,
): void {
  for (const field of Object.keys(request)) {
    if (known.includes(field)) continue;
    throw new CommerceUnitError(
      'malformed-record',
      `${operation} does not accept the field "${field}". Accepted: ${known.join(', ')}. A field ` +
        'nobody reads is a property somebody believes the vocabulary carries',
    );
  }
}

/**
 * Refuse an origin that is not a human or a system.
 *
 * There is no `ai` kind in this component at all — absent from the type rather than refused at the
 * boundary. An agent that could register a commerce unit type could define the categories every
 * risk pack, commission rule and fulfilment path keys off, which is authority over the platform's
 * economics one indirection out (v3 §38).
 *
 * The shape is checked before either field is read, so `kind` cannot be a getter that answers
 * `system` to the check and something else to whatever reads the record next.
 */
export function assertOrigin(
  value: unknown,
  field: string,
): { kind: 'human' | 'system'; id: string } {
  if (value === null || typeof value !== 'object') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected { kind, id }`,
    );
  }
  assertCanonicalRecord(value, field, ORIGIN_RECORD);
  const origin = value as { kind?: unknown; id?: unknown };
  if (origin.kind === 'ai') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field}.kind is "ai". No agent registers a commerce unit type: the vocabulary decides ` +
        'which risk pack applies, which commission rule matches and which fulfilment path runs, ' +
        'and v3 §38 keeps that behind a human',
    );
  }
  if (origin.kind !== 'human' && origin.kind !== 'system') {
    throw new CommerceUnitError(
      'malformed-record',
      `${field}.kind is "${String(origin.kind)}"; expected "human" or "system"`,
    );
  }
  return { kind: origin.kind, id: assertUnitIdentifier(origin.id, `${field}.id`) };
}
