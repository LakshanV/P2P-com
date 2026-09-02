/**
 * Every event type and audit action this deployment publishes.
 *
 * A module declares its own facts; K-08 and K-09 refuse anything they have not been told about, and
 * rightly — an event log that accepts unregistered types is a log nobody can read. Somebody has to
 * put the two halves together, and that somebody is the **application**, because which modules are
 * deployed is a deployment decision. A different assembly of the same kernel would publish a
 * different list.
 *
 * **This file is the reason a relay can run at all.** Without it every outbox row from every module
 * would be dispatched to a K-08 that has never heard of its type, and the relay would dead-letter
 * the platform's entire event traffic while reporting a healthy zero dispatched.
 *
 * `tests/platform-events.test.ts` reads the modules from disk and asserts this list is complete, so
 * a module that adds an event and forgets to register it fails the build rather than failing in
 * production at the moment somebody finally runs the relay.
 *
 * Owned by: apps/api.
 */

import type { AuditActionDefinition } from '../../kernel/audit-foundation/index.ts';
import type { EventTypeDefinition } from '../../kernel/event-infrastructure/index.ts';
import {
  EVIDENCE_SUBMITTED_ACTION,
  EVIDENCE_SUBMITTED_EVENT,
  LEVEL_CHANGED_ACTION,
  LEVEL_CHANGED_EVENT,
  SELLER_VERIFIED_ACTION,
  SELLER_VERIFIED_EVENT,
  VERIFICATION_REJECTED_ACTION,
  VERIFICATION_REJECTED_EVENT,
  VERIFICATION_STARTED_ACTION,
  VERIFICATION_STARTED_EVENT,
} from '../../modules/capability-verification/index.ts';
import {
  NEED_CAPTURED_ACTION,
  NEED_CAPTURED_EVENT,
  NEED_CLOSED_EVENT,
  NEED_INTERPRETED_ACTION,
  NEED_INTERPRETED_EVENT,
  NEED_READY_EVENT,
  NEED_STATUS_ACTION,
} from '../../modules/commerce-request/index.ts';
import {
  LEG_POSTED_ACTION,
  LEG_POSTED_EVENT,
  LEG_REVERSED_ACTION,
  LEG_REVERSED_EVENT,
  PLAN_ALLOCATED_ACTION,
  PLAN_ALLOCATED_EVENT,
  PLAN_CANCELLED_ACTION,
  PLAN_CANCELLED_EVENT,
  PLAN_COMMITTED_ACTION,
  PLAN_COMMITTED_EVENT,
  PLAN_SETTLED_ACTION,
  PLAN_SETTLED_EVENT,
  WALLET_OPENED_ACTION,
  WALLET_OPENED_EVENT,
  WALLET_STATUS_CHANGED_ACTION,
  WALLET_STATUS_CHANGED_EVENT,
} from '../../modules/financial-ledger/index.ts';
import {
  ESCALATE_TO_RFQ_EVENT,
  MATCH_FOUND_EVENT,
  MATCH_RUN_ACTION,
} from '../../modules/matching/index.ts';
import {
  ORDER_CANCELLED_ACTION,
  ORDER_CANCELLED_EVENT,
  ORDER_COMPLETED_ACTION,
  ORDER_COMPLETED_EVENT,
  ORDER_CONFIRMED_ACTION,
  ORDER_CONFIRMED_EVENT,
  ORDER_CREATED_ACTION,
  ORDER_CREATED_EVENT,
  ORDER_FULFILLING_ACTION,
  ORDER_FULFILLING_EVENT,
  ORDER_PLACED_ACTION,
  ORDER_PLACED_EVENT,
  ORDER_SPLIT_ACTION,
  ORDER_SPLIT_EVENT,
} from '../../modules/orders/index.ts';
import {
  PAYMENT_AUTHORISED_ACTION,
  PAYMENT_AUTHORISED_EVENT,
  PAYMENT_CANCELLED_ACTION,
  PAYMENT_CANCELLED_EVENT,
  PAYMENT_CAPTURED_ACTION,
  PAYMENT_CAPTURED_EVENT,
  PAYMENT_FAILED_ACTION,
  PAYMENT_FAILED_EVENT,
  PAYMENT_REFUNDED_ACTION,
  PAYMENT_REFUNDED_EVENT,
  PAYMENT_REQUESTED_ACTION,
  PAYMENT_REQUESTED_EVENT,
} from '../../modules/payments/index.ts';
import {
  QUOTE_ACCEPTED_EVENT,
  QUOTE_ACTION,
  QUOTE_EXPIRED_EVENT,
  QUOTE_REJECTED_EVENT,
  QUOTE_SUBMITTED_EVENT,
  QUOTE_WITHDRAWN_EVENT,
} from '../../modules/quotes/index.ts';
import {
  INVITATION_ACTION,
  RFQ_ACTION,
  RFQ_AWARDED_EVENT,
  RFQ_CANCELLED_EVENT,
  RFQ_CLOSED_EVENT,
  RFQ_CREATED_EVENT,
  SUPPLIER_INVITED_EVENT,
} from '../../modules/rfq/index.ts';
import {
  CAPABILITY_ACTIVATED_ACTION,
  CAPABILITY_ACTIVATED_EVENT,
  CAPABILITY_DEACTIVATED_ACTION,
  CAPABILITY_DEACTIVATED_EVENT,
} from '../../modules/universal-account/index.ts';
import {
  INVENTORY_ADJUSTED_ACTION,
  INVENTORY_ADJUSTED_EVENT,
  INVENTORY_COMMITTED_ACTION,
  INVENTORY_COMMITTED_EVENT,
  INVENTORY_RECEIVED_ACTION,
  INVENTORY_RECEIVED_EVENT,
  INVENTORY_RELEASED_ACTION,
  INVENTORY_RELEASED_EVENT,
  INVENTORY_RESERVED_ACTION,
  INVENTORY_RESERVED_EVENT,
  LISTING_CREATED_ACTION,
  LISTING_CREATED_EVENT,
  LISTING_PUBLISHED_ACTION,
  LISTING_PUBLISHED_EVENT,
  LISTING_SUSPENDED_ACTION,
  LISTING_SUSPENDED_EVENT,
  LISTING_WITHDRAWN_ACTION,
  LISTING_WITHDRAWN_EVENT,
} from '../../modules/universal-listing/index.ts';

