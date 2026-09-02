/**
 * How a new person gets authority, and why that is a port rather than a call.
 *
 * K-04 has **no bootstrap path for a grant**, deliberately: every grant is made by an administrator
 * K-04 can name, presenting their own session, and `main.ts` says in so many words that publishing
 * the first policy is an operator act performed out of band rather than something an HTTP process
 * does to itself on startup. That rule is right, and it is also the reason self-service
 * registration cannot simply call `permissions.grant`: the API is not a person, and it holds no
 * session of its own.
 *
 * So the authority to hand somebody the CUSTOMER role is **injected**. A deployment that has an
 * administrator willing to stand behind self-service registration configures one; a deployment that
 * has not is refused, loudly, at the moment somebody tries to register — rather than quietly
 * creating accounts that hold nothing and discovering later that nobody can do anything.
 *
 * Two implementations ship:
 *
 *   * `permissionGrantor` — the real one. Every grant is made through K-04's own surface by a named
 *     administrator, with an administration purpose, exactly as an operator making it by hand would.
 *     Nothing here writes a grant row directly, and nothing here can grant a capability the
 *     published policy does not already give the role.
 *   * `unavailableGrantor` — the honest absence. Registration answers 503 and says what is missing.
 *
 * **What this file cannot do, by construction:** grant a role that is not in the V1 policy, grant a
 * capability the policy does not give that role, or grant anything in an account other than the new
 * person's own. The capabilities come from `JAYA_V1_ROLES`, which is data, and K-04 refuses a grant
 * whose action or resource type the active policy version does not carry.
 *
 * Owned by: apps/api.
 */

import type { PermissionService } from '../../kernel/permissions/index.ts';

import { ApiError } from './errors.ts';
import { JAYA_V1_ROLES } from './policy.ts';

export interface GrantRoleRequest {
  readonly subjectId: string;
  /** The new person's own account. Authority never spans accounts, and this is not an exception. */
  readonly accountId: string;
  readonly role: string;
  /**
   * Derived from the registration's idempotency key, so a retried registration converges on the
   * grants the first attempt made rather than making a second set.
   */
  readonly idempotencyKey: string;
  /** Mint the grant identifiers. Deterministic, for the same reason. */
  readonly derivedId: (prefix: string, discriminator: string) => string;
}

/**
 * Who can hand somebody a role.
 *
 * A port with one method, because that is the whole of what registration needs from K-04 and a
 * route holding the administrator's session would be a route that could grant anything.
 */
export interface RoleGrantor {
  grantRole(request: GrantRoleRequest): Promise<void>;
}

export interface PermissionGrantorOptions {
  readonly permissions: PermissionService;
  /**
   * The administrator's session secret.
   *
   * Configured by the deployment. This is the credential that stands behind every self-service
   * registration, and a deployment that will not name one gets `unavailableGrantor`.
   */
  readonly administratorToken: string;
}

/**
 * Roles a person may take on for themselves.
 *
 * `CUSTOMER` and `SUPPLIER` are here because taking them on grants **nothing that matters yet**:
 * being a supplier in this platform means holding a directory entry, and a directory entry starts
 * `pending` and is invisible to sourcing until an operator admits it. The real gate is admission,
 * which is `admit`, which no trading role holds — so a self-assumed SUPPLIER role is a person who
 * may fill in a form, and nothing more.
 *
 * `DRIVER`, `FINANCE`, `OPERATIONS` and everything else are **not** here. A driver takes custody of
 * somebody else's goods and a staff role reaches another party's records; neither is a thing to
 * assume by asking. They are granted by an operator, out of band, exactly as they are today.
 */
export const SELF_ASSUMABLE_ROLES: readonly string[] = Object.freeze(['CUSTOMER', 'SUPPLIER']);

export function permissionGrantor(options: PermissionGrantorOptions): RoleGrantor {
  return {
    async grantRole(request: GrantRoleRequest): Promise<void> {
      const entry = JAYA_V1_ROLES.find((candidate) => candidate.role === request.role);
      if (entry === undefined) {
        throw new ApiError(
          400,
          'unknown-role',
          `"${request.role}" is not a role this platform publishes.`,
        );
      }

      for (const capability of entry.capabilities) {
        const discriminator = `${request.role}:${capability.action}:${capability.resourceType}`;
        await options.permissions.grant({
          grantId: request.derivedId('grant', discriminator),
          subjectId: request.subjectId,
          // The new person's own account, always. K-04 checks this again against the subject.
          accountId: request.accountId,
          role: request.role,
          effect: 'allow',
          action: capability.action,
          resourceType: capability.resourceType,
          presentedToken: options.administratorToken,
          administrationPurpose: 'system-maintenance',
          idempotencyKey: request.derivedId('idem', discriminator),
        });
      }
    },
  };
}

/**
 * No administrator stands behind registration in this deployment.
 *
 * Fails at the moment somebody tries, with the reason. The alternative — creating the subject and
 * the account and then silently granting nothing — would produce a person who can sign in and do
 * absolutely nothing, and who has no way to find out why.
 */
export function unavailableGrantor(reason: string): RoleGrantor {
  return {
    grantRole(): Promise<void> {
      return Promise.reject(
        new ApiError(
          503,
          'registration-unavailable',
          `Self-service registration is not configured in this deployment. ${reason}`,
        ),
      );
    },
  };
}
