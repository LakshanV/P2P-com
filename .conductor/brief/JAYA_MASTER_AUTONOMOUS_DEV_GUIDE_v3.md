# JAYA — MASTER AUTONOMOUS DEVELOPMENT & SUPERVISION GUIDE
## Version 3.0 — Conductor / OpenAI Supervisor + Claude Worker

---

# 0. PURPOSE

This file is the authoritative project specification and autonomous development operating manual for **JAYA**, an AI-native universal P2P commerce platform.

The intended development arrangement is:

- **OpenAI supervisory model** = Project Director / Technical Manager / Reviewer / QA gatekeeper
- **Claude Code** = Primary implementation worker
- **Repository** = Persistent source of truth and development memory
- **Human owner** = Business authority for genuinely ambiguous, legal, commercial, credential, or irreversible decisions

The OpenAI supervisor must direct Claude through the entire build, review what Claude produces, detect omissions and architectural drift, require corrections, run or require tests, maintain the implementation status, and continue to the next highest-priority unblocked task.

The project must not be considered complete simply because pages render or individual features appear to work.

---

# 1. HIERARCHY OF AUTHORITY

When instructions conflict, use this order:

1. `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE.md` — this document
2. `CURRENT_IMPLEMENTATION_STATUS.md`
3. `MASTER_IMPLEMENTATION_CHECKLIST.md`
4. `ARCHITECTURE.md`
5. Module specifications
6. API/database/event contracts
7. Existing tests
8. Existing implementation
9. Temporary chat/run instructions

The supervisor must not allow a temporary implementation shortcut to silently override this master specification.

---

# 2. AUTONOMOUS DEVELOPMENT MISSION

Build JAYA as a continuously evolving universal commerce operating system in which one account can:

- buy products
- sell products
- request products
- fulfil requests
- offer services
- purchase services
- list used goods
- buy used goods
- list vehicles
- buy vehicles
- book accommodation
- host accommodation
- participate in RFQs
- provide bulk/wholesale supply
- arrange delivery/logistics
- earn and redeem rewards
- participate as an introducer/referrer
- access eligible financial/working-capital facilities through appropriate providers
- monitor budgets and spending
- interact with JAYA AI across the platform

The system must remain category-neutral and extensible.

---

# 3. PRODUCT NORTH STAR

JAYA is not merely an ecommerce catalogue.

The core interaction is:

> **Tell JAYA what you need, or what you can offer. JAYA understands, connects, transacts, fulfils and learns.**

The system should progressively coordinate:

Need → Identification → Search → Match → Offer/RFQ → Order → Payment → Fulfilment → Delivery/Stay/Service → Acceptance → Settlement → Rewards → Learning

---

# 4. ONE UNIVERSAL ACCOUNT

Do not create separate identities for buyers, sellers, hosts or service providers.

Create one `JAYA Account` with capabilities.

Examples:

- Buyer
- Seller
- Supplier
- Host
- Guest
- Service Provider
- Business Purchaser
- Introducer
- Delivery Provider

Capabilities activate when required and can have separate verification requirements.

Shared across capabilities:

- identity
- authentication
- profile
- conversations
- payment history
- rewards
- reputation
- preferences
- disputes
- AI memory
- settings
- permissions

---

# 5. THE THREE COCKPITS

## 5.1 User / Buyer Cockpit

A first-class, engaging personal commerce cockpit showing contextually relevant modules such as:

- JAYA AI
- Requests
- Suggested items
- Discover
- Orders
- Order progress
- Deliveries
- Accommodation
- Services
- Selling
- Saved items
- Payments
- Rewards
- Budget
- Spending
- Committed spending
- Remaining discretionary budget
- Financial health
- Eligible finance options
- Conversations
- Profile
- Privacy
- Preferences

The cockpit should adapt to each user instead of showing every feature at once.

## 5.2 Seller Cockpit

A premium seller operating dashboard with:

- sales
- listings
- inventory
- orders
- RFQs
- opportunities
- messages
- fulfilment
- delivery readiness
- payments
- settlements
- held funds
- accelerated payout eligibility
- guarantee/security utilisation
- returns/disputes
- seller performance
- AI market insights
- demand trends
- pricing suggestions
- missed opportunities
- inventory suggestions
- customer demand
- rewards/promotions
- working-capital/finance facilities
- verification level
- AI seller assistant

## 5.3 Internal Operations Cockpit

Authorised JAYA staff must be able to supervise the whole commerce network.

Include:

- live activity
- users
- sellers
- requests
- listings
- orders
- payments
- settlements
- accommodation
- services
- deliveries
- disputes
- rewards
- commissions
- seller guarantees/security
- payout exposure
- risk alerts
- high-risk listings
- listing review queue
- AI escalations
- AI decisions
- conversation supervision
- human takeover
- system health
- module health
- model health
- AI cost/usage
- audit logs
- policy/configuration changes

All staff access must be role-based, purpose-based and audited.

---

# 6. CONVERSATION SUPERVISION

JAYA must maintain a unified conversation system.

Authorised staff need a Conversation Monitoring Centre supporting:

- customer ↔ JAYA AI conversations
- seller ↔ JAYA AI conversations
- buyer/seller transaction conversations
- support conversations
- voice-AI conversations
- escalated conversations

Filters should include:

- AI low confidence
- user complaint
- fraud suspicion
- payment issue
- seller dispute
- unresolved request
- policy issue
- high-value transaction
- negative conversation
- AI requesting human help

