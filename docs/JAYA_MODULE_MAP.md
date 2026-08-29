# JAYA — Module Map

**Version:** 1.0  
**Status:** BASELINE  
**Last updated:** 2026-08-24  
**Governing document:** `docs/JAYA_MASTER_ARCHITECTURE.md`

---

## 1. Purpose

This document is the canonical inventory of every JAYA module. It maps:

- the user's 83-module master brief (Part I);
- the existing 62-unit module map (`docs/MODULE_MAP.md`);
- layer assignment;
- ownership rules;
- dependencies;
- key events.

**Rule:** A module may depend only on the platform substrate, the commerce kernel, and modules in strictly lower layers. Upward or lateral communication happens only by domain event through the event bus.

---

## 2. Legend

| Field | Meaning |
|---|---|
| **ID** | Brief number or existing K-/M-ID |
| **Name** | Canonical module name |
| **Layer** | L0 kernel / L1 account / L2 primitives / L3 discovery / L4 negotiation / L5 financial core / L6 settlement/risk / L7 fulfilment / L8 verticals & cockpits |
| **Owner** | Single module that may change this behaviour |
| **Owned Data** | Tables/collections this module writes exclusively |
| **Public API** | Sanctioned entry points for other modules |
| **Emits** | Domain events published to the event bus |
| **Consumes** | Domain events this module subscribes to |
| **Depends On** | Lower-layer modules and kernel components |
| **Status** | Current implementation state |

---

## 3. Commerce Kernel (L0)

These components are shared by every business module. No kernel component depends on a business module.

### K-01 — Identity

| Field | Value |
|---|---|
| Brief # | 01 |
| Purpose | Person/organisation identity records and identifiers |
| Owner | Identity |
| Owned Data | `identity.identity_subject`, `identity.identity_document` |
| Public API | `createSubject(subject)`, `findSubject(id)`, `findByExternalId(...)` |
| Emits | `identity.created`, `identity.linked` |
| Consumes | — |
| Depends On | substrate |
| Status | Foundation implemented |

### K-02 — Authentication

| Field | Value |
|---|---|
| Brief # | 01 (authn) |
| Purpose | Credentials, sessions, MFA, tokens |
| Owner | Authentication |
| Owned Data | `authentication.binding`, `authentication.evidence`, `authentication.session`, `authentication.mfa_factor` |
| Public API | `bindIdentity(...)`, `authenticate(...)`, `createSession(...)`, `rotateSession(...)`, `revokeSession(...)`, `validateSession(...)` |
| Emits | `authentication.bound`, `authentication.session_created`, `authentication.session_revoked` |
| Consumes | `identity.created` |
| Depends On | K-01 |
| Status | Foundation implemented; no real verifier |

### K-03 — Accounts

| Field | Value |
|---|---|
| Brief # | 02 / 04 (universal account) |
| Purpose | The one universal JAYA Account and its profile core |
| Owner | Accounts |
| Owned Data | `accounts.universal_account`, `accounts.account_profile` |
| Public API | `openAccount(subjectId)`, `findAccount(id)`, `findBySubject(subjectId)` |
| Emits | `account.opened` |
| Consumes | `identity.created` |
| Depends On | K-01 |
| Status | Foundation implemented |

### K-04 — Permissions

| Field | Value |
|---|---|
| Brief # | 03 |
| Purpose | RBAC/ABAC evaluation, role and grant storage |
| Owner | Permissions |
| Owned Data | `permissions.policy_version`, `permissions.grant`, `permissions.revocation`, `permissions.decision` |
| Public API | `publishPolicy(...)`, `grant(...)`, `revoke(...)`, `authorize(...)` |
| Emits | `permissions.policy_published`, `permissions.granted`, `permissions.revoked` |
| Consumes | `account.opened`, `identity.created` |
| Depends On | K-01, K-03 |
| Status | Foundation implemented; no read API; no callers |

### K-05 — Configuration

| Field | Value |
|---|---|
| Brief # | 83 (feature flags / config) |
| Purpose | Environment and platform configuration resolution |
| Owner | Configuration |
| Owned Data | `kernel_configuration.config_version` |
| Public API | `publish(...)`, `resolve(key, scope)`, `resolveForDecision(...)` |
| Emits | `configuration.published`, `configuration.activated` |
| Consumes | — |
| Depends On | substrate |
| Status | Foundation implemented |

### K-06 — Policy Engine

| Field | Value |
|---|---|
| Brief # | 83 (policy studio) |
| Purpose | Versioned business policy storage and evaluation |
| Owner | Policy Engine |
| Owned Data | `kernel_policy_engine.draft`, `kernel_policy_engine.version`, `kernel_policy_engine.activation`, `kernel_policy_engine.retirement` |
| Public API | `draft(...)`, `publish(...)`, `activate(...)`, `retire(...)`, `evaluate(...)` |
| Emits | `policy.published`, `policy.activated`, `policy.retired` |
| Consumes | — |
| Depends On | K-05 |
| Status | Foundation implemented; no financial consumer |

### K-07 — Feature Flags

| Field | Value |
|---|---|
| Brief # | 83 |
| Purpose | Flag definitions, targeting, rollout stages, kill switches |
| Owner | Feature Flags |
| Owned Data | `kernel_feature_flags.version`, `kernel_feature_flags.activation`, `kernel_feature_flags.lifecycle` |
| Public API | `publish(...)`, `activate(...)`, `kill(...)`, `retire(...)`, `evaluate(...)` |
| Emits | `feature_flag.published`, `feature_flag.activated`, `feature_flag.killed` |
| Consumes | — |
| Depends On | K-05 |
| Status | Foundation implemented |

