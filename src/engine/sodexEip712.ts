import {
  concatHex,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SodexChainId, SodexNetwork } from '../types/market';

export const ZERO_VERIFYING_CONTRACT: Address =
  '0x0000000000000000000000000000000000000000';

export interface SodexNetworkConfig {
  id: SodexNetwork;
  label: string;
  chainId: SodexChainId;
  chainIdHex: string;
  restBase: string;
  wsBase: string;
  rpcUrl: string;
  explorerUrl: string;
  verifyingContract: Address;
  isMainnet: boolean;
}

export const SODEX_NETWORKS: Record<SodexNetwork, SodexNetworkConfig> = {
  testnet: {
    id: 'testnet',
    label: 'SoDEX Testnet (ValueChain)',
    chainId: 138565,
    chainIdHex: '0x21d35',
    restBase: 'https://testnet-gw.sodex.dev/api/v1',
    wsBase: 'wss://testnet-gw.sodex.dev/ws',
    rpcUrl: 'https://testnet.valuechain.xyz',
    explorerUrl: 'https://test-scan.valuechain.xyz',
    verifyingContract: ZERO_VERIFYING_CONTRACT,
    isMainnet: false,
  },
  mainnet: {
    id: 'mainnet',
    label: 'SoDEX Mainnet (ValueChain)',
    chainId: 286623,
    chainIdHex: '0x45f9f',
    restBase: 'https://mainnet-gw.sodex.dev/api/v1',
    wsBase: 'wss://mainnet-gw.sodex.dev/ws',
    rpcUrl: 'https://mainnet.valuechain.xyz',
    explorerUrl: 'https://main-scan.valuechain.xyz',
    verifyingContract: ZERO_VERIFYING_CONTRACT,
    isMainnet: true,
  },
};

