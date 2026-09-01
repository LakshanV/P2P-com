/**
 * Payment provider contract test.
 *
 * `docs/JAYA_TEST_MATRIX.md` §1.3 lists Payments as a mandatory contract suite: a replacement
 * gateway adapter is valid exactly when it passes this file. It is parameterised over the adapter,
 * so plugging in a real processor means implementing `PaymentProvider`, describing which of its
 * instrument tokens produce which outcome, and calling `runPaymentProviderContract` from a small
 * driver — never editing this file.
 *
 * What the contract pins is the behaviour M-12 relies on, and nothing else. It says nothing about
 * how an adapter talks to its gateway, what it names its references, or which rails it settles. It
 * says only this:
 *
 *   * **The same idempotency key means the same operation.** A retry after a timeout must not
 *     become a second charge, so an adapter that cannot recognise its own key cannot be used.
 *   * **A failure carries a vocabulary code, never the gateway's prose.** A caller cannot branch on
 *     a message in a language nobody chose, and an adapter that passed one through would push the
 *     parsing problem onto every consumer.
 *   * **A declared rail or asset is one the adapter will actually attempt.** The declaration is what
 *     M-12 checks before calling out, so a declaration that lies moves the failure to the gateway.
 *   * **No internally issued JAYA value is ever declared settleable.** M-13 allocates those against
 *     the universal ledger; there is no rail down which a reward could travel.
 *   * **A result is a result.** Every call answers with an outcome, a reference or null, and a
 *     failure code that agrees with the outcome — never a half-populated object a caller has to
 *     guess about.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAILURE_CODES,
  INTERNAL_VALUE_CODES,
  MockPaymentProvider,
  PAYMENT_RAILS,
  type FailureCode,
  type PaymentProvider,
  type ProviderRequest,
  type ProviderResult,
} from '../../modules/payments/index.ts';

/** What a driver must supply to run this contract against its adapter. */
export interface PaymentProviderUnderTest {
  /** A human name for the adapter, used in test titles. */
  readonly name: string;
  /** A fresh adapter. Called once per assertion, so a stateful adapter starts clean. */
  build(): PaymentProvider;
  /** A token this adapter settles successfully at every step. */
  readonly successToken: string;
  /**
   * A token this adapter refuses with a definite answer, and the code it refuses with.
   *
   * The code matters: a definite refusal is what lets M-12 fail the payment, and an adapter that
   * reported a decline as a timeout would leave every declined payment sitting open.
   */
  readonly declineToken: string;
  readonly declineCode: FailureCode;
  /** A token whose outcome is unknown — a timeout or an unreachable gateway. */
  readonly indeterminateToken: string;
  /** A rail and asset pair this adapter declares. */
  readonly rail: (typeof PAYMENT_RAILS)[number];
  readonly assetCode: string;
  readonly assetScale: number;
}

const AMOUNT = 250_000n;

function requestFor(
  subject: PaymentProviderUnderTest,
  instrumentToken: string,
  idempotencyKey: string,
  providerReference: string | null = null,
): ProviderRequest {
  return {
    instrumentToken,
    amountMinor: AMOUNT,
    assetCode: subject.assetCode,
    assetScale: subject.assetScale,
    rail: subject.rail,
    idempotencyKey,
    providerReference,
  };
}

/** Every field of a result, checked for internal agreement. */
function assertWellFormed(result: ProviderResult, what: string): void {
  assert.ok(
    result.outcome === 'succeeded' || result.outcome === 'failed',
    `${what} answered with outcome "${String(result.outcome)}"`,
  );
  assert.ok(
    result.providerReference === null || typeof result.providerReference === 'string',
    `${what} answered with a providerReference that is neither a string nor null`,
  );

  if (result.outcome === 'succeeded') {
    assert.equal(
      result.failureCode,
      null,
      `${what} succeeded and carried failureCode "${String(result.failureCode)}". A caller ` +
        'reading both would have to decide which one to believe',
    );
    return;
  }

  assert.ok(
    result.failureCode !== null,
    `${what} failed and carried no failureCode. A failure nobody can attribute is a support ticket`,
  );
  assert.ok(
    (FAILURE_CODES as readonly string[]).includes(result.failureCode),
    `${what} failed with "${String(result.failureCode)}", which is not in the vocabulary. An ` +
      'unmapped string here would eventually be parsed by somebody',
  );
}

