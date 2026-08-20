/**
 * K-06 Policy Engine — the immutability boundary (FND-005b).
 *
 * One function per record type, applied everywhere a record crosses a boundary: service results,
 * every in-memory seed, read and write, and PostgreSQL decoding. One boundary rather than a freeze
 * at each call site, because a rule applied in six places is a rule that will be applied in five
 * after the next change — which is how K-09 shipped with a frozen record whose `actor` was still
 * writable (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * The nested structures are the point here, more than in any other component. A policy version
 * holds a rule list, each rule holds a selector, a predicate tree and an output map, and every one
 * of those decides money. A caller handed a version who could edit a rule's `outputs.rate` would
 * change the commission for every transaction evaluated afterwards — with no write, no row and
 * nothing in the history to find.
 *
 * Owned by: K-06 Policy Engine.
 */

import type {
  OutputSchema,
  OutputValue,
  PolicyActivation,
  PolicyDraft,
  PolicyRetirement,
  PolicyRule,
  PolicyVersion,
  Predicate,
} from './types.ts';

/** Frozen all the way down: a predicate tree with a mutable branch is a mutable policy. */
export function sealPredicate(predicate: Predicate): Predicate {
  switch (predicate.kind) {
    case 'fact-in':
      return Object.freeze({ ...predicate, values: Object.freeze([...predicate.values]) });
    case 'amount-at-least':
    case 'amount-below':
      return Object.freeze({ ...predicate, amount: Object.freeze({ ...predicate.amount }) });
    case 'all':
    case 'any':
      return Object.freeze({ ...predicate, of: Object.freeze(predicate.of.map(sealPredicate)) });
    default:
      return Object.freeze({ ...predicate });
  }
}

export function sealOutputValue(output: OutputValue): OutputValue {
  return output.kind === 'decimal'
    ? Object.freeze({ ...output, value: Object.freeze({ ...output.value }) })
    : Object.freeze({ ...output });
}

export function sealOutputSchema(schema: OutputSchema): OutputSchema {
  switch (schema.kind) {
    case 'decimal':
      return Object.freeze({
        ...schema,
        minimum: Object.freeze({ ...schema.minimum }),
        maximum: Object.freeze({ ...schema.maximum }),
      });
    case 'enum':
      return Object.freeze({ ...schema, values: Object.freeze([...schema.values]) });
    default:
      return Object.freeze({ ...schema });
  }
}

const sealOutputs = (
  outputs: Readonly<Record<string, OutputValue>>,
): Readonly<Record<string, OutputValue>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(outputs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, sealOutputValue(value)]),
    ),
  );

const sealSchema = (
  schema: Readonly<Record<string, OutputSchema>>,
): Readonly<Record<string, OutputSchema>> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(schema)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, sealOutputSchema(value)]),
    ),
  );

export function sealRule(rule: PolicyRule): PolicyRule {
  return Object.freeze({
    ...rule,
    selector: Object.freeze({ ...rule.selector }),
    condition: rule.condition === null ? null : sealPredicate(rule.condition),
    outputs: sealOutputs(rule.outputs),
  });
}

export function sealDraft(draft: PolicyDraft): PolicyDraft {
  return Object.freeze({
    ...draft,
    outputSchema: sealSchema(draft.outputSchema),
    rules: Object.freeze(draft.rules.map(sealRule)),
    defaultOutputs: draft.defaultOutputs === null ? null : sealOutputs(draft.defaultOutputs),
    draftedBy: Object.freeze({ ...draft.draftedBy }),
  });
}

export function sealVersion(version: PolicyVersion): PolicyVersion {
  return Object.freeze({
    ...version,
    outputSchema: sealSchema(version.outputSchema),
    rules: Object.freeze(version.rules.map(sealRule)),
    defaultOutputs: version.defaultOutputs === null ? null : sealOutputs(version.defaultOutputs),
    publishedBy: Object.freeze({ ...version.publishedBy }),
  });
}

export function sealActivation(activation: PolicyActivation): PolicyActivation {
  return Object.freeze({ ...activation, activatedBy: Object.freeze({ ...activation.activatedBy }) });
}

export function sealRetirement(retirement: PolicyRetirement): PolicyRetirement {
  return Object.freeze({ ...retirement, retiredBy: Object.freeze({ ...retirement.retiredBy }) });
}

export const sealDrafts = (drafts: readonly PolicyDraft[]): readonly PolicyDraft[] =>
  Object.freeze(drafts.map(sealDraft));

export const sealVersions = (versions: readonly PolicyVersion[]): readonly PolicyVersion[] =>
  Object.freeze(versions.map(sealVersion));

export const sealActivations = (
  activations: readonly PolicyActivation[],
): readonly PolicyActivation[] => Object.freeze(activations.map(sealActivation));

export const sealRetirements = (
  retirements: readonly PolicyRetirement[],
): readonly PolicyRetirement[] => Object.freeze(retirements.map(sealRetirement));
