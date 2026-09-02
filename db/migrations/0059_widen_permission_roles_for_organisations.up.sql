-- migration: 0059_widen_permission_roles_for_organisations
-- direction: up
-- owner: kernel_permissions
--
-- K-04 gains the organisation role namespace (D-053, D-054).
--
-- A person acting for a business holds authority **in that business's account**, and the grant that
-- confers it names a role. Until now every role in the vocabulary was a platform role: what somebody
-- is to JAYA. An organisation role is a different thing — what somebody is to one business — and the
-- two needed separate names for a reason that is not tidiness.
--
-- `FINANCE` is a platform finance operator who reaches **other parties'** records, and K-04 rightly
-- demands a declared purpose on every grant of it (v3 5.3). A shop's bookkeeper reaches their own
-- employer's books. Reusing `FINANCE` for both would have made the bookkeeper platform staff and
-- demanded a purpose every time they opened their own company's accounts -- which is either a
-- meaningless ritual or an audit trail full of "system-maintenance" that says nothing.
--
-- So `ORG_*` is its own namespace, and deliberately **not** added to
-- `permission_grant_staff_purpose`: a member of a business is not reaching another party, and a
-- purpose on such a grant would record a control that is not being enforced.
--
-- This is a widening. No existing row can be invalidated by it, and the rollback can fail by design
-- once an organisation membership has produced a grant -- see the down file.

BEGIN;

ALTER TABLE kernel_permissions.permission_grant
  DROP CONSTRAINT IF EXISTS permission_grant_role_known;

ALTER TABLE kernel_permissions.permission_grant
  ADD CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT',
                    'ORG_OWNER', 'ORG_ADMIN', 'ORG_MANAGER', 'ORG_SALES', 'ORG_PROCUREMENT',
                    'ORG_INVENTORY', 'ORG_FINANCE', 'ORG_FULFILMENT', 'ORG_DRIVER_MANAGER',
                    'ORG_READ_ONLY'));

COMMENT ON CONSTRAINT permission_grant_role_known ON kernel_permissions.permission_grant IS
  'Two namespaces. The unprefixed roles are what somebody is to JAYA; ORG_* is what somebody is to one business, held in that business own account. Only the first set can be staff, and only staff grants carry a purpose.';

COMMIT;