### K-08 — Event Infrastructure

| Field | Value |
|---|---|
| Brief # | Domain Event Bus |
| Purpose | Durable publish/subscribe, idempotency, retries, dead-letter, replay |
| Owner | Event Infrastructure |
| Owned Data | `kernel_event_infrastructure.event`, `kernel_event_infrastructure.event_delivery`, `kernel_event_infrastructure.event_receipt` |
| Public API | `publish(...)`, `claimDeliveries(...)`, `acknowledge(...)`, `reschedule(...)`, `deadLetter(...)`, `replay(...)` |
| Emits | `event.delivered`, `event.dead_lettered` |
| Consumes | — |
| Depends On | substrate |
| Status | Foundation implemented; no producers wired |

### K-09 — Audit Foundation

| Field | Value |
|---|---|
| Brief # | 79 |
| Purpose | Append-only audit trail |
| Owner | Audit Foundation |
| Owned Data | `kernel_audit_foundation.audit_record` |
| Public API | `record(...)`, `query(...)`, `queryAll(...)` |
| Emits | — |
| Consumes | — |
| Depends On | K-01, K-04 |
| Status | Foundation implemented; no producers wired |

### K-10 — Ledger Foundation

| Field | Value |
|---|---|
| Brief # | 47 / 49 |
| Purpose | Double-entry primitives, accounts, entries, immutability |
| Owner | Ledger Foundation |
| Owned Data | `kernel_ledger.ledger_account`, `kernel_ledger.ledger_entry`, `kernel_ledger.ledger_txn` |
| Public API | `createAccount(...)`, `postEntry(...)`, `postTransaction(...)` |
| Emits | `ledger.entry_posted` |
| Consumes | — |
| Depends On | substrate |
| Status | Foundation implemented |

### K-11 — Commerce Unit Registry

| Field | Value |
|---|---|
| Brief # | 12 (catalogue primitives) / 48 (asset types) |
| Purpose | CommerceUnit abstraction, unit-of-measure registry, category adapters |
| Owner | Commerce Unit Registry |
| Owned Data | `kernel_commerce_unit_registry.type_version`, `kernel_commerce_unit_registry.unit_of_measure`, `kernel_commerce_unit_registry.category_adapter` |
| Public API | `publish(...)`, `activate(...)`, `retire(...)`, `resolve(...)` |
| Emits | `commerce_unit.published`, `commerce_unit.activated` |
| Consumes | — |
| Depends On | K-05 |
| Status | Foundation implemented |

### K-12 — Conversation Foundation

| Field | Value |
|---|---|
| Brief # | 07 / 08 |
| Purpose | Conversation, participant, message, attachment primitives |
| Owner | Conversation Foundation |
| Owned Data | `kernel_conversation_foundation.conversation`, `kernel_conversation_foundation.participant`, `kernel_conversation_foundation.message` |
| Public API | `createConversation(...)`, `addParticipant(...)`, `sendMessage(...)`, `getMessages(...)` |
| Emits | `conversation.created`, `conversation.message_sent` |
| Consumes | — |
| Depends On | K-01, K-03 |
| Status | Foundation implemented |

### K-13 — AI Gateway

| Field | Value |
|---|---|
| Brief # | 71 |
| Purpose | Single boundary to model providers: task registry, model bindings, routing, provider adapters, cost capture, decision recording |
| Owner | AI Gateway |
| Owned Data | `kernel_ai_gateway.task_definition`, `kernel_ai_gateway.model_binding`, `kernel_ai_gateway.ai_run`, `kernel_ai_gateway.ai_decision`, `kernel_ai_gateway.outbox` |
| Public API | `registerTask(...)`, `registerModel(...)`, `executeTask(...)`, `recordDecision(...)` |
| Emits | `ai.task_executed`, `ai.decision_recorded` |
| Consumes | — |
| Depends On | K-05, K-06, K-09 |
| Status | Foundation implemented; no real provider adapters wired |

### K-14 — Notifications

| Field | Value |
|---|---|
| Brief # | 67 |
| Purpose | Channel-neutral delivery of templated notifications |
| Owner | Notifications |
| Owned Data | `kernel_notifications.channel`, `kernel_notifications.notification`, `kernel_notifications.delivery_attempt`, `kernel_notifications.outbox` |
| Public API | `createChannel(...)`, `send(...)`, `schedule(...)`, `getStatus(id)`, `recordDeliveryAttempt(...)` |
| Emits | `notification.sent`, `notification.failed` |
| Consumes | many (event-driven) |
| Depends On | K-03, K-08, K-09 |
| Status | Foundation implemented; in-app channel only, live provider adapters not wired |

### K-15 — Search Foundation

| Field | Value |
|---|---|
| Brief # | 13 |
| Purpose | Index abstraction, query primitives, ranking hooks |
| Owner | Search Foundation |
| Owned Data | `kernel_search_foundation.document`, `kernel_search_foundation.query_log`, `kernel_search_foundation.outbox` |
| Public API | `index(...)`, `query(...)`, `remove(...)` |
| Emits | `search.indexed`, `search.removed`, `search.performed` |
| Consumes | — |
| Depends On | substrate, K-08 Event Infrastructure, K-09 Audit Foundation |
| Status | Foundation implemented |

---

## 4. Business Modules

### L1 — Account & Capability