Human staff can enter a conversation with full permitted context, resolve the issue, and return control to AI.

Employee access to conversations must be logged and restricted. Sensitive information should be redacted when not needed.

---

# 7. MODULARITY IS A NON-NEGOTIABLE ARCHITECTURAL REQUIREMENT

The project will change frequently.

Therefore every major commerce capability must be implemented as a small, bounded module that can be developed, replaced, redesigned or upgraded without rewriting unrelated code.

The architecture must optimise for daily evolution.

A change to Listing must not require changes to Payment, Rewards, Accommodation and Accounts unless the published contract genuinely changes.

---

# 8. COMMERCE KERNEL

Keep a small, stable central kernel containing common capabilities only:

- Identity
- Accounts
- Authentication
- Permissions
- Conversation foundation
- Commerce Unit Registry
- Event infrastructure
- AI Gateway
- Policy Engine
- Configuration
- Ledger foundation
- Audit foundation
- Notifications
- Search foundation
- Feature flags

Business features should sit outside the kernel.

---

# 9. PRIMARY MODULE MAP

Initial independently owned modules should include at minimum:

1. Identity & Authentication
2. Universal Account
3. Capability & Verification
4. User Cockpit
5. Seller Cockpit
6. Staff / Operations Cockpit
7. Conversations
8. Conversation Supervision
9. Item / Commerce Request
10. Universal Listing
11. Commerce Unit Registry
12. Product Catalog
13. Search & Discovery
14. Matching
15. Offers
16. RFQ / Reverse Marketplace
17. Quotes
18. Orders
19. Payments
20. Financial Ledger
21. Seller Payouts
22. Settlements
23. Seller Risk
24. Listing Risk / Trust & Safety
25. Used Goods Risk Pack
26. Vehicle Risk Pack
27. Accommodation
28. Services
29. Logistics
30. Returns
31. Disputes
32. Warranty / Buyer Protection
33. Rewards
34. Referrals
35. Commission Rules
36. Budgeting
37. User Intelligence
38. Seller Market Intelligence
39. Finance Provider Marketplace
40. Notifications
41. AI Gateway
42. AI Model Registry
43. AI Routing / Control Plane
44. AI Decision Audit
45. AI Monitoring
46. Policy / Configuration Studio
47. Feature Flags / Rollouts
48. Analytics / Platform Intelligence
49. Admin Audit
50. Module Registry / Health

The supervisor may refine module boundaries when technically justified, but must preserve modular isolation.

---

# 10. MODULE CONTRACT STANDARD

Every module must document:

- module name
- business purpose
- owned data
- public API
- events consumed
- events emitted
- UI surfaces
- permissions
- configuration
- AI capabilities
- dependencies
- error states
- retries/idempotency requirements
- tests
- observability
- feature flags
- version
- definition of done

No module may directly alter another module's private data simply because it is convenient.

Use public application interfaces or events.

---

# 11. UNIVERSAL COMMERCE UNIT

Create a reusable `CommerceUnit` abstraction supporting:

- new product
- used product
- bulk commodity
- vehicle
- accommodation
- service
- rental
- wholesale lot
- custom item
- other future permitted category

Common fields can include:

- CommerceUnit ID
- owner/seller/host/provider
- type
- category
- title
- description
- images
- videos
- attributes
- location
- quantity
- units
- pricing model
- availability
- condition
- delivery/fulfilment options
- verification
- risk status
- seller/provider declarations
- AI analysis
- moderation status
- lifecycle status

Category adapters extend the common object rather than duplicating the platform.

---

# 12. DEFINABLE COMMERCIAL UNITS

Support flexible pricing and fulfilment units.

Examples:

Goods:
- each
- gram
- kg
- tonne
- litre
- metre
- box
- pallet
- lot
- container

Accommodation:
- night
- week
- month
- room
- property
- guest where appropriate

Services:
- hour
- job
- visit
- kilometre
- quotation
- fixed package

Rentals:
- hour
- day
- week
- month

Never hardcode commerce assumptions around one category.

---

# 13. REQUEST MODULE

A customer can request something using:

- text
- voice
- photo
- multiple photos
- screenshot
- video
- URL
- barcode/QR
- document
- future AI glasses or browser context

The Request/Need object should capture:

- original input
- structured interpretation
- desired item/service/stay
- quantity
- unit
- budget
- maximum price
- location
- required date/time
- quality
- preferences
- acceptable substitutes
- fulfilment requirements
- media
- AI confidence
- clarification status
- matching status
- RFQ status
- resulting order
- lifecycle state

The request module is separate from Listing.

---

# 14. LISTING MODULE

The universal Listing module must support:

- new items
- used items
- vehicles
- commodities
- accommodation
- services
- rentals
- bulk lots

Listing creation should be exceptionally easy.

Signature flow:

Camera → AI identifies → AI proposes title → AI description → AI attributes → AI condition → AI category → AI price suggestion → seller reviews → risk checks → publish or review

The seller remains responsible for the accuracy of representations.

---

# 15. NON-STANDARDISED AND USED GOODS

Used goods and non-standardised items require stronger trust and evidence controls.

Examples:

- used phones
- vehicles
- clothing
- luxury goods
- machinery
- collectibles
- parts

For applicable categories require seller representations such as:

