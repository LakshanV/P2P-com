# JAYA — Integration Registry

**Governing documents:** `docs/JAYA_MASTER_ARCHITECTURE.md`, `docs/JAYA_MODULE_MAP.md`, `docs/JAYA_DECISION_LOG.md`

This registry lists every external dependency, the adapter interface that isolates it, the mock provider for local development, and the live provider roadmap.

---

## 1. Integration Template

Every external dependency must have:

```text
PORT           TypeScript interface in a kernel/business module
MOCK_ADAPTER   Local fake implementation for tests and dev
TEST_ADAPTER   Deterministic fake for contract tests
LIVE_ADAPTERS  Provider-specific implementations
CONFIG_KEYS    Environment variables / config entries
DOCUMENTATION  Setup, credentials, webhooks, failure modes
```

---

## 2. AI Providers

**Owner module:** K-13 AI Gateway

### Port

`AIProvider` — executes a task by name and returns a structured, auditable result.

```typescript
interface AIProvider {
  execute(task: AITask, input: unknown, options: AIOptions): Promise<AIResult>;
  estimateCost(task: AITask, input: unknown): Promise<CostEstimate>;
}
```

### Mock Adapters

| Adapter | Use | Behaviour |
|---|---|---|
| `MockAIProvider` | Unit tests, local dev | Returns deterministic canned responses based on task name and input hash. Records calls. |
| `RecordingAIProvider` | Contract tests | Records every call, validates shape, returns configurable responses. |

### Live Adapters (roadmap)

| Provider | Adapter | Notes |
|---|---|---|
| Kimi | `KimiAdapter` | Primary candidate for text tasks |
| OpenAI | `OpenAIAdapter` | GPT models |
| Anthropic Claude | `ClaudeAdapter` | Reasoning tasks |
| DeepSeek | `DeepSeekAdapter` | Cost-sensitive tasks |
| Google | `GoogleAdapter` | Multimodal |
| Local / open-source | `LocalModelAdapter` | Self-hosted option |
| Vision specialist | `VisionAdapter` | Image interpretation |
| Speech specialist | `SpeechAdapter` | Voice transcription |

### Configuration

```text
AI_PROVIDER_PRIMARY=kimi|openai|claude|deepseek|google|local
AI_PROVIDER_FALLBACK=...
AI_KIMI_API_KEY=...
AI_OPENAI_API_KEY=...
AI_CLAUDE_API_KEY=...
AI_DEEPSEEK_API_KEY=...
AI_GOOGLE_API_KEY=...
AI_LOCAL_BASE_URL=...
```

### Status

- Port: **defined conceptually; not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until BL-04 resolved**

---

## 3. Payment Providers

**Owner module:** M-12 Payments

### Port

`PaymentProvider` — provider-neutral authorise/capture/refund/cancel with idempotency.

```typescript
interface PaymentProvider {
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
  authorize(intentId: string): Promise<AuthorizationResult>;
  capture(intentId: string, amount: MoneyAmount): Promise<CaptureResult>;
  cancel(intentId: string): Promise<CancellationResult>;
  refund(paymentId: string, amount: MoneyAmount): Promise<RefundResult>;
  getStatus(paymentId: string): Promise<PaymentStatus>;
}
```

### Mock Adapters

| Adapter | Use | Behaviour |
|---|---|---|
| `MockPaymentProvider` | Unit tests, local dev | Simulates success/failure by intent prefix. Supports idempotency key replay. |
| `FailingPaymentProvider` | Adversarial tests | Simulates network/decline/fraud failures deterministically. |

### Live Adapters (roadmap)

| Provider | Adapter | Notes |
|---|---|---|
| Local payment gateway | `LocalGatewayAdapter` | Country-specific gateway |
| Stripe | `StripeAdapter` | Cards |
| Bank transfer | `BankTransferAdapter` | Manual/admin-mediated |
| Wallet | `WalletAdapter` | Mobile wallets |
| Payment links | `PaymentLinkAdapter` | Shareable links |
| Cash on delivery | `CODAdapter` | Driver collects |
| Escrow provider | `EscrowAdapter` | Licensed third-party escrow |

