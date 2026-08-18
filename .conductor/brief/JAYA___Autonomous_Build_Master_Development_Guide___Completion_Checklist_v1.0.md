# JAYA
# Autonomous Build Master Development Guide & Completion Checklist
## Version 1.0

---

# 0. PURPOSE OF THIS DOCUMENT

This document is the **authoritative development specification** for the autonomous construction of the JAYA / Janajaya P2P AI Commerce Network.

It converts the JAYA business playbook into an executable engineering programme for:

- autonomous AI coding systems;
- coding agents;
- orchestrator agents;
- Claude Code or equivalent workers;
- human developers supervising the build;
- QA/review agents;
- security reviewers;
- deployment agents.

This document is the **master source of truth** for development.

The builder must not treat a feature as complete merely because:

- a page exists;
- a button appears;
- a mockup renders;
- an API route has been stubbed;
- dummy data works;
- a database table exists.

A feature is complete only when all relevant layers function together.

---

# 1. MASTER PRODUCT DEFINITION

JAYA is an:

> **AI-native peer-to-peer commerce and transaction orchestration network.**

It connects:

```text
Buyer
  ↕
JAYA AI
  ↕
Suppliers
  ↕
Service Providers
  ↕
Logistics
  ↕
Payments
  ↕
Introducers / Network Participants
```

JAYA must NOT be architected primarily as:

- an ecommerce store;
- supermarket application;
- classified advertising website;
- simple chatbot;
- conventional marketplace;
- inventory-owning retailer.

The system must instead be centred around:

```text
NEED
   ↓
UNDERSTANDING
   ↓
MATCHING
   ↓
OFFERS
   ↓
TRANSACTION
   ↓
FULFILMENT
```

---

# 2. PRODUCT NORTH STAR

Every feature and technical decision must support this question:

> **Does this make it easier for somebody with a need to be intelligently connected with somebody capable of fulfilling that need and safely completing the transaction?**

If not, reconsider whether the feature belongs in the core product.

---

# 3. DEVELOPMENT OPERATING PRINCIPLES

The autonomous development system MUST follow these principles.

## 3.1 Build complete vertical slices

Do not build:

- all frontend first;
- then backend;
- then database;
- then testing.

Instead build functional slices.

Example:

```text
Customer creates Need
→ database record
→ AI classification
→ supplier search
→ API
→ frontend
→ status update
→ audit event
→ test
```

Complete the whole flow before claiming completion.

---

## 3.2 Never silently drop requirements

Every requirement must end in one of:

```text
IMPLEMENTED
TESTED
DEFERRED WITH REASON
BLOCKED WITH REASON
OUT OF SCOPE
```

Nothing may simply disappear.

---

## 3.3 No placeholder completion

Forbidden completion patterns include:

```text
TODO
Coming Soon
mock endpoint
fake button
temporary static response
hard-coded fake database response
dummy success handler
```

These may exist temporarily during implementation but cannot remain in a module marked complete.

---

## 3.4 AI recommends; deterministic systems execute

LLMs may:

- interpret;
- classify;
- recommend;
- rank;
- summarise;
- negotiate;
- predict;
- guide.

LLMs must NOT independently become the authoritative source for:

- payment balances;
- order amount;
- transaction status;
- commission amount;
- settlement status;
- permissions;
- user authority;
- refund state;
- financial ledger;
- legally binding acceptance.

---

# 4. AUTONOMOUS DEVELOPMENT GOVERNANCE

The development agent must maintain the following files throughout development.

```text
/docs
    MASTER_PRODUCT_SPEC.md
    MASTER_IMPLEMENTATION_CHECKLIST.md
    CURRENT_IMPLEMENTATION_STATUS.md
    ARCHITECTURE.md
    DATABASE_SCHEMA.md
    API_CONTRACTS.md
    AI_ARCHITECTURE.md
    SECURITY_MODEL.md
    PERMISSIONS_MATRIX.md
    EVENT_CATALOG.md
    TEST_STRATEGY.md
    DEPLOYMENT_GUIDE.md
    OPERATIONS_RUNBOOK.md
    KNOWN_LIMITATIONS.md
    DECISIONS_LEDGER.md
    CHANGELOG.md
```

These documents must remain aligned with the codebase.

---

# 5. ANTI-DRIFT RULE

Before starting any major task, the autonomous developer must check:

```text
1. MASTER_PRODUCT_SPEC
2. CURRENT_IMPLEMENTATION_STATUS
3. MASTER_IMPLEMENTATION_CHECKLIST
4. Relevant architecture document
5. Existing code
6. Existing tests
```

The agent must never rely only on its current conversation context.

The repository is the persistent development memory.

---

# 6. DEVELOPMENT STATUS SYSTEM

Every major feature must have one status.

```text
[ ] NOT STARTED

[~] IN PROGRESS

[?] NEEDS REVIEW

[x] COMPLETE

[!] BLOCKED

[-] INTENTIONALLY DEFERRED
```

A completed item must have evidence.

Example:

```text
[x] Customer Need Creation

Evidence:
- API implemented
- DB migration committed
- UI implemented
- permissions tested
- event emitted
- integration test passes
- error states tested
```

---

# 7. SYSTEM ARCHITECTURE

Target high-level architecture:

```text
CLIENT CHANNELS
│
├── Web
├── Mobile App
├── WhatsApp
├── Voice
├── Browser Extension
├── Future AI Glasses
└── Partner APIs
       │
       ▼
API / CHANNEL GATEWAY
       │
       ▼
IDENTITY + SESSION LAYER
       │
       ▼
JAYA ORCHESTRATION LAYER
       │
       ├── Intent Engine
       ├── Need Interpreter
       ├── Search Agent
       ├── Product Identification
       ├── Procurement Agent
       ├── Recommendation Agent
       ├── Negotiation Agent
       ├── Supplier Agent
       ├── Logistics Agent
       └── Support Agent
       │
       ▼
COMMERCE DOMAIN SERVICES
       │
       ├── Customers
       ├── Needs
       ├── Products
       ├── Suppliers
       ├── Offers
       ├── RFQs
       ├── Quotes
       ├── Orders
       ├── Payments
       ├── Settlements
       ├── Delivery
       ├── Quality
       ├── Reputation
       ├── Referrals
       ├── Commission
       └── Disputes
       │
       ▼
DATA + EVENT LAYER
       │
       ├── Operational DB
       ├── Event Bus
       ├── Search Index
       ├── Vector Store
       ├── Object Storage
       ├── Analytics
       └── Audit Log
```

