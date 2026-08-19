/**
 * K-08 Event Infrastructure — the event-type and subscription registries (FND-003b).
 *
 * A registry rather than free-form strings, for the same reason K-05 registers configuration keys:
 * an unregistered type has no declared payload, so nothing can say whether an envelope carrying it
 * is well formed. Consumers would then be validating producers' output by reading their code.
 *
 * Versions are explicit and immutable. A payload shape that changes gets a new version; the old
 * one keeps validating the events already in the log, because those events are still readable
 * years later and must still be checkable against the contract they were published under.
 *
 * Owned by: K-08 Event Infrastructure.
 */

import { KERNEL_COMPONENTS, BUSINESS_MODULES } from '../../platform/architecture/manifest.ts';

import { EventError, type EventPayload, type JsonScalar } from './types.ts';

/** What a declared payload field may be. Scalars only — see `EventPayload`. */
export type PayloadFieldKind = 'string' | 'integer' | 'boolean';

export interface PayloadField {
  readonly name: string;
  readonly kind: PayloadFieldKind;
  /** An optional field may be absent, but never present-and-wrong-typed. */
  readonly required: boolean;
  readonly description: string;
}

export interface EventTypeDefinition {
  /** Dotted lower-case, e.g. `inventory.item_reserved`. */
  readonly type: string;
  /** 1 or greater. One definition per (type, version). */
  readonly schemaVersion: number;
  /** Manifest id of the only unit permitted to publish it. */
  readonly owner: string;
  readonly description: string;
  readonly payloadFields: readonly PayloadField[];
}

export interface SubscriptionDefinition {
  /** Stable name of a consumer, e.g. `audit-writer`. Appears in every delivery row. */
  readonly subscription: string;
  /** Manifest id of the unit that owns the consumer. */
  readonly owner: string;
  /** Types it receives. A subscription to an unregistered type is a registration error. */
  readonly types: readonly string[];
  readonly description: string;
}

const TYPE_NAME = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
const SUBSCRIPTION_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Field names that mean a credential is being carried.
 *
 * An event is fanned out to every subscriber, stored for as long as the log is kept, and read by
 * anyone who can read the log. A credential in a payload is therefore published, not merely
 * stored, and it cannot be unpublished. Refused at registration *and* at publication: at
 * registration so the contract can never declare one, at publication so a dynamically-built
 * payload cannot smuggle one past a clean declaration.
 */
export const SECRET_FIELD_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'credential',
  'authorization',
  'session_id',
  'access_key',
];

/** Value shapes that look like a credential whatever the field is called. */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\bpostgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/,
];

const manifestIds = (): ReadonlySet<string> =>
  new Set([
    'platform',
    ...KERNEL_COMPONENTS.map((component) => component.id),
    ...BUSINESS_MODULES.map((mod) => mod.id),
  ]);

/** Refuse a definition that could never be validated, or that declares a credential field. */
export function assertRegistrableType(definition: EventTypeDefinition): void {
  if (!TYPE_NAME.test(definition.type)) {
    throw new EventError(
      'unknown-event-type',
      `"${definition.type}" is not a valid event type name. Expected dotted lower-case such as ` +
        'inventory.item_reserved, so a type reads as a subject and a fact',
    );
  }
  if (!Number.isInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    throw new EventError(
      'unknown-schema-version',
      `${definition.type} declares schema version ${definition.schemaVersion}; versions start at 1`,
    );
  }
  if (!manifestIds().has(definition.owner)) {
    throw new EventError(
      'producer-not-permitted',
      `${definition.type} is owned by "${definition.owner}", which is not a unit in ` +
        'platform/architecture/manifest.ts. An event type with no owner has nobody to change it',
    );
  }
  if (definition.description.trim() === '') {
    throw new EventError(
      'unknown-event-type',
      `${definition.type} has no description; a consumer in another unit has only this to go on`,
    );
  }

  const seen = new Set<string>();
  for (const field of definition.payloadFields) {
    if (!FIELD_NAME.test(field.name)) {
      throw new EventError(
        'invalid-payload',
        `${definition.type} declares field "${field.name}"; expected lower_snake_case`,
      );
    }
    if (seen.has(field.name)) {
      throw new EventError(
        'invalid-payload',
        `${definition.type} declares field "${field.name}" twice`,
      );
    }
    seen.add(field.name);

    const fragment = SECRET_FIELD_FRAGMENTS.find((secret) => field.name.includes(secret));
    if (fragment !== undefined) {
      throw new EventError(
        'secret-bearing-payload',
        `${definition.type} declares field "${field.name}", which names a credential ` +
          `("${fragment}"). An event is fanned out to every subscriber and kept for as long as ` +
          'the log is kept, so a credential here is published and cannot be unpublished',
      );
    }
  }
}