### Configuration

```text
PAYMENT_PROVIDER_PRIMARY=mock|stripe|local|bank|wallet|cod|escrow
PAYMENT_STRIPE_SECRET_KEY=...
PAYMENT_STRIPE_WEBHOOK_SECRET=...
PAYMENT_LOCAL_GATEWAY_BASE_URL=...
PAYMENT_LOCAL_GATEWAY_API_KEY=...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until BL-05 resolved**

---

## 4. Crypto / Digital Asset Custody

**Owner module:** M-12 Payments (adapter) + M-13 Financial Ledger (asset types)

### Port

`CryptoCustodyProvider` — holds balances at an external compliant custodian.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockCryptoProvider` | Simulates BTC/ETH/USDT balances and transfers |

### Live Adapters (roadmap)

| Provider | Assets | Notes |
|---|---|---|
| Compliant custodian TBD | BTC, ETH, USDT | External provider holds private keys |

### Configuration

```text
CRYPTO_PROVIDER=mock|...
CRYPTO_PROVIDER_API_KEY=...
```

### Status

- All: **not yet implemented**

---

## 5. Logistics / Mobility Providers

**Owner module:** M-19 Logistics

### Port

`LogisticsProvider` — creates shipment, assigns driver/vehicle, tracks status.

```typescript
interface LogisticsProvider {
  createShipment(request: ShipmentRequest): Promise<Shipment>;
  assignDriver(shipmentId: string): Promise<DriverAssignment>;
  getStatus(shipmentId: string): Promise<ShipmentStatus>;
  recordPickup(shipmentId: string, proof: Proof): Promise<void>;
  recordDelivery(shipmentId: string, proof: Proof): Promise<void>;
}
```

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockLogisticsProvider` | Local dev/tests with deterministic driver/vehicle assignment |
| `SimulatedDispatchProvider` | Tests dispatch algorithm in isolation |

### Live Adapters (roadmap)

| Provider | Adapter | Notes |
|---|---|---|
| Yaanadiri | `YaanadiriAdapter` | Primary mobility partner |
| Merchant drivers | `MerchantDriverAdapter` | In-house fleet |
| Independent drivers | `IndependentDriverAdapter` | Gig drivers |
| Courier companies | `CourierAdapter` | Third-party couriers |
| Transport providers | `TransportAdapter` | Bulk/freight |

### Configuration

```text
LOGISTICS_PROVIDER_PRIMARY=mock|yaanadiri|merchant|courier|transport
YAANADIRI_API_KEY=...
YAANADIRI_WEBHOOK_SECRET=...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until Yaanadiri API available**

---

## 6. Maps / Location Providers

**Owner module:** M-43 Location

### Port

`MapsProvider` — geocode, distance, routing, geospatial search.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockMapsProvider` | Deterministic geocoding and distance for tests |

### Live Adapters (roadmap)

| Provider | Notes |
|---|---|
| Google Maps | Geocoding, distance matrix |
| Mapbox | Routing, geocoding |
| OpenStreetMap / Nominatim | Cost-sensitive geocoding |
| PostGIS | Internal spatial storage/queries |

### Configuration

```text
MAPS_PROVIDER=mock|google|mapbox|osm
MAPS_API_KEY=...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**

---

## 7. Notification Providers

**Owner module:** K-14 Notifications

### Port

`NotificationChannelProvider` — sends a templated message through a channel.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockNotificationProvider` | Records notifications, simulates success/failure |
| `InAppNotificationProvider` | Stores in-app notifications directly |

### Live Adapters (roadmap)

| Channel | Provider Adapter |
|---|---|
| Push | `PushProvider` |
| SMS | `SMSProvider` (Twilio, local telco) |
| WhatsApp | `WhatsAppProvider` (Twilio, official API) |
| Email | `EmailProvider` (SendGrid, SES, local SMTP) |

### Configuration

```text
NOTIFICATION_CHANNELS=in-app|push|sms|whatsapp|email
SMS_PROVIDER=twilio|...
SMS_PROVIDER_API_KEY=...
WHATSAPP_PROVIDER=twilio|...
EMAIL_PROVIDER=sendgrid|ses|smtp|...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until BL-07 resolved**