---

# 8. ARCHITECTURAL REQUIREMENT — MODULAR MONOLITH FIRST

Unless scale requires otherwise, start as a **well-structured modular monolith**.

Do NOT create premature microservice complexity.

Each business domain must still maintain clean boundaries.

Example modules:

```text
/modules
    identity
    customer
    supplier
    catalog
    need
    matching
    rfq
    order
    payment
    settlement
    logistics
    referral
    reputation
    quality
    ai
    notifications
    admin
```

Migration to services later must be possible without rewriting the business logic.

---

# 9. CORE DOMAIN OBJECTS

The database and domain model must support at minimum:

- User
- Customer Profile
- Business Profile
- Supplier
- Supplier Location
- Supplier Capability
- Product
- Product Variant
- Inventory
- Need
- Need Item
- Offer
- RFQ
- RFQ Supplier Invitation
- Quote
- Order
- Order Item
- Payment
- Refund
- Settlement
- Delivery
- Delivery Stop
- Inspection
- Dispute
- Return
- Warranty
- Referral
- Attribution
- Commission
- Reputation Event
- Conversation
- Message
- AI Run
- AI Decision
- Notification
- Consent
- Permission
- Audit Event

---

# 10. NEED OBJECT — PRIMARY COMMERCE PRIMITIVE

The Need object is one of the most important records in the entire platform.

It must support:

```text
Need ID
Customer ID
Intent
Original customer input
Structured interpretation
Item/category
Quantity
Units
Budget
Maximum price
Location
Required date/time
Quality requirements
Brand preferences
Acceptable substitutes
Delivery preferences
Payment preferences
Images/files
Confidence score
AI interpretation
Human corrections
Matching status
RFQ status
Order linkage
Completion status
Created timestamp
Updated timestamp
```

---

# 11. NEED LIFECYCLE

Required states:

```text
DRAFT
RECEIVED
INTERPRETING
NEEDS_CLARIFICATION
READY
SEARCHING
MATCHED
SUPPLIER_OUTREACH
RFQ_ACTIVE
OFFERS_RECEIVED
RECOMMENDATION_READY
CUSTOMER_DECISION
ORDER_CREATED
FULFILLING
COMPLETED
CANCELLED
FAILED
```

Transitions must be deterministic and validated.

---

# 12. NEED CREATION CHANNELS

The architecture must support a common Need ingestion interface for:

- text;
- chat;
- voice transcription;
- photographs;
- screenshots;
- videos;
- URLs;
- barcode;
- QR;
- document;
- API;
- future wearable input.

All inputs should eventually enter the same Need pipeline.

---

# 13. AI PRODUCT IDENTIFICATION MODULE

## Required functionality

The AI must attempt to determine from images/content:

- product category;
- probable manufacturer;
- model;
- variant;
- visible text;
- visible identifiers;
- condition;
- colour;
- approximate dimensions where possible;
- likely compatibility;
- missing information required.

## Confidence thresholds

Example policy:

```text
>= 0.90
Can present confident identification

0.70–0.89
Present as probable and request confirmation

0.40–0.69
Ask targeted clarifying questions

< 0.40
Do not guess as fact
```

All confidence thresholds must be configurable.

---

# 14. PRODUCT IDENTIFICATION HUMAN CORRECTION

The customer or supplier must be able to correct AI identification.

Store:

```text
AI prediction
Confidence
Correction
Corrected by
Timestamp
Model/version
Reason where available
```

These records should later improve training/evaluation.

---

# 15. SEARCH PIPELINE

The system must follow this priority.

```text
1. Existing JAYA inventory
2. Known supplier capabilities
3. Historical supply matches
4. Private supplier outreach
5. Approved external sources
6. RFQ
```

Do NOT immediately expose every Need publicly.

---

# 16. MATCHING ENGINE

Supplier matching must support weighted scoring.

Example:

```text
MATCH SCORE =
product compatibility
+ stock probability
+ location proximity
+ price competitiveness
+ fulfilment score
+ customer preference
+ response history
+ delivery compatibility
+ quality requirements
```

Weights must be configurable.

Store match explanations.

---

# 17. SUPPLIER MODULE

## Required

Supplier records must support:

- business information;
- verification state;
- contacts;
- locations;
- delivery areas;
- categories;
- capabilities;
- stock/inventory;
- price rules;
- operating hours;
- payment terms;
- service areas;
- performance;
- onboarding source;
- introducer;
- documents;
- active/inactive state.

---

# 18. SUPPLIER ONBOARDING

Support:

- manual form;
- AI-assisted onboarding;
- photograph-based product creation;
- spreadsheet upload;
- API;
- POS integration later;
- conversational onboarding.

Supplier onboarding must not require advanced technical knowledge.

---

# 19. AI SUPPLIER DASHBOARD

Build intelligence cards including:

- current demand;
- predicted demand;
- open matching opportunities;
- missed sales;
- price competitiveness;
- response time;
- order performance;
- stock recommendations;
- regional demand;
- repeat customer trends.

Initial versions may use basic analytics before predictive models are introduced.

---

# 20. RFQ MODULE

RFQ must support:

- one product;
- multiple products;
- quantities;
- quality specification;
- images;
- delivery location;
- delivery deadline;
- partial fulfilment;
- acceptable substitutes;
- payment terms;
- quote closing time;
- supplier visibility rules;
- attachments;
- inspection requirements.

---

# 21. RFQ PRIVACY MODES

Support:

```text
PRIVATE
SELECTED_SUPPLIERS
VERIFIED_NETWORK
PUBLIC_NETWORK
```

Default preference should be targeted supplier matching rather than uncontrolled public posting.

---

