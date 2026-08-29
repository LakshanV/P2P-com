/**
 * K-05 Configuration — outbox event and audit definitions (FND-003d).
 *
 * These definitions describe the facts K-05 publishes to the platform event log and audit log.
 * They are declared separately from the service so a relay can register them without importing K-05
 * internals, and so the payloads stay stable once consumers depend on them.
 *
 * Owned by: K-05 Configuration.
 */

import type { AuditActionDefinition, EvidenceField } from '../audit-foundation/registry.ts';
import type { EventTypeDefinition, PayloadField } from '../event-infrastructure/registry.ts';

export const CONFIGURATION_VERSION_PUBLISHED_EVENT: EventTypeDefinition = {
  type: 'configuration.version_published',
  schemaVersion: 1,
  owner: 'K-05',
  description: 'A configuration version became active and is now resolvable.',
  payloadFields: [
    {
      name: 'version_id',
      kind: 'string',
      required: true,
      description: 'The activated version id.',
    },
    { name: 'config_key', kind: 'string', required: true, description: 'The configuration key.' },
    {
      name: 'scope_level',
      kind: 'string',
      required: true,
      description: 'global, region or tenant.',
    },
    {
      name: 'scope_id',
      kind: 'string',
      required: true,
      description: 'Empty for global, otherwise the scope id.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: true,
      description: 'ISO-8601 instant from which the version applies.',
    },
    {
      name: 'superseded_version_id',
      kind: 'string',
      required: false,
      description: 'The version this replaced, or null.',
    },
  ] satisfies PayloadField[],
};

export const CONFIGURATION_VERSION_PUBLISHED_ACTION: AuditActionDefinition = {
  action: 'configuration.version_published',
  owner: 'K-05',
  authority: 'business-authoritative',
  description: 'A configuration version was activated and is now resolvable.',
  resourceTypes: ['configuration_version'],
  evidenceFields: [
    {
      name: 'version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The activated version id.',
    },
    {
      name: 'config_key',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The configuration key.',
    },
    {
      name: 'scope_level',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The scope level.',
    },
    {
      name: 'scope_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'The scope id.',
    },
    {
      name: 'effective_from',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'When the version takes effect.',
    },
    {
      name: 'superseded_version_id',
      kind: 'string',
      required: false,
      classification: 'internal',
      description: 'The version replaced, if any.',
    },
  ] satisfies EvidenceField[],
};