- lawful ownership or lawful authority to sell
- authenticity where represented
- known material defects
- condition accuracy
- identifiers/serials where appropriate

Store declaration version, seller identity, item/listing, date/time and relevant evidence.

Seller representations reduce ambiguity but must not be the only protection.

Combine with:

- AI checks
- evidence
- category-specific requirements
- seller history
- risk scoring
- payment/settlement controls
- buyer acceptance
- dispute protection
- optional inspection
- human review for exceptions

---

# 16. CATEGORY RISK PACKS

Trust controls should be pluggable.

Examples:

## Used Phones
- IMEI/serial
- model/storage
- activation/network lock declaration
- battery/condition
- repairs
- ownership
- photos
- proof of purchase where needed

## Vehicles
- VIN/chassis
- registration
- ownership/title evidence
- mileage
- accident/condition evidence
- security-interest checks where available
- inspections
- photos/videos

## Fashion/Luxury
- brand
- model
- size
- serial/date codes
- authenticity evidence
- AI indicators
- proof of purchase where required

## Accommodation
- host verification
- property/location verification
- safety/policy information
- image consistency
- fraud controls

Each risk pack can evolve independently.

---

# 17. LISTING REVIEW PIPELINE

Initial target:

AI reviews every listing.
Humans review high-risk, low-confidence, policy-sensitive and sampled listings.

Lifecycle:

DRAFT
→ AI_REVIEW
→ NEEDS_SELLER_INFO / HUMAN_REVIEW / APPROVED
→ PUBLISHED
→ LIMITED / SUSPENDED / REMOVED / SOLD

Over time:

Stage 1: AI reviews 100%; humans review exceptions + samples.
Stage 2: AI auto-approves low risk; humans medium/high.
Stage 3: AI handles nearly all normal listings; humans exceptions/appeals.
Long term: AI-first oversight with human governance and quality sampling.

Random human sampling must continue even at high automation to detect model drift.

---

# 18. SELLER ONBOARDING

Seller registration must be as easy as or easier than major international platforms.

Use progressive verification.

Initial registration may require:

- name/business name
- phone
- email
- country
- location/address
- applicable tax identifier
- payout destination/bank details
- basic identity
- seller agreement

Tax identifiers are jurisdiction-configurable and must not be hardcoded to one country.

The seller should be able to start the onboarding/listing process within minutes.

---

# 19. SELLER VERIFICATION LEVELS

Example configurable levels:

LEVEL 0 — registered
LEVEL 1 — identity verified
LEVEL 2 — bank verified
LEVEL 3 — business/tax verified
LEVEL 4 — enhanced verified
LEVEL 5 — secured / accelerated payout eligible

Capabilities and transaction limits can depend on verification level.

---

# 20. SELLER PAYOUT & RISK SYSTEM

Create seller payout logic as a standalone policy-driven module.

Do not embed settlement rules in registration or order code.

It must determine:

- eligible proceeds
- held proceeds
- release time
- reserve
- security coverage
- accelerated exposure
- dispute exposure
- permitted payout
- payout method
- policy version

Initial business concept:

## Standard/new seller
Eligible proceeds may be delayed up to approximately **45 days**, depending on policy, category and milestone.

The policy must define the starting milestone, for example:

- delivery confirmation
- buyer acceptance
- service completion
- accommodation checkout

## Accelerated seller payout
Eligible sellers may receive settlement in approximately **24 hours** if stronger approved protection/security exists.

Initial concept:
- bank guarantee or other approved security
- initial target security coverage: 50% of accelerated exposure

These values MUST be configuration, not source-code constants.

Support generic security instruments such as:

- bank guarantee
- rolling reserve
- cash security
- approved insurance
- third-party guarantee
- other future security

Actual legal/financial implementation must use appropriate providers and jurisdiction-specific rules.

---

# 21. RISK-BASED SETTLEMENT

Eventually settlement timing may consider:

- seller verification
- seller age
- transaction history
- completed order count
- dispute rate
- return rate
- category risk
- item value
- average transaction value
- delivery confirmation
- buyer complaints
- fraud score
- security provided
- account anomalies

The system should evolve from blanket holds toward evidence-based seller tiers while preserving buyer/platform protection.

---

# 22. ACCOMMODATION

Accommodation must be an independent CommerceUnit module, conceptually similar to leading accommodation marketplaces but implemented through JAYA's common infrastructure.

Support:

- host capability
- property
- property/room type
- guest capacity
- beds/bathrooms
- amenities
- images/video
- map/location
- availability calendar
- nightly/weekly/monthly pricing
- fees
- house rules
- cancellation policies
- check-in/check-out
- min/max stay
- reservation
- payment
- settlement
- reviews
- disputes
- host/guest conversations
- AI listing assistance
- AI pricing/occupancy insights
- fraud/risk review

Reuse shared:
- identity
- conversations
- payment
- ledger
- rewards
- reputation
- disputes
- AI
- settlement

Do not create a separate platform codebase.

---

# 23. REWARDS / POINTS

Implement an auditable JAYA Points system.

Possible sources:
- purchase
- sale
- successful referral
- promotion
- loyalty
- seller performance
- platform campaign

Funding types:
- JAYA funded
- seller funded
- shared
- campaign funded

Rewards may be used for:
- eligible discounts
- partial eligible purchase payment
- seller promotions
- platform services
- other configured uses

Seller may configure incentives, and JAYA AI may suggest reward levels.

