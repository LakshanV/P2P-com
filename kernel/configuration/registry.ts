/**
 * K-05 Configuration — the key registry and value validation (FND-003a).
 *
 * A configuration key must be registered before anything can be published for it. That is the
 * difference between configuration and a shared mutable dictionary: an unregistered key has no
 * schema, so nothing can say whether a value is valid, what scopes it may vary at, or what it
 * means. Systems that allow arbitrary keys accumulate values nobody can explain and nobody dares
 * delete.
 *
 * Two categories of value are refused outright rather than validated:
 *
 *   - **Secrets.** Configuration is read widely, versioned forever and shown in admin surfaces.
 *     A credential placed here cannot be rotated by deleting a row, because every prior version
 *     still holds it. Secrets belong in a secret store, which this repository does not yet have.
 *   - **Financial policy values.** Commission rates, fees, payout thresholds and the like are
 *     K-06 Policy Engine's, not K-05's. The distinction matters because financial values need
 *     deterministic evaluation with their own audit and approval path; letting them in here would
 *     put money decisions behind a general-purpose settings table.
 *
 * Owned by: K-05 Configuration.
 */

import {
  ConfigurationError,
  type ConfigurationKey,
  type ConfigurationValue,
  type Scope,
  type ValueSchema,
} from './types.ts';

/**
 * Key-name prefixes reserved for K-06 Policy Engine. A financial policy value is not a setting.
 */
export const FINANCIAL_KEY_PREFIXES: readonly string[] = [
  'commission.',
  'fee.',
  'price.',
  'payout.',
  'settlement.',
  'tax.',
  'refund.',
  'interest.',
];

/** Key-name fragments that indicate a credential rather than a setting. */
export const SECRET_KEY_FRAGMENTS: readonly string[] = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'credential',
  'private_key',
  'privatekey',
  'passphrase',
];

/**
 * Value shapes that carry a credential whatever the key is called. Blunt on purpose: a false
 * positive costs someone a rename, a false negative puts a live credential in an immutable
 * version record that cannot be deleted.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i, // userinfo in a URL
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /\b(?:sk|pk|ghp|gho|xox[baprs])_[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export class ConfigurationRegistry {
  readonly #keys: ReadonlyMap<string, ConfigurationKey>;

  constructor(keys: readonly ConfigurationKey[]) {
    const index = new Map<string, ConfigurationKey>();
    for (const key of keys) {
      if (index.has(key.id)) {
        throw new ConfigurationError('invalid-value', `duplicate configuration key "${key.id}"`);
      }
      assertRegistrableKey(key);
      index.set(key.id, key);
    }
    this.#keys = index;
  }

  has(id: string): boolean {
    return this.#keys.has(id);
  }

  /** The registered key, or a refusal naming it. Never returns a fabricated key. */
  require(id: string): ConfigurationKey {
    const key = this.#keys.get(id);
    if (key === undefined) {
      throw new ConfigurationError(
        'unknown-key',
        `"${id}" is not a registered configuration key. Register it with a value schema before ` +
          'publishing — an unregistered key has no schema, so nothing can say what a valid value is',
      );
    }
    return key;
  }

  ids(): readonly string[] {
    return [...this.#keys.keys()].sort();
  }
}

/** Reject a key definition that this component must never accept. */
export function assertRegistrableKey(key: ConfigurationKey): void {
  if (!/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(key.id)) {
    throw new ConfigurationError(
      'invalid-value',
      `"${key.id}" is not a valid key name — use dotted lower-case segments, e.g. session.timeout`,
    );
  }

  const lowered = key.id.toLowerCase();
  const financial = FINANCIAL_KEY_PREFIXES.find((prefix) => lowered.startsWith(prefix));
  if (financial !== undefined) {
    throw new ConfigurationError(
      'financial-policy-value',
      `"${key.id}" starts with "${financial}", which is a financial policy value. Those belong to ` +
        'K-06 Policy Engine, where they get deterministic evaluation and their own approval path — ' +
        'not to a general-purpose settings component',
    );
  }

  const secretFragment = SECRET_KEY_FRAGMENTS.find((fragment) => lowered.includes(fragment));
  if (secretFragment !== undefined) {
    throw new ConfigurationError(
      'secret-bearing-value',
      `"${key.id}" contains "${secretFragment}", so it names a credential. Configuration versions ` +
        'are immutable and read widely; a secret placed here could never be rotated by deletion',
    );
  }

  if (key.scopes.length === 0) {
    throw new ConfigurationError(
      'invalid-value',
      `"${key.id}" permits no scopes, so it can never be set`,
    );
  }
}

/** Reject a value that does not satisfy its key's schema, or that carries a credential. */
export function assertValidValue(key: ConfigurationKey, value: ConfigurationValue): void {
  assertNotSecretBearing(key.id, value);
  const failure = describeSchemaFailure(key.schema, value);
  if (failure !== null) {
    throw new ConfigurationError('invalid-value', `value for "${key.id}" is invalid: ${failure}`);
  }
}

function assertNotSecretBearing(keyId: string, value: ConfigurationValue): void {
  if (typeof value !== 'string') return;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(value)) {
      throw new ConfigurationError(
        'secret-bearing-value',
        `the value for "${keyId}" looks like a credential. Configuration versions are immutable, ` +
          'so a secret stored here cannot be revoked by deleting it — put it in a secret store',
      );
    }
  }
}

/** Human-readable reason a value fails its schema, or null when it satisfies it. */
export function describeSchemaFailure(
  schema: ValueSchema,
  value: ConfigurationValue,
): string | null {
  switch (schema.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `expected a boolean, got ${typeof value}`;

    case 'integer':
    case 'duration-seconds': {
      if (typeof value !== 'number') return `expected a number, got ${typeof value}`;
      if (!Number.isInteger(value)) return `expected an integer, got ${value}`;
      if (value < schema.minimum || value > schema.maximum) {
        return `expected ${schema.minimum}..${schema.maximum}, got ${value}`;
      }
      return null;
    }

    case 'string': {
      if (typeof value !== 'string') return `expected a string, got ${typeof value}`;
      if (value.length > schema.maxLength) {
        return `expected at most ${schema.maxLength} characters, got ${value.length}`;
      }
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
        return `expected a value matching /${schema.pattern}/`;
      }
      return null;
    }

    case 'enum':
      return typeof value === 'string' && schema.values.includes(value)
        ? null
        : `expected one of ${schema.values.join(', ')}`;

    default: {
      // Exhaustiveness: a new kind must be handled rather than silently accepted.
      const exhaustive: never = schema;
      return `unsupported schema ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** Reject a scope the key does not permit. */
export function assertScopePermitted(key: ConfigurationKey, scope: Scope): void {
  if (!key.scopes.includes(scope.level)) {
    throw new ConfigurationError(
      'scope-not-permitted',
      `"${key.id}" may not be set at ${scope.level} scope; permitted: ${key.scopes.join(', ')}`,
    );
  }
  if (scope.level === 'global' && scope.id !== '') {
    throw new ConfigurationError('invalid-value', 'the global scope carries no identifier');
  }
  if (scope.level !== 'global' && scope.id.trim() === '') {
    throw new ConfigurationError('invalid-value', `${scope.level} scope requires an identifier`);
  }
}
