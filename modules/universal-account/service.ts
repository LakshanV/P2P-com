/**
 * M-01 Universal Account — the service.
 *
 * Four operations:
 *
 *   `activateCapability`   — create or reactivate a capability, appending a state row and emitting
 *                            an event and audit record.
 *   `deactivateCapability` — deactivate a capability, appending a state row and emitting an event
 *                            and audit record.
 *   `listCapabilities`     — every capability for an account, sealed and ordered.
 *   `getCapabilityHistory` — the append-only transition log for one capability.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-01 Universal Account.
 */

import { InvalidInstantError, parseInstant } from '../../platform/time/instant.ts';

import {
  makeCapabilityActivatedAction,
  makeCapabilityActivatedEvent,
  makeCapabilityDeactivatedAction,
  makeCapabilityDeactivatedEvent,
} from './outbox.ts';
import { FOREIGN_FIELDS, assertUniversalAccountIdentifier } from './registry.ts';
import type {
  UniversalAccountRepository,
  UniversalAccountTransaction,
} from './repository.ts';
import {
  sealAccountCapability,
  sealAccountCapabilities,
  sealCapabilityState,
  sealCapabilityStates,
} from './immutable.ts';
import { validateAccountCapability, validateCapabilityState } from './validate.ts';
import {
  UniversalAccountError,
  type AccountCapability,
  type CapabilityState,
  type CapabilityStatus,
} from './types.ts';

export interface ActivateCapabilityRequest {
  readonly capabilityId: string;
  readonly accountId: string;
  readonly capability: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly activatedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly stateId: string;
  readonly reason: string;
}

export interface ActivateCapabilityResult {
  readonly capability: AccountCapability;
  readonly state: CapabilityState | null;
  readonly replayed: boolean;
}

export interface DeactivateCapabilityRequest {
  readonly capabilityId: string;
  readonly deactivatedAt: string;
  readonly updatedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly stateId: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface DeactivateCapabilityResult {
  readonly capability: AccountCapability;
  readonly state: CapabilityState | null;
  readonly replayed: boolean;
}

const ACTIVATE_CAPABILITY_KEYS: readonly string[] = [
  'capabilityId',
  'accountId',
  'capability',
  'attributes',
  'activatedAt',
  'createdAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'stateId',
  'reason',
];

const DEACTIVATE_CAPABILITY_KEYS: readonly string[] = [
  'capabilityId',
  'deactivatedAt',
  'updatedAt',
  'correlationId',
  'idempotencyKey',
  'stateId',
  'reason',
  'occurredAt',
];

export class UniversalAccountService {
  readonly #repository: UniversalAccountRepository;

  constructor(repository: UniversalAccountRepository) {
    this.#repository = repository;
  }

