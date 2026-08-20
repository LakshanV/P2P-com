/**
 * K-11 Commerce Unit Registry — domain types (FND-005c).
 *
 * K-11 owns one thing: **the vocabulary every other unit of the platform describes goods and
 * services with.** v3 §11 names ten kinds of `CommerceUnit`; v3 §12 names the units they are
 * priced and fulfilled in — each, kilogram, tonne, night, room, hour, job, kilometre — and ends
 * with the sentence this component exists to make executable:
 *
 * > *Never hardcode commerce assumptions around one category.*
 *
 * A registry is how that stops being advice. If "night" lives in the accommodation module and
 * "tonne" in the commodity module, then the platform has two vocabularies that will drift, and the
 * first cross-category feature — a search, a commission rule, an invoice line — has to translate
 * between them. Here they are one register, versioned, with a hierarchy.
 *
 * Where it sits between its neighbours:
 *
 * | Question | Component |
 * |---|---|
 * | What kinds of thing can be sold, and in what units | **K-11** |
 * | What does policy say about this category | **K-06 Policy Engine** — K-11 *pins* the version, and decides nothing |
 * | What is the current value of one setting | **K-05 Configuration** |
 * | May this party do this | **K-04 Permissions** |
 * | What is this amount, in what currency | **K-10 Ledger foundation** — K-11 holds no money and no currency |
 * | What is this called in Sinhala | Localization — K-11 holds handles, never display text |
 *
 * **K-11 holds no prices, no amounts, no currencies, no tax rules, no conversion factors and no
 * translations.** A unit of measure here is an opaque handle and a family; it is deliberately not
 * a conversion table, because "1 tonne = 1000 kg" is arithmetic somebody has to be accountable
 * for, and the component accountable for arithmetic is K-10.
 *
 * Deterministic and provider-neutral by construction: no clock is read here, no randomness is
 * generated here, and nothing in this component knows that AI exists.
 *
 * Owned by: K-11 Commerce Unit Registry. See kernel/commerce-unit-registry/CONTRACT.md.
 */

/**
 * The kinds of commerce unit, exactly as v3 §11 lists them.
 *
 * `other` is the guide's "other future permitted category" and is deliberately not a licence to
 * invent: which kinds a deployment actually permits is configuration (see `ports.ts`), and a type
 * published under a kind the deployment has not permitted is refused.
 */