# 22. QUOTE MODULE

Quote must include:

- supplier;
- RFQ;
- offered products;
- quantity;
- unit price;
- taxes/fees if applicable;
- delivery fee;
- total landed cost;
- delivery promise;
- warranty;
- substitutions;
- terms;
- validity period;
- attachments.

---

# 23. AI QUOTE EVALUATION

JAYA must calculate an explainable commercial ranking.

Factors include:

- landed price;
- supplier reliability;
- quality;
- distance;
- delivery probability;
- warranty;
- payment terms;
- customer preferences;
- prior experience;
- dispute history.

AI-generated summaries must not alter actual quote values.

---

# 24. SPLIT FULFILMENT ENGINE

The system must support satisfying one Need through multiple suppliers.

Example:

```text
Required: 10,000 units

Supplier A = 4,000
Supplier B = 3,000
Supplier C = 3,000
```

The platform must calculate:

- combined quantity;
- combined price;
- delivery implications;
- multiple settlements;
- customer-facing unified order experience.

---

# 25. ORDER ENGINE

Order states:

```text
DRAFT
PENDING_APPROVAL
APPROVED
AWAITING_PAYMENT
PAID
CONFIRMED
PREPARING
READY_FOR_PICKUP
IN_DELIVERY
DELIVERED
PENDING_ACCEPTANCE
COMPLETED
CANCELLED
DISPUTED
REFUNDED
PARTIALLY_REFUNDED
```

State transitions must be validated.

---

# 26. ORDER IMMUTABILITY PRINCIPLE

After customer confirmation, critical commercial values must not be silently mutated.

Store snapshots of:

- product;
- quantity;
- price;
- supplier;
- fees;
- tax;
- delivery;
- terms.

Any modification should create explicit revisions or adjustment records.

---

# 27. TRANSACTION ENGINE

A confirmed transaction must bind:

```text
Need
Offer / Quote
Customer
Supplier
Order
Payment
Delivery
Settlement
Commission
```

References must remain auditable.

---

# 28. PAYMENT ARCHITECTURE

Payment providers must be abstracted.

Required internal states:

```text
CREATED
PENDING
AUTHORISED
CAPTURED
FAILED
CANCELLED
PARTIALLY_REFUNDED
REFUNDED
```

Use idempotency keys for external payment operations.

---

# 29. FINANCIAL LEDGER

Do not derive money balances by reconstructing UI states.

Maintain an immutable or append-only ledger for:

- customer payment;
- supplier payable;
- refund;
- commission;
- platform fee;
- logistics fee;
- settlement;
- adjustment.

---

# 30. SETTLEMENT ENGINE

Support:

- supplier settlements;
- logistics payouts;
- introducer commissions;
- platform commissions;
- refund deductions;
- disputes/holds.

No AI agent may manually alter settlement totals.

---

# 31. LOGISTICS MODULE

Support:

- pickup;
- delivery;
- multi-stop delivery;
- driver/provider assignment;
- transport type;
- delivery window;
- GPS tracking;
- proof of pickup;
- proof of delivery;
- failed delivery;
- reschedule.

---

# 32. ROUTE CONSOLIDATION

Prepare architecture for:

```text
Supplier A
   ↓
Supplier B
   ↓
Supplier C
   ↓
Customer
```

Optimisation may initially be simple but interfaces must allow later route optimisation algorithms.

---

# 33. SERVICE PROVIDER MODULE

Services remain secondary but must use reusable provider architecture.

Examples:

- installer;
- repairer;
- transporter;
- mechanic;
- electrician;
- tester;
- inspector.

The same provider framework should support multiple industries.

---

# 34. REPUTATION SYSTEM

Do not rely purely on average star ratings.

Create event-based reputation.

Examples:

```text
order.completed
order.cancelled_by_supplier
delivery.late
quality.dispute
refund.required
customer.repeat_purchase
rfq.response_fast
inspection.passed
```

Compute reputation from underlying events.

---

# 35. REFERRAL / INTRODUCER MODULE

Support relationships:

```text
User A
introduced
Supplier B

User A
introduced
Customer C
```

Referral earnings must be linked to actual qualifying transactions.

Do NOT reward recruitment alone.

---

# 36. ATTRIBUTION ENGINE

Attribution must store:

- introducer;
- introduced entity;
- event;
- campaign;
- transaction;
- attribution model;
- attribution window;
- commission rule;
- qualifying state.

---

# 37. COMMISSION ENGINE

Commission rules must be configurable by:

- supplier;
- category;
- customer;
- introducer type;
- transaction type;
- campaign;
- geography;
- time window.

Commission calculation must be deterministic.

---

# 38. CONVERSATION-FIRST UX

The customer home interface should prioritise:

```text
What do you need?
```

Input modes:

- type;
- voice;
- camera;
- upload;
- paste link.

Traditional product browsing remains available but is secondary.

---

# 39. CHAT EXPERIENCE

Conversation should display commerce objects naturally.

Example:

```text
USER:
Need 20kg red onions tomorrow.

JAYA:
I found three suppliers.

[Offer Card]
[Offer Card]
[Offer Card]
```

Buttons should allow:

- view;
- compare;
- ask question;
- select;
- purchase.

---

# 40. UNIFIED CONVERSATION CONTEXT

A customer must be able to continue an existing commercial conversation through another channel.

Example:

```text
Web → WhatsApp → Voice → App
```

All channels must resolve to the same:

- customer identity;
- conversation;
- Need;
- order;
- preferences.

---

# 41. CUSTOMER MEMORY ARCHITECTURE

Separate:

```text
Identity Memory
Preference Memory
Transaction Memory
Conversation Memory
Relationship Memory
Product Memory
Predictive Memory
```

Do not load all memory into every model request.

---

# 42. AI MODEL GATEWAY

No AI provider may be hardcoded throughout the application.

Create:

```text
AI Gateway
    ├── OpenAI Adapter
    ├── Anthropic Adapter
    ├── Google Adapter
    ├── DeepSeek Adapter
    ├── Kimi Adapter
    └── Local/Open Source Adapter
```

Provider availability may change.