export function assertRegistrableSubscription(
  definition: SubscriptionDefinition,
  knownTypes: ReadonlySet<string>,
): void {
  if (!SUBSCRIPTION_NAME.test(definition.subscription)) {
    throw new EventError(
      'unknown-subscription',
      `"${definition.subscription}" is not a valid subscription name; expected kebab-case`,
    );
  }
  if (!manifestIds().has(definition.owner)) {
    throw new EventError(
      'producer-not-permitted',
      `subscription "${definition.subscription}" is owned by "${definition.owner}", which is not ` +
        'a unit in platform/architecture/manifest.ts',
    );
  }
  if (definition.types.length === 0) {
    throw new EventError(
      'unknown-subscription',
      `subscription "${definition.subscription}" receives no types, so it would never be delivered to`,
    );
  }
  for (const type of definition.types) {
    if (!knownTypes.has(type)) {
      throw new EventError(
        'unknown-event-type',
        `subscription "${definition.subscription}" subscribes to unregistered type "${type}"`,
      );
    }
  }
}

/** Refuse a payload that does not match the declared version of its type. Fail closed. */
export function assertValidPayload(definition: EventTypeDefinition, payload: EventPayload): void {
  const declared = new Map(definition.payloadFields.map((field) => [field.name, field]));

  for (const [name, value] of Object.entries(payload)) {
    const field = declared.get(name);
    if (field === undefined) {
      // Unknown fields are refused rather than ignored. Ignoring one lets a producer believe it
      // published something a consumer will never see, which surfaces as a silent data loss.
      throw new EventError(
        'invalid-payload',
        `${definition.type} v${definition.schemaVersion} does not declare field "${name}". ` +
          `Declared fields: ${[...declared.keys()].join(', ') || '(none)'}. Add a new schema ` +
          'version rather than widening this one, which events already in the log conform to',
      );
    }
    assertFieldValue(definition, field, value);
  }

  for (const field of definition.payloadFields) {
    if (field.required && !(field.name in payload)) {
      throw new EventError(
        'invalid-payload',
        `${definition.type} v${definition.schemaVersion} requires field "${field.name}"`,
      );
    }
  }

  assertNoSecretValues(definition, payload);
}

function assertFieldValue(
  definition: EventTypeDefinition,
  field: PayloadField,
  value: JsonScalar,
): void {
  const describe = (): string =>
    `${definition.type} v${definition.schemaVersion} field "${field.name}"`;

  if (value === null) {
    if (field.required) {
      throw new EventError('invalid-payload', `${describe()} is required and may not be null`);
    }
    return;
  }

  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') {
        throw new EventError(
          'invalid-payload',
          `${describe()} must be a string, got ${typeof value}`,
        );
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new EventError(
          'invalid-payload',
          `${describe()} must be a safe integer, got ${JSON.stringify(value)}`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new EventError(
          'invalid-payload',
          `${describe()} must be a boolean, got ${typeof value}`,
        );
      }
      return;
    default: {
      const unreachable: never = field.kind;
      throw new EventError('invalid-payload', `unsupported field kind ${String(unreachable)}`);
    }
  }
}