#### M-01 — Universal Account

| Field | Value |
|---|---|
| Brief # | 05 (cockpit identity) |
| Purpose | Account capabilities: buyer, seller, host, provider, introducer, driver, business purchaser |
| Owner | Universal Account |
| Owned Data | `module_account.account_capability`, `module_account.capability_state` |
| Public API | `activateCapability(...)`, `deactivateCapability(...)`, `listCapabilities(...)` |
| Emits | `capability.activated`, `capability.deactivated` |
| Consumes | `account.opened`, `identity.created` |
| Depends On | K-01, K-03, K-04 |
| Status | **NOT STARTED** |

#### M-02 — Capability & Verification

| Field | Value |
|---|---|
| Brief # | 28 (supplier network), 29 (member network) |
| Purpose | Progressive verification levels, evidence, tax/payout identifiers |
| Owner | Capability & Verification |
| Owned Data | `module_verification.verification_case`, `module_verification.evidence`, `module_verification.level` |
| Public API | `startVerification(...)`, `submitEvidence(...)`, `evaluateLevel(...)` |
| Emits | `verification.level_changed`, `seller.verified` |
| Consumes | `account.opened` |
| Depends On | K-01, K-03, K-04 |
| Status | **NOT STARTED** |

### L2 — Commerce Primitives

#### M-03 — Need / Request Engine

| Field | Value |
|---|---|
| Brief # | 09 |
| Purpose | The Need object: multimodal capture, structured interpretation, lifecycle |
| Owner | Need Engine |
| Owned Data | `module_need.request`, `module_need.request_item`, `module_need.request_media`, `module_need.request_interpretation` |
| Public API | `createNeed(input)`, `interpret(needId)`, `updateNeed(...)`, `getNeed(...)` |
| Emits | `NeedCreated`, `NeedInterpreted`, `NeedReady`, `NeedCancelled` |
| Consumes | `ai.task_executed` |
| Depends On | K-01, K-03, K-12, K-13 |
| Status | **NOT STARTED** |

#### M-04 — Universal Listing / Inventory Interface

| Field | Value |
|---|---|
| Brief # | 15 (supply offer), 22–24 (inventory) |
| Purpose | Listing lifecycle over every CommerceUnit type; inventory interface |
| Owner | Universal Listing |
| Owned Data | `module_listing.listing`, `module_listing.listing_version`, `module_listing.listing_media`, `module_listing.listing_declaration`, `module_listing.inventory_snapshot` |
| Public API | `publishListing(...)`, `getAvailability(...)`, `reserve(...)`, `release(...)`, `commit(...)`, `receive(...)`, `adjust(...)` |
| Emits | `listing.created`, `listing.published`, `InventoryReserved`, `InventoryReleased`, `InventoryCommitted` |
| Consumes | `commerce_unit.activated` |
| Depends On | K-11, M-02 |
| Status | **NOT STARTED** |

#### M-05 — Product Catalogue

| Field | Value |
|---|---|
| Brief # | 12 |
| Purpose | Canonical products, variants, attributes, identifiers |
| Owner | Product Catalogue |
| Owned Data | `module_catalogue.product`, `module_catalogue.variant`, `module_catalogue.attribute`, `module_catalogue.brand`, `module_catalogue.category` |
| Public API | `createProduct(...)`, `createVariant(...)`, `findProduct(...)`, `resolveIdentifier(...)` |
| Emits | `catalogue.product_created`, `catalogue.variant_created` |
| Consumes | `ai.task_executed` |
| Depends On | K-11, M-02 |
| Status | **NOT STARTED** |

### L3 — Discovery

#### M-06 — Search & Discovery

| Field | Value |
|---|---|
| Brief # | 13 |
| Purpose | Keyword, semantic, structured, and visual search aggregation |
| Owner | Search & Discovery |
| Owned Data | `module_search.search_query_log`, `module_search.discovery_surface` |
| Public API | `search(...)`, `facetedSearch(...)`, `suggest(...)` |
| Emits | `search.performed` |
| Consumes | `catalogue.product_created`, `listing.published`, `ai.task_executed` |
| Depends On | K-15, M-04, M-05 |
| Status | **NOT STARTED** |

#### M-07 — Matching Engine

| Field | Value |
|---|---|
| Brief # | 14 |
| Purpose | Request-to-supply matching and match explanation |
| Owner | Matching Engine |
| Owned Data | `module_match.match`, `module_match.match_explanation`, `module_match.match_run` |
| Public API | `match(needId)`, `score(candidate)`, `explain(matchId)` |
| Emits | `MatchFound` |
| Consumes | `NeedReady`, `listing.published` |
| Depends On | M-03, M-04, M-06, K-13 |
| Status | **NOT STARTED** |

### L4 — Negotiation

#### M-08 — Offers

| Field | Value |
|---|---|
| Brief # | 15 (supply offer), 18 |
| Purpose | Direct seller offers against a request |
| Owner | Offers |
| Owned Data | `module_offer.offer`, `module_offer.offer_line` |
| Public API | `createOffer(...)`, `acceptOffer(...)`, `declineOffer(...)` |
| Emits | `offer.created`, `offer.accepted` |
| Consumes | `NeedReady`, `listing.published` |
| Depends On | M-03, M-04, M-07 |
| Status | **NOT STARTED** |

#### M-09 — RFQ / Reverse Marketplace