Never store only a mutable points balance. Use a ledger:
- earn
- redeem
- expire
- reverse
- adjust

---

# 24. COMMISSION RULE ENGINE

JAYA service commissions must be configuration-driven.

Rules may vary by:

- seller
- seller tier
- category
- subcategory
- product
- geography
- transaction amount
- customer segment where appropriate
- campaign
- accommodation
- service type
- payment type
- promotional period

Every transaction stores the exact commission policy version applied at purchase time.

Changing future policy must not rewrite historical economics.

---

# 25. CUSTOMER BUDGET & FINANCIAL COCKPIT

Users may optionally configure budgets for living/business spending.

Examples:
- groceries
- transport
- utilities
- education
- entertainment
- business procurement
- custom categories

Show:
- allocated
- spent
- committed
- remaining

Committed spend includes confirmed pending obligations, not only completed purchases.

JAYA AI may provide useful suggestions based on user-defined goals and preferences.

Do not treat "remaining budget" as automatically spendable advertising inventory.

Recommendations should distinguish:
- essential commitments
- reserves
- planned spend
- optional/discretionary spend

Avoid exploitative personalisation.

---

# 26. AI USER PERSONALISATION

With appropriate permission, JAYA may learn:

- preferred brands
- quality preferences
- price sensitivity
- preferred suppliers
- typical quantities
- timing/reorder cycles
- delivery preferences
- declared household/business needs
- budget preferences
- location where permitted
- prior purchase patterns

Recommendations should become progressively more useful while preserving user control, inspection and deletion capabilities where applicable.

---

# 27. SELLER MARKET INTELLIGENCE

The Seller Cockpit must evolve into an AI business assistant.

Potential insight cards:

- demand growth
- geographic demand
- price competitiveness
- lost opportunities
- unanswered demand
- inventory suggestions
- reorder suggestions
- customer repeat patterns
- delivery-radius opportunities
- fulfilment issues
- response-time issues
- category trends
- expected near-term demand
- promotion recommendations

Initial releases can use deterministic analytics before advanced prediction.

---

# 28. FINANCE / WORKING CAPITAL

Seller/User cockpits can expose eligible finance opportunities such as:

- working capital
- inventory finance
- purchase-order finance
- invoice finance
- equipment/vehicle finance
- trade finance

Where regulated, JAYA acts as connector/technology layer and uses appropriate licensed providers.

Finance providers must be pluggable.

---

# 29. AI CONTROL PLANE

No business module may hardcode one AI provider.

Create:

AI Gateway
→ Model Registry
→ Task Router
→ Provider Adapters
→ Evaluation
→ Audit
→ Cost/Latency Monitoring
→ Fallbacks

Support current/future:
- OpenAI
- Anthropic
- Google
- Kimi
- DeepSeek
- specialist models
- in-house/open-source models

The platform must be able to switch or combine models without rebuilding business modules.

---

# 30. MODEL ROUTING

Route by task rather than habit.

Examples:

- simple classification → lower-cost capable model
- routine conversational response → balanced model
- difficult procurement reasoning → stronger reasoning model
- image identification → vision model
- embeddings → embedding model
- fraud/risk cross-check → specialised/independent model
- bulk offline classification → economical model

For sensitive/high-risk decisions, support multi-model comparison.

If model disagreement crosses policy threshold, escalate to human review.

---

# 31. AI SHADOW MODE

New models should initially be deployed in shadow mode:

- production model decides
- candidate sees same permitted input
- candidate output is logged but not executed
- compare quality/cost/latency/errors
- promote only after evaluation

Every important AI decision should store:
- provider
- model
- model/version
- prompt/policy version
- task
- tools called
- relevant reference IDs
- confidence
- latency
- cost
- recommendation
- human override
- final outcome

---

# 32. CONTROLLED AI SELF-IMPROVEMENT

AI may identify:
- poor matches
- user corrections
- seller corrections
- human interventions
- disputes
- cancellations
- bad recommendations
- false risk flags
- high latency
- high cost

AI can produce improvement proposals.

Production changes follow:

problem detected
→ proposal
→ tests/simulation
→ evaluation
→ approval as required
→ feature flag
→ limited rollout
→ metrics
→ expand or rollback

Production AI must not silently rewrite business policy.

---

# 33. FIRST-CLASS UI/UX

UI/UX is a first-class engineering requirement and independent release gate.

JAYA should feel polished, simple, modern and highly engaging.

Principles:
- conversation-first
- mobile-first
- extremely low friction
- minimal typing
- excellent camera/media flows
- intelligent progressive disclosure
- consistent design language
- high-quality motion/feedback without gimmicks
- fast perceived performance
- accessible
- resilient on slower connections
- dense operational dashboards where useful, without clutter

Every module requires:
- mobile
- desktop
- empty states
- loading states
- error states
- success states
- first-time experience
- returning-user experience
- accessibility review
- responsive testing
- realistic-data testing

A page merely rendering is NOT UI completion.

---

# 34. DESIGN SYSTEM

Create a shared JAYA design system for:

- typography
- spacing
- layout
- buttons
- forms
- inputs
- cards
- navigation
- chat
- commerce cards
- seller opportunity cards
- status chips
- tables
- filters
- charts
- maps
- media viewer
- drawers
- modals
- notifications
- skeletons
- progress
- motion
- accessibility

Modules must reuse this system.

---

# 35. CONFIGURATION-FIRST BUSINESS RULES