export const SODEX_EXCHANGE_ACTION_TYPES = {
  ExchangeAction: [
    { name: 'payloadHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const;

export const SODEX_EIP712_DOMAIN_TYPE = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

export type SodexDomainName = 'spot' | 'futures';

export interface SodexSpotOrderItem {
  symbolID: number;
  clOrdID: string;
  side: 1 | 2; // 1 = BUY, 2 = SELL
  type: 1 | 2; // 1 = LIMIT, 2 = MARKET
  timeInForce: 1 | 2 | 3 | 4; // 1 = GTC, 2 = IOC, 3 = FOK, 4 = POST_ONLY
  price: string;
  quantity: string;
}

export interface SodexSpotBatchOrderParams {
  accountID: number;
  orders: SodexSpotOrderItem[];
}

export interface SodexPerpOrderItem {
  clOrdID: string;
  modifier: 1; // 1 = NORMAL
  side: 1 | 2; // 1 = BUY, 2 = SELL
  type: 1 | 2; // 1 = LIMIT, 2 = MARKET
  timeInForce: 1 | 2 | 3 | 4; // 1 = GTC, 2 = IOC, 3 = FOK, 4 = POST_ONLY
  price: string;
  quantity: string;
  reduceOnly: boolean;
  positionSide: 1 | 2 | 3; // 1 = BOTH, 2 = LONG, 3 = SHORT
}

export interface SodexPerpOrderParams {
  accountID: number;
  symbolID: number;
  orders: SodexPerpOrderItem[];
}

export interface SodexEip712Domain {
  name: SodexDomainName;
  version: '1';
  chainId: SodexChainId;
  verifyingContract: Address;
}

export interface SodexExchangeActionIntent {
  network: SodexNetwork;
  domainName: SodexDomainName;
  actionType: 'batchNewOrder' | 'newOrder';
  endpointUrl: string;
  httpMethod: 'POST';
  nonce: bigint;
  nonceStr: string;
  clOrdIds: string[];
  params: SodexSpotBatchOrderParams | SodexPerpOrderParams;
  canonicalSigningJson: string;
  httpBodyJson: string;
  payloadHash: Hex;
  typedDataHash: Hex;
  domain: SodexEip712Domain;
  primaryType: 'ExchangeAction';
  /** JSON-RPC eth_signTypedData_v4 compatible object */
  ethSignTypedDataV4Payload: {
    types: {
      EIP712Domain: typeof SODEX_EIP712_DOMAIN_TYPE;
      ExchangeAction: typeof SODEX_EXCHANGE_ACTION_TYPES.ExchangeAction;
    };
    domain: SodexEip712Domain;
    primaryType: 'ExchangeAction';
    message: {
      payloadHash: Hex;
      nonce: string;
    };
  };
}

export interface SignedSodexEnvelope {
  intent: SodexExchangeActionIntent;
  signerAddress: Address;
  recoveredAddress: Address;
  verified: boolean;
  mode: 'WALLET_EIP1193' | 'EPHEMERAL_DRY_RUN';
  rawSignature: Hex;
  typedWireSignature: Hex; // 0x01 || 65-byte ECDSA signature
  headers: {
    'Content-Type': 'application/json';
    Accept: 'application/json';
    'X-API-Nonce': string;
    'X-API-Sign': Hex;
  };
  curlCommand: string;
  signedAtIso: string;
}

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  isMetaMask?: boolean;
  isRabby?: boolean;
  isCoinbaseWallet?: boolean;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function formatDecimalFixed(value: number, precision: number, minValue = 0): string {
  const safe = Number.isFinite(value) ? Math.max(minValue, value) : minValue;
  const clampedPrec = Math.max(0, Math.min(8, Math.round(precision)));
  return safe.toFixed(clampedPrec);
}

export function makeClOrdId(prefix: string, nonce: bigint, idx = 0): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 10) || 'bd';
  const suffix = idx > 0 ? `-${idx}` : '';
  return `${cleanPrefix}-${nonce.toString().slice(-11)}${suffix}`.slice(0, 30);
}

/**
 * Computes canonical SoDEX ExchangeAction payloadHash = keccak256(utf8(JSON.stringify({ type, params })))
 * matching docs.sodex.com/for-developers/developers/trading/authentication-and-signing.
 */
export function computeSodexPayloadHash(
  actionType: 'batchNewOrder' | 'newOrder',
  params: SodexSpotBatchOrderParams | SodexPerpOrderParams,
): { canonicalSigningJson: string; httpBodyJson: string; payloadHash: Hex } {
  const httpBodyJson = JSON.stringify(params);
  // Strict Go struct key order: "type" before "params"
  const canonicalSigningJson = JSON.stringify({ type: actionType, params });
  const payloadHash = keccak256(toHex(canonicalSigningJson));
  return { canonicalSigningJson, httpBodyJson, payloadHash };
}

function finalizeIntent(args: {
  network: SodexNetwork;
  domainName: SodexDomainName;
  actionType: 'batchNewOrder' | 'newOrder';
  endpointPath: string;
  nonce: bigint;
  clOrdIds: string[];
  params: SodexSpotBatchOrderParams | SodexPerpOrderParams;
}): SodexExchangeActionIntent {
  const net = SODEX_NETWORKS[args.network];
  const { canonicalSigningJson, httpBodyJson, payloadHash } = computeSodexPayloadHash(
    args.actionType,
    args.params,
  );

  const domain: SodexEip712Domain = {
    name: args.domainName,
    version: '1',
    chainId: net.chainId,
    verifyingContract: net.verifyingContract,
  };

  const typedDataHash = hashTypedData({
    domain,
    types: SODEX_EXCHANGE_ACTION_TYPES,
    primaryType: 'ExchangeAction',
    message: {
      payloadHash,
      nonce: args.nonce,
    },
  });

  const nonceStr = args.nonce.toString();

  return {
    network: args.network,
    domainName: args.domainName,
    actionType: args.actionType,
    endpointUrl: `${net.restBase}${args.endpointPath}`,
    httpMethod: 'POST',
    nonce: args.nonce,
    nonceStr,
    clOrdIds: args.clOrdIds,
    params: args.params,
    canonicalSigningJson,
    httpBodyJson,
    payloadHash,
    typedDataHash,
    domain,
    primaryType: 'ExchangeAction',
    ethSignTypedDataV4Payload: {
      types: {
        EIP712Domain: SODEX_EIP712_DOMAIN_TYPE,
        ExchangeAction: SODEX_EXCHANGE_ACTION_TYPES.ExchangeAction,
      },
      domain,
      primaryType: 'ExchangeAction',
      message: {
        payloadHash,
        nonce: nonceStr,
      },
    },
  };
}

/**
 * Builds an official SoDEX Spot `batchNewOrder` EIP-712 ExchangeAction intent.
 * Preserves exact Go struct field ordering required by SoDEX gateway signature verification.
 */
export function buildSpotBatchNewOrderIntent(input: {
  network: SodexNetwork;
  accountID: number;
  nonce?: bigint;
  orders: Array<{
    symbolID: number;
    side: 'BUY' | 'SELL';
    orderType: 'LIMIT' | 'MARKET';
    timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';
    price: string;
    quantity: string;
    clOrdID?: string;
  }>;
}): SodexExchangeActionIntent {
  const nonce = input.nonce ?? BigInt(Date.now());
  const tifMap = { GTC: 1, IOC: 2, FOK: 3, POST_ONLY: 4 } as const;

  const normalizedOrders: SodexSpotOrderItem[] = input.orders.map((ord, idx) => ({
    symbolID: Math.max(1, Math.trunc(ord.symbolID)),
    clOrdID: ord.clOrdID ?? makeClOrdId('bdspot', nonce, idx),
    side: ord.side === 'BUY' ? 1 : 2,
    type: ord.orderType === 'LIMIT' ? 1 : 2,
    timeInForce: tifMap[ord.timeInForce],
    price: ord.price,
    quantity: ord.quantity,
  }));

  const params: SodexSpotBatchOrderParams = {
    accountID: Math.max(1, Math.trunc(input.accountID)),
    orders: normalizedOrders,
  };

  return finalizeIntent({
    network: input.network,
    domainName: 'spot',
    actionType: 'batchNewOrder',
    endpointPath: '/spot/trade/orders/batch',
    nonce,
    clOrdIds: normalizedOrders.map((o) => o.clOrdID),
    params,
  });
}

/**
 * Builds an official SoDEX Perps `newOrder` EIP-712 ExchangeAction intent (`domain.name = "futures"`).
 * Preserves exact Go struct field ordering required by SoDEX Perps REST gateway.
 */
export function buildPerpNewOrderIntent(input: {
  network: SodexNetwork;
  accountID: number;
  symbolID: number;
  nonce?: bigint;
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'POST_ONLY';
  price: string;
  quantity: string;
  reduceOnly?: boolean;
  clOrdID?: string;
}): SodexExchangeActionIntent {
  const nonce = input.nonce ?? BigInt(Date.now());
  const tifMap = { GTC: 1, IOC: 2, FOK: 3, POST_ONLY: 4 } as const;
  const clOrdID = input.clOrdID ?? makeClOrdId('bdperp', nonce, 0);

  const params: SodexPerpOrderParams = {
    accountID: Math.max(1, Math.trunc(input.accountID)),
    symbolID: Math.max(1, Math.trunc(input.symbolID)),
    orders: [
      {
        clOrdID,
        modifier: 1,
        side: input.side === 'BUY' ? 1 : 2,
        type: input.orderType === 'LIMIT' ? 1 : 2,
        timeInForce: tifMap[input.timeInForce],
        price: input.price,
        quantity: input.quantity,
        reduceOnly: Boolean(input.reduceOnly),
        positionSide: 1,
      },
    ],
  };

  return finalizeIntent({
    network: input.network,
    domainName: 'futures',
    actionType: 'newOrder',
    endpointPath: '/perps/trade/orders',
    nonce,
    clOrdIds: [clOrdID],
    params,
  });
}

/**
 * Formats a 65-byte ECDSA signature into SoDEX's 66-byte ExchangeAction wire signature (`0x01 || r || s || v`).
 */
export function formatSodexTypedSignature(rawSignature: Hex): Hex {
  const clean = rawSignature.toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(clean)) {
    throw new Error(
      `Invalid 65-byte ECDSA signature length (${rawSignature.length - 2} hex chars; expected 130)`,
    );
  }
  return concatHex(['0x01', clean as Hex]);
}