/** Every event type any deployed module publishes. */
export const PLATFORM_EVENT_TYPES: readonly EventTypeDefinition[] = Object.freeze([
  // M-01 Universal Account
  CAPABILITY_ACTIVATED_EVENT,
  CAPABILITY_DEACTIVATED_EVENT,

  // M-02 Capability & Verification
  VERIFICATION_STARTED_EVENT,
  EVIDENCE_SUBMITTED_EVENT,
  LEVEL_CHANGED_EVENT,
  VERIFICATION_REJECTED_EVENT,
  SELLER_VERIFIED_EVENT,

  // M-03 Commerce Request
  NEED_CAPTURED_EVENT,
  NEED_INTERPRETED_EVENT,
  NEED_READY_EVENT,
  NEED_CLOSED_EVENT,

  // M-04 Universal Listing
  LISTING_CREATED_EVENT,
  LISTING_PUBLISHED_EVENT,
  LISTING_SUSPENDED_EVENT,
  LISTING_WITHDRAWN_EVENT,
  INVENTORY_RECEIVED_EVENT,
  INVENTORY_ADJUSTED_EVENT,
  INVENTORY_RESERVED_EVENT,
  INVENTORY_RELEASED_EVENT,
  INVENTORY_COMMITTED_EVENT,

  // M-07 Matching
  MATCH_FOUND_EVENT,
  ESCALATE_TO_RFQ_EVENT,

  // M-09 RFQ
  RFQ_CREATED_EVENT,
  RFQ_CLOSED_EVENT,
  RFQ_AWARDED_EVENT,
  RFQ_CANCELLED_EVENT,
  SUPPLIER_INVITED_EVENT,

  // M-10 Quotes
  QUOTE_SUBMITTED_EVENT,
  QUOTE_WITHDRAWN_EVENT,
  QUOTE_EXPIRED_EVENT,
  QUOTE_ACCEPTED_EVENT,
  QUOTE_REJECTED_EVENT,

  // M-11 Orders
  ORDER_CREATED_EVENT,
  ORDER_PLACED_EVENT,
  ORDER_CONFIRMED_EVENT,
  ORDER_FULFILLING_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_CANCELLED_EVENT,
  ORDER_SPLIT_EVENT,

  // M-12 Payments
  PAYMENT_REQUESTED_EVENT,
  PAYMENT_AUTHORISED_EVENT,
  PAYMENT_CAPTURED_EVENT,
  PAYMENT_FAILED_EVENT,
  PAYMENT_CANCELLED_EVENT,
  PAYMENT_REFUNDED_EVENT,

  // M-13 Financial Ledger
  WALLET_OPENED_EVENT,
  WALLET_STATUS_CHANGED_EVENT,
  PLAN_ALLOCATED_EVENT,
  PLAN_COMMITTED_EVENT,
  PLAN_SETTLED_EVENT,
  PLAN_CANCELLED_EVENT,
  LEG_POSTED_EVENT,
  LEG_REVERSED_EVENT,
]);

