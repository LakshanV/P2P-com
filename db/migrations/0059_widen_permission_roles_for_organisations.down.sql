-- migration: 0059_widen_permission_roles_for_organisations
-- direction: down
-- owner: kernel_permissions
--
-- Narrows the role vocabulary back to the platform roles.
--
-- **This can fail by design, and that is the correct behaviour.** Once a person has been given a
-- place in a business, the grant that carries their authority names an `ORG_*` role; narrowing the
-- CHECK with such rows on record would either require deleting somebody's authority or rewriting it
-- into a platform role they were never given. Both are decisions about who may act for a business,
-- and a migration must not take either on an operator's behalf.
--
-- An operator who genuinely wants this revokes the organisation grants first, deliberately, and can
-- then see exactly whose authority they removed.

BEGIN;

ALTER TABLE kernel_permissions.permission_grant
  DROP CONSTRAINT IF EXISTS permission_grant_role_known;

ALTER TABLE kernel_permissions.permission_grant
  ADD CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT'));

COMMIT;