/**
 * Cryptographically verifies an EIP-712 ExchangeAction signature via secp256k1 ecrecover.
 */
export async function verifyExchangeActionSignature(
  intent: SodexExchangeActionIntent,
  rawSignature: Hex,
  expectedSigner: Address,
): Promise<{ valid: boolean; recoveredAddress: Address; typedWireSignature: Hex }> {
  const typedWireSignature = formatSodexTypedSignature(rawSignature);
  const checksummedExpected = getAddress(expectedSigner);

  const recoveredAddress = await recoverTypedDataAddress({
    domain: intent.domain,
    types: SODEX_EXCHANGE_ACTION_TYPES,
    primaryType: 'ExchangeAction',
    message: {
      payloadHash: intent.payloadHash,
      nonce: intent.nonce,
    },
    signature: rawSignature,
  });

  const verified = await verifyTypedData({
    address: checksummedExpected,
    domain: intent.domain,
    types: SODEX_EXCHANGE_ACTION_TYPES,
    primaryType: 'ExchangeAction',
    message: {
      payloadHash: intent.payloadHash,
      nonce: intent.nonce,
    },
    signature: rawSignature,
  });

  return {
    valid: verified && recoveredAddress.toLowerCase() === checksummedExpected.toLowerCase(),
    recoveredAddress,
    typedWireSignature,
  };
}

export function buildSignedCurlPreview(
  intent: SodexExchangeActionIntent,
  typedWireSignature: Hex,
): string {
  return [
    `curl -sS -X POST "${intent.endpointUrl}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Accept: application/json" \\`,
    `  -H "X-API-Nonce: ${intent.nonceStr}" \\`,
    `  -H "X-API-Sign: ${typedWireSignature}" \\`,
    `  --data-raw '${intent.httpBodyJson}'`,
  ].join('\n');
}