| Field | Value |
|---|---|
| Brief # | 16–17 |
| Purpose | Buyer-initiated RFQ, supplier invitation, privacy modes, tender closing |
| Owner | RFQ / Reverse Marketplace |
| Owned Data | `module_rfq.rfq`, `module_rfq.rfq_invitation`, `module_rfq.rfq_policy` |
| Public API | `createRFQ(...)`, `inviteSuppliers(...)`, `closeRFQ(...)`, `selectWinner(...)` |
| Emits | `RFQCreated`, `RFQClosed`, `QuoteSubmitted` |
| Consumes | `NeedReady`, `seller.verified` |
| Depends On | M-03, M-02, M-07, K-12 |
| Status | **NOT STARTED** |

#### M-10 — Quotes & Offer Scoring

| Field | Value |
|---|---|
| Brief # | 18–19 |
| Purpose | Supplier quotes, comparison, ranking, split-fulfilment candidates |
| Owner | Quotes |
| Owned Data | `module_quote.quote`, `module_quote.quote_line`, `module_quote.quote_evaluation` |
| Public API | `submitQuote(...)`, `evaluateQuotes(...)`, `acceptQuote(...)` |
| Emits | `QuoteSubmitted`, `QuoteAccepted` |
| Consumes | `RFQCreated`, `offer.created` |
| Depends On | M-09, M-08, K-13, K-06 |
| Status | **NOT STARTED** |

### L5 — Financial Core (Deterministic Authority Zone)

#### M-11 — Orders

| Field | Value |
|---|---|
| Brief # | 20–21 |
| Purpose | Order state machine, immutable commercial snapshot, split fulfilment |
| Owner | Orders |
| Owned Data | `module_order.order`, `module_order.order_item`, `module_order.order_snapshot`, `module_order.order_event` |
| Public API | `createOrder(...)`, `confirmOrder(...)`, `cancelOrder(...)`, `getOrder(...)` |
| Emits | `OrderCreated`, `order.confirmed`, `order.completed`, `order.cancelled` |
| Consumes | `QuoteAccepted`, `offer.accepted`, `PaymentCaptured` |
| Depends On | M-03, M-10, M-12, M-04, K-06 |
| Status | **NOT STARTED** |

#### M-12 — Payments

| Field | Value |
|---|---|
| Brief # | 44–46 |
| Purpose | Provider-neutral authorise/capture/refund with idempotency and webhooks |
| Owner | Payments |
| Owned Data | `module_payment.payment`, `module_payment.payment_attempt`, `module_payment.refund`, `module_payment.webhook_receipt` |
| Public API | `createPaymentIntent(...)`, `authorize(...)`, `capture(...)`, `cancel(...)`, `refund(...)`, `getStatus(...)` |
| Emits | `PaymentRequested`, `PaymentCaptured`, `PaymentFailed`, `payment.refunded` |
| Consumes | `OrderCreated`, `order.cancelled` |
| Depends On | K-10, M-11, payment-provider adapters |
| Status | **NOT STARTED** |

#### M-13 — Financial Ledger

| Field | Value |
|---|---|
| Brief # | 47–52 |
| Purpose | Authoritative money movement, multi-value ledger, balances |
| Owner | Financial Ledger |
| Owned Data | `module_ledger.ledger_journal`, `module_ledger.ledger_posting`, `module_ledger.balance` |
| Public API | `post(...)`, `getBalance(accountId, assetType)`, `lock(...)`, `release(...)` |
| Emits | `ledger.entry_posted`, `balance.changed` |
| Consumes | `PaymentCaptured`, `payment.refunded`, `commission.created`, `settlement.released` |
| Depends On | K-10, M-12, M-14, M-15 |
| Status | **NOT STARTED** |

#### M-14 — Commission Rules

| Field | Value |
|---|---|
| Brief # | 53 |
| Purpose | Marketplace, wholesale, introducer, logistics commission calculation |
| Owner | Commission Rules |
| Owned Data | `module_commission.commission_rule`, `module_commission.commission_charge` |
| Public API | `calculateCommission(...)`, `createRule(...)`, `versionRule(...)` |
| Emits | `commission.created` |
| Consumes | `order.confirmed`, `PaymentCaptured` |
| Depends On | K-06, M-11, M-12 |
| Status | **NOT STARTED** |

### L6 — Settlement, Payout, Risk

#### M-15 — Settlements

| Field | Value |
|---|---|
| Brief # | 47 / 58 |
| Purpose | Eligibility, milestones, release scheduling |
| Owner | Settlements |
| Owned Data | `module_settlement.settlement`, `module_settlement.settlement_milestone` |
| Public API | `createSettlement(...)`, `markMilestone(...)`, `release(...)` |
| Emits | `settlement.eligible`, `settlement.released` |
| Consumes | `order.completed`, `delivery.completed`, `payment.refunded` |
| Depends On | M-11, M-13, M-19 |
| Status | **NOT STARTED** |

#### M-16 — Seller Payouts

| Field | Value |
|---|---|
| Brief # | 58 |
| Purpose | Held vs eligible proceeds, reserves, accelerated payout, execution |
| Owner | Seller Payouts |
| Owned Data | `module_payout.payout`, `module_payout.payout_hold`, `module_payout.reserve`, `module_payout.security_instrument` |
| Public API | `schedulePayout(...)`, `executePayout(...)`, `holdFunds(...)` |
| Emits | `payout.scheduled`, `payout.executed` |
| Consumes | `settlement.released`, `seller.verified` |
| Depends On | M-13, M-15, M-17 |
| Status | **NOT STARTED** |