export function runPaymentProviderContract(subject: PaymentProviderUnderTest): void {
  const label = subject.name;

  // -------------------------------------------------------------------------
  // Declarations
  // -------------------------------------------------------------------------

  test(`${label}: declares a name, at least one rail and at least one asset`, () => {
    const adapter = subject.build();
    assert.match(
      adapter.name,
      /^[a-z][a-z0-9_-]{0,63}$/,
      'the adapter name is a vocabulary word matching Payment.provider',
    );
    assert.ok(adapter.supportedRails.length > 0, 'an adapter that settles no rail settles nothing');
    assert.ok(adapter.supportedAssets.length > 0, 'an adapter must say what it can move');
  });

  test(`${label}: declares only rails M-12 recognises`, () => {
    const adapter = subject.build();
    for (const rail of adapter.supportedRails) {
      assert.ok(
        (PAYMENT_RAILS as readonly string[]).includes(rail),
        `"${rail}" is not a rail M-12 knows, so no payment could ever name it`,
      );
    }
  });

  test(`${label}: never declares internally issued JAYA value as settleable`, () => {
    const adapter = subject.build();
    for (const code of adapter.supportedAssets) {
      assert.ok(
        !(INTERNAL_VALUE_CODES as readonly string[]).includes(code),
        `"${code}" is value JAYA issues itself. No external counterparty settles it, and an ` +
          'adapter claiming it could would either fail confusingly at the gateway or, far worse, ' +
          'succeed against a fiat balance and turn a restricted credit into cash',
      );
    }
  });

  test(`${label}: declares assets in the settlement-code shape`, () => {
    const adapter = subject.build();
    for (const code of adapter.supportedAssets) {
      assert.match(
        code,
        /^[A-Z0-9]{3,12}$/,
        `"${code}" is not a settlement asset code. The shape is deliberately wider than ISO-4217 ` +
          'so a digital asset needs no new contract, but it is not unbounded',
      );
    }
  });

  test(`${label}: declares the rail and asset the contract exercises`, () => {
    const adapter = subject.build();
    assert.ok(
      adapter.supportedRails.includes(subject.rail),
      `the driver names rail "${subject.rail}", which the adapter does not declare`,
    );
    assert.ok(
      adapter.supportedAssets.includes(subject.assetCode),
      `the driver names asset "${subject.assetCode}", which the adapter does not declare`,
    );
  });

  // -------------------------------------------------------------------------
  // The four operations
  // -------------------------------------------------------------------------

  test(`${label}: authorises, captures, cancels and refunds a good instrument`, async () => {
    const adapter = subject.build();

    const authorised = await adapter.authorise(
      requestFor(subject, subject.successToken, 'idem_contract_auth1'),
    );
    assertWellFormed(authorised, 'authorise');
    assert.equal(authorised.outcome, 'succeeded');
    assert.ok(
      authorised.providerReference !== null,
      'a successful authorisation must return a reference; reconciliation has nothing to match on ' +
        'without one',
    );

    const captured = await adapter.capture(
      requestFor(subject, subject.successToken, 'idem_contract_cap1', authorised.providerReference),
    );
    assertWellFormed(captured, 'capture');
    assert.equal(captured.outcome, 'succeeded');

    const refunded = await adapter.refund(
      requestFor(subject, subject.successToken, 'idem_contract_ref1', captured.providerReference),
    );
    assertWellFormed(refunded, 'refund');
    assert.equal(refunded.outcome, 'succeeded');

    const cancelled = await adapter.cancel(
      requestFor(subject, subject.successToken, 'idem_contract_cxl1', authorised.providerReference),
    );
    assertWellFormed(cancelled, 'cancel');
  });

  test(`${label}: refuses a bad instrument with a definite, vocabulary reason`, async () => {
    const adapter = subject.build();
    const result = await adapter.authorise(
      requestFor(subject, subject.declineToken, 'idem_contract_dec1'),
    );

    assertWellFormed(result, 'a declined authorise');
    assert.equal(result.outcome, 'failed');
    assert.equal(
      result.failureCode,
      subject.declineCode,
      'the adapter reported a different code from the one its driver declares. A decline reported ' +
        'as a timeout would leave every declined payment sitting open, waiting for a retry that ' +
        'can never succeed',
    );
  });

  test(`${label}: reports an unknown outcome as an indeterminate failure`, async () => {
    const adapter = subject.build();
    const result = await adapter.authorise(
      requestFor(subject, subject.indeterminateToken, 'idem_contract_ind1'),
    );

    assertWellFormed(result, 'an indeterminate authorise');
    assert.equal(result.outcome, 'failed');
    assert.ok(
      result.failureCode === 'provider-timeout' || result.failureCode === 'provider-unavailable',
      `an unknown outcome was reported as "${String(result.failureCode)}". M-12 leaves a payment ` +
        'where it was for exactly these two codes and fails it for every other, so misreporting ' +
        'one is how a retry becomes a second charge',
    );
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  test(`${label}: the same key twice is the same operation`, async () => {
    const adapter = subject.build();
    const key = 'idem_contract_same1';

    const first = await adapter.authorise(requestFor(subject, subject.successToken, key));
    const second = await adapter.authorise(requestFor(subject, subject.successToken, key));

    assert.equal(first.outcome, second.outcome);
    assert.equal(
      first.providerReference,
      second.providerReference,
      'the same idempotency key produced two different references, so the gateway treated a retry ' +
        'as a second operation. This is the difference between charging somebody once and twice',
    );
  });

  test(`${label}: different keys are different operations`, async () => {
    const adapter = subject.build();

    const first = await adapter.authorise(
      requestFor(subject, subject.successToken, 'idem_contract_diff1'),
    );
    const second = await adapter.authorise(
      requestFor(subject, subject.successToken, 'idem_contract_diff2'),
    );

    assert.notEqual(
      first.providerReference,
      second.providerReference,
      'two distinct operations share a reference, so reconciliation cannot tell them apart',
    );
  });

  test(`${label}: a capture and an authorisation under one key stay distinguishable`, async () => {
    // A retry of a capture must match the earlier capture, not the authorisation that preceded it.
    const adapter = subject.build();
    const key = 'idem_contract_kind1';

    const authorised = await adapter.authorise(requestFor(subject, subject.successToken, key));
    const captured = await adapter.capture(
      requestFor(subject, subject.successToken, key, authorised.providerReference),
    );

    assert.notEqual(
      authorised.providerReference,
      captured.providerReference,
      'an authorisation and a capture returned the same reference, so a reconciliation reading the ' +
        'attempt trail cannot tell which call it is looking at',
    );
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------

  test(`${label}: a result carries nothing beyond the three declared fields`, async () => {
    const adapter = subject.build();
    const result = await adapter.authorise(
      requestFor(subject, subject.successToken, 'idem_contract_shape'),
    );

    assert.deepEqual(
      Object.keys(result).sort(),
      ['failureCode', 'outcome', 'providerReference'],
      'the result carries fields M-12 does not read. An adapter smuggling extra state through the ' +
        'port makes the port a suggestion',
    );
  });
}

// ---------------------------------------------------------------------------
// The reference adapter, run against the contract it defines
// ---------------------------------------------------------------------------

runPaymentProviderContract({
  name: 'MockPaymentProvider',
  build: () => new MockPaymentProvider(),
  successToken: 'tok_contract_good01',
  declineToken: 'tok_contract_decline',
  declineCode: 'card-declined',
  indeterminateToken: 'tok_contract_timeout',
  rail: 'card',
  assetCode: 'LKR',
  assetScale: 2,
});