Frequently changing business policy must live in a controlled policy/configuration system wherever safely possible.

Examples:
- commissions
- payout delay
- guarantee percentage
- reserve percentage
- reward rules
- seller limits
- category enable/disable
- risk thresholds
- AI confidence thresholds
- refund periods
- seller verification requirements
- transaction limits
- RFQ rules
- listing review thresholds

Policies must be versioned.

Historic transactions retain the policy version originally applied.

---

# 36. FEATURE FLAGS & ROLLOUTS

Major features must support controlled rollout:

- OFF
- internal only
- selected accounts
- selected sellers
- selected categories
- selected countries
- percentage rollout
- full rollout

Support rollback/kill switches for high-risk functions.

---

# 37. EVENT-DRIVEN INTEGRATION

Modules should communicate through durable contracts and events.

Examples:

user.created
seller.verified
request.created
request.interpreted
request.matched
listing.created
listing.reviewed
listing.published
offer.created
rfq.created
quote.received
order.created
order.confirmed
payment.authorised
payment.captured
delivery.assigned
delivery.completed
stay.checked_out
service.completed
buyer.accepted
dispute.created
refund.created
settlement.eligible
settlement.released
reward.earned
commission.created
risk.escalated

Critical events require:
- idempotency
- retries
- dead-letter handling
- observability
- safe replay where appropriate
- consumer-side deduplication
- transaction/crash-window handling

---

# 38. FINANCIAL ARCHITECTURE

AI must never be the financial authority.

Use deterministic services for:

- order totals
- payments
- refunds
- ledger
- commissions
- rewards
- settlements
- reserves
- guarantee exposure
- payouts

Maintain auditable append-only/immutable financial records where appropriate.

External payment operations must use idempotency keys.

A crash after payment capture must never produce an invisible/unrecoverable order.

---

# 39. SELLER / BUYER PROTECTION

A transaction should preserve immutable commercial evidence:

- listing snapshot
- title/description
- media references
- price
- quantity
- condition
- seller representations
- policy version
- buyer acceptance
- payment history
- delivery/stay/service milestones
- messages/evidence where permitted

Used/high-risk categories can support:
- inspection period
- serial verification
- delayed settlement
- evidence comparison
- independent inspection
- buyer acceptance window

---

# 40. SECURITY & PRIVACY

Mandatory:
- secure auth
- MFA support
- least privilege
- RBAC/ABAC as appropriate
- server-side authorisation
- data isolation
- input validation
- webhook signing
- secure secrets
- encryption
- rate limits
- abuse detection
- audit logs
- secure session/cookie handling
- dependency scanning
- security testing
- privacy controls
- consent
- retention policies
- data minimisation

Staff access to conversations and sensitive records must be logged.

---

# 41. ANTI-CLONE / IP PROTECTION

The defensibility of JAYA should remain server-side and data/network driven.

Do not expose:
- proprietary ranking weights
- private prompts
- fraud rules
- demand/supply intelligence algorithms
- customer intelligence logic
- seller risk logic
- private API secrets
- internal decision policies

Use:
- server-side logic
- API gateway
- scoped tokens
- rate limiting
- auth
- logging
- abuse detection
- feature flags
- access control

The long-term moat is the network, data, reputation, transaction history and intelligence rather than frontend code alone.

---

# 42. REPOSITORY AS PERSISTENT DEVELOPMENT MEMORY

The supervisor and Claude must not depend on conversation context alone.

Maintain:

/docs
- MASTER_PRODUCT_SPEC.md
- MASTER_IMPLEMENTATION_CHECKLIST.md
- CURRENT_IMPLEMENTATION_STATUS.md
- ARCHITECTURE.md
- MODULE_MAP.md
- DATABASE_SCHEMA.md
- API_CONTRACTS.md
- EVENT_CATALOG.md
- AI_ARCHITECTURE.md
- AI_MODEL_REGISTRY.md
- SECURITY_MODEL.md
- PERMISSIONS_MATRIX.md
- POLICY_CATALOG.md
- TEST_STRATEGY.md
- UX_SYSTEM.md
- DEPLOYMENT_GUIDE.md
- OPERATIONS_RUNBOOK.md
- DECISIONS_LEDGER.md
- KNOWN_LIMITATIONS.md
- CHANGELOG.md

This master guide may itself live under `/docs`.

---

# 43. OPENAI SUPERVISOR RESPONSIBILITIES

The OpenAI supervisor is NOT a passive relay between the human and Claude.

It must function as the development manager.

For every work cycle it should:

1. Read the master specification and current status.
2. Inspect the repository and existing tests relevant to the next task.
3. Identify the highest-priority unblocked task.
4. Check dependencies and architectural boundaries.
5. Create a bounded implementation instruction for Claude.
6. Require Claude to implement the complete vertical slice.
7. Review the implementation independently.
8. Run/review tests and inspect failures.
9. Search for omitted requirements.
10. Perform adversarial reasoning on critical flows.
11. Reject incomplete or brittle work.
12. Return precise correction instructions to Claude.
13. Repeat until the task meets Definition of Done.
14. Update checklist/status/docs.
15. Commit atomic changes where workflow permits.
16. Continue to the next task without waiting for human permission unless genuine escalation is required.

The supervisor must challenge Claude's claims of completion.

---

# 44. CLAUDE WORKER RESPONSIBILITIES