#### M-17 — Seller Risk

| Field | Value |
|---|---|
| Brief # | 57 / 76 |
| Purpose | Seller scoring, tiering, exposure limits |
| Owner | Seller Risk |
| Owned Data | `module_seller_risk.risk_profile`, `module_seller_risk.risk_signal` |
| Public API | `assessSeller(...)`, `setTier(...)`, `getExposure(...)` |
| Emits | `risk.escalated` |
| Consumes | `order.completed`, `order.cancelled`, `delivery.late`, `quality.dispute` |
| Depends On | M-02, M-11, K-13 |
| Status | **NOT STARTED** |

#### M-18 — Listing Risk / Trust & Safety

| Field | Value |
|---|---|
| Brief # | 57 / 76 |
| Purpose | Listing review pipeline, moderation queue, appeals, sampling |
| Owner | Listing Risk |
| Owned Data | `module_listing_risk.review_case`, `module_listing_risk.moderation_decision`, `module_listing_risk.sample_record` |
| Public API | `flagListing(...)`, `review(...)`, `appeal(...)` |
| Emits | `listing.reviewed`, `risk.escalated` |
| Consumes | `listing.published` |
| Depends On | M-04, K-13 |
| Status | **NOT STARTED** |

### L7 — Fulfilment and Resolution

#### M-19 — Logistics

| Field | Value |
|---|---|
| Brief # | 37–42 |
| Purpose | Pickup, delivery, multi-stop, driver assignment, tracking, proof |
| Owner | Logistics |
| Owned Data | `module_logistics.delivery`, `module_logistics.delivery_stop`, `module_logistics.proof_of_delivery` |
| Public API | `createShipment(...)`, `assignDriver(...)`, `recordPickup(...)`, `recordDelivery(...)`, `reschedule(...)` |
| Emits | `ShipmentCreated`, `DriverAssigned`, `delivery.assigned`, `DeliveryCompleted`, `delivery.late` |
| Consumes | `order.confirmed`, `PaymentCaptured` |
| Depends On | M-11, logistics-provider adapters, M-43 Location |
| Status | **NOT STARTED** |

#### M-20 — Returns

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Return authorisation and movement |
| Owner | Returns |
| Owned Data | `module_returns.return_case`, `module_returns.return_item` |
| Public API | `requestReturn(...)`, `authoriseReturn(...)`, `completeReturn(...)` |
| Emits | `return.authorised`, `return.completed` |
| Consumes | `order.completed`, `delivery.completed` |
| Depends On | M-11, M-19 |
| Status | **NOT STARTED** |

#### M-21 — Disputes

| Field | Value |
|---|---|
| Brief # | 77 |
| Purpose | Dispute lifecycle, evidence, resolution |
| Owner | Disputes |
| Owned Data | `module_disputes.dispute`, `module_disputes.dispute_evidence`, `module_disputes.resolution` |
| Public API | `openDispute(...)`, `addEvidence(...)`, `resolveDispute(...)` |
| Emits | `DisputeOpened`, `dispute.resolved` |
| Consumes | `order.completed`, `delivery.completed`, `quality.dispute` |
| Depends On | M-11, M-19, K-12, K-13 |
| Status | **NOT STARTED** |

#### M-22 — Warranty / Buyer Protection

| Field | Value |
|---|---|
| Brief # | 78 |
| Purpose | Protection eligibility, inspection windows, claims |
| Owner | Warranty / Buyer Protection |
| Owned Data | `module_warranty.protection_case`, `module_warranty.inspection` |
| Public API | `openClaim(...)`, `scheduleInspection(...)`, `resolveClaim(...)` |
| Emits | `warranty.claim_opened`, `warranty.claim_resolved` |
| Consumes | `order.completed`, `delivery.completed` |
| Depends On | M-11, M-19, M-21 |
| Status | **NOT STARTED** |

### L8 — Verticals, Incentives, Intelligence, Cockpits, Governance

#### M-23 — Accommodation

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Property, room type, calendar, reservation |
| Owner | Accommodation |
| Owned Data | `module_accommodation.property`, `module_accommodation.room_type`, `module_accommodation.availability`, `module_accommodation.reservation` |
| Public API | `listProperty(...)`, `searchAvailability(...)`, `bookStay(...)` |
| Emits | `stay.checked_out` |
| Consumes | `payment.captured`, `delivery.completed` |
| Depends On | M-04, M-11, M-12, M-13, M-15, M-21 |
| Status | **NOT STARTED** |

#### M-24 — Services

| Field | Value |
|---|---|
| Brief # | 65–66 |
| Purpose | Service offering, scheduling, completion evidence |
| Owner | Services |
| Owned Data | `module_services.service_offering`, `module_services.service_booking`, `module_services.completion_record` |
| Public API | `createServiceOffering(...)`, `bookService(...)`, `recordCompletion(...)` |
| Emits | `service.completed` |
| Consumes | `NeedReady`, `order.confirmed` |
| Depends On | M-03, M-04, M-11, M-19 |
| Status | **NOT STARTED** |

#### M-25 — Used Goods Risk Pack

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Pluggable evidence and declaration requirements for used goods |
| Owner | Used Goods Risk Pack |
| Owned Data | `module_used_goods.requirement`, `module_used_goods.declaration` |
| Public API | `getRequirements(category)`, `submitDeclaration(...)` |
| Emits | `used_goods.declaration_submitted` |
| Consumes | `listing.published` |
| Depends On | M-04, K-13 |
| Status | **NOT STARTED** |

