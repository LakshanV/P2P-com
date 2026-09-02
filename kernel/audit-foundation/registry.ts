/**
 * K-09 Audit Foundation — the action registry (FND-003c).
 *
 * An audit action is registered before it can be recorded, for the same reason a K-08 event type
 * is: an unregistered action has no declared evidence, so nothing can say whether a record carrying
 * it is complete or whether the fields it carries are safe to keep. A log full of ad-hoc actions
 * with ad-hoc fields is a log nobody can query and nobody dares expose.
 *
 * Registration declares three things the record itself cannot:
 *
 *   - **Authority.** Whether the action is security-sensitive or business-authoritative. Both are
 *     audited; the distinction is what a reader filters on during an incident.
 *   - **Owner.** Which manifest unit's action this is, so a unit cannot record another's history.
 *   - **Evidence, field by field, with a classification.** An undeclared field is refused rather
 *     than stored, because a field nobody classified is a field nobody can decide about later.
 *
 * **No business-specific actions are registered here.** The registry is a mechanism; the actions
 * belong to the units that take them, and no unit emits audit records yet.
 *
 * Owned by: K-09 Audit Foundation.
 */

import {
  APPLICATIONS,
  BUSINESS_MODULES,
  KERNEL_COMPONENTS,
} from '../../platform/architecture/manifest.ts';

import {
  AuditError,
  EVIDENCE_CLASSIFICATIONS,
  type AuditEvidence,
  type EvidenceClassification,
  type EvidenceValue,
} from './types.ts';

/**
 * Why the action is audited at all.
 *
 * Both are recorded identically. The distinction exists so a reader can ask "show me every
 * security-sensitive action by this actor" without knowing every action name in advance.
 */
export const ACTION_AUTHORITIES = ['security-sensitive', 'business-authoritative'] as const;
export type ActionAuthority = (typeof ACTION_AUTHORITIES)[number];

export type EvidenceFieldKind = 'string' | 'integer' | 'boolean';

export interface EvidenceField {
  readonly name: string;
  readonly kind: EvidenceFieldKind;
  readonly required: boolean;
  readonly classification: EvidenceClassification;
  readonly description: string;
}

export interface AuditActionDefinition {
  /** Dotted lower-case, e.g. `configuration.version_published`. */
  readonly action: string;
  /** Manifest id of the only unit permitted to record it. */
  readonly owner: string;
  readonly authority: ActionAuthority;
  readonly description: string;
  /** The resource types this action may name. Empty means any type owned by `owner`. */
  readonly resourceTypes: readonly string[];
  readonly evidenceFields: readonly EvidenceField[];
}

/**
 * An action reads as a subject and a deed: `configuration.version_published`.
 *
 * Both halves are snake_case, matching K-08's rule for event types and for the same reason: the
 * subject used to be a single word, which refused actions modules legitimately wanted to record. A
 * hyphen is still refused.
 */
const ACTION_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const FIELD_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * Field names that mean a credential is being recorded.
 *
 * An audit log is the longest-lived store in the system and the one most likely to be exported for
 * review. A credential in it is a credential published for the retention period, and no
 * classification makes that acceptable — `restricted` included. Write `REDACTED` instead: that the
 * field existed is worth recording, its value is not.
 */
export const SECRET_FIELD_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'private_key',
  'access_key',
  'credential',
  'authorization',
  'session_token',
];

/** Value shapes that are a credential whatever the field is called. */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(postgres(?:ql)?|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@/,
];

const manifestIds = (): ReadonlySet<string> =>
  new Set([
    'platform',
    ...KERNEL_COMPONENTS.map((component) => component.id),
    ...BUSINESS_MODULES.map((mod) => mod.id),
    // An application owns the consumers that join two modules of the same layer, because neither
    // module may import the other and the join has to be made from above both.
    ...APPLICATIONS,
  ]);

/** Refuse a definition that could never be validated, or that declares a credential field. */
export function assertRegistrableAction(definition: AuditActionDefinition): void {
  if (!ACTION_NAME.test(definition.action)) {
    throw new AuditError(
      'unknown-action',
      `"${definition.action}" is not a valid action name. Expected dotted lower-case such as ` +
        'configuration.version_published, so an action reads as a subject and a deed',
    );
  }
  if (!manifestIds().has(definition.owner)) {
    throw new AuditError(
      'unknown-action',
      `${definition.action} is owned by "${definition.owner}", which is not a unit in ` +
        'platform/architecture/manifest.ts. An action with no owner has nobody accountable for it',
    );
  }
  if (!ACTION_AUTHORITIES.includes(definition.authority)) {
    throw new AuditError(
      'unknown-action',
      `${definition.action} declares authority "${definition.authority}"; expected one of ` +
        ACTION_AUTHORITIES.join(', '),
    );
  }
  if (definition.description.trim() === '') {
    throw new AuditError(
      'unknown-action',
      `${definition.action} has no description; a reader years from now has only this to go on`,
    );
  }
  for (const type of definition.resourceTypes) {
    if (!RESOURCE_TYPE.test(type)) {
      throw new AuditError(
        'unknown-action',
        `${definition.action} declares resource type "${type}"; expected lower_snake_case`,
      );
    }
  }

  const seen = new Set<string>();
  for (const field of definition.evidenceFields) {
    if (!FIELD_NAME.test(field.name)) {
      throw new AuditError(
        'invalid-evidence',
        `${definition.action} declares evidence field "${field.name}"; expected lower_snake_case`,
      );
    }
    if (seen.has(field.name)) {
      throw new AuditError(
        'invalid-evidence',
        `${definition.action} declares evidence field "${field.name}" twice`,
      );
    }
    seen.add(field.name);

    if (!EVIDENCE_CLASSIFICATIONS.includes(field.classification)) {
      throw new AuditError(
        'unclassified-evidence',
        `${definition.action} field "${field.name}" has classification ` +
          `"${field.classification}"; expected one of ${EVIDENCE_CLASSIFICATIONS.join(', ')}. ` +
          'A field nobody classified is a field nobody can decide about when it is read',
      );
    }

    const fragment = SECRET_FIELD_FRAGMENTS.find((secret) => field.name.includes(secret));
    if (fragment !== undefined) {
      throw new AuditError(
        'secret-bearing-evidence',
        `${definition.action} declares evidence field "${field.name}", which names a credential ` +
          `("${fragment}"). An audit log is the longest-lived store in the system; a credential ` +
          'in one is published for the whole retention period, and no classification changes that',
      );
    }
  }
}