Claude is the primary implementation worker.

Claude must:

- inspect relevant existing code before editing
- respect module ownership/contracts
- avoid unrelated rewrites
- implement backend + data + API + UI + permissions + tests where relevant
- update migrations/contracts
- handle errors and edge cases
- preserve idempotency and crash safety
- run relevant tests
- report what changed
- report limitations honestly
- not mark placeholders complete
- not silently omit requirements
- not declare the overall project complete

Claude should make routine technical decisions autonomously inside the specification.

---

# 45. DEVELOPMENT TASK FORMAT

Every delegated task should specify:

TASK ID
MODULE
OBJECTIVE
BUSINESS PURPOSE
CURRENT STATE
IN SCOPE
OUT OF SCOPE
DEPENDENCIES
OWNED FILES/DATA
PUBLIC CONTRACTS
DATA CHANGES
API CHANGES
UI/UX CHANGES
EVENTS
SECURITY
FAILURE CASES
TESTS REQUIRED
ACCEPTANCE CRITERIA
DEFINITION OF DONE

This reduces ambiguous implementation and model wastage.

---

# 46. MODEL USAGE OPTIMISATION — DEVELOPMENT

Claude/OpenAI usage must be actively optimised.

Principles:

## Use the cheapest capable level for the task
Use strongest reasoning only for:
- architecture
- difficult debugging
- P0/P1 failures
- financial state machines
- security
- concurrency
- migration safety
- complex cross-module changes
- final independent review

Use lower-cost capable models/effort for:
- straightforward implementation
- boilerplate
- repetitive CRUD
- test expansion
- documentation
- formatting
- low-risk refactors

## Avoid rereading the entire repository
Use:
- `CURRENT_IMPLEMENTATION_STATUS.md`
- module docs
- dependency map
- targeted searches
- compact architecture summaries

## Keep tasks bounded
Do not tell a worker "finish everything" in one giant prompt.

Delegate module-sized vertical slices.

## Reuse discovered context
Do not repeatedly ask models to rediscover already documented architecture.

## Escalate only when needed
Routine worker failure:
→ retry with clearer bounded task.

Complex persistent failure:
→ stronger reasoning/reviewer.

## Avoid expensive circular review
Set clear acceptance criteria.
Fix concrete failures rather than repeating open-ended reviews endlessly.

## Batch related low-risk work
Small compatible tasks can be grouped when it reduces repeated context loading without weakening review.

## Track development AI usage
Where Conductor permits, record:
- model
- task
- reasoning level
- duration
- approximate usage/cost
- retries
- outcome

The supervisor should periodically identify wasteful patterns.

---

# 47. TESTING IS CONTINUOUS, NOT JUST FINAL

Do not wait until "the end" to test.

Testing happens at four levels:

## Level 1 — Task
After every implementation task:
- unit tests
- type/lint/build checks
- targeted module tests

## Level 2 — Module
Before module completion:
- integration
- permissions
- error paths
- UI/E2E
- idempotency/concurrency where relevant

## Level 3 — Phase
Before phase exit:
- cross-module E2E
- regression
- security review
- adversarial review
- data/migration checks

## Level 4 — Final Release
Before declaring release ready:
- full regression
- all critical user journeys
- financial adversarial suite
- permission matrix
- security checks
- performance/scale sanity
- responsive UI review
- recovery tests
- failure injection where practical

---

# 48. MANDATORY TEST TYPES

Relevant modules must include:

- unit
- integration
- API contract
- database
- migration
- permission
- negative/invalid input
- idempotency
- concurrency
- crash-window recovery
- webhook replay
- queue retry
- dead-letter handling
- E2E
- mobile/responsive
- accessibility
- AI evaluation
- security
- regression

Do not create meaningless tests merely to inflate counts.

Tests must defend important behaviour.

---

# 49. CRITICAL FINANCIAL / SETTLEMENT ADVERSARIAL SUITE

Mandatory scenarios include:

- duplicate payment webhook
- payment provider retry
- payment capture succeeds but process crashes immediately afterward
- order confirmation fails after payment
- duplicate refund
- partial refund then retry
- duplicate payout
- settlement worker crash
- duplicate settlement event
- seller payout and dispute race
- guarantee/security expires before payout
- accelerated payout exceeds permitted security exposure
- return after accelerated payout
- chargeback after seller payout
- commission event duplicated
- reward earn event duplicated
- reward reversal
- order cancellation during payment
- concurrent updates to same order
- delivery completion emitted twice
- accommodation checkout emitted twice
- queue consumer retry
- stale worker acting after newer state
- permission escalation attempt

No P0/P1 failures may remain before release.

---

# 50. LISTING / TRUST ADVERSARIAL SUITE

Test:

- AI misidentifies used item
- seller corrects it
- seller omits required title/ownership evidence
- duplicate image/listing
- suspicious price
- serial mismatch
- counterfeit risk
- prohibited category
- high-risk seller
- listing changed after purchase
- immutable order snapshot remains correct
- AI low confidence escalates
- human override audit
- policy version retained
- false-positive moderation appeal
- staff attempts unauthorised conversation access

---

# 51. UI/UX QUALITY GATE

Before a user-facing module is complete, independent review must confirm:

- mobile usability
- desktop usability
- visual hierarchy
- consistent design system
- understandable navigation
- low cognitive load
- sensible defaults
- minimal seller/buyer friction
- realistic data
- loading states
- empty states
- errors
- confirmations
- accessibility
- no dead controls
- no placeholder actions
- fast perceived interaction
- polished first-run experience