#### M-26 — Vehicle Risk Pack

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | VIN, title, mileage, inspection, security-interest checks |
| Owner | Vehicle Risk Pack |
| Owned Data | `module_vehicle.record`, `module_vehicle.evidence` |
| Public API | `registerVehicle(...)`, `submitEvidence(...)`, `getReport(...)` |
| Emits | `vehicle.verified` |
| Consumes | `listing.published` |
| Depends On | M-04, K-13 |
| Status | **NOT STARTED** |

#### M-27 — Fashion / Luxury Risk Pack

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Brand, serial, authenticity evidence |
| Owner | Fashion / Luxury Risk Pack |
| Owned Data | `module_fashion.authenticity_case`, `module_fashion.authenticity_evidence` |
| Public API | `submitAuthenticityEvidence(...)`, `evaluateCase(...)` |
| Emits | `fashion.authenticity_verified` |
| Consumes | `listing.published` |
| Depends On | M-04, K-13 |
| Status | **NOT STARTED** |

#### M-28 — Rewards

| Field | Value |
|---|---|
| Brief # | 56 |
| Purpose | JAYA Points ledger — earn, redeem, expire, reverse, adjust |
| Owner | Rewards |
| Owned Data | `module_rewards.points_entry`, `module_rewards.points_account`, `module_rewards.reward_rule` |
| Public API | `earn(...)`, `redeem(...)`, `expire(...)` |
| Emits | `RewardIssued`, `reward.earned` |
| Consumes | `order.completed`, `payment.captured` |
| Depends On | K-10, M-13, K-06 |
| Status | **NOT STARTED** |

#### M-29 — Referrals

| Field | Value |
|---|---|
| Brief # | 54–55 |
| Purpose | Introducer relationships and referral records |
| Owner | Referrals |
| Owned Data | `module_referrals.referral`, `module_referrals.introducer_link` |
| Public API | `registerIntroducer(...)`, `recordReferral(...)`, `getReferralTree(...)` |
| Emits | `referral.registered` |
| Consumes | `account.opened` |
| Depends On | K-01, K-03, M-01 |
| Status | **NOT STARTED** |

#### M-30 — Attribution

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Deterministic attribution of outcomes to referrers and campaigns |
| Owner | Attribution |
| Owned Data | `module_attribution.attribution_record`, `module_attribution.attribution_run` |
| Public API | `attributeOutcome(...)`, `runAttribution(...)` |
| Emits | `attribution.recorded` |
| Consumes | `order.completed`, `payment.captured` |
| Depends On | M-29, M-11, K-06 |
| Status | **NOT STARTED** |

#### M-31 — Budgeting / Life Money

| Field | Value |
|---|---|
| Brief # | 59–63 |
| Purpose | User budgets, safe-to-spend, cashflow forecast, goals |
| Owner | Budgeting |
| Owned Data | `module_budget.budget`, `module_budget.budget_category`, `module_budget.commitment`, `module_budget.goal` |
| Public API | `createBudget(...)`, `getSafeToSpend(...)`, `forecastCashflow(...)` |
| Emits | `budget.updated` |
| Consumes | `order.completed`, `payment.captured`, `reward.earned` |
| Depends On | M-13, M-28, M-32 |
| Status | **NOT STARTED** |

#### M-32 — User Intelligence

| Field | Value |
|---|---|
| Brief # | 64 |
| Purpose | Permissioned personalisation and preference learning |
| Owner | User Intelligence |
| Owned Data | `module_user_intelligence.user_signal`, `module_user_intelligence.preference_profile`, `module_user_intelligence.consent` |
| Public API | `recordSignal(...)`, `getPreferences(...)`, `updateConsent(...)` |
| Emits | `intelligence.preference_updated` |
| Consumes | many (with consent) |
| Depends On | K-01, K-03, K-13, M-68 Consent |
| Status | **NOT STARTED** |

#### M-33 — Seller Market Intelligence

| Field | Value |
|---|---|
| Brief # | 27 / 30 |
| Purpose | Demand, pricing, missed opportunities, inventory insight |
| Owner | Seller Market Intelligence |
| Owned Data | `module_seller_intel.insight_card`, `module_seller_intel.insight_run`, `module_seller_intel.demand_cloud` |
| Public API | `generateInsights(...)`, `getDemandCloud(...)` |
| Emits | `seller_intel.insight_generated` |
| Consumes | `listing.published`, `order.completed`, `search.performed` |
| Depends On | M-04, M-11, M-45, K-13 |
| Status | **NOT STARTED** |

#### M-34 — Finance Provider Marketplace

| Field | Value |
|---|---|
| Brief # | 46 / 52 |
| Purpose | Pluggable licensed finance providers and eligibility presentation |
| Owner | Finance Provider Marketplace |
| Owned Data | `module_finance_provider.provider`, `module_finance_provider.offer`, `module_finance_provider.eligibility_result` |
| Public API | `registerProvider(...)`, `getOffers(...)` |
| Emits | `finance.offer_presented` |
| Consumes | `NeedReady` |
| Depends On | M-03, M-02, K-13 |
| Status | **NOT STARTED** |

#### M-35 — Conversation Supervision

