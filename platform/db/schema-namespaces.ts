/**
 * The schema-namespace ownership convention (FND-002a).
 *
 * MODULE_MAP.md §2 requires "module-owned schema namespaces, no cross-module joins" so that any
 * module can later be extracted to a service without rewriting its business logic. That is a
 * statement about PostgreSQL schemas, and it is only real if the mapping from owner to schema
 * name is derivable rather than remembered.
 *
 * So the mapping is computed from platform/architecture/manifest.ts — the same register the
 * boundary checks use — instead of being maintained as a second list. Adding a kernel component
 * or a module to the manifest creates its namespace here automatically; misspelling a schema in a
 * migration fails the migration validator, because the name resolves to no owner.
 *
 * Owned by: FND-002a (data foundation). Describes namespaces; contains no business logic and
 * opens no database connection.
 */

import { BUSINESS_MODULES, KERNEL_COMPONENTS } from '../architecture/manifest.ts';

/** What kind of unit owns a schema. */
export type SchemaOwnerKind = 'platform' | 'kernel' | 'module';

export interface SchemaOwner {
  /** PostgreSQL schema name, e.g. `kernel_identity`. */
  readonly schema: string;
  readonly kind: SchemaOwnerKind;
  /** Manifest id (`K-01`, `M-11`) or `platform` for the substrate. */
  readonly id: string;
  /** Human name of the owning unit. */
  readonly name: string;
}

/**
 * The substrate's own schema. It holds the migration ledger and anything else that belongs to no
 * business owner. It is deliberately NOT `public`.
 */
export const PLATFORM_SCHEMA = 'platform';

/** Prefix separating kernel namespaces from module namespaces in a flat schema list. */
export const KERNEL_SCHEMA_PREFIX = 'kernel_';
export const MODULE_SCHEMA_PREFIX = 'module_';

/**
 * PostgreSQL's default schema. Nothing owned by a kernel component or a business module may live
 * here: `public` is on the default `search_path`, so a table placed in it is reachable by every
 * unit and belongs to none, which is exactly the cross-module coupling the architecture forbids.
 */
export const FORBIDDEN_SCHEMA = 'public';

/** A directory slug becomes a schema-name fragment: kebab-case to snake_case. */
const toSchemaFragment = (dir: string): string => dir.replace(/-/g, '_');

/** Every schema this repository may create, derived from the architecture manifest. */
export function schemaOwners(): readonly SchemaOwner[] {
  return [
    { schema: PLATFORM_SCHEMA, kind: 'platform', id: 'platform', name: 'Platform substrate' },
    ...KERNEL_COMPONENTS.map((component): SchemaOwner => ({
      schema: `${KERNEL_SCHEMA_PREFIX}${toSchemaFragment(component.dir)}`,
      kind: 'kernel',
      id: component.id,
      name: component.name,
    })),
    ...BUSINESS_MODULES.map((mod): SchemaOwner => ({
      schema: `${MODULE_SCHEMA_PREFIX}${toSchemaFragment(mod.dir)}`,
      kind: 'module',
      id: mod.id,
      name: mod.name,
    })),
  ];
}

/** Index of schema name to owner, for O(1) resolution during validation. */
export function schemaOwnerIndex(): ReadonlyMap<string, SchemaOwner> {
  return new Map(schemaOwners().map((owner) => [owner.schema, owner]));
}

/** Resolve a schema name to its owning unit, or null when no unit owns it. */
export function ownerOfSchema(schema: string): SchemaOwner | null {
  return schemaOwnerIndex().get(schema.toLowerCase()) ?? null;
}

/** Every legal schema name, sorted. Used by the tests and by the validator's error messages. */
export function knownSchemas(): readonly string[] {
  return schemaOwners()
    .map((owner) => owner.schema)
    .sort();
}