---

# 43. TASK-BASED MODEL ROUTING

Route models according to task type.

Example:

```text
Simple classification
→ small/cheap model

Conversation
→ balanced model

Complex procurement reasoning
→ advanced reasoning model

Vision
→ vision-capable model

Embeddings
→ embedding model

Bulk offline classification
→ low-cost model
```

---

# 44. COST CONTROL

Implement:

- token budgets;
- model budgets;
- request caching;
- conversation summarisation;
- retrieval;
- structured memory;
- response reuse;
- model downgrade;
- retry strategies;
- maximum reasoning budgets;
- usage monitoring.

---

# 45. AI OBSERVABILITY

Every important AI call should record:

```text
Provider
Model
Task
Prompt version
Token usage
Estimated cost
Latency
Outcome
Tool calls
Confidence
Error
Fallback model
```

Do not log sensitive content unnecessarily.

---

# 46. AI DECISION AUDIT

When AI materially affects a commercial workflow, store:

```text
Decision
Inputs/reference IDs
Recommendation
Confidence
Reason summary
Model
Version
Timestamp
Human override
Final action
```

---

# 47. AGENT PERMISSION MODEL

Agents receive explicit tool capabilities.

Example:

```text
Search Agent:
CAN search products
CAN query suppliers
CANNOT create payment

Procurement Agent:
CAN prepare recommendation
CANNOT capture money

Payment Service:
CAN execute authorised payment
CANNOT choose supplier
```

Never give a general LLM unrestricted database access.

---

# 48. AI AUTHORITY ENVELOPE

Future autonomous purchasing must use rules.

Example:

```text
User allows:
Category = household groceries
Maximum order = Rs. 10,000
Monthly maximum = Rs. 50,000
Price variation = < 5%
Supplier score = > 90
```

The AI can execute only when ALL rules pass.

---

# 49. PRIVACY SYSTEM

Implement consent for:

- GPS;
- behavioural personalisation;
- image processing;
- microphone;
- browser integration;
- wearable integration;
- marketing;
- AI memory;
- third-party sharing where applicable.

---

# 50. DATA MINIMISATION

Do not collect data merely because it may someday be useful.

Data must have:

```text
Purpose
Retention policy
Access policy
Consent basis where required
```

---

# 51. SECURITY BASELINE

Mandatory:

- secure authentication;
- MFA support;
- RBAC;
- least privilege;
- tenant isolation where applicable;
- encryption in transit;
- encryption at rest;
- secrets manager;
- rate limits;
- validation;
- sanitisation;
- CSRF protection where relevant;
- secure cookies;
- API authentication;
- webhook signing;
- dependency scanning;
- audit logging.

---

# 52. ROLE SYSTEM

Initial roles:

```text
CUSTOMER
SUPPLIER
SERVICE_PROVIDER
DRIVER
STAFF
OPERATIONS
FINANCE
SUPPORT
MANAGER
ADMIN
SUPER_ADMIN
AI_AGENT
```

Permissions must be explicit.

---

# 53. AUDIT LOG

Capture sensitive actions including:

- account changes;
- permission changes;
- supplier verification;
- quote modification;
- order approval;
- refund;
- payment action;
- settlement;
- commission adjustment;
- dispute decision;
- admin override.

---

# 54. ANTI-CLONE / IP PROTECTION

Business-critical intelligence should remain server-side.

Never expose:

- full matching logic;
- proprietary ranking weights;
- customer intelligence models;
- supplier intelligence algorithms;
- fraud rules;
- internal pricing models;
- private prompts;
- API secrets.

---

# 55. API SECURITY

Implement:

- authenticated APIs;
- signed requests where required;
- rate limiting;
- scoped tokens;
- server-side authorisation;
- API versioning;
- abuse detection;
- request IDs;
- idempotency.

---

# 56. EVENT ARCHITECTURE

Required event catalogue initially:

```text
user.created
supplier.created
supplier.verified

need.created
need.interpreted
need.updated
need.ready
need.matched
need.failed

supplier.match_created
supplier.invited

rfq.created
rfq.published
quote.received

offer.created
offer.selected

order.created
order.confirmed
order.cancelled
order.completed

payment.created
payment.authorised
payment.captured
payment.failed
payment.refunded

delivery.created
delivery.assigned
delivery.picked_up
delivery.completed

inspection.created
inspection.completed

settlement.created
settlement.released

commission.created
commission.earned
commission.paid

dispute.created
dispute.resolved
```

---

# 57. EVENT RELIABILITY

Critical events must support:

- retries;
- idempotency;
- dead-letter handling;
- observability;
- replay where safe.

---

# 58. ADMIN / OPERATIONS CONTROL CENTRE

Build one central operations application.

Required dashboards:

### Customers

### Suppliers

### Needs

### Matching

### RFQs

### Orders

### Payments

### Settlements

### Logistics

### Disputes

### Referrals

### AI Operations

### Platform Health

---

# 59. UNMATCHED NEEDS DASHBOARD

This is strategically important.

Show:

- requested product;
- category;
- number of requests;
- geography;
- estimated demand;
- reason unmatched.

This helps JAYA decide what suppliers to recruit.

---

# 60. MARKET OPPORTUNITY ENGINE

Later AI should identify patterns such as:

> 68 unresolved requests for Product X in Kandy in 14 days.

Recommended action:

```text
Recruit suppliers
Expand delivery area
Create import opportunity
Aggregate purchasing
```

---

# 61. CUSTOMER FRONTEND MVP

Checklist:

- [ ] Authentication
- [ ] Customer onboarding
- [ ] Main conversational home
- [ ] Text Need creation
- [ ] Image Need creation
- [ ] Voice input
- [ ] Need history
- [ ] Offers
- [ ] Offer comparison
- [ ] Product browsing
- [ ] Cart/order
- [ ] Payment
- [ ] Delivery tracking
- [ ] Order history
- [ ] Notifications
- [ ] Profile
- [ ] Preferences
- [ ] Privacy controls
- [ ] Support
- [ ] Responsive mobile experience

---

# 62. SUPPLIER FRONTEND MVP