| Field | Value |
|---|---|
| Brief # | 82 |
| Purpose | Staff monitoring centre, escalation filters, human takeover, redaction |
| Owner | Conversation Supervision |
| Owned Data | `module_conv_supervision.supervision_case`, `module_conv_supervision.takeover_session`, `module_conv_supervision.access_log` |
| Public API | `flagConversation(...)`, `takeover(...)` |
| Emits | `supervision.case_opened` |
| Consumes | `risk.escalated`, `conversation.message_sent` |
| Depends On | K-12, M-21, M-76 Risk |
| Status | **NOT STARTED** |

#### M-36 — User Cockpit

| Field | Value |
|---|---|
| Brief # | 05 / 06 / 58 |
| Purpose | Buyer-facing adaptive cockpit and read-model projections |
| Owner | User Cockpit |
| Owned Data | `module_cockpit.cockpit_layout`, `module_cockpit.cockpit_preference`, `module_cockpit.projection` |
| Public API | `getCockpit(userId)`, `getSection(userId, section)`, `pinWidget(...)` |
| Emits | — |
| Consumes | many events for projections |
| Depends On | M-01, M-13, M-11, M-19, M-28, M-31 |
| Status | **NOT STARTED** |

#### M-37 — Seller Cockpit

| Field | Value |
|---|---|
| Brief # | 26 / 27 |
| Purpose | Seller operating dashboard |
| Owner | Seller Cockpit |
| Owned Data | `module_seller_cockpit.seller_cockpit_layout`, `module_seller_cockpit.widget_state` |
| Public API | `getSellerDashboard(...)`, `getSalesReport(...)` |
| Emits | — |
| Consumes | many events for projections |
| Depends On | M-04, M-11, M-13, M-33 |
| Status | **NOT STARTED** |

#### M-38 — Operations Cockpit

| Field | Value |
|---|---|
| Brief # | 81–82 |
| Purpose | Internal staff supervision surface |
| Owner | Operations Cockpit |
| Owned Data | `module_ops.ops_view_config`, `module_ops.ops_action_log` |
| Public API | `getOpsView(...)`, `runQuery(...)` |
| Emits | — |
| Consumes | many events |
| Depends On | M-36, M-37, K-09, K-13 |
| Status | **NOT STARTED** |

#### M-39 — AI Model Registry

| Field | Value |
|---|---|
| Brief # | 71–72 |
| Purpose | Model catalogue, versions, shadow-mode candidates |
| Owner | AI Model Registry |
| Owned Data | `module_ai_registry.ai_model_record`, `module_ai_registry.ai_model_version`, `module_ai_registry.shadow_run` |
| Public API | `registerModel(...)`, `publishVersion(...)`, `scheduleShadowRun(...)` |
| Emits | `ai_model.registered` |
| Consumes | `ai.task_executed` |
| Depends On | K-13 |
| Status | **NOT STARTED** |

#### M-40 — AI Routing / Control Plane

| Field | Value |
|---|---|
| Brief # | 72 |
| Purpose | Task-to-model routing rules, thresholds, fallbacks, rollout |
| Owner | AI Routing / Control Plane |
| Owned Data | `module_ai_routing.routing_rule`, `module_ai_routing.routing_version` |
| Public API | `createRule(...)`, `routeTask(...)`, `evaluateFallback(...)` |
| Emits | `ai.routing_decided` |
| Consumes | `ai_model.registered`, `feature_flag.activated` |
| Depends On | K-13, K-07, M-39 |
| Status | **NOT STARTED** |

#### M-41 — AI Decision Audit

| Field | Value |
|---|---|
| Brief # | 75 |
| Purpose | Durable record of AI decisions, overrides, outcomes |
| Owner | AI Decision Audit |
| Owned Data | `module_ai_audit.ai_decision_record`, `module_ai_audit.human_override` |
| Public API | `recordDecision(...)`, `recordOverride(...)` |
| Emits | `ai.decision_recorded` |
| Consumes | `ai.task_executed`, `ai.routing_decided` |
| Depends On | K-13, K-09 |
| Status | **NOT STARTED** |

#### M-42 — AI Monitoring

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Cost, latency, error, drift and disagreement monitoring |
| Owner | AI Monitoring |
| Owned Data | `module_ai_monitoring.ai_metric`, `module_ai_monitoring.ai_alert` |
| Public API | `recordMetric(...)`, `getDashboard(...)` |
| Emits | `ai.alert_triggered` |
| Consumes | `ai.task_executed`, `ai.decision_recorded` |
| Depends On | K-13, M-41 |
| Status | **NOT STARTED** |

#### M-43 — Location

| Field | Value |
|---|---|
| Brief # | 43 |
| Purpose | Central location/geospatial service |
| Owner | Location |
| Owned Data | `module_location.location`, `module_location.geo_index` |
| Public API | `resolveAddress(...)`, `geocode(...)`, `distance(...)`, `searchRadius(...)` |
| Emits | `location.resolved` |
| Consumes | — |
| Depends On | substrate (PostGIS) |
| Status | **NOT STARTED** |

#### M-44 — Policy / Configuration Studio

| Field | Value |
|---|---|
| Brief # | 83 |
| Purpose | Authoring and approval UI over K-06 policies |
| Owner | Policy Studio |
| Owned Data | `module_policy_studio.policy_draft`, `module_policy_studio.policy_approval` |
| Public API | `createDraft(...)`, `submitApproval(...)`, `approve(...)` |
| Emits | `policy.draft_submitted` |
| Consumes | `policy.published` |
| Depends On | K-06, K-04 |
| Status | **NOT STARTED** |

#### M-45 — Analytics / Platform Intelligence