  /**
   * Activate or reactivate a capability.
   *
   * Validates, checks idempotency by key, and creates or updates the capability. A capability that
   * is already active for the same `(accountId, capability)` is refused. A deactivated or suspended
   * capability with the same id is reactivated. Each successful activation appends a state row and
   * emits both an event and an audit record in the same transaction.
   */
  async activateCapability(
    request: ActivateCapabilityRequest,
  ): Promise<ActivateCapabilityResult> {
    assertNoForeignConcerns(request, ACTIVATE_CAPABILITY_KEYS, 'activateCapability');
    const capability = sealAccountCapability(
      validateAccountCapability(
        {
          capabilityId: request.capabilityId,
          accountId: request.accountId,
          capability: request.capability,
          status: 'active',
          activatedAt: request.activatedAt,
          deactivatedAt: null,
          attributes: request.attributes,
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#activate(capability, request.stateId, request.reason);
    } catch (error) {
      const conflicted =
        error instanceof UniversalAccountError &&
        (error.code === 'duplicate-capability-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findCapabilityByIdempotencyKey(capability.idempotencyKey),
      );
      if (winner === null || !capabilityEquals(winner, capability)) throw error;
      return { capability: sealAccountCapability(winner), state: null, replayed: true };
    }
  }

  async #activate(
    capability: AccountCapability,
    stateId: string,
    reason: string,
  ): Promise<ActivateCapabilityResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findCapabilityByIdempotencyKey(capability.idempotencyKey);
      if (existingKey !== null) {
        if (!capabilityEquals(existingKey, capability)) {
          throw new UniversalAccountError(
            'idempotency-key-reuse',
            `idempotency key "${capability.idempotencyKey}" has already been used for a different capability`,
          );
        }
        return { capability: sealAccountCapability(existingKey), state: null, replayed: true };
      }

      const existingId = await tx.findCapabilityById(capability.capabilityId);
      if (existingId !== null) {
        if (!capabilityEquals(existingId, capability)) {
          throw new UniversalAccountError(
            'duplicate-capability-id',
            `capability ${capability.capabilityId} already exists. A capability is created once and ` +
              'its lifecycle is updated through the service',
          );
        }

        if (existingId.status === 'active') {
          return { capability: sealAccountCapability(existingId), state: null, replayed: true };
        }

        const updated = sealAccountCapability({
          ...existingId,
          status: 'active',
          activatedAt: capability.activatedAt,
          deactivatedAt: null,
          updatedAt: capability.updatedAt,
        });
        const state = sealCapabilityState(
          validateCapabilityState(
            {
              stateId,
              capabilityId: updated.capabilityId,
              accountId: updated.accountId,
              fromStatus: existingId.status,
              toStatus: 'active',
              reason,
              occurredAt: capability.activatedAt,
              correlationId: capability.correlationId,
              idempotencyKey: capability.idempotencyKey,
            },
            'request',
          ),
        );

        await tx.updateCapability(updated);
        await tx.insertState(state);
        await this.#emitActivated(updated, tx);
        return { capability: updated, state, replayed: false };
      }

      const activeByRole = await this.#findActiveByRole(
        tx,
        capability.accountId,
        capability.capability,
      );
      if (activeByRole !== null && activeByRole.capabilityId !== capability.capabilityId) {
        throw new UniversalAccountError(
          'capability-already-active',
          `account ${capability.accountId} already has an active ${capability.capability} capability`,
        );
      }

      const state = sealCapabilityState(
        validateCapabilityState(
          {
            stateId,
            capabilityId: capability.capabilityId,
            accountId: capability.accountId,
            fromStatus: null,
            toStatus: 'active',
            reason,
            occurredAt: capability.activatedAt,
            correlationId: capability.correlationId,
            idempotencyKey: capability.idempotencyKey,
          },
          'request',
        ),
      );