Checklist:

- [ ] Supplier signup
- [ ] Verification workflow
- [ ] Business profile
- [ ] Locations
- [ ] Product creation
- [ ] AI image-assisted creation
- [ ] Inventory
- [ ] Pricing
- [ ] Incoming Needs
- [ ] RFQ invitations
- [ ] Quote submission
- [ ] Orders
- [ ] Delivery readiness
- [ ] Settlement history
- [ ] Performance
- [ ] Basic demand analytics
- [ ] Notifications

---

# 63. OPERATIONS FRONTEND MVP

Checklist:

- [ ] Staff login
- [ ] Role-based access
- [ ] Live Need queue
- [ ] AI confidence alerts
- [ ] Unmatched Needs
- [ ] Suppliers
- [ ] Supplier verification
- [ ] RFQs
- [ ] Orders
- [ ] Payments
- [ ] Logistics
- [ ] Refunds
- [ ] Disputes
- [ ] AI runs
- [ ] Exceptions
- [ ] Audit trail
- [ ] Platform health

---

# 64. PHASE 0 — FOUNDATION

Do not begin major feature development until the following are complete.

- [ ] Repository structure created
- [ ] CI pipeline
- [ ] Staging environment
- [ ] Production environment design
- [ ] Environment validation
- [ ] Database setup
- [ ] Migration system
- [ ] Authentication
- [ ] Permissions framework
- [ ] Logging
- [ ] Error monitoring
- [ ] API conventions
- [ ] Event conventions
- [ ] Testing framework
- [ ] AI provider abstraction
- [ ] File/object storage
- [ ] Feature flags
- [ ] Audit framework
- [ ] Development docs

## Phase 0 exit gate

All foundation tests pass before Phase 1.

---

# 65. PHASE 1 — CORE CUSTOMER-TO-SUPPLIER COMMERCE

Build:

```text
Customer
→ Need
→ AI interpretation
→ supplier/product search
→ offer
→ order
→ payment
→ delivery
→ completion
```

Checklist:

- [ ] Customer account
- [ ] Need model
- [ ] Need API
- [ ] Need UI
- [ ] AI interpretation
- [ ] Product search
- [ ] Supplier database
- [ ] Supplier search
- [ ] Offer model
- [ ] Offer recommendation
- [ ] Order engine
- [ ] Payment abstraction
- [ ] Delivery basics
- [ ] Notification system
- [ ] Order completion
- [ ] Full integration test

## Phase 1 Definition of Done

A new customer must be able to:

1. create account;
2. tell JAYA what they need;
3. receive at least one valid supplier/product option;
4. choose;
5. create an order;
6. pay using test payment environment;
7. receive delivery status;
8. complete the transaction.

No manual database edits permitted.

---

# 66. PHASE 2 — AI PRODUCT IDENTIFICATION

- [ ] Photo upload
- [ ] Multi-photo support
- [ ] Vision model abstraction
- [ ] OCR
- [ ] Item recognition
- [ ] Confidence
- [ ] Clarifying question
- [ ] User correction
- [ ] Structured product result
- [ ] Search integration
- [ ] Logging
- [ ] Evaluation dataset
- [ ] Accuracy tests

---

# 67. PHASE 3 — SUPPLIER NETWORK

- [ ] Supplier self-onboarding
- [ ] Verification
- [ ] Locations
- [ ] Capabilities
- [ ] Inventory
- [ ] AI product upload
- [ ] Pricing
- [ ] Order processing
- [ ] Availability
- [ ] Supplier notifications
- [ ] Performance
- [ ] Settlement view

---

# 68. PHASE 4 — RFQ & REVERSE MARKETPLACE

- [ ] RFQ generation
- [ ] Supplier selection
- [ ] Supplier invitations
- [ ] Quote submissions
- [ ] Closing times
- [ ] Comparison
- [ ] AI ranking
- [ ] Customer selection
- [ ] Partial fulfilment
- [ ] Split supplier orders
- [ ] Quote audit
- [ ] RFQ analytics

---

# 69. PHASE 5 — LOGISTICS ORCHESTRATION

- [ ] Logistics providers
- [ ] Delivery jobs
- [ ] Assignment
- [ ] Pickup
- [ ] Tracking
- [ ] Proof of delivery
- [ ] Delivery failure
- [ ] Reassignment
- [ ] Multi-stop preparation
- [ ] Delivery pricing
- [ ] Customer notifications
- [ ] Supplier notifications

---

# 70. PHASE 6 — P2P REFERRAL NETWORK

- [ ] User referral IDs
- [ ] Supplier introduction
- [ ] Customer introduction
- [ ] Attribution
- [ ] Qualification rules
- [ ] Commission rules
- [ ] Commission ledger
- [ ] Pending earnings
- [ ] Earned earnings
- [ ] Reversal
- [ ] Settlement
- [ ] Abuse detection

---

# 71. PHASE 7 — CUSTOMER INTELLIGENCE

- [ ] Purchase preferences
- [ ] Brand preferences
- [ ] Price sensitivity
- [ ] Supplier preferences
- [ ] Delivery preferences
- [ ] Repeat purchase patterns
- [ ] Recommendations
- [ ] User controls
- [ ] Memory inspection
- [ ] Memory deletion
- [ ] Personalisation opt-out

---

# 72. PHASE 8 — SUPPLIER INTELLIGENCE

- [ ] Demand analytics
- [ ] Regional demand
- [ ] Price benchmark
- [ ] Missed opportunity
- [ ] Repeat customer data
- [ ] Inventory recommendation
- [ ] Demand forecast
- [ ] Supply recommendation
- [ ] Opportunity alerts

---

# 73. PHASE 9 — DEMAND AGGREGATION

- [ ] Similar Need clustering
- [ ] Geographic clustering
- [ ] Quantity aggregation
- [ ] Bulk quote requests
- [ ] Customer consent where required
- [ ] Shared procurement
- [ ] Split fulfilment
- [ ] Savings calculation

---

# 74. PHASE 10 — AUTONOMOUS PROCUREMENT