/** A credential-shaped value under an innocent field name is still a published credential. */
function assertNoSecretValues(definition: EventTypeDefinition, payload: EventPayload): void {
  for (const [name, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue;
    const pattern = SECRET_VALUE_PATTERNS.find((candidate) => candidate.test(value));
    if (pattern !== undefined) {
      throw new EventError(
        'secret-bearing-payload',
        `${definition.type} field "${name}" carries a value shaped like a credential ` +
          `(${String(pattern)}). Publish an identifier a consumer can exchange for the secret ` +
          'through the unit that owns it, never the secret itself',
      );
    }
  }
}

/** The declared event types, indexed by type and version. */
export class EventTypeRegistry {
  readonly #byKey: Map<string, EventTypeDefinition>;
  readonly #versionsByType: Map<string, number[]>;

  constructor(definitions: readonly EventTypeDefinition[]) {
    this.#byKey = new Map();
    this.#versionsByType = new Map();

    for (const definition of definitions) {
      assertRegistrableType(definition);
      const key = keyOf(definition.type, definition.schemaVersion);
      if (this.#byKey.has(key)) {
        throw new EventError(
          'unknown-event-type',
          `${definition.type} v${definition.schemaVersion} is registered twice`,
        );
      }
      this.#byKey.set(key, definition);
      this.#versionsByType.set(definition.type, [
        ...(this.#versionsByType.get(definition.type) ?? []),
        definition.schemaVersion,
      ]);
    }
  }

  /**
   * The definition, or a refusal naming which half was unknown.
   *
   * The distinction matters to a caller: an unknown type is a missing registration, an unknown
   * version of a known type is usually a producer running ahead of its own deployment.
   */
  require(type: string, schemaVersion: number): EventTypeDefinition {
    const definition = this.#byKey.get(keyOf(type, schemaVersion));
    if (definition !== undefined) return definition;

    const versions = this.#versionsByType.get(type);
    if (versions === undefined) {
      throw new EventError(
        'unknown-event-type',
        `"${type}" is not a registered event type. An unregistered type has no declared payload, ` +
          'so nothing can say whether this envelope is well formed',
      );
    }
    throw new EventError(
      'unknown-schema-version',
      `${type} has no schema version ${schemaVersion}; registered versions are ` +
        `${versions.sort((a, b) => a - b).join(', ')}`,
    );
  }

  has(type: string, schemaVersion: number): boolean {
    return this.#byKey.has(keyOf(type, schemaVersion));
  }

  types(): readonly string[] {
    return [...this.#versionsByType.keys()].sort();
  }

  all(): readonly EventTypeDefinition[] {
    return [...this.#byKey.values()];
  }
}

/** Which subscriptions receive which types. */
export class SubscriptionRegistry {
  readonly #bySubscription: Map<string, SubscriptionDefinition>;

  constructor(definitions: readonly SubscriptionDefinition[], types: EventTypeRegistry) {
    const knownTypes = new Set(types.types());
    this.#bySubscription = new Map();

    for (const definition of definitions) {
      assertRegistrableSubscription(definition, knownTypes);
      if (this.#bySubscription.has(definition.subscription)) {
        throw new EventError(
          'unknown-subscription',
          `subscription "${definition.subscription}" is registered twice`,
        );
      }
      this.#bySubscription.set(definition.subscription, definition);
    }
  }

  require(subscription: string): SubscriptionDefinition {
    const definition = this.#bySubscription.get(subscription);
    if (definition === undefined) {
      throw new EventError(
        'unknown-subscription',
        `"${subscription}" is not a registered subscription`,
      );
    }
    return definition;
  }

  /** Subscriptions that receive this type, in a stable order so fan-out is deterministic. */
  subscribersOf(type: string): readonly SubscriptionDefinition[] {
    return [...this.#bySubscription.values()]
      .filter((definition) => definition.types.includes(type))
      .sort((a, b) => a.subscription.localeCompare(b.subscription));
  }

  all(): readonly SubscriptionDefinition[] {
    return [...this.#bySubscription.values()];
  }
}

function keyOf(type: string, schemaVersion: number): string {
  return `${type}@${schemaVersion}`;
}