      await tx.insertCapability(capability);
      await tx.insertState(state);
      await this.#emitActivated(capability, tx);
      return { capability, state, replayed: false };
    });
  }

  /**
   * Deactivate a capability.
   *
   * Refuses when the capability id is unknown or the capability is already deactivated. Sets the
   * status to `deactivated`, records the instant, appends a state row, and emits an event and audit
   * record in the same transaction.
   */
  async deactivateCapability(
    request: DeactivateCapabilityRequest,
  ): Promise<DeactivateCapabilityResult> {
    assertNoForeignConcerns(request, DEACTIVATE_CAPABILITY_KEYS, 'deactivateCapability');
    assertUniversalAccountIdentifier(request.capabilityId, 'capabilityId');
    assertUniversalAccountIdentifier(request.stateId, 'stateId');
    assertUniversalAccountIdentifier(request.correlationId, 'correlationId');
    assertUniversalAccountIdentifier(request.idempotencyKey, 'idempotencyKey');
    const deactivatedAt = parseAndCheckInstant(request.deactivatedAt, 'deactivatedAt');
    const updatedAt = parseAndCheckInstant(request.updatedAt, 'updatedAt');
    const occurredAt = parseAndCheckInstant(request.occurredAt, 'occurredAt');

    try {
      return await this.#deactivate(
        request.capabilityId,
        request.stateId,
        request.reason,
        deactivatedAt,
        updatedAt,
        occurredAt,
        request.correlationId,
        request.idempotencyKey,
      );
    } catch (error) {
      const conflicted =
        error instanceof UniversalAccountError &&
        (error.code === 'duplicate-state-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#findDeactivatedState(request.stateId, request.idempotencyKey);
      if (winner === null) throw error;

      const capability = await this.#repository.withTransaction((tx) =>
        tx.findCapabilityById(winner.capabilityId),
      );
      if (capability === null) throw error;

      const expected = buildDeactivateState(
        winner.capabilityId,
        winner.accountId,
        winner.fromStatus ?? 'active',
        request.reason,
        occurredAt,
        request.correlationId,
        request.idempotencyKey,
        winner.stateId,
      );
      if (!stateEquals(winner, expected)) throw error;
      return { capability: sealAccountCapability(capability), state: winner, replayed: true };
    }
  }

  async #deactivate(
    capabilityId: string,
    stateId: string,
    reason: string,
    deactivatedAt: string,
    updatedAt: string,
    occurredAt: string,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<DeactivateCapabilityResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingStateId = await tx.findStateById(stateId);
      if (existingStateId !== null) {
        const expected = buildDeactivateState(
          existingStateId.capabilityId,
          existingStateId.accountId,
          existingStateId.fromStatus ?? 'active',
          reason,
          occurredAt,
          correlationId,
          idempotencyKey,
          existingStateId.stateId,
        );
        if (!stateEquals(existingStateId, expected)) {
          throw new UniversalAccountError(
            'duplicate-state-id',
            `state ${stateId} already exists with different content`,
          );
        }
        const capability = await tx.findCapabilityById(existingStateId.capabilityId);
        if (capability === null) {
          throw new UniversalAccountError(
            'capability-not-found',
            `capability ${existingStateId.capabilityId} does not exist`,
          );
        }
        return { capability: sealAccountCapability(capability), state: existingStateId, replayed: true };
      }

      const existingKey = await tx.findStateByIdempotencyKey(idempotencyKey);
      if (existingKey !== null) {
        const expected = buildDeactivateState(
          existingKey.capabilityId,
          existingKey.accountId,
          existingKey.fromStatus ?? 'active',
          reason,
          occurredAt,
          correlationId,
          idempotencyKey,
          existingKey.stateId,
        );
        if (!stateEquals(existingKey, expected)) {
          throw new UniversalAccountError(
            'idempotency-key-reuse',
            `idempotency key "${idempotencyKey}" has already been used for a different state`,
          );
        }
        const capability = await tx.findCapabilityById(existingKey.capabilityId);
        if (capability === null) {
          throw new UniversalAccountError(
            'capability-not-found',
            `capability ${existingKey.capabilityId} does not exist`,
          );
        }
        return { capability: sealAccountCapability(capability), state: existingKey, replayed: true };
      }

      const existing = await tx.findCapabilityById(capabilityId);
      if (existing === null) {
        throw new UniversalAccountError(
          'capability-not-found',
          `capability ${capabilityId} does not exist`,
        );
      }
      if (existing.status === 'deactivated') {
        throw new UniversalAccountError(
          'capability-not-active',
          `capability ${capabilityId} is already deactivated`,
        );
      }

      const state = sealCapabilityState(
        validateCapabilityState(
          {
            stateId,
            capabilityId: existing.capabilityId,
            accountId: existing.accountId,
            fromStatus: existing.status,
            toStatus: 'deactivated',
            reason,
            occurredAt,
            correlationId,
            idempotencyKey,
          },
          'request',
        ),
      );
      const updated = sealAccountCapability({
        ...existing,
        status: 'deactivated',
        deactivatedAt,
        updatedAt,
      });

      await tx.updateCapability(updated);
      await tx.insertState(state);
      await this.#emitDeactivated(updated, state, tx);
      return { capability: updated, state, replayed: false };
    });
  }

  async #findDeactivatedState(
    stateId: string,
    idempotencyKey: string,
  ): Promise<CapabilityState | null> {
    const byStateId = await this.#repository.withTransaction((tx) => tx.findStateById(stateId));
    if (byStateId !== null) return byStateId;
    return this.#repository.withTransaction((tx) => tx.findStateByIdempotencyKey(idempotencyKey));
  }

  /** Every capability for the account, sealed and ordered by capability ascending. */
  async listCapabilities(accountId: string): Promise<readonly AccountCapability[]> {
    assertUniversalAccountIdentifier(accountId, 'accountId');
    const capabilities = await this.#repository.withTransaction((tx) =>
      tx.findCapabilitiesByAccountId(accountId),
    );
    return sealAccountCapabilities(capabilities);
  }

  /** The append-only transition log for one capability, oldest first. */
  async getCapabilityHistory(capabilityId: string): Promise<readonly CapabilityState[]> {
    assertUniversalAccountIdentifier(capabilityId, 'capabilityId');
    const states = await this.#repository.withTransaction((tx) =>
      tx.findStatesByCapabilityId(capabilityId),
    );
    return sealCapabilityStates(states);
  }

  async #findActiveByRole(
    tx: UniversalAccountTransaction,
    accountId: string,
    capability: string,
  ): Promise<AccountCapability | null> {
    const capabilities = await tx.findCapabilitiesByAccountId(accountId);
    return (
      capabilities.find((c) => c.capability === capability && c.status === 'active') ?? null
    );
  }

  async #emitActivated(
    capability: AccountCapability,
    tx: UniversalAccountTransaction,
  ): Promise<void> {
    const correlationId = capability.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeCapabilityActivatedEvent(capability, correlationId, causationId));
    await tx.insertOutbox(makeCapabilityActivatedAction(capability, correlationId, causationId));
  }

  async #emitDeactivated(
    capability: AccountCapability,
    state: CapabilityState,
    tx: UniversalAccountTransaction,
  ): Promise<void> {
    const correlationId = state.correlationId;
    const causationId: string | null = null;
    await tx.insertOutbox(makeCapabilityDeactivatedEvent(capability, state, correlationId, causationId));
    await tx.insertOutbox(makeCapabilityDeactivatedAction(capability, state, correlationId, causationId));
  }
}

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new UniversalAccountError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new UniversalAccountError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A capability record carries only what M-01 owns`,
      );
    }
    throw new UniversalAccountError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

function parseAndCheckInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new UniversalAccountError(
      'malformed-instant',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  try {
    return parseInstant(value).source;
  } catch (error) {
    if (error instanceof InvalidInstantError) {
      throw new UniversalAccountError('malformed-instant', `${field}: ${error.message}`);
    }
    throw error;
  }
}

function capabilityEquals(a: AccountCapability, b: AccountCapability): boolean {
  return (
    a.capabilityId === b.capabilityId &&
    a.accountId === b.accountId &&
    a.capability === b.capability &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
    a.createdAt === b.createdAt
  );
}

function stateEquals(a: CapabilityState, b: CapabilityState): boolean {
  return (
    a.stateId === b.stateId &&
    a.capabilityId === b.capabilityId &&
    a.accountId === b.accountId &&
    a.fromStatus === b.fromStatus &&
    a.toStatus === b.toStatus &&
    a.reason === b.reason &&
    a.occurredAt === b.occurredAt
  );
}

function buildDeactivateState(
  capabilityId: string,
  accountId: string,
  fromStatus: CapabilityStatus,
  reason: string,
  occurredAt: string,
  correlationId: string,
  idempotencyKey: string,
  stateId: string,
): CapabilityState {
  return {
    stateId,
    capabilityId,
    accountId,
    fromStatus,
    toStatus: 'deactivated',
    reason,
    occurredAt,
    correlationId,
    idempotencyKey,
  };
}