---

## 8. Object Storage

**Owner module:** Platform substrate / modules needing file uploads

### Port

`ObjectStorageProvider` — upload, download, delete, presign URLs.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockObjectStorageProvider` | In-memory file storage for tests |
| `LocalFileStorageProvider` | Local filesystem for dev |

### Live Adapters (roadmap)

| Provider | Notes |
|---|---|
| MinIO | Self-hosted S3-compatible |
| AWS S3 | Cloud object storage |
| Cloudflare R2 | Cloud object storage |

### Configuration

```text
OBJECT_STORAGE_PROVIDER=mock|local|minio|s3|r2
OBJECT_STORAGE_ENDPOINT=...
OBJECT_STORAGE_BUCKET=...
OBJECT_STORAGE_ACCESS_KEY=...
OBJECT_STORAGE_SECRET_KEY=...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until BL-06 resolved**

---

## 9. Identity / Authentication Providers

**Owner module:** K-02 Authentication

### Port

`Verifier` — verifies a claimed identity factor.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockVerifier` | Always returns configured result for tests |
| `PasswordlessOTPVerifier` | Simulates OTP verification |

### Live Adapters (roadmap)

| Provider | Notes |
|---|---|
| Passwordless OTP | Email/SMS OTP |
| Passkey / WebAuthn | Device-bound credentials |
| OAuth (Google, Apple, etc.) | Social login |
| SAML / OIDC | Enterprise SSO |

### Configuration

```text
AUTH_VERIFIERS=mock|otp|passkey|oauth|saml
AUTH_OTP_TTL_SECONDS=300
```

### Status

- Port: **exists in K-02 as injected port; only default refusal implementation**
- Mock adapter: **to be implemented as next kernel task**
- Live adapters: **deferred**

---

## 10. Wholesale / Procurement Integrations

**Owner module:** M-34 Finance Provider Marketplace / M-09 RFQ / M-35 Wholesale Exchange

### Port

`WholesaleConnector` — submits RFQs/bulk orders and receives availability/pricing.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockWholesaleConnector` | Returns canned responses for tests |

### Live Adapters (roadmap)

| Provider | Adapter | Notes |
|---|---|---|
| Singha | `SinghaConnector` | Bulk sourcing, supplier access, wholesale RFQs |

### Configuration

```text
WHOLESALE_CONNECTORS=mock|singha
SINGHA_API_KEY=...
SINGHA_API_BASE_URL=...
```

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**
- Live adapters: **deferred until Singha API available**

---

## 11. Browser Assistant / Wearables

**Owner module:** Channel adapters feeding M-03 Need

### Port

`NeedCaptureChannel` — ingests multimodal input and returns a `NeedCreateCommand`.

### Mock Adapters

| Adapter | Use |
|---|---|
| `MockBrowserAssistant` | Simulates "Find on JAYA" / "Compare on JAYA" |
| `MockWearableGateway` | Simulates glasses/wearable capture |

### Live Adapters (roadmap)

| Channel | Notes |
|---|---|
| Browser extension | Sends product link/screenshot to JAYA |
| AI glasses API | Generic image/speech capture endpoint |

### Status

- Port: **not yet implemented**
- Mock adapter: **not yet implemented**

---

## 12. Integration Status Summary

| Integration | Port | Mock | Live | Blocker |
|---|---|---|---|---|
| AI providers | concept | no | no | BL-04 |
| Payment providers | no | no | no | BL-05 |
| Crypto custody | no | no | no | — |
| Logistics / Yaanadiri | no | no | no | Yaanadiri API |
| Maps / location | no | no | no | — |
| Notifications | no | no | no | BL-07 |
| Object storage | no | no | no | BL-06 |
| Authentication verifiers | yes (K-02) | next task | no | — |
| Wholesale / Singha | no | no | no | Singha API |
| Browser assistant / wearables | no | no | no | — |

---

## 13. Credential Placeholders

Add to `.env.example` as each integration is implemented. Do not commit real credentials.

See `.env.example` for current placeholders.
