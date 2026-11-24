export type FeedStatus =
  | 'LIVE_WS'
  | 'LIVE_REST'
  | 'LIVE_RPC'
  | 'LIVE_DIRECT'
  | 'SNAPSHOT'
  | 'FALLBACK';

export interface FeedTelemetry {
  id: 'sodex_perps' | 'sodex_spot' | 'valuechain_rpc' | 'sosovalue_api';
  label: string;
  status: FeedStatus;
  endpoint: string;
  lastUpdatedIso: string;
  latencyMs: number | null;
  framesReceived?: number;
  detail: string;
}

export interface PerpMarginTier {
  maxNotionalValue: string;
  maintenanceMarginRate: string;
  maxLeverage: number;
  maintenanceDeduction: string;
}

export interface PerpSymbolSpec {
  id: number;
  name: string;
  displayName: string;
  baseCoin: string;
  quoteCoin: string;
  pricePrecision: number;
  quantityPrecision: number;
  maxLeverage: number;
  initLeverage: number;
  fundingInterval: number;
  interestRate: string;
  maxFundingRate: string;
  minFundingRate: string;
  makerFee: string;
  takerFee: string;
  openInterestCapUSD: string;
  marginTiers: PerpMarginTier[];
  status: string;
}

export interface PerpTicker {
  symbol: string;
  lastPx: string;
  openPx: string;
  highPx: string;
  lowPx: string;
  volume: string;
  quoteVolume: string;
  vwap: string;
  change: string;
  changePct: number;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
  fundingRate: string;
  nextFundingTime: number;
  indexPrice: string;
  markPrice: string;
  openInterest: string;
}

export interface SpotSymbolSpec {
  id: number;
  name: string;
  displayName: string;
  baseCoin: string;
  quoteCoin: string;
  pricePrecision: number;
  quantityPrecision: number;
  makerFee: string;
  takerFee: string;
  status: string;
}

export interface SpotTicker {
  symbol: string;
  lastPx: string;
  openPx: string;
  highPx: string;
  lowPx: string;
  volume: string;
  quoteVolume: string;
  vwap: string;
  change: string;
  changePct: number;
  askPx: string;
  askSz: string;
  bidPx: string;
  bidSz: string;
}

export type OrderBookLevel = [string, string];

export interface OrderBookSnapshot {
  blockTime?: number;
  blockHeight?: number;
  updateID: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface LiveTrade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  timestamp: number;
}

export interface ValueChainTelemetry {
  chainId: number;
  blockNumber: number;
  gasPriceWei: number;
  rpcUrl: string;
  explorerUrl: string;
  capturedAt: string;
}

export interface EtfDailyFlow {
  date: string;
  total_net_inflow: number;
  total_value_traded: number;
  total_net_assets: number;
  cum_net_inflow: number;
}

export interface SoSoMarketOverview {
  total_market_cap: string;
  total_market_cap_change_pct: string;
  total_volume_24h: string;
  eth_gas_gwei: string;
  btc_gas_sat_vb: string;
  as_of: number;
}

export interface SoSoNewsItem {
  id: string;
  title: string;
  source: string;
  category: string;
  publishedAt: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

export interface SsiConstituentWeight {
  symbol: string;
  weight: number;
}

export interface SoSoValueDataset {
  mode: 'LIVE_DIRECT' | 'LIVE_CI_SNAPSHOT' | 'SNAPSHOT' | 'FALLBACK';
  note: string;
  marketOverview: SoSoMarketOverview;
  btcEtfHistory: EtfDailyFlow[];
  ethEtfHistory: EtfDailyFlow[];
  ssiConstituents: {
    ssimag7: SsiConstituentWeight[];
    ssidefi: SsiConstituentWeight[];
  };
  news: SoSoNewsItem[];
}

export interface KlineBar {
  t: number; // open timestamp (ms)
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  q: string;
  n: number;
}

export interface HistoricalKlineBundle {
  perpSymbol: string;
  spotSymbol: string;
  interval: '4h';
  source: 'LIVE_REST' | 'SNAPSHOT' | 'SYNTHETIC';
  fetchedAtIso: string;
  latencyMs: number | null;
  perpBars: KlineBar[];
  spotBars: KlineBar[];
}

export type SodexNetwork = 'testnet' | 'mainnet';
export type SodexChainId = 138565 | 286623;

export interface DiagProbeResult {
  id: string;
  label: string;
  pillar: 'SoDEX' | 'ValueChain' | 'SoSoValue' | 'EIP-712';
  endpoint: string;
  method: 'GET' | 'POST' | 'WS' | 'LOCAL';
  ok: boolean;
  statusLabel: string;
  httpStatus: number | null;
  latencyMs: number;
  checkedAtIso: string;
  summary: string;
  rawPreview: string;
}

export interface MarketSnapshotPayload {
  schemaVersion: number;
  generatedAt: string;
  sodexSummary: {
    totalPerpMarkets: number;
    totalSpotMarkets: number;
    gateway: string;
  };
  valueChain: ValueChainTelemetry;
  perps: {
    symbols: PerpSymbolSpec[];
    tickers: PerpTicker[];
    realizedVol: Record<string, number>;
  };
  spot: {
    symbols: SpotSymbolSpec[];
    tickers: SpotTicker[];
  };
  orderbooks: {
    perps: Record<string, OrderBookSnapshot>;
    spot: Record<string, OrderBookSnapshot>;
  };
  klines30d?: Record<string, { perp: KlineBar[]; spot: KlineBar[] }>;
  sosovalue: SoSoValueDataset;
}

export interface BasisOpportunity {
  baseCoin: string;
  perpSymbol: string;
  spotSymbol: string;
  spotPrice: number;
  perpMarkPrice: number;
  indexPrice: number;
  basisBps: number;
  hourlyFundingRate: number;
  annualizedFundingPct: number;
  nextFundingTime: number;
  openInterestUsd: number;
  volume24hUsd: number;
  changePct24h: number;
  maxLeverage: number;
  makerFeeBps: number;
  takerFeeBps: number;
  spotTakerFeeBps: number;
  netCarryApyPct: number;
  breakevenDays: number;
  strategySide: 'LONG_SPOT_SHORT_PERP' | 'REVERSE_CARRY_WATCH';
  realizedVol: number;
}

export interface PaperExecutionOrder {
  id: string;
  createdAtIso: string;
  strategyType: 'DELTA_NEUTRAL_BASIS' | 'SSI_REBALANCE';
  symbol: string;
  spotSymbol: string;
  direction: 'LONG_SPOT_SHORT_PERP' | 'REBALANCE_BASKET';
  notionalUsd: number;
  leverage: number;
  entrySpotPrice: number;
  entryPerpPrice: number;
  entryHourlyFundingRate: number;
  expectedNetApyPct: number;
  estimatedFeesUsd: number;
  liquidationBufferPct: number;
  guardrailStatus: 'PASS' | 'WARN';
  status: 'OPEN' | 'CLOSED';
  notes: string;
  executionChannel?: 'PAPER' | 'EIP712_DRY_RUN' | 'EIP712_WALLET_SIGNED';
  eip712Network?: SodexNetwork;
  eip712Signer?: string;
  eip712Digest?: string;
  clOrdId?: string;
  typedSignaturePreview?: string;
}
