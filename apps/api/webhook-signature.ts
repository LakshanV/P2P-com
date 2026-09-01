/**
 * Proving that a webhook came from the provider it claims to.
 *
 * The defect this file exists to close: the webhook route read `signatureVerified` **from the
 * request body**. M-12 was careful — it refuses `unverified-webhook` outright, and its comment says
 * hardcoding the flag "would make every webhook route an unauthenticated way to move money" — but
 * the API handed it a value the caller supplied. Anybody who could reach the port could post
 * `{"signatureVerified": true, "assertedStatus": "captured"}` and a payment would move. The module
 * was asking the right question and the layer above it was letting the attacker answer.
 *
 * So the answer is computed here, from a secret the caller does not have.
 *
 * **Signed over the raw bytes.** `t=<unix seconds>.<body>`, HMAC-SHA256, hex. Not over the parsed
 * body: two JSON documents that mean the same thing are different strings, so a check against a
 * re-serialised body would fail for honest senders — and a check that fails for honest senders gets
 * relaxed until it passes.
 *
 * **The timestamp is inside the signed payload.** Otherwise it is a field an attacker edits: a
 * delivery captured today could be replayed indefinitely by moving the timestamp forward, because
 * the signature would not cover it. Signing it makes a stale delivery unforgeable *and* detectable.
 *
 * **Comparison is timing-safe, and both directions of the window are checked.** A future-dated
 * delivery is refused as firmly as an old one; a clock that can be pushed forward is a replay window
 * that can be widened.
 *
 * **An unconfigured provider verifies nothing.** No secret means every delivery from that provider
 * is refused, rather than accepted because there was nothing to check it against.
 *
 * Owned by: apps/api.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { ApiError } from './errors.ts';

/** The header a provider signs with. Named for this platform, not for any one gateway. */
export const SIGNATURE_HEADER = 'x-jaya-signature';

/**
 * How far out of step a delivery's clock may be, in seconds.
 *
 * Five minutes each way. Wide enough for a gateway retrying through a queue and for ordinary clock
 * drift; narrow enough that a signature captured from a log is worthless by the time somebody reads
 * it.
 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Where the per-provider signing secrets come from.
 *
 * A port, so the secrets can live in the environment, in K-05 Configuration, or in a secret manager
 * without this file knowing which. Returning null means "no secret for that provider", which is a
 * refusal and not a pass.
 */
export interface WebhookSecrets {
  secretFor(provider: string): string | null;
}

/** No secrets at all: every webhook is refused. The correct default for a deployment that has not configured one. */
export const NO_WEBHOOK_SECRETS: WebhookSecrets = Object.freeze({
  secretFor: () => null,
});

/**
 * Secrets from a plain map. Used by tests, and by a deployment that reads them from its environment.
 *
 * The map is copied, so a caller that later mutates what it passed does not change what is verified.
 */
export function webhookSecrets(secrets: Readonly<Record<string, string>>): WebhookSecrets {
  const held = new Map(Object.entries(secrets));
  return Object.freeze({
    secretFor: (provider: string): string | null => held.get(provider) ?? null,
  });
}

/** What a provider must send to be believed. */
export interface SignatureCheck {
  readonly provider: string;
  /** Exactly the bytes the provider sent. */
  readonly rawBody: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: WebhookSecrets;
  /** "Now", as a UTC instant, from the request context. */
  readonly now: string;
}

/**
 * Compute the signature for a payload. Exported so a test — or a mock provider — can send a real one.
 *
 * There is deliberately no way to ask this module to *skip* verification. A test that wants a
 * delivery accepted signs it, which is also what a provider does.
 */
export function signWebhook(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestampSeconds)}.${rawBody}`, 'utf8')
    .digest('hex');
}

/** The header value a provider would send for a payload. */
export function webhookSignatureHeader(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return `t=${String(timestampSeconds)},v1=${signWebhook(secret, timestampSeconds, rawBody)}`;
}

/**
 * Verify a delivery, or throw.
 *
 * Returns nothing on success: there is no boolean for a caller to ignore. Every refusal is a 401
 * with a message that says what was wrong with the *form* of the delivery and never whether a
 * particular provider is configured — which provider secrets a deployment holds is not a stranger's
 * business.
 */
export function verifyWebhookSignature(check: SignatureCheck): void {
  const secret = check.secrets.secretFor(check.provider);
  const presented = check.headers[SIGNATURE_HEADER];

  if (presented === undefined || presented === '') {
    throw new ApiError(
      401,
      'unsigned-webhook',
      `A webhook delivery must carry a "${SIGNATURE_HEADER}" header of the form ` +
        '"t=<unix seconds>,v1=<hex>". An unsigned delivery is an instruction from a stranger.',
    );
  }

  const parsed = parseSignatureHeader(presented);
  if (parsed === null) {
    throw new ApiError(
      401,
      'malformed-webhook-signature',
      `The "${SIGNATURE_HEADER}" header must be "t=<unix seconds>,v1=<hex>".`,
    );
  }

  const nowSeconds = Math.floor(instantToMillis(check.now) / 1000);
  const drift = Math.abs(nowSeconds - parsed.timestampSeconds);
  if (drift > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(
      401,
      'stale-webhook',
      `The delivery's timestamp is ${String(drift)} seconds away from now, and at most ` +
        `${String(SIGNATURE_TOLERANCE_SECONDS)} is accepted in either direction. A signature with ` +
        'no expiry is a signature that can be replayed for ever.',
    );
  }

  // Only now. A missing secret is checked against the same refusal as a wrong signature, and after
  // the cheap structural checks, so this route does not answer "is provider X configured here?"
  const expected =
    secret === null ? null : signWebhook(secret, parsed.timestampSeconds, check.rawBody ?? '');

  if (expected === null || !constantTimeEquals(expected, parsed.signature)) {
    throw new ApiError(
      401,
      'bad-webhook-signature',
      'The signature does not match the body under any secret this deployment holds for that ' +
        'provider. The delivery is refused and nothing was recorded.',
    );
  }
}

interface ParsedSignature {
  readonly timestampSeconds: number;
  readonly signature: string;
}

function parseSignatureHeader(header: string): ParsedSignature | null {
  let timestampSeconds: number | null = null;
  let signature: string | null = null;

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) return null;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      if (!/^[0-9]{1,12}$/.test(value)) return null;
      timestampSeconds = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signature = value;
    }
    // Unknown parts are ignored rather than refused, so a provider adding a scheme version later
    // does not break a deployment that has not been updated. `v1` is still required.
  }

  if (timestampSeconds === null || signature === null) return null;
  return { timestampSeconds, signature };
}

/**
 * Timing-safe string comparison.
 *
 * `===` on a hex digest leaks how many characters matched, one comparison at a time. That is enough
 * to reconstruct a signature given enough attempts, which is why nothing here uses it.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function instantToMillis(instant: string): number {
  const millis = Date.parse(instant);
  if (Number.isNaN(millis)) {
    throw new ApiError(
      500,
      'unclassified',
      'the request context supplied an instant that is not a UTC instant',
    );
  }
  return millis;
}