- [ ] Authority envelope
- [ ] Spending rules
- [ ] Category rules
- [ ] Supplier minimum rating
- [ ] Price variance rule
- [ ] Approval escalation
- [ ] Automated reorder
- [ ] Autonomous match selection
- [ ] Deterministic validation
- [ ] Kill switch
- [ ] Audit history

---

# 75. PHASE 11 — OMNICHANNEL

Add connectors incrementally.

- [ ] Web chat
- [ ] App
- [ ] WhatsApp
- [ ] Voice AI
- [ ] SMS
- [ ] Email
- [ ] Browser integration interface
- [ ] Wearable interface contract

Shared identity is mandatory.

---

# 76. PHASE 12 — QUALITY / CERTIFICATION ADAPTERS

Create generic interface.

```text
QualityProvider
InspectionRequest
InspectionResult
Certification
Verification
```

Potential integrations:

- agricultural grading;
- vehicles;
- machinery;
- gems/GSI;
- specialist testing.

---

# 77. PHASE 13 — ADVANCED MARKET INTELLIGENCE

- [ ] Demand map
- [ ] Supply map
- [ ] Shortage detection
- [ ] Oversupply detection
- [ ] Price trends
- [ ] Procurement suggestions
- [ ] Supplier recruitment recommendations
- [ ] Delivery optimisation
- [ ] Geographic expansion recommendations

---

# 78. TESTING STRATEGY

Every module must include:

- unit tests;
- integration tests;
- permission tests;
- API contract tests;
- edge-case tests;
- negative tests;
- concurrency tests where relevant;
- idempotency tests;
- UI tests;
- AI evaluation tests where relevant.

---

# 79. CRITICAL FINANCIAL TESTS

Mandatory adversarial scenarios:

- [ ] Duplicate payment webhook
- [ ] Payment timeout
- [ ] Payment success after client timeout
- [ ] Refund retry
- [ ] Double refund request
- [ ] Settlement retry
- [ ] Duplicate commission event
- [ ] Order cancellation during payment
- [ ] Payment succeeds but order process crashes
- [ ] Delivery completed twice
- [ ] Supplier payout retry
- [ ] Concurrency on same order

---

# 80. CRITICAL COMMERCE TESTS

- [ ] Need interpreted incorrectly
- [ ] Customer corrects product
- [ ] No suppliers found
- [ ] Supplier inventory changes after quote
- [ ] Quote expires
- [ ] Supplier withdraws
- [ ] Partial quantity only
- [ ] Multiple suppliers
- [ ] Customer cancels
- [ ] Supplier cancels
- [ ] Delivery fails
- [ ] Quality rejected
- [ ] Dispute opened

---

# 81. AI EVALUATION TESTING

Maintain benchmark sets for:

- Need extraction;
- product identification;
- supplier matching;
- quote ranking;
- recommendation quality;
- hallucination rate;
- unsafe transaction suggestions;
- clarification quality.

Models cannot be upgraded blindly.

Run evaluations before changing default models.

---

# 82. ERROR EXPERIENCE

Never show:

```text
Something went wrong
```

without useful handling.

Every failure should have:

- friendly customer message;
- internal error code;
- trace ID;
- retry path;
- escalation path where relevant.

---

# 83. HUMAN ESCALATION

AI must escalate when:

- confidence below threshold;
- disputed product identification;
- high-value transaction;
- suspicious behaviour;
- payment inconsistency;
- unresolved supplier failure;
- regulatory rule triggered;
- unresolved customer complaint.

---

# 84. OBSERVABILITY

Implement dashboards for:

- API errors;
- job failures;
- queue depth;
- latency;
- DB health;
- webhook health;
- payment failures;
- AI usage;
- AI spend;
- AI latency;
- fallback frequency;
- failed Needs;
- unmatched Needs;
- delivery failures.

---

# 85. AUTONOMOUS QA LOOP

At the completion of every phase:

```text
BUILD
 ↓
RUN TESTS
 ↓
SELF-REVIEW
 ↓
ADVERSARIAL REVIEW
 ↓
FIX
 ↓
RUN TESTS AGAIN
 ↓
UPDATE CHECKLIST
 ↓
UPDATE STATUS
 ↓
COMMIT
```

Do not proceed with known P0 or P1 defects.

---

# 86. BUG SEVERITY

## P0

System/data/financial catastrophe.

Examples:

- money captured without recoverable order;
- cross-user data leakage;
- settlement corruption;
- destructive security vulnerability.

**Immediate stop.**

---

## P1

Major feature broken or significant security/business problem.

Must fix before phase exit.

---

## P2

Important defect but workaround exists.

May proceed only if documented.

---

## P3

Minor visual/usability issue.

Can enter backlog.

---

# 87. SELF-REVIEW QUESTIONS

Before declaring any feature complete, ask:

### Functional

- Does it actually work end to end?
- Are all promised actions implemented?
- Are error paths functional?

### Data

- Is information persisted?
- Are state transitions valid?
- Is history retained?

### Security

- Can another user access it?
- Are server-side permissions enforced?
- Is sensitive data exposed?

### Reliability

- What happens if execution stops halfway?
- Can a retry create duplicates?
- Is the operation idempotent?

### UX

- Does mobile work?
- Are empty states handled?
- Are loading states handled?
- Are errors understandable?

### AI

- Can the model hallucinate a transaction value?
- What happens at low confidence?
- Can it perform unauthorised actions?

---

# 88. COMPLETION EVIDENCE FORMAT

For every phase, update:

```text
PHASE:
Phase 4 — RFQ

STATUS:
COMPLETE

IMPLEMENTED:
...

TESTED:
...

TEST COMMAND:
...

TEST RESULTS:
...

KNOWN LIMITATIONS:
...

SECURITY REVIEW:
PASS

DATA MIGRATIONS:
...

COMMITS:
...

DEFERRED:
...
```

---

# 89. AUTONOMOUS AGENT ROLES

Where the build system supports multiple agents, divide responsibility.

## Manager / Orchestrator

Owns:

- master plan;
- requirements;
- sequencing;
- task delegation;
- completion validation.

## Architect

Owns:

- architecture;
- module boundaries;
- data design;
- integration rules.

## Implementer

Writes code.

## QA Agent

Tests implementation independently.

## Adversarial Reviewer

Attempts to break assumptions.

## Security Reviewer

Reviews auth, permissions and attack surfaces.

## UX Reviewer

Tests usability and responsive behaviour.

## Documentation Agent

Keeps repository documentation synchronised.

The Implementer must not be the only agent deciding whether its work is correct.

---

# 90. TASK FORMAT FOR AUTONOMOUS DEVELOPMENT

Every delegated development task should contain:

```text
TASK ID

OBJECTIVE

BUSINESS PURPOSE

IN SCOPE

OUT OF SCOPE

DEPENDENCIES

FILES / MODULES

DATA CHANGES

API CHANGES

UI CHANGES

EVENTS

SECURITY REQUIREMENTS

ERROR CASES

TESTS REQUIRED

ACCEPTANCE CRITERIA

DEFINITION OF DONE
```

---

# 91. GIT WORKFLOW

Recommended:

```text
main
develop
feature/*
fix/*
```

Every task must end in an atomic commit.

Commit messages should identify feature/phase.

Example:

```text
feat(need): implement multimodal need creation
```

Do not commit broken partial work to production branches.

---

# 92. DATABASE MIGRATION RULES

- Never manually alter production schema.
- Every schema change requires migration.
- Migrations should be reversible where reasonably possible.
- Production data must not be casually deleted.
- Breaking migrations require explicit review.
- Financial history must never be rewritten without controlled adjustment.

---

# 93. DEPLOYMENT GATES

Production deployment requires:

- [ ] Build passes
- [ ] Type checks pass
- [ ] Lint passes
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Critical E2E passes
- [ ] Security checks pass
- [ ] Migrations validated
- [ ] Environment validation passes
- [ ] Rollback path available
- [ ] Monitoring active

---

# 94. FEATURE FLAG SYSTEM

High-risk modules should support controlled rollout.

Examples:

- autonomous purchasing;
- AI negotiation;
- referral payouts;
- new model providers;
- demand aggregation;
- supplier autopricing.

---

# 95. PRODUCT ANALYTICS

Track from the beginning:

```text
Need Created
Need Successfully Understood
Need Matched
RFQ Required
Offer Presented
Offer Selected
Order Created
Payment Completed
Delivery Completed
Transaction Completed
Repeat Customer
```

---

# 96. NORTH-STAR METRICS

Build reporting for:

- Need Fulfilment Rate
- Automatic Match Rate
- Time to Match
- Offer Conversion
- Transaction Completion Rate
- Repeat Usage
- Supplier Response Rate
- Supplier Reliability
- Delivery Success
- AI Resolution Rate
- Human Escalation Rate
- Cost Per AI-Resolved Need
- Gross Transaction Value
- Platform Take Rate

---

# 97. MVP NON-GOALS

Do not delay the MVP for:

- advanced AI glasses;
- every payment provider;
- perfect ML forecasting;
- full international expansion;
- every category;
- complex blockchain;
- unnecessary microservices;
- fully autonomous purchasing;
- highly sophisticated dynamic pricing.

Build extensibility for these without implementing all immediately.

---

# 98. MASTER MVP ACCEPTANCE TEST

The MVP is NOT complete until the following scenario passes:

```text
NEW CUSTOMER
 ↓
Registers
 ↓
Opens JAYA
 ↓
Types or photographs what they need
 ↓
AI interprets requirement
 ↓
Need is created
 ↓
JAYA searches supply
 ↓
At least one genuine supplier/offer returned
 ↓
Customer reviews option
 ↓
Customer confirms
 ↓
Order created
 ↓
Payment test succeeds
 ↓
Supplier receives order
 ↓
Delivery is assigned
 ↓
Customer receives updates
 ↓
Delivery completes
 ↓
Order completes
 ↓
Supplier payable is calculated
 ↓
Platform fee is calculated
 ↓
Audit history exists
```

All steps must occur through normal application interfaces.

---

# 99. MASTER SUPPLIER ACCEPTANCE TEST

```text
NEW SUPPLIER
 ↓
Registers
 ↓
Completes verification
 ↓
Uploads product photograph
 ↓
AI suggests product information
 ↓
Supplier corrects/approves
 ↓
Inventory becomes available
 ↓
Relevant customer Need appears
 ↓
Supplier receives opportunity
 ↓
Supplier submits offer
 ↓
Customer accepts
 ↓
Order processed
 ↓
Supplier fulfils
 ↓
Settlement becomes payable
 ↓
Performance updates
```

---

# 100. MASTER RFQ ACCEPTANCE TEST

```text
Customer Need has no existing match
 ↓
Private supplier matching fails
 ↓
RFQ generated
 ↓
Qualified suppliers invited
 ↓
Multiple quotes received
 ↓
AI ranks them
 ↓
Customer sees clear comparison
 ↓
Customer chooses
 ↓
Order created
```

---

# 101. MASTER SPLIT-FULFILMENT TEST

```text
Need = 1,000 units

Supplier A = 400
Supplier B = 350
Supplier C = 250

System:
 ↓
recognises combined fulfilment
 ↓
presents solution
 ↓
customer accepts
 ↓
creates appropriate supplier obligations
 ↓
combines customer-facing transaction
 ↓
settles each supplier correctly
```

---

# 102. MASTER AUTONOMOUS DEVELOPMENT CHECKLIST

## Product

- [ ] Business vision understood
- [ ] Conversation-first architecture preserved
- [ ] Need Object is central
- [ ] Supplier network is independent
- [ ] JAYA remains connector/orchestrator
- [ ] Architecture category-neutral

## Backend

- [ ] Authentication
- [ ] RBAC
- [ ] Customer
- [ ] Supplier
- [ ] Catalog
- [ ] Need
- [ ] Matching
- [ ] Offer
- [ ] RFQ
- [ ] Quote
- [ ] Order
- [ ] Payment
- [ ] Ledger
- [ ] Settlement
- [ ] Logistics
- [ ] Reputation
- [ ] Referral
- [ ] Commission
- [ ] Dispute
- [ ] Notification
- [ ] Audit
- [ ] Events