/** Every audit action any deployed module records. */
export const PLATFORM_AUDIT_ACTIONS: readonly AuditActionDefinition[] = Object.freeze([
  CAPABILITY_ACTIVATED_ACTION,
  CAPABILITY_DEACTIVATED_ACTION,

  VERIFICATION_STARTED_ACTION,
  EVIDENCE_SUBMITTED_ACTION,
  LEVEL_CHANGED_ACTION,
  VERIFICATION_REJECTED_ACTION,
  SELLER_VERIFIED_ACTION,

  NEED_CAPTURED_ACTION,
  NEED_INTERPRETED_ACTION,
  NEED_STATUS_ACTION,

  LISTING_CREATED_ACTION,
  LISTING_PUBLISHED_ACTION,
  LISTING_SUSPENDED_ACTION,
  LISTING_WITHDRAWN_ACTION,
  INVENTORY_RECEIVED_ACTION,
  INVENTORY_ADJUSTED_ACTION,
  INVENTORY_RESERVED_ACTION,
  INVENTORY_RELEASED_ACTION,
  INVENTORY_COMMITTED_ACTION,

  MATCH_RUN_ACTION,

  RFQ_ACTION,
  INVITATION_ACTION,

  QUOTE_ACTION,

  ORDER_CREATED_ACTION,
  ORDER_PLACED_ACTION,
  ORDER_CONFIRMED_ACTION,
  ORDER_FULFILLING_ACTION,
  ORDER_COMPLETED_ACTION,
  ORDER_CANCELLED_ACTION,
  ORDER_SPLIT_ACTION,

  PAYMENT_REQUESTED_ACTION,
  PAYMENT_AUTHORISED_ACTION,
  PAYMENT_CAPTURED_ACTION,
  PAYMENT_FAILED_ACTION,
  PAYMENT_CANCELLED_ACTION,
  PAYMENT_REFUNDED_ACTION,

  WALLET_OPENED_ACTION,
  WALLET_STATUS_CHANGED_ACTION,
  PLAN_ALLOCATED_ACTION,
  PLAN_COMMITTED_ACTION,
  PLAN_SETTLED_ACTION,
  PLAN_CANCELLED_ACTION,
  LEG_POSTED_ACTION,
  LEG_REVERSED_ACTION,
]);

/**
 * Every schema that owns an outbox the relay must poll.
 *
 * Named rather than discovered, for the same reason the two lists above are: which modules are
 * deployed is a decision, and a relay that discovered its own sources would quietly start
 * publishing whatever somebody added next.
 */
export const PLATFORM_OUTBOX_SCHEMAS: readonly string[] = Object.freeze([
  'module_universal_account',
  'module_capability_verification',
  'module_commerce_request',
  'module_universal_listing',
  'module_matching',
  'module_rfq',
  'module_quotes',
  'module_orders',
  'module_payments',
  'module_financial_ledger',
]);