export const UNIT_KINDS = [
  'new-product',
  'used-product',
  'bulk-commodity',
  'vehicle',
  'accommodation',
  'service',
  'rental',
  'wholesale-lot',
  'custom-item',
  'other',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/**
 * The measure families of v3 §12, and the units inside each.
 *
 * Grouped rather than flat because the grouping is the guide's: "hour" means something different
 * under services and under rentals, and a registry that flattened them would let a rental be
 * priced per job. A type declares which units it permits, and every one must belong to a family
 * the kind allows.
 */
export const MEASURE_FAMILIES = {
  goods: ['each', 'gram', 'kilogram', 'tonne', 'litre', 'metre', 'box', 'pallet', 'lot', 'container'],
  accommodation: ['night', 'week', 'month', 'room', 'property', 'guest'],
  service: ['hour', 'job', 'visit', 'kilometre', 'quotation', 'fixed-package'],
  rental: ['hour', 'day', 'week', 'month'],
} as const;

export type MeasureFamily = keyof typeof MEASURE_FAMILIES;
export const MEASURE_FAMILY_NAMES = Object.keys(MEASURE_FAMILIES) as readonly MeasureFamily[];

/** A unit of measure, qualified by the family it belongs to. `hour` alone is ambiguous. */
export interface UnitOfMeasure {
  readonly family: MeasureFamily;
  readonly unit: string;
}

/**
 * Which measure families each kind may be priced in.
 *
 * From v3 §12's own grouping. A vehicle sold by the night, or accommodation sold by the tonne, is
 * not a configuration choice somebody should be able to make by accident.
 */
export const KIND_FAMILIES: Readonly<Record<UnitKind, readonly MeasureFamily[]>> = Object.freeze({
  'new-product': ['goods'],
  'used-product': ['goods'],
  'bulk-commodity': ['goods'],
  vehicle: ['goods'],
  accommodation: ['accommodation'],
  service: ['service'],
  rental: ['rental'],
  'wholesale-lot': ['goods'],
  'custom-item': ['goods', 'service'],
  other: ['goods', 'accommodation', 'service', 'rental'],
});

/**
 * Who owns a type definition.
 *
 * `platform` is the shared vocabulary every tenant sees. A tenant may extend it — v3 §11's
 * "category adapters extend the common object rather than duplicating the platform" — by
 * publishing types whose parent is a platform type. What a tenant may **not** do is parent onto
 * another tenant's type, or retire one: that is the isolation rule, and it is the reason ownership
 * is a field rather than a convention.
 */
export type OwnerScope =
  | { readonly kind: 'platform' }
  | { readonly kind: 'tenant'; readonly tenantId: string };

export function sameOwner(a: OwnerScope, b: OwnerScope): boolean {
  if (a.kind === 'platform' && b.kind === 'platform') return true;
  return a.kind === 'tenant' && b.kind === 'tenant' && a.tenantId === b.tenantId;
}

export function ownerKey(owner: OwnerScope): string {
  return owner.kind === 'platform' ? 'platform' : `tenant:${owner.tenantId}`;
}

/** Who authored something. There is no `ai` kind, deliberately — see `registry.ts`. */
export type OriginKind = 'human' | 'system';

export interface Origin {
  readonly kind: OriginKind;
  readonly id: string;
}

/**
 * One immutable, numbered version of one commerce unit type.
 *
 * Numbered per type key and never edited. A type is referenced by every listing, order and
 * invoice line that ever used it, so editing one in place would change what those records mean
 * retroactively — the same failure v3 §24 forbids for policy, arriving through the vocabulary
 * instead of through the rates.
 */
export interface UnitTypeVersion {
  readonly typeVersionId: string;
  readonly typeKey: string;
  /** Monotonic per type key, starting at 1. Ordering is the number, never the clock. */
  readonly version: number;
  readonly kind: UnitKind;
  readonly owner: OwnerScope;
  /** The type this one extends, or null for a root. Resolved through the activation chain. */
  readonly parentTypeKey: string | null;
  /** Non-empty, deduplicated. Every unit must belong to a family the kind allows. */
  readonly measures: readonly UnitOfMeasure[];
  /**
   * The K-06 policy key carrying this category's risk pack (v3 §16), or null.
   *
   * K-11 stores the **key**, never the rules. The version in force is resolved through K-06's
   * public contract at activation and pinned into the activation record, so a listing created
   * under this type can be explained against the policy that was in force when it was activated.
   */
  readonly riskPolicyKey: string | null;
  /** Bounded effective window, both ends optional, both inclusive of the instant they name. */
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly publishedAt: string;
  readonly publishedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * An appended record that a version became the one in force for its type key.
 *
 * Guarded: an activation names the version it supersedes, so two operators changing the same type
 * at once cannot both win. It also carries the pinned K-06 policy version, which is why activation
 * — rather than publication — is where provenance is captured: publication is a proposal, and
 * activation is the moment the type starts describing real listings.
 */
export interface UnitTypeActivation {
  readonly activationId: string;
  readonly typeKey: string;
  readonly typeVersionId: string;
  readonly supersedesVersionId: string | null;
  /** The K-06 policy version in force when this type was activated, or null when it names none. */
  readonly riskPolicyVersionId: string | null;
  readonly activatedAt: string;
  readonly activatedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * The end of a type's life. Appended, terminal, one per type key.
 *
 * Retiring a type stops new listings being described by it; it does not remove the versions
 * existing listings already reference. A retired type whose history vanished would make every
 * record that used it unreadable.
 */
export interface UnitTypeRetirement {
  readonly retirementId: string;
  readonly typeKey: string;
  readonly reason: string;
  readonly retiredAt: string;
  readonly retiredBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * A resolved type: the version in force, its ancestry, and the measures it actually permits.
 *
 * `ancestry` runs from the immediate parent outwards to the root, and `measures` is the type's own
 * set — inheritance of *measures* is deliberately not modelled, because a child that silently
 * gained a parent's units would change meaning whenever the parent was edited. What the ancestry
 * gives a caller is provenance, not behaviour.
 */
export interface ResolvedUnitType {
  readonly typeKey: string;
  readonly typeVersionId: string;
  readonly version: number;
  readonly kind: UnitKind;
  readonly owner: OwnerScope;
  readonly measures: readonly UnitOfMeasure[];
  readonly ancestry: readonly string[];
  readonly riskPolicyKey: string | null;
  readonly riskPolicyVersionId: string | null;
  readonly resolvedAt: string;
  /** Deterministic text naming the version, its depth and its ancestry. Never a tenant handle. */
  readonly explanation: string;
}

export type CommerceUnitErrorCode =
  /** The value is not a well-formed opaque identifier. */
  | 'malformed-identifier'
  /** The value looks like a natural or personal identifier. */
  | 'natural-identifier'
  /** The value looks like a credential. */
  | 'secret-bearing-input'
  /** A request carried a field by which the caller would state the answer or the derived hierarchy. */
  | 'caller-asserted-outcome'
  /** No type by that key has a version in force. */
  | 'no-such-type'
  /** The named version does not exist, or belongs to a different type key. */
  | 'no-such-version'
  /** A kind, measure family or unit of measure this component does not recognise. */
  | 'unsupported-kind'
  | 'unsupported-measure'
  /** The kind does not permit that measure family — a vehicle sold by the night. */
  | 'measure-not-permitted'
  /** A parent that does not exist, is retired, or is not in force. */
  | 'missing-parent'
  /** A type whose parent chain reaches itself. */
  | 'hierarchy-cycle'
  /** A type that names itself as its own parent. */
  | 'self-parent'
  /** The chain is deeper than the registry permits. */
  | 'hierarchy-too-deep'
  /** Two roots, or an ancestry that cannot be resolved to one chain. */
  | 'ambiguous-ancestry'
  /** A tenant type parented onto, or retiring, another owner's type. */
  | 'cross-owner-relationship'
  /** `effectiveUntil` is not after `effectiveFrom`, or a bound is not a finite instant. */
  | 'invalid-effective-window'
  /** The version is not in force at the instant asked about. */
  | 'version-not-effective'
  | 'duplicate-type-version'
  | 'duplicate-activation'
  | 'duplicate-retirement'
  /** An idempotency key was reused with any authority-bearing input changed. */
  | 'idempotency-key-reuse'
  /** An activation lost a race: the version it claimed to supersede is no longer in force. */
  | 'stale-activation'
  /** Nobody is permitted to register types: no authoring authority was injected. */
  | 'registration-refused'
  /** A mutation was attempted on a type that has been retired. */
  | 'type-retired'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A write tried to rewrite registry history. */
  | 'immutable-history'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record';

export class CommerceUnitError extends Error {
  readonly code: CommerceUnitErrorCode;

  constructor(code: CommerceUnitErrorCode, message: string) {
    super(message);
    this.name = 'CommerceUnitError';
    this.code = code;
  }
}