## AI

- [ ] AI Gateway
- [ ] Provider abstraction
- [ ] Model router
- [ ] Need interpretation
- [ ] Image identification
- [ ] Search
- [ ] Ranking
- [ ] Recommendations
- [ ] Confidence
- [ ] Human escalation
- [ ] Usage tracking
- [ ] Cost tracking
- [ ] Prompt versioning
- [ ] Evaluation tests

## Customer UI

- [ ] Conversational home
- [ ] Search
- [ ] Image
- [ ] Voice
- [ ] Need tracking
- [ ] Offers
- [ ] Compare
- [ ] Orders
- [ ] Payments
- [ ] Delivery
- [ ] Notifications
- [ ] Profile
- [ ] Settings
- [ ] Privacy

## Supplier UI

- [ ] Onboarding
- [ ] Verification
- [ ] Inventory
- [ ] AI uploads
- [ ] Opportunities
- [ ] RFQs
- [ ] Quotes
- [ ] Orders
- [ ] Fulfilment
- [ ] Settlements
- [ ] Analytics

## Staff UI

- [ ] Operations dashboard
- [ ] Need queue
- [ ] Supplier management
- [ ] Matching
- [ ] RFQ management
- [ ] Orders
- [ ] Payments
- [ ] Logistics
- [ ] Disputes
- [ ] AI exceptions
- [ ] Audit

## Reliability

- [ ] Retries
- [ ] Idempotency
- [ ] Dead-letter handling
- [ ] Concurrency controls
- [ ] Crash recovery
- [ ] Transaction boundaries
- [ ] Webhook validation

## Security

- [ ] Permission matrix
- [ ] Server authorisation
- [ ] Rate limiting
- [ ] Validation
- [ ] Secure secrets
- [ ] Audit logs
- [ ] Data isolation
- [ ] Vulnerability scanning

## Testing

- [ ] Unit
- [ ] Integration
- [ ] E2E
- [ ] Permissions
- [ ] Security
- [ ] Financial
- [ ] AI evaluations
- [ ] Mobile/responsive
- [ ] Failure scenarios
- [ ] Concurrency

## Deployment

- [ ] CI/CD
- [ ] Staging
- [ ] Production
- [ ] Monitoring
- [ ] Error tracking
- [ ] Backups
- [ ] Migration safety
- [ ] Rollback
- [ ] Feature flags

## Documentation

- [ ] Architecture current
- [ ] Schema current
- [ ] API documentation current
- [ ] AI design current
- [ ] Current status current
- [ ] Checklist current
- [ ] Known issues current
- [ ] Decisions ledger current

---

# 103. ABSOLUTE COMPLETION RULE

The autonomous builder must not state:

> "Project completed"

until:

```text
ALL REQUIRED MVP CHECKLIST ITEMS = COMPLETE

ALL P0 DEFECTS = ZERO

ALL P1 DEFECTS = ZERO

ALL MVP ACCEPTANCE TESTS = PASS

ALL REQUIRED MIGRATIONS = APPLIED

ALL SECURITY GATES = PASS

ALL CRITICAL FINANCIAL TESTS = PASS

ALL USER ROLES = TESTED

ALL PRIMARY FLOWS = TESTED ON MOBILE + DESKTOP

PRODUCTION DEPLOYMENT = HEALTHY

CURRENT_IMPLEMENTATION_STATUS = UPDATED
```

Anything else must be described accurately as:

```text
partially complete
phase complete
MVP candidate
release candidate
blocked
```

rather than claiming the entire project is finished.

---

# 104. AUTONOMOUS CONTINUATION RULE

After completing one task:

```text
1. Run tests.
2. Review implementation.
3. Fix defects.
4. Update documentation.
5. Mark checklist evidence.
6. Commit.
7. Inspect dependency graph.
8. Select next highest-priority unblocked task.
9. Continue.
```

Do not stop merely because a single requested module has been implemented if the active autonomous development objective is to complete the broader phase/project.

---

# 105. USAGE OPTIMISATION RULE

Use expensive AI development models selectively.

Suggested development routing:

```text
Architecture / difficult debugging / security
→ strongest reasoning model

Routine implementation
→ capable coding model

Boilerplate / test expansion / documentation
→ lower-cost worker model

Review
→ independent model/agent where possible
```

Avoid repeatedly rereading the entire repository.

Maintain compact repository state documents for orientation.

---

# 106. ESCALATION RULE

Human input should only be requested where the decision genuinely requires:

- business policy;
- regulatory decision;
- credentials;
- external service access;
- irreversible commercial decision;
- conflicting requirements that cannot reasonably be resolved.

Routine technical decisions should be made autonomously using this specification.

---

# 107. FINAL AUTONOMOUS BUILDER DIRECTIVE

You are not building a collection of screens.

You are building an operational commerce network.

The system must eventually allow:

> **"JAYA, I need this."**

to trigger:

```text
UNDERSTAND
   ↓
IDENTIFY
   ↓
SEARCH
   ↓
MATCH
   ↓
SOURCE
   ↓
COMPARE
   ↓
TRANSACT
   ↓
PAY
   ↓
FULFIL
   ↓
DELIVER
   ↓
SETTLE
   ↓
LEARN
```

The AI provides intelligence.

The application provides authority, durability, accountability and execution.

Every development decision must preserve that separation.

---

# 108. FINAL COMMAND TO AUTONOMOUS DEVELOPMENT SYSTEM

Use this document as the authoritative development programme.

Proceed phase-by-phase.

Do not skip requirements.

Do not mark placeholders complete.

Do not assume UI completion equals system completion.

Maintain the implementation checklist continuously.

Test every vertical slice.

Independently review major work.

Fix discovered defects before progressing where severity requires it.

Keep financial state deterministic and auditable.

Keep AI provider-neutral.

Keep critical commercial intelligence server-side.

Keep the product conversation-first.

Continue autonomously through the highest-priority unblocked tasks until the current development scope reaches its documented Definition of Done.