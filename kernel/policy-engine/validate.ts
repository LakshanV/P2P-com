/**
 * K-06 Policy Engine — one validator per record, for requests and for stored rows (FND-005b).
 *
 * The same function judges a candidate record on the way in and a row on the way out. K-01 needed
 * a correction to reach that shape (CURRENT_IMPLEMENTATION_STATUS §11.22) because a row written
 * around the service decoded cleanly and was then acted upon, and K-04 found the same hole in its
 * adapter. This component starts there, and the consequence of not doing so would be the worst
 * yet: a malformed rule row that decoded cleanly is a commission rate nobody authored, pinned into
 * a financial record as though somebody had.
 *
 * Fail-closed everywhere. A version whose output schema cannot be read is not "probably the
 * default" — it is `malformed-record`, because a policy engine that guesses is one whose answers
 * cannot be relied on in the cases that matter.
 *
 * Owned by: K-06 Policy Engine.
 */

import { InvalidInstantError, compareInstants, parseInstant } from '../../platform/time/instant.ts';

import { assertDecimal, compareDecimals, decimalToText, refuseFloatingPoint } from './decimal.ts';
import { REQUEST_FINGERPRINT } from './fingerprint.ts';
import {
  MAX_RULES,
  assertKnownFields,
  assertOrigin,
  assertPolicyIdentifier,
  assertPolicyKey,
  assertPredicate,
  assertScopeSelector,
} from './registry.ts';
import {
  OUTPUT_KINDS,
  PolicyError,
  specificity,
  type OutputSchema,
  type OutputValue,
  type PolicyActivation,
  type PolicyDraft,
  type PolicyRetirement,
  type PolicyRule,
  type PolicyVersion,
} from './types.ts';

/** Where a record came from, which decides what a refusal should tell the reader. */
export type RecordSource = 'request' | 'stored row';

const STORED_ROW_NOTE =
  'A stored row that fails this was not written by this component — refusing it rather than ' +
  'pinning a policy version nobody authored into a financial record';

function inSource<T>(source: RecordSource, body: () => T): T {
  try {
    return body();
  } catch (error) {
    if (source === 'request' || !(error instanceof PolicyError)) throw error;
    if (error.message.includes(STORED_ROW_NOTE)) throw error;
    throw new PolicyError(error.code, `${error.message}. ${STORED_ROW_NOTE}`);
  }
}

/** Run a decode so that whatever it refuses says the row came from the database. */
export function inStoredRow<T>(body: () => T): T {
  return inSource('stored row', body);
}

const DRAFT_FIELDS = [
  'draftId',
  'policyKey',
  'outputSchema',
  'rules',
  'defaultOutputs',
  'notes',
  'draftedAt',
  'draftedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const VERSION_FIELDS = [
  'policyVersionId',
  'policyKey',
  'version',
  'draftId',
  'outputSchema',
  'rules',
  'defaultOutputs',
  'effectiveFrom',
  'effectiveUntil',
  'publishedAt',
  'publishedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const ACTIVATION_FIELDS = [
  'activationId',
  'policyKey',
  'policyVersionId',
  'supersedesVersionId',
  'activatedAt',
  'activatedBy',
  'idempotencyKey',
  'requestFingerprint',
];

const RETIREMENT_FIELDS = [
  'retirementId',
  'policyKey',
  'reason',
  'retiredAt',
  'retiredBy',
  'idempotencyKey',
  'requestFingerprint',
];