/** Refuse evidence that does not match the action's declaration. Fail closed. */
export function assertValidEvidence(
  definition: AuditActionDefinition,
  evidence: AuditEvidence,
): void {
  const declared = new Map(definition.evidenceFields.map((field) => [field.name, field]));

  for (const [name, value] of Object.entries(evidence)) {
    const field = declared.get(name);
    if (field === undefined) {
      // Refused rather than dropped. Dropping it means a recorder believes it captured something
      // the log does not hold — which surfaces during an investigation, when it is far too late.
      throw new AuditError(
        'unclassified-evidence',
        `${definition.action} does not declare evidence field "${name}", so it has no ` +
          `classification. Declared fields: ${[...declared.keys()].join(', ') || '(none)'}. ` +
          'Add it to the action definition with a classification rather than recording it unclassified',
      );
    }
    assertFieldValue(definition, field, value);
  }

  for (const field of definition.evidenceFields) {
    if (field.required && !(field.name in evidence)) {
      throw new AuditError(
        'invalid-evidence',
        `${definition.action} requires evidence field "${field.name}"`,
      );
    }
  }

  assertNoSecretValues(definition, evidence);
}

function assertFieldValue(
  definition: AuditActionDefinition,
  field: EvidenceField,
  value: EvidenceValue,
): void {
  const describe = (): string => `${definition.action} evidence field "${field.name}"`;

  if (value === null) {
    if (field.required) {
      throw new AuditError('invalid-evidence', `${describe()} is required and may not be null`);
    }
    return;
  }

  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') {
        throw new AuditError(
          'invalid-evidence',
          `${describe()} must be a string, got ${typeof value}`,
        );
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new AuditError(
          'invalid-evidence',
          `${describe()} must be a safe integer, got ${JSON.stringify(value)}`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new AuditError(
          'invalid-evidence',
          `${describe()} must be a boolean, got ${typeof value}`,
        );
      }
      return;
    default: {
      const unreachable: never = field.kind;
      throw new AuditError('invalid-evidence', `unsupported field kind ${String(unreachable)}`);
    }
  }
}

/** A credential-shaped value under an innocent field name is still a recorded credential. */
function assertNoSecretValues(definition: AuditActionDefinition, evidence: AuditEvidence): void {
  for (const [name, value] of Object.entries(evidence)) {
    if (typeof value !== 'string') continue;
    const pattern = SECRET_VALUE_PATTERNS.find((candidate) => candidate.test(value));
    if (pattern !== undefined) {
      throw new AuditError(
        'secret-bearing-evidence',
        `${definition.action} evidence field "${name}" carries a value shaped like a credential ` +
          `(${String(pattern)}). Record the marker REDACTED instead: that the field existed is ` +
          'worth keeping, its value is not',
      );
    }
  }
}

/** The declared actions. */
export class AuditActionRegistry {
  readonly #byAction: Map<string, AuditActionDefinition>;

  constructor(definitions: readonly AuditActionDefinition[]) {
    this.#byAction = new Map();

    for (const definition of definitions) {
      assertRegistrableAction(definition);
      if (this.#byAction.has(definition.action)) {
        throw new AuditError('unknown-action', `${definition.action} is registered twice`);
      }
      this.#byAction.set(definition.action, definition);
    }
  }

  require(action: string): AuditActionDefinition {
    const definition = this.#byAction.get(action);
    if (definition === undefined) {
      throw new AuditError(
        'unknown-action',
        `"${action}" is not a registered audit action. An unregistered action has no declared ` +
          'evidence, so nothing can say whether this record is complete or safe to keep',
      );
    }
    return definition;
  }

  has(action: string): boolean {
    return this.#byAction.has(action);
  }

  actions(): readonly string[] {
    return [...this.#byAction.keys()].sort();
  }

  all(): readonly AuditActionDefinition[] {
    return [...this.#byAction.values()];
  }

  /** The classification of one field, for a reader deciding whether it may be shown. */
  classificationOf(action: string, field: string): EvidenceClassification {
    const definition = this.require(action);
    const declared = definition.evidenceFields.find((entry) => entry.name === field);
    if (declared === undefined) {
      throw new AuditError(
        'unclassified-evidence',
        `${action} does not declare evidence field "${field}"`,
      );
    }
    return declared.classification;
  }
}