| Field | Value |
|---|---|
| Brief # | 80 |
| Purpose | Platform-level metrics and north-star reporting |
| Owner | Analytics |
| Owned Data | `module_analytics.metric_definition`, `module_analytics.metric_snapshot` |
| Public API | `recordMetric(...)`, `getReport(...)` |
| Emits | `analytics.snapshot_created` |
| Consumes | many events |
| Depends On | K-08, K-09 |
| Status | **NOT STARTED** |

#### M-46 — Admin Audit

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Staff-facing audit search over K-09 |
| Owner | Admin Audit |
| Owned Data | `module_admin_audit.audit_query`, `module_admin_audit.audit_export` |
| Public API | `searchAudit(...)`, `exportAudit(...)` |
| Emits | `admin_audit.exported` |
| Consumes | — |
| Depends On | K-09, K-04 |
| Status | **NOT STARTED** |

#### M-47 — Module Registry / Health

| Field | Value |
|---|---|
| Brief # | — |
| Purpose | Module inventory, version, health, contract registry |
| Owner | Module Registry |
| Owned Data | `module_registry.module_record`, `module_registry.module_health`, `module_registry.contract_record` |
| Public API | `registerModule(...)`, `recordHealth(...)`, `getContract(...)` |
| Emits | `module.health_updated` |
| Consumes | — |
| Depends On | K-08, K-09 |
| Status | **NOT STARTED** |

---

## 5. Dependency Graph Summary

```text
L8  COCKPITS · VERTICALS · INTELLIGENCE · GOVERNANCE
    M-36 M-37 M-38  M-23 M-24 M-25/26/27  M-28 M-29 M-30
    M-31 M-32 M-33 M-34 M-35  M-39 M-40 M-41 M-42  M-43 M-44 M-45 M-46 M-47
              │
              v
L7  FULFILMENT & RESOLUTION
    M-19 Logistics  M-20 Returns  M-21 Disputes  M-22 Warranty
              │
              v
L6  SETTLEMENT / PAYOUT / RISK
    M-15 Settlements  M-16 Payouts  M-17 Seller Risk  M-18 Listing Risk
              │
              v
L5  FINANCIAL CORE (deterministic authority zone)
    M-11 Orders  M-12 Payments  M-13 Financial Ledger  M-14 Commission Rules
              │
              v
L4  NEGOTIATION
    M-08 Offers  M-09 RFQ  M-10 Quotes
              │
              v
L3  DISCOVERY
    M-06 Search  M-07 Matching
              │
              v
L2  COMMERCE PRIMITIVES
    M-03 Need  M-04 Listing/Inventory  M-05 Catalog
              │
              v
L1  ACCOUNT & CAPABILITY
    M-01 Universal Account  M-02 Capability & Verification
              │
              v
L0  COMMERCE KERNEL
    K-01 K-02 K-03 K-04 K-05 K-06 K-07 K-08 K-09 K-10 K-11 K-12 K-13 K-14 K-15
              │
              v
    PLATFORM SUBSTRATE
```

---

## 6. Event Flow Examples

| Emitter | Event | Subscribers |
|---|---|---|
| M-01 | `capability.activated` | M-36, M-37, M-45 |
| M-02 | `seller.verified` | M-16, M-17, M-37 |
| M-03 | `NeedCreated`, `NeedInterpreted`, `MatchFound` | M-07, M-35, M-45 |
| M-04 | `listing.created`, `listing.published` | M-06, M-18, M-33 |
| M-18 | `listing.reviewed` | M-04 (subscription), M-38 |
| M-11 | `OrderCreated`, `order.confirmed`, `order.completed` | M-15, M-19, M-28, M-31, M-33, M-45 |
| M-12 | `PaymentCaptured`, `payment.refunded` | M-13, M-15, M-38 |
| M-14 | `commission.created` | M-13, M-45 |
| M-19 | `delivery.assigned`, `DeliveryCompleted` | M-15, M-22, M-36 |
| M-15 | `settlement.eligible`, `settlement.released` | M-16, M-37, M-38 |
| M-28 | `RewardIssued` | M-31, M-36 |
| M-17 / M-18 | `risk.escalated` | M-35, M-38 |

---

## 7. Module Contract Standard

Before implementation, every module publishes a contract at `docs/modules/<module-id>-<name>.md` with:

```text
MODULE NAME:
MODULE ID:
LAYER:
BUSINESS PURPOSE:
OWNED DATA:
PUBLIC API:
EVENTS CONSUMED:
EVENTS EMITTED:
UI SURFACES:
PERMISSIONS:
CONFIGURATION:
AI CAPABILITIES:
DEPENDENCIES:
ERROR STATES:
RETRIES / IDEMPOTENCY:
TESTS:
OBSERVABILITY:
FEATURE FLAGS:
VERSION:
DEFINITION OF DONE:
```

---

## 8. Anti-Cycle Rules

1. Downward-only imports.
2. No upward calls; use events.
3. No sibling calls within a layer; use events.
4. No shared tables; one writer per table.
5. Control planes sit above their subject.
6. Kernel never depends on modules.
7. Cockpits are terminal (nothing depends on them).
8. New module admission test: name layer, owned data, every edge.

---

## 9. Status Legend

| Status | Meaning |
|---|---|
| Foundation implemented | Core library and tests exist; may lack API/UI/wiring |
| Implemented | Full vertical slice: domain, persistence, API, tests |
| In progress | Currently being built |
| Not started | No code |
| Deferred | Intentionally delayed with reason |
| Blocked | Cannot proceed until external blocker resolved |