function instant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PolicyError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant`,
    );
  }
  try {
    parseInstant(value);
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new PolicyError('malformed-record', `${field}: ${error.message}`);
    }
    throw error;
  }
  return value;
}

const optionalInstant = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : instant(value, field);

function fingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REQUEST_FINGERPRINT.test(value)) {
    throw new PolicyError(
      'malformed-record',
      `${field} is "${String(value)}"; expected a lowercase SHA-256 in hex. A record with no ` +
        'fingerprint of the request that produced it cannot tell a genuine retry from a reused key',
    );
  }
  return value;
}

function boundedText(value: unknown, field: string, max: number, required: boolean): string {
  if (value === undefined || value === null) {
    if (!required) return '';
    throw new PolicyError('malformed-record', `${field} is required`);
  }
  if (typeof value !== 'string') {
    throw new PolicyError('malformed-record', `${field} is ${typeof value}; expected text`);
  }
  if (required && value.trim() === '') {
    throw new PolicyError('malformed-record', `${field} must not be blank`);
  }
  if (value.length > max) {
    throw new PolicyError('malformed-record', `${field} is longer than ${max} characters`);
  }
  return value;
}

/** An output name: short, lowercase, and not a sentence. */
const OUTPUT_NAME = /^[a-z][a-zA-Z0-9]{1,39}$/;

function assertOutputName(value: string, field: string): string {
  if (!OUTPUT_NAME.test(value)) {
    throw new PolicyError(
      'unsupported-output',
      `${field} is "${value}"; an output name is lowerCamelCase, 2 to 40 characters`,
    );
  }
  return value;
}

export function assertOutputSchema(value: unknown, path: string): OutputSchema {
  if (value === null || typeof value !== 'object') {
    throw new PolicyError(
      'unsupported-output',
      `${path} is ${value === null ? 'null' : typeof value}; expected an output schema`,
    );
  }
  const schema = value as { kind?: unknown; [key: string]: unknown };
  if (
    typeof schema.kind !== 'string' ||
    !(OUTPUT_KINDS as readonly string[]).includes(schema.kind)
  ) {
    throw new PolicyError(
      'unsupported-output',
      `${path}.kind is "${String(schema.kind)}"; expected one of ${OUTPUT_KINDS.join(', ')}`,
    );
  }

  switch (schema.kind) {
    case 'decimal': {
      refuseFloatingPoint(schema.minimum, `${path}.minimum`);
      refuseFloatingPoint(schema.maximum, `${path}.maximum`);
      const minimum = assertDecimal(schema.minimum, `${path}.minimum`);
      const maximum = assertDecimal(schema.maximum, `${path}.maximum`);
      if (
        typeof schema.scale !== 'number' ||
        !Number.isInteger(schema.scale) ||
        schema.scale < 0 ||
        schema.scale > 9
      ) {
        throw new PolicyError('unsupported-output', `${path}.scale must be a whole number, 0 to 9`);
      }
      if (compareDecimals(minimum, maximum) > 0) {
        throw new PolicyError(
          'unsupported-output',
          `${path} has minimum ${decimalToText(minimum)} above maximum ${decimalToText(maximum)}, ` +
            'so no value can satisfy it and every rule using it would be refused',
        );
      }
      return Object.freeze({ kind: 'decimal' as const, scale: schema.scale, minimum, maximum });
    }

    case 'duration-seconds': {
      const { minimum, maximum } = schema as { minimum?: unknown; maximum?: unknown };
      for (const [name, bound] of [
        ['minimum', minimum],
        ['maximum', maximum],
      ] as const) {
        if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0) {
          throw new PolicyError(
            'unsupported-output',
            `${path}.${name} is ${String(bound)}; expected a whole number of seconds, 0 or more`,
          );
        }
      }
      if ((minimum as number) > (maximum as number)) {
        throw new PolicyError('unsupported-output', `${path} has minimum above maximum`);
      }
      return Object.freeze({
        kind: 'duration-seconds' as const,
        minimum: minimum as number,
        maximum: maximum as number,
      });
    }

    case 'boolean':
      return Object.freeze({ kind: 'boolean' as const });

    case 'enum': {
      if (!Array.isArray(schema.values) || schema.values.length === 0) {
        throw new PolicyError('unsupported-output', `${path}.values must be a non-empty array`);
      }
      if (schema.values.length > 32) {
        throw new PolicyError('unbounded-structure', `${path}.values holds more than 32 entries`);
      }
      return Object.freeze({
        kind: 'enum' as const,
        values: Object.freeze(
          schema.values.map((entry, index) =>
            assertPolicyIdentifier(entry, `${path}.values[${index}]`),
          ),
        ),
      });
    }

    default:
      return Object.freeze({
        kind: 'configured' as const,
        key: boundedText(schema.key, `${path}.key`, 120, true),
      });
  }
}

/** A value, judged against the schema the policy declared for that output. */
export function assertOutputValue(value: unknown, schema: OutputSchema, path: string): OutputValue {
  if (value === null || typeof value !== 'object') {
    throw new PolicyError(
      'unsupported-output',
      `${path} is ${value === null ? 'null' : typeof value}; expected an output value`,
    );
  }
  const output = value as { kind?: unknown; value?: unknown; key?: unknown };
  if (output.kind !== schema.kind) {
    throw new PolicyError(
      'unsupported-output',
      `${path}.kind is "${String(output.kind)}" but the policy declares this output as ` +
        `"${schema.kind}". A value of a kind the schema does not declare is a rule nobody reviewed`,
    );
  }

  switch (schema.kind) {
    case 'decimal': {
      refuseFloatingPoint(output.value, `${path}.value`);
      const decimal = assertDecimal(output.value, `${path}.value`);
      if (decimal.scale !== schema.scale) {
        throw new PolicyError(
          'malformed-decimal',
          `${path}.value has scale ${decimal.scale} but the policy declares scale ${schema.scale}. ` +
            'The scale is the author’s statement of how precisely they meant it, so it is ' +
            'matched rather than coerced',
        );
      }
      if (
        compareDecimals(decimal, schema.minimum) < 0 ||
        compareDecimals(decimal, schema.maximum) > 0
      ) {
        throw new PolicyError(
          'unsupported-output',
          `${path}.value is ${decimalToText(decimal)}, outside the declared range ` +
            `${decimalToText(schema.minimum)}–${decimalToText(schema.maximum)}`,
        );
      }
      return Object.freeze({ kind: 'decimal' as const, value: decimal });
    }

    case 'duration-seconds': {
      if (
        typeof output.value !== 'number' ||
        !Number.isSafeInteger(output.value) ||
        output.value < schema.minimum ||
        output.value > schema.maximum
      ) {
        throw new PolicyError(
          'unsupported-output',
          `${path}.value is ${String(output.value)}; expected a whole number of seconds between ` +
            `${schema.minimum} and ${schema.maximum}`,
        );
      }
      return Object.freeze({ kind: 'duration-seconds' as const, value: output.value });
    }

    case 'boolean': {
      if (typeof output.value !== 'boolean') {
        throw new PolicyError(
          'unsupported-output',
          `${path}.value is ${String(output.value)}; expected true or false`,
        );
      }
      return Object.freeze({ kind: 'boolean' as const, value: output.value });
    }

    case 'enum': {
      if (typeof output.value !== 'string' || !schema.values.includes(output.value)) {
        throw new PolicyError(
          'unsupported-output',
          `${path}.value is "${String(output.value)}"; expected one of ${schema.values.join(', ')}`,
        );
      }
      return Object.freeze({ kind: 'enum' as const, value: output.value });
    }

    default: {
      if (output.key !== schema.key) {
        throw new PolicyError(
          'unsupported-output',
          `${path}.key is "${String(output.key)}" but the policy declares "${schema.key}"`,
        );
      }
      return Object.freeze({ kind: 'configured' as const, key: schema.key });
    }
  }
}

/** Every output the schema declares must be present, and nothing else may be. */
function assertOutputMap(
  value: unknown,
  schema: Readonly<Record<string, OutputSchema>>,
  path: string,
): Readonly<Record<string, OutputValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(
      'unsupported-output',
      `${path} is ${value === null ? 'null' : typeof value}; expected an object of outputs`,
    );
  }
  const supplied = value as Record<string, unknown>;
  const outputs: Record<string, OutputValue> = {};

  for (const [name, declared] of Object.entries(schema)) {
    if (!(name in supplied)) {
      throw new PolicyError(
        'unsupported-output',
        `${path} does not set "${name}", which the policy declares. A rule that answers only some ` +
          'of what a policy promises leaves the caller to invent the rest',
      );
    }
    outputs[name] = assertOutputValue(supplied[name], declared, `${path}.${name}`);
  }
  for (const name of Object.keys(supplied)) {
    if (name in schema) continue;
    throw new PolicyError(
      'unsupported-output',
      `${path} sets "${name}", which the policy does not declare. Nothing reads it, so it is a ` +
        'rule somebody believes is in force',
    );
  }
  return Object.freeze(outputs);
}

function assertRules(
  value: unknown,
  schema: Readonly<Record<string, OutputSchema>>,
): readonly PolicyRule[] {
  if (!Array.isArray(value)) {
    throw new PolicyError('malformed-record', 'rules must be an array');
  }
  if (value.length === 0) {
    throw new PolicyError(
      'malformed-record',
      'a policy with no rules answers nothing. Publish declared defaults if that is what is meant',
    );
  }
  if (value.length > MAX_RULES) {
    throw new PolicyError(
      'unbounded-structure',
      `a policy carries ${value.length} rules; at most ${MAX_RULES}`,
    );
  }

  const rules = value.map((entry, index) => {
    const path = `rules[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      throw new PolicyError('malformed-record', `${path} is not a rule object`);
    }
    const rule = entry as Record<string, unknown>;
    assertKnownFields(rule, ['ruleId', 'selector', 'condition', 'outputs'], path);
    return Object.freeze({
      ruleId: assertPolicyIdentifier(rule.ruleId, `${path}.ruleId`),
      selector: assertScopeSelector(rule.selector, `${path}.selector`),
      condition:
        rule.condition === null || rule.condition === undefined
          ? null
          : assertPredicate(rule.condition, `${path}.condition`),
      outputs: assertOutputMap(rule.outputs, schema, `${path}.outputs`),
    });
  });

  const ids = new Set(rules.map((rule) => rule.ruleId));
  if (ids.size !== rules.length) {
    throw new PolicyError(
      'malformed-record',
      'two rules share a rule id, so a decision could not say which one decided it',
    );
  }

  // Two rules with the same selector *and* no condition can never be told apart, so every
  // evaluation reaching them is ambiguous. Refusing at authoring is better than refusing at
  // evaluation, when a transaction is waiting.
  const unconditional = rules.filter((rule) => rule.condition === null);
  const seen = new Map<string, string>();
  for (const rule of unconditional) {
    const key = JSON.stringify(
      Object.entries(rule.selector).sort(([left], [right]) => left.localeCompare(right)),
    );
    const clash = seen.get(key);
    if (clash !== undefined) {
      throw new PolicyError(
        'ambiguous-precedence',
        `rules "${clash}" and "${rule.ruleId}" bind the same scope with no condition, so both ` +
          `match whenever either does and specificity ${specificity(rule.selector)} cannot ` +
          'separate them. Which commission applies would depend on row order',
      );
    }
    seen.set(key, rule.ruleId);
  }

  return Object.freeze(rules);
}