For JAYA, technically functional but mediocre UI is not considered complete.

---

# 52. BUG SEVERITY & STOP RULES

P0 — catastrophic:
- money lost/corrupted
- unrecoverable paid transaction
- cross-user data exposure
- severe auth/security flaw
- destructive migration/data loss
- settlement corruption

STOP all progression until fixed.

P1 — major:
- primary workflow broken
- significant security flaw
- major financial inconsistency
- core module unavailable

Must fix before phase completion.

P2 — important:
May proceed only if documented and non-blocking.

P3 — minor:
Backlog permitted.

---

# 53. NO SILENT REQUIREMENT LOSS

Every requirement must have one explicit state:

NOT STARTED
IN PROGRESS
NEEDS REVIEW
COMPLETE
BLOCKED
DEFERRED WITH REASON
OUT OF SCOPE WITH REASON

Nothing may disappear because the model forgot it.

---

# 54. NO PLACEHOLDER COMPLETION

A module is not complete if it contains user-facing or required-functionality placeholders such as:

- TODO
- fake success
- hardcoded mock data
- stub API
- non-functional button
- "coming soon"
- temporary bypass
- skipped authorization
- skipped tests

Temporary implementation scaffolding is allowed only while the item remains IN PROGRESS.

---

# 55. DEFINITION OF DONE — MODULE

A module can be marked complete only if all relevant layers are done:

- business requirement
- architecture
- database
- migration
- API
- events
- permissions
- backend logic
- AI/tool integration if needed
- frontend
- mobile UX
- desktop UX
- loading/error/empty states
- audit
- observability
- configuration
- tests
- security review
- documentation
- feature flags
- rollback considerations

Evidence must be recorded.

---

# 56. COMPLETION EVIDENCE

For every module/phase record:

MODULE/PHASE:
STATUS:

IMPLEMENTED:
TESTED:
TEST COMMANDS:
TEST RESULTS:
SECURITY:
UI/UX REVIEW:
MIGRATIONS:
EVENTS:
KNOWN LIMITATIONS:
DEFERRED:
COMMITS:
FOLLOW-UP:

The supervisor must not accept "done" without evidence.

---

# 57. AUTONOMOUS REVIEW LOOP

For every major task:

PLAN
↓
CLAUDE IMPLEMENTS
↓
BUILD / TEST
↓
OPENAI SUPERVISOR REVIEWS
↓
ADVERSARIAL CHECK
↓
CORRECTIONS TO CLAUDE
↓
RETEST
↓
DOCUMENT
↓
COMMIT
↓
NEXT TASK

Repeat as many times as needed.

---

# 58. CORRECTION LOOP RULE

When a review discovers a defect introduced by the previous correction, do not merely patch locally.

The supervisor must:

1. identify the failed invariant
2. determine whether architecture/state assumptions were wrong
3. inspect adjacent flows
4. create regression tests reproducing both the original defect and the new defect
5. correct the implementation
6. rerun the wider affected test suite
7. record the learning in the decisions/corrections ledger where appropriate

This prevents "fix one thing, break another" loops.

---

# 59. PHASED BUILD ORDER

The supervisor may adjust sequencing based on repository state, but the logical programme is:

## Phase 0 — Foundation
- repository/doc structure
- CI
- environments
- DB/migrations
- auth
- permissions
- events
- logging
- audit
- feature flags
- configuration
- design system
- AI gateway
- test infrastructure

## Phase 1 — Universal Account + Cockpit Foundations
- one account
- capabilities
- user cockpit shell
- seller cockpit shell
- operations cockpit shell
- shared navigation
- conversation foundation

## Phase 2 — Request / Need
- multimodal request
- AI interpretation
- clarification
- request lifecycle
- staff monitoring

## Phase 3 — Listing + CommerceUnit
- seller onboarding
- AI listing creation
- listing lifecycle
- risk pipeline
- human review

## Phase 4 — Catalog / Search / Matching
- search
- discovery
- supplier matching
- matching explanations

## Phase 5 — Offers / RFQ / Quotes
- direct offers
- reverse marketplace
- private supplier outreach
- quote ranking
- split fulfilment foundations

## Phase 6 — Orders / Payments / Ledger
- order state machine
- payment abstraction
- immutable commercial snapshot
- ledger
- refund foundation

## Phase 7 — Seller Payouts / Settlements / Risk
- standard holds
- policy milestones
- accelerated payout
- security instruments
- guarantee exposure
- settlement dashboard

## Phase 8 — Logistics / Fulfilment
- pickup
- delivery
- proof
- failures
- multi-stop foundations

## Phase 9 — Rewards / Referrals / Commissions
- points ledger
- rewards rules
- attribution
- configurable commissions

## Phase 10 — Used Goods / Category Risk Packs
- phones/electronics
- vehicles
- fashion/luxury
- generic high-risk used goods

## Phase 11 — Accommodation
- host
- property
- calendar
- reservation
- check-in/out
- settlement
- review/dispute

## Phase 12 — Budget / User Intelligence
- budgets
- spending
- committed spend
- personalisation
- recommendations

## Phase 13 — Seller Intelligence / Opportunities
- demand insights
- pricing
- missed demand
- stock suggestions
- performance analytics

