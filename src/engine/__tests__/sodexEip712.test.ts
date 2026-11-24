import { describe, expect, it } from 'vitest';
import {
  allocateMonotonicSodexNonce,
  buildPerpNewOrderIntent,
  buildSignedCurlPreview,
  buildSpotBatchNewOrderIntent,
  formatSodexTypedSignature,
  signIntentWithEphemeralDryRunKey,
  SODEX_EXCHANGE_ACTION_TYPES,
  SodexNonceAllocator,
  validateSodexAccountId,
  verifyExchangeActionSignature,
  ZERO_VERIFYING_CONTRACT,
} from '../sodexEip712';

describe('SoDEX Official EIP-712 ExchangeAction & batchNewOrder Builder', () => {
  it('constructs exact Go-ordered spot batchNewOrder payloadHash, domain, and EIP-712 typed data', () => {
    const nonce = 1795510000000n;
    const intent = buildSpotBatchNewOrderIntent({
      network: 'mainnet',
      accountID: 4201,
      nonce,
      orders: [
        {
          symbolID: 1,
          clOrdID: 'bdspot-test-1',
          side: 'BUY',
          orderType: 'LIMIT',
          timeInForce: 'POST_ONLY',
          price: '60250.00',
          quantity: '0.41500',
        },
      ],
    });

    expect(intent.domain).toEqual({
      name: 'spot',
      version: '1',
      chainId: 286623,
      verifyingContract: ZERO_VERIFYING_CONTRACT,
    });
    expect(intent.primaryType).toBe('ExchangeAction');
    expect(intent.actionType).toBe('batchNewOrder');
    expect(intent.endpointUrl).toBe('https://mainnet-gw.sodex.dev/api/v1/spot/trade/orders/batch');
    expect(intent.nonceStr).toBe('1795510000000');
    expect(intent.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(intent.typedDataHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify exact canonical signing JSON field order ("type" before "params", Go struct field order)
    expect(intent.canonicalSigningJson).toBe(
      '{"type":"batchNewOrder","params":{"accountID":4201,"orders":[{"symbolID":1,"clOrdID":"bdspot-test-1","side":1,"type":1,"timeInForce":4,"price":"60250.00","quantity":"0.41500"}]}}',
    );
    expect(intent.ethSignTypedDataV4Payload.types.ExchangeAction).toEqual(
      SODEX_EXCHANGE_ACTION_TYPES.ExchangeAction,
    );
  });

  it('constructs exact Go-ordered perps newOrder intent under futures domain on testnet 138565', () => {
    const nonce = 1795510000123n;
    const intent = buildPerpNewOrderIntent({
      network: 'testnet',
      accountID: 777,
      symbolID: 3,
      nonce,
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'GTC',
      price: '60300.5',
      quantity: '0.2500',
      reduceOnly: false,
      clOrdID: 'bdperp-hedge-1',
    });

    expect(intent.domain).toEqual({
      name: 'futures',
      version: '1',
      chainId: 138565,
      verifyingContract: ZERO_VERIFYING_CONTRACT,
    });
    expect(intent.endpointUrl).toBe('https://testnet-gw.sodex.dev/api/v1/perps/trade/orders');
    expect(intent.canonicalSigningJson).toBe(
      '{"type":"newOrder","params":{"accountID":777,"symbolID":3,"orders":[{"clOrdID":"bdperp-hedge-1","modifier":1,"side":2,"type":1,"timeInForce":1,"price":"60300.5","quantity":"0.2500","reduceOnly":false,"positionSide":1}]}}',
    );
  });

  it('appends optional SoDEX builder attribution (id, fee) in exact Go struct order when provided and omits it otherwise', () => {
    const spotWithBuilder = buildSpotBatchNewOrderIntent({
      network: 'mainnet',
      accountID: 4201,
      nonce: 1795510000500n,
      builder: { id: 88, fee: 10 },
      orders: [
        {
          symbolID: 1,
          clOrdID: 'bdspot-b-1',
          side: 'BUY',
          orderType: 'LIMIT',
          timeInForce: 'POST_ONLY',
          price: '60000.00',
          quantity: '0.10000',
        },
      ],
    });
    expect(spotWithBuilder.canonicalSigningJson).toBe(
      '{"type":"batchNewOrder","params":{"accountID":4201,"orders":[{"symbolID":1,"clOrdID":"bdspot-b-1","side":1,"type":1,"timeInForce":4,"price":"60000.00","quantity":"0.10000"}],"builder":{"id":88,"fee":10}}}',
    );

    const perpWithBuilder = buildPerpNewOrderIntent({
      network: 'testnet',
      accountID: 777,
      symbolID: 1,
      nonce: 1795510000501n,
      builder: { id: 88, fee: 10 },
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'POST_ONLY',
      price: '60050.0',
      quantity: '0.1000',
      clOrdID: 'bdperp-b-1',
    });
    expect(perpWithBuilder.canonicalSigningJson).toBe(
      '{"type":"newOrder","params":{"accountID":777,"symbolID":1,"orders":[{"clOrdID":"bdperp-b-1","modifier":1,"side":2,"type":1,"timeInForce":4,"price":"60050.0","quantity":"0.1000","reduceOnly":false,"positionSide":1}],"builder":{"id":88,"fee":10}}}',
    );
  });

  it('allocates strictly monotonic distinct nonces across Spot and Perp hedge legs even within the same millisecond', async () => {
    const fixedClockMs = 1795520000000;
    const allocator = new SodexNonceAllocator();

    const spotNonce = allocator.next(fixedClockMs);
    const perpNonce = allocator.next(fixedClockMs);
    const retryNonce = allocateMonotonicSodexNonce(perpNonce, fixedClockMs - 5000);

    expect(perpNonce).toBe(spotNonce + 1n);
    expect(retryNonce).toBe(perpNonce + 1n);

    const spotIntent = buildSpotBatchNewOrderIntent({
      network: 'testnet',
      accountID: 5501,
      nonce: spotNonce,
      orders: [
        {
          symbolID: 1,
          side: 'BUY',
          orderType: 'LIMIT',
          timeInForce: 'POST_ONLY',
          price: '60000.00',
          quantity: '0.40000',
        },
      ],
    });

    const perpIntent = buildPerpNewOrderIntent({
      network: 'testnet',
      accountID: 5502,
      symbolID: 1,
      nonce: perpNonce,
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'POST_ONLY',
      price: '60040.0',
      quantity: '0.4000',
    });

    expect(spotIntent.nonce).not.toBe(perpIntent.nonce);
    expect(perpIntent.nonce > spotIntent.nonce).toBe(true);
    expect(spotIntent.clOrdIds[0]).not.toBe(perpIntent.clOrdIds[0]);

    const [signedSpot, signedPerp] = await Promise.all([
      signIntentWithEphemeralDryRunKey(spotIntent),
      signIntentWithEphemeralDryRunKey(perpIntent),
    ]);
    expect(signedSpot.verified).toBe(true);
    expect(signedPerp.verified).toBe(true);
    expect(signedSpot.headers['X-API-Nonce']).not.toBe(signedPerp.headers['X-API-Nonce']);
  });

  it('validates accountID strictly and rejects missing, zero, or negative accountIDs without defaulting to 1001', () => {
    expect(validateSodexAccountId('')).toBeNull();
    expect(validateSodexAccountId('   ')).toBeNull();
    expect(validateSodexAccountId('0')).toBeNull();
    expect(validateSodexAccountId('-12')).toBeNull();
    expect(validateSodexAccountId('abc')).toBeNull();
    expect(validateSodexAccountId(0)).toBeNull();
    expect(validateSodexAccountId(Number.NaN)).toBeNull();
    expect(validateSodexAccountId('4201')).toBe(4201);
    expect(validateSodexAccountId(777)).toBe(777);

    expect(() =>
      buildSpotBatchNewOrderIntent({
        network: 'testnet',
        accountID: 0,
        orders: [
          {
            symbolID: 1,
            side: 'BUY',
            orderType: 'LIMIT',
            timeInForce: 'GTC',
            price: '60000',
            quantity: '0.1',
          },
        ],
      }),
    ).toThrow(/accountID/i);

    expect(() =>
      buildPerpNewOrderIntent({
        network: 'testnet',
        accountID: -1,
        symbolID: 1,
        side: 'SELL',
        orderType: 'LIMIT',
        timeInForce: 'GTC',
        price: '60000',
        quantity: '0.1',
      }),
    ).toThrow(/accountID/i);
  });

  it('signs ExchangeAction with ephemeral key, prepends 0x01 wire prefix, and passes secp256k1 ecrecover verification', async () => {
    const intent = buildSpotBatchNewOrderIntent({
      network: 'testnet',
      accountID: 4201,
      nonce: 1795510000999n,
      orders: [
        {
          symbolID: 1,
          side: 'BUY',
          orderType: 'LIMIT',
          timeInForce: 'GTC',
          price: '60100.00',
          quantity: '0.10000',
        },
        {
          symbolID: 2,
          side: 'SELL',
          orderType: 'LIMIT',
          timeInForce: 'GTC',
          price: '2150.00',
          quantity: '1.5000',
        },
      ],
    });

    const signed = await signIntentWithEphemeralDryRunKey(intent);

    expect(signed.verified).toBe(true);
    expect(signed.recoveredAddress.toLowerCase()).toBe(signed.signerAddress.toLowerCase());
    // 0x01 + 65 bytes ECDSA = 66 bytes => 0x + 132 hex chars
    expect(signed.typedWireSignature).toMatch(/^0x01[0-9a-f]{130}$/);
    expect(signed.headers['X-API-Sign']).toBe(signed.typedWireSignature);
    expect(signed.headers['X-API-Nonce']).toBe('1795510000999');

    const curl = buildSignedCurlPreview(intent, signed.typedWireSignature);
    expect(curl).toContain('X-API-Sign: 0x01');
    expect(curl).toContain('/spot/trade/orders/batch');
  });

  it('rejects tampered payloads and invalid raw signature lengths', async () => {
    const original = buildPerpNewOrderIntent({
      network: 'mainnet',
      accountID: 4201,
      symbolID: 1,
      nonce: 1795510001111n,
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'POST_ONLY',
      price: '60500',
      quantity: '0.5000',
    });

    const signed = await signIntentWithEphemeralDryRunKey(original);

    // Mutate price -> payloadHash changes -> ecrecover must NOT verify against original signer
    const tampered = buildPerpNewOrderIntent({
      network: 'mainnet',
      accountID: 4201,
      symbolID: 1,
      nonce: 1795510001111n,
      side: 'SELL',
      orderType: 'LIMIT',
      timeInForce: 'POST_ONLY',
      price: '69999',
      quantity: '0.5000',
    });

    const checkTampered = await verifyExchangeActionSignature(
      tampered,
      signed.rawSignature,
      signed.signerAddress,
    );
    expect(checkTampered.valid).toBe(false);

    expect(() => formatSodexTypedSignature('0x1234')).toThrow(/Invalid 65-byte ECDSA signature/i);
  });
});