function assertSchemaMap(value: unknown): Readonly<Record<string, OutputSchema>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(
      'unsupported-output',
      `outputSchema is ${value === null ? 'null' : typeof value}; expected an object`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new PolicyError(
      'unsupported-output',
      'outputSchema is empty, so the policy promises nothing and no caller could use it',
    );
  }
  if (entries.length > 16) {
    throw new PolicyError('unbounded-structure', 'outputSchema declares more than 16 outputs');
  }
  return Object.freeze(
    Object.fromEntries(
      entries.map(([name, schema]) => [
        assertOutputName(name, `outputSchema key "${name}"`),
        assertOutputSchema(schema, `outputSchema.${name}`),
      ]),
    ),
  );
}

export function validatePolicyDraft(candidate: unknown, source: RecordSource): PolicyDraft {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new PolicyError('malformed-record', 'a policy draft must be an object');
    }
    assertKnownFields(candidate, DRAFT_FIELDS, 'a policy draft');
    const value = candidate as Record<string, unknown>;
    const outputSchema = assertSchemaMap(value.outputSchema);

    return {
      draftId: assertPolicyIdentifier(value.draftId, 'draftId'),
      policyKey: assertPolicyKey(value.policyKey),
      outputSchema,
      rules: assertRules(value.rules, outputSchema),
      defaultOutputs:
        value.defaultOutputs === null || value.defaultOutputs === undefined
          ? null
          : assertOutputMap(value.defaultOutputs, outputSchema, 'defaultOutputs'),
      notes: boundedText(value.notes, 'notes', 2000, false),
      draftedAt: instant(value.draftedAt, 'draftedAt'),
      draftedBy: assertOrigin(value.draftedBy, 'draftedBy'),
      idempotencyKey: assertPolicyIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validatePolicyVersion(candidate: unknown, source: RecordSource): PolicyVersion {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new PolicyError('malformed-record', 'a policy version must be an object');
    }
    assertKnownFields(candidate, VERSION_FIELDS, 'a policy version');
    const value = candidate as Record<string, unknown>;

    const version = value.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new PolicyError(
        'malformed-record',
        `version is ${String(version)}; expected a positive integer. Version numbers order a ` +
          'policy’s history, and a clock cannot: two publications can share an instant',
      );
    }

    const effectiveFrom = optionalInstant(value.effectiveFrom, 'effectiveFrom');
    const effectiveUntil = optionalInstant(value.effectiveUntil, 'effectiveUntil');
    if (
      effectiveFrom !== null &&
      effectiveUntil !== null &&
      compareInstants(effectiveUntil, effectiveFrom) <= 0
    ) {
      throw new PolicyError(
        'invalid-effective-window',
        `effectiveUntil (${effectiveUntil}) is not after effectiveFrom (${effectiveFrom}), so the ` +
          'window contains no instant and the version could never decide anything. A policy that ' +
          'reads as scheduled and can never apply is worse than one published without a window',
      );
    }

    const outputSchema = assertSchemaMap(value.outputSchema);
    return {
      policyVersionId: assertPolicyIdentifier(value.policyVersionId, 'policyVersionId'),
      policyKey: assertPolicyKey(value.policyKey),
      version,
      draftId: assertPolicyIdentifier(value.draftId, 'draftId'),
      outputSchema,
      rules: assertRules(value.rules, outputSchema),
      defaultOutputs:
        value.defaultOutputs === null || value.defaultOutputs === undefined
          ? null
          : assertOutputMap(value.defaultOutputs, outputSchema, 'defaultOutputs'),
      effectiveFrom,
      effectiveUntil,
      publishedAt: instant(value.publishedAt, 'publishedAt'),
      publishedBy: assertOrigin(value.publishedBy, 'publishedBy'),
      idempotencyKey: assertPolicyIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateActivation(candidate: unknown, source: RecordSource): PolicyActivation {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new PolicyError('malformed-record', 'an activation must be an object');
    }
    assertKnownFields(candidate, ACTIVATION_FIELDS, 'an activation');
    const value = candidate as Record<string, unknown>;

    const policyVersionId = assertPolicyIdentifier(value.policyVersionId, 'policyVersionId');
    const supersedes =
      value.supersedesVersionId === null || value.supersedesVersionId === undefined
        ? null
        : assertPolicyIdentifier(value.supersedesVersionId, 'supersedesVersionId');
    if (supersedes !== null && supersedes === policyVersionId) {
      throw new PolicyError(
        'malformed-record',
        'an activation supersedes itself, which records no transition at all',
      );
    }

    return {
      activationId: assertPolicyIdentifier(value.activationId, 'activationId'),
      policyKey: assertPolicyKey(value.policyKey),
      policyVersionId,
      supersedesVersionId: supersedes,
      activatedAt: instant(value.activatedAt, 'activatedAt'),
      activatedBy: assertOrigin(value.activatedBy, 'activatedBy'),
      idempotencyKey: assertPolicyIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}

export function validateRetirement(candidate: unknown, source: RecordSource): PolicyRetirement {
  return inSource(source, () => {
    if (candidate === null || typeof candidate !== 'object') {
      throw new PolicyError('malformed-record', 'a retirement must be an object');
    }
    assertKnownFields(candidate, RETIREMENT_FIELDS, 'a retirement');
    const value = candidate as Record<string, unknown>;

    return {
      retirementId: assertPolicyIdentifier(value.retirementId, 'retirementId'),
      policyKey: assertPolicyKey(value.policyKey),
      reason: boundedText(value.reason, 'reason', 500, true),
      retiredAt: instant(value.retiredAt, 'retiredAt'),
      retiredBy: assertOrigin(value.retiredBy, 'retiredBy'),
      idempotencyKey: assertPolicyIdentifier(value.idempotencyKey, 'idempotencyKey'),
      requestFingerprint: fingerprint(value.requestFingerprint, 'requestFingerprint'),
    };
  });
}