## Phase 14 — Finance Provider Marketplace
- provider abstraction
- eligibility presentation
- working-capital opportunities

## Phase 15 — AI Control Plane Advanced
- registry UI
- routing controls
- shadow mode
- model evaluation
- multi-model checks
- cost optimisation
- improvement proposals

## Phase 16 — Advanced Operations / Autonomy
- richer conversation supervision
- exception routing
- risk automation
- sampling
- AI-first moderation
- opportunity engine

## Phase 17 — Omnichannel / Future Inputs
- WhatsApp
- voice
- browser
- AI glasses interface contracts
- partner APIs

## Phase 18 — Final Hardening
- full regression
- security
- financial adversarial suite
- performance
- UX review
- recovery
- production readiness

---

# 60. MASTER MVP USER JOURNEY

Minimum end-to-end user journey:

New user
→ registers one account
→ asks JAYA for an item
→ AI interprets the request
→ matching/search runs
→ valid offer/listing found
→ user selects
→ order created
→ payment succeeds in test/provider environment
→ seller receives order
→ fulfilment/delivery progresses
→ buyer receives status
→ transaction completes
→ settlement eligibility calculated
→ commission calculated
→ rewards if applicable
→ audit history exists
→ operations cockpit can inspect the transaction

No manual DB edits.

---

# 61. MASTER SELLER JOURNEY

New user
→ activates seller capability
→ provides basic seller/tax/payout details
→ creates listing with photos
→ AI proposes listing content
→ seller confirms declarations
→ risk pipeline runs
→ publishes or enters review
→ buyer/request matches
→ seller receives order/opportunity
→ seller fulfils
→ funds enter settlement policy
→ seller sees held/available funds
→ accelerated payout rules work if eligible
→ performance and market insights update

---

# 62. MASTER ACCOMMODATION JOURNEY

User activates host capability
→ lists property
→ AI helps listing
→ availability/pricing configured
→ guest searches/asks JAYA
→ property matched
→ reservation
→ payment
→ check-in
→ checkout
→ settlement eligibility
→ rewards/review/dispute where applicable
→ operations can supervise exceptions

---

# 63. OPERATIONS ACCEPTANCE

Staff must be able to:

- monitor live platform activity
- inspect a request
- inspect a listing
- review a risky item
- review seller verification/risk
- inspect payment/settlement state
- inspect guarantee/security exposure
- inspect relevant conversation with permission
- take over an escalated conversation
- view AI decision metadata
- view model/cost/latency
- change permitted configuration
- use feature flags
- audit who changed what

---

# 64. PRODUCTION COMPLETION RULE

The OpenAI supervisor may NOT state "project completed" unless:

- all required release checklist items are complete
- no P0 defects
- no P1 defects
- critical E2E journeys pass
- critical financial adversarial suite passes
- permissions pass
- migrations validated
- security gates pass
- UI/UX gates pass
- mobile and desktop critical flows pass
- production deployment is healthy
- monitoring is active
- `CURRENT_IMPLEMENTATION_STATUS.md` is accurate
- known limitations are documented
- no required placeholder/stub remains

Use accurate statuses such as:
- phase complete
- module complete
- MVP candidate
- release candidate
- partially complete
- blocked

---

# 65. HUMAN ESCALATION RULE

Do not ask the human owner for routine coding decisions.

Escalate only when necessary for:

- conflicting business policy
- legal/regulatory choice
- credentials/access
- missing external service
- irreversible commercial decision
- ambiguous high-impact product decision
- genuinely unresolvable requirement conflict

When escalating:
- explain the issue briefly
- provide recommended option
- provide alternatives
- identify what work can continue in parallel

---

# 66. AUTONOMOUS CONTINUATION RULE

Unless blocked:

1. finish current task
2. test
3. independently review
4. correct
5. retest
6. update docs/checklists
7. commit
8. select next highest-priority unblocked task
9. continue

Do not stop simply because one module is complete.

---

# 67. DAILY CHANGE PROCESS

New requirements must first be classified:

- NEW MODULE
- MODULE EXTENSION
- POLICY CHANGE
- CONFIGURATION CHANGE
- UI/UX CHANGE
- AI CHANGE
- DATA CHANGE
- SECURITY/RISK CHANGE

Then:

impact analysis
→ identify owning module
→ inspect contracts/dependencies
→ implement locally
→ module tests
→ integration tests
→ regression
→ UI review
→ security review if needed
→ feature flag
→ rollout

Avoid opportunistic changes to unrelated code.

---

# 68. FINAL DIRECTIVE TO OPENAI SUPERVISOR

You are the project's senior technical manager and autonomous development supervisor.

Claude is a powerful implementation worker, not the source of truth and not the final reviewer.

Your responsibility is to ensure JAYA is actually built — completely, modularly, safely and to first-class UI/UX standards.

You must:

- preserve the product vision
- preserve module boundaries
- prevent requirement loss
- prevent false completion
- optimise model usage
- control development cost
- direct Claude precisely
- independently review Claude
- require rigorous testing
- challenge unsafe assumptions
- enforce financial correctness
- enforce security
- enforce UI/UX quality
- keep repository documentation current
- continue autonomously through the roadmap
- escalate to the human only when genuinely required

The desired end state is:

> **One JAYA account, one intelligent commerce cockpit, one modular commerce network, capable of safely coordinating almost any permitted request, listing, purchase, sale, stay or service through AI-assisted commerce.**
