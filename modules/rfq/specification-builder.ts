/**
 * Turning what the platform understood into what a supplier may see.
 *
 * The single most sensitive translation in the product, and the reason it is a named function with
 * its own file rather than three lines inside a route handler.
 *
 * On one side is a Need: a sentence somebody wrote, and the platform's structured reading of it. The
 * sentence is deliberately exempt from the identifier rules — "ring me on 0771234567 about the
 * cement" is a Need, not a leak — and it may hold a telephone number, an address, a medical detail,
 * a grievance about a competitor, or a hint about what the buyer is willing to pay.
 *
 * On the other side is a tender that goes to strangers.
 *
 * **Nothing crosses except by being named.** This builder takes the structured reading and copies
 * only the keys it recognises, into fields whose meaning a supplier can act on. It is an
 * **allowlist**, and that direction is the whole point: a denylist would need updating every time
 * M-03's interpreter learned to extract a new field, and the one nobody remembered to add would be
 * the one that leaked.
 *
 * So a reading that carries `customerPhone`, `buyerNote` or `maxBudget` produces a specification
 * that simply does not contain them — not because those keys are blocked, but because they were
 * never on the list.
 *
 * **The buyer's budget is deliberately not carried, even though M-03 may know it.** A supplier who
 * can see what a buyer will pay quotes that number. That is not a privacy rule; it is the difference
 * between a market and a rubber stamp.
 *
 * Owned by: M-09 RFQ.
 */

import type { RfqSpecification, SubstitutionPolicy } from './types.ts';
import { validateSpecification } from './validate.ts';

/**
 * Keys a supplier may see, and what each becomes.
 *
 * Everything here is a **requirement** — something a supplier must meet in order to quote. If a key
 * is not on this list it does not reach a tender, whatever M-03 extracted and however useful it
 * might have been.
 */
const CARRIED_KEYS: Readonly<Record<string, keyof RfqSpecification | 'attribute'>> = Object.freeze({
  commodity: 'category',
  category: 'category',
  quantity: 'quantity',
  unit: 'unit',
  district: 'deliveryDistrict',
  deliveryDistrict: 'deliveryDistrict',
  requiredBy: 'requiredBy',
  neededBy: 'requiredBy',
  condition: 'condition',
  // Anything else on this list is a specification attribute: a grade, a size, a standard. These are
  // the facts a supplier filters on and quotes against.
  grade: 'attribute',
  size: 'attribute',
  colour: 'attribute',
  color: 'attribute',
  material: 'attribute',
  voltage: 'attribute',
  capacity: 'attribute',
  model: 'attribute',
  brand: 'attribute',
  standard: 'attribute',
  packaging: 'attribute',
  finish: 'attribute',
});

export interface BuildSpecificationOptions {
  /** M-03's structured reading. The words are not a parameter, because they may not travel. */
  readonly structured: Readonly<Record<string, unknown>>;
  /**
   * A supplier-facing description, written for a supplier.
   *
   * Supplied by the caller rather than derived, because a good one is a judgement — but checked
   * here by the same private-text guard as everything else, since "written for a supplier" is
   * exactly what somebody in a hurry will claim about a paste.
   */
  readonly itemDescription: string;
  readonly substitutionPolicy: SubstitutionPolicy;
  readonly qualityRequirements?: readonly string[];
  /** Opaque references only. The artefacts live elsewhere and are fetched through a guarded route. */
  readonly attachmentReferences?: readonly string[];
  /** Used when the reading found no unit, which is common for a countable thing. */
  readonly defaultUnit?: string;
}

/**
 * Build a supplier-facing specification from a Need's reading.
 *
 * Throws when the reading does not contain enough to ask a sensible question — no category, or no
 * quantity. Refusing is correct: a tender that cannot say what is wanted or how much wastes every
 * supplier who opens it, and "we were not sure" is not a thing to send to eleven strangers.
 */
export function buildSpecification(options: BuildSpecificationOptions): RfqSpecification {
  const attributes: Record<string, string> = {};
  let category: string | null = null;
  let quantity: bigint | null = null;
  let unit: string | null = null;
  let deliveryDistrict: string | null = null;
  let requiredBy: string | null = null;
  let condition: string | null = null;

  for (const [key, value] of Object.entries(options.structured)) {
    const destination = CARRIED_KEYS[key];
    // Not on the allowlist. It stays in M-03 — which is where the person who wrote it can see who
    // has read it.
    if (destination === undefined) continue;

    const text = scalarText(value);
    if (text === null) continue;

    switch (destination) {
      case 'category':
        category ??= text;
        break;
      case 'quantity':
        quantity ??= readQuantity(value);
        break;
      case 'unit':
        unit ??= text;
        break;
      case 'deliveryDistrict':
        deliveryDistrict ??= text;
        break;
      case 'requiredBy':
        requiredBy ??= text;
        break;
      case 'condition':
        condition ??= text;
        break;
      default:
        attributes[key] = text;
    }
  }

  if (category === null) {
    throw new Error(
      'a tender needs a category: a supplier cannot quote for "something", and asking eleven ' +
        'strangers what the buyer meant is not a use of their time',
    );
  }
  if (quantity === null || quantity <= 0n) {
    throw new Error(
      'a tender needs a quantity: a supplier quoting for an unknown amount is guessing, and a ' +
        'quote based on a guess is not comparable to one that is not',
    );
  }

  // Validated rather than returned directly, so the private-text guard runs over every string a
  // supplier will read — including the description the caller wrote and every attribute value.
  return validateSpecification(
    {
      category,
      itemDescription: options.itemDescription,
      quantity,
      unit: unit ?? options.defaultUnit ?? 'unit',
      attributes,
      deliveryDistrict,
      requiredBy,
      condition,
      qualityRequirements: [...(options.qualityRequirements ?? [])],
      substitutionPolicy: options.substitutionPolicy,
      attachmentReferences: [...(options.attachmentReferences ?? [])],
    },
    'request',
  );
}

/** The keys this builder will carry. Exported so a test can assert the allowlist has not widened. */
export function carriedKeys(): readonly string[] {
  return Object.freeze(Object.keys(CARRIED_KEYS).sort());
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return String(value);
  // An object or an array carries structure this builder has no rule for, and guessing at one is
  // how a nested field nobody looked at ends up in front of a supplier.
  return null;
}

function readQuantity(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}