/**
 * Signs an ExchangeAction intent with a throwaway in-memory ephemeral test keypair for
 * zero-wallet cryptographic dry-run verification (never persisted, zero funds, never broadcast).
 */
export async function signIntentWithEphemeralDryRunKey(
  intent: SodexExchangeActionIntent,
): Promise<SignedSodexEnvelope> {
  const ephemeralKey = generatePrivateKey();
  const account = privateKeyToAccount(ephemeralKey);

  const rawSignature = await account.signTypedData({
    domain: intent.domain,
    types: SODEX_EXCHANGE_ACTION_TYPES,
    primaryType: 'ExchangeAction',
    message: {
      payloadHash: intent.payloadHash,
      nonce: intent.nonce,
    },
  });

  const verification = await verifyExchangeActionSignature(intent, rawSignature, account.address);

  return {
    intent,
    signerAddress: account.address,
    recoveredAddress: verification.recoveredAddress,
    verified: verification.valid,
    mode: 'EPHEMERAL_DRY_RUN',
    rawSignature,
    typedWireSignature: verification.typedWireSignature,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Nonce': intent.nonceStr,
      'X-API-Sign': verification.typedWireSignature,
    },
    curlCommand: buildSignedCurlPreview(intent, verification.typedWireSignature),
    signedAtIso: new Date().toISOString(),
  };
}

export function detectInjectedProvider(): {
  available: boolean;
  provider: Eip1193Provider | null;
  label: string;
} {
  if (typeof window === 'undefined' || !window.ethereum) {
    return { available: false, provider: null, label: 'No EIP-1193 wallet detected' };
  }
  const eth = window.ethereum;
  const label = eth.isRabby
    ? 'Rabby Wallet (EIP-1193)'
    : eth.isMetaMask
      ? 'MetaMask (EIP-1193)'
      : eth.isCoinbaseWallet
        ? 'Coinbase Wallet (EIP-1193)'
        : 'Injected EVM Wallet (EIP-1193)';
  return { available: true, provider: eth, label };
}

export async function connectInjectedWallet(): Promise<{
  address: Address;
  chainId: number;
  providerLabel: string;
}> {
  const { available, provider, label } = detectInjectedProvider();
  if (!available || !provider) {
    throw new Error(
      'No browser wallet found (window.ethereum unavailable). Install MetaMask/Rabby or use Local Cryptographic Dry-Run.',
    );
  }
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!Array.isArray(accounts) || !accounts[0]) {
    throw new Error('Wallet connection returned no authorized accounts.');
  }
  const rawChain = (await provider.request({ method: 'eth_chainId' })) as string;
  const chainId = typeof rawChain === 'string' ? parseInt(rawChain, 16) : Number(rawChain || 1);
  return {
    address: getAddress(accounts[0]),
    chainId: Number.isFinite(chainId) ? chainId : 1,
    providerLabel: label,
  };
}

export async function requestSwitchToValueChain(network: SodexNetwork): Promise<void> {
  const { provider } = detectInjectedProvider();
  if (!provider) return;
  const cfg = SODEX_NETWORKS[network];
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: cfg.chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: cfg.chainIdHex,
            chainName: cfg.label,
            nativeCurrency: { name: 'SOSO', symbol: 'SOSO', decimals: 18 },
            rpcUrls: [cfg.rpcUrl],
            blockExplorerUrls: [cfg.explorerUrl],
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

/**
 * Signs an official SoDEX ExchangeAction intent via injected EIP-1193 wallet (`eth_signTypedData_v4`),
 * then performs immediate local secp256k1 ecrecover verification before returning the signed envelope.
 */
export async function signIntentWithInjectedWallet(
  intent: SodexExchangeActionIntent,
  signerAddress: Address,
): Promise<SignedSodexEnvelope> {
  const { available, provider } = detectInjectedProvider();
  if (!available || !provider) {
    throw new Error('Injected EIP-1193 wallet provider not available.');
  }

  const checksummed = getAddress(signerAddress);
  const rawSignature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [checksummed, JSON.stringify(intent.ethSignTypedDataV4Payload)],
  })) as Hex;

  const verification = await verifyExchangeActionSignature(intent, rawSignature, checksummed);

  return {
    intent,
    signerAddress: checksummed,
    recoveredAddress: verification.recoveredAddress,
    verified: verification.valid,
    mode: 'WALLET_EIP1193',
    rawSignature,
    typedWireSignature: verification.typedWireSignature,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Nonce': intent.nonceStr,
      'X-API-Sign': verification.typedWireSignature,
    },
    curlCommand: buildSignedCurlPreview(intent, verification.typedWireSignature),
    signedAtIso: new Date().toISOString(),
  };
}
