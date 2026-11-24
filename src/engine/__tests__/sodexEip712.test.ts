import { describe, expect, it } from 'vitest';
import {
  buildPerpNewOrderIntent,
  buildSignedCurlPreview,
  buildSpotBatchNewOrderIntent,
  formatSodexTypedSignature,
  signIntentWithEphemeralDryRunKey,
  SODEX_EXCHANGE_ACTION_TYPES,
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

  it('signs ExchangeAction with ephemeral key, prepends 0x01 wire prefix, and passes secp256k1 ecrecover verification', async () => {
    const intent = buildSpotBatchNewOrderIntent({
      network: 'testnet',
      accountID: 1001,
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
      accountID: 1001,
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
      accountID: 1001,
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
