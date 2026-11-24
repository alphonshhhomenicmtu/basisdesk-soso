import type {
  LiveTrade,
  MarketSnapshotPayload,
  OrderBookSnapshot,
  PerpSymbolSpec,
  PerpTicker,
  SoSoValueDataset,
  SpotSymbolSpec,
  SpotTicker,
  ValueChainTelemetry,
} from '../types/market';

export const SODEX_REST_BASE = 'https://mainnet-gw.sodex.dev/api/v1';
export const SODEX_PERPS_WS = 'wss://mainnet-gw.sodex.dev/ws/perps';
export const SODEX_SPOT_WS = 'wss://mainnet-gw.sodex.dev/ws/spot';
export const VALUECHAIN_RPC_URL = 'https://mainnet.valuechain.xyz';
export const SOSOVALUE_API_BASE = 'https://openapi.sosovalue.com/openapi/v1';

const CORE_PERP_SET = new Set([
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'BNB-USD',
  'XRP-USD',
  'DOGE-USD',
  'ADA-USD',
  'LINK-USD',
  'AAVE-USD',
  'UNI-USD',
  'AVAX-USD',
  'SUI-USD',
  'HYPE-USD',
]);

const CORE_SPOT_SET = new Set([
  'vBTC_vUSDC',
  'vETH_vUSDC',
  'vSOL_vUSDC',
  'vBNB_vUSDC',
  'vXRP_vUSDC',
  'vDOGE_vUSDC',
  'vADA_vUSDC',
  'vLINK_vUSDC',
  'vAAVE_vUSDC',
  'vUNI_vUSDC',
  'vAVAX_vUSDC',
  'vSUI_vUSDC',
  'vHYPE_vUSDC',
  'vMAG7ssi_vUSDC',
  'vDEFIssi_vUSDC',
  'vMEMEssi_vUSDC',
  'vUSSI_vUSDC',
  'WSOSO_vUSDC',
]);

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<{ data: T; latencyMs: number }> {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${res.statusText})`);
    }
    const data = (await res.json()) as T;
    return { data, latencyMs: Math.round(performance.now() - start) };
  } finally {
    clearTimeout(timer);
  }
}

export async function loadBaselineSnapshot(): Promise<MarketSnapshotPayload> {
  const { data } = await fetchJsonWithTimeout<MarketSnapshotPayload>(
    './data/market-snapshot.json',
    { cache: 'no-cache' },
    6000,
  );
  return data;
}

export async function fetchLiveSodexMarkets(): Promise<{
  perpSymbols: PerpSymbolSpec[];
  perpTickers: PerpTicker[];
  spotSymbols: SpotSymbolSpec[];
  spotTickers: SpotTicker[];
  totalPerpMarkets: number;
  totalSpotMarkets: number;
  latencyMs: number;
}> {
  const start = performance.now();
  const [pSym, pTick, sSym, sTick] = await Promise.all([
    fetchJsonWithTimeout<{ data: PerpSymbolSpec[] }>(`${SODEX_REST_BASE}/perps/markets/symbols`),
    fetchJsonWithTimeout<{ data: PerpTicker[] }>(`${SODEX_REST_BASE}/perps/markets/tickers`),
    fetchJsonWithTimeout<{ data: SpotSymbolSpec[] }>(`${SODEX_REST_BASE}/spot/markets/symbols`),
    fetchJsonWithTimeout<{ data: SpotTicker[] }>(`${SODEX_REST_BASE}/spot/markets/tickers`),
  ]);

  return {
    perpSymbols: (pSym.data.data || []).filter((s) => CORE_PERP_SET.has(s.name)),
    perpTickers: (pTick.data.data || []).filter((t) => CORE_PERP_SET.has(t.symbol)),
    spotSymbols: (sSym.data.data || []).filter((s) => CORE_SPOT_SET.has(s.name)),
    spotTickers: (sTick.data.data || []).filter((t) => CORE_SPOT_SET.has(t.symbol)),
    totalPerpMarkets: (pSym.data.data || []).length,
    totalSpotMarkets: (sSym.data.data || []).length,
    latencyMs: Math.round(performance.now() - start),
  };
}

export async function fetchLiveOrderBook(
  marketType: 'perps' | 'spot',
  symbol: string,
  limit = 15,
): Promise<OrderBookSnapshot> {
  const { data } = await fetchJsonWithTimeout<{ data: OrderBookSnapshot }>(
    `${SODEX_REST_BASE}/${marketType}/markets/${encodeURIComponent(symbol)}/orderbook?limit=${limit}`,
  );
  return data.data;
}

export async function fetchLivePerpTrades(symbol: string, limit = 15): Promise<LiveTrade[]> {
  const { data } = await fetchJsonWithTimeout<{
    data: Array<{ t: number; T: number; s: string; S: 'BUY' | 'SELL'; p: string; q: string }>;
  }>(`${SODEX_REST_BASE}/perps/markets/${encodeURIComponent(symbol)}/trades?limit=${limit}`);
  return (data.data || []).map((row) => ({
    id: `${row.s}-${row.t}`,
    symbol: row.s,
    side: row.S,
    price: Number(row.p),
    quantity: Number(row.q),
    timestamp: row.T,
  }));
}

export async function fetchLiveValueChainRpc(): Promise<{
  telemetry: ValueChainTelemetry;
  latencyMs: number;
}> {
  const { data, latencyMs } = await fetchJsonWithTimeout<
    Array<{ id: number; result?: string }>
  >(
    VALUECHAIN_RPC_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_blockNumber', params: [] },
        { jsonrpc: '2.0', id: 3, method: 'eth_gasPrice', params: [] },
      ]),
    },
    6000,
  );

  const byId = new Map((data || []).map((item) => [item.id, item.result]));
  return {
    telemetry: {
      chainId: parseInt(byId.get(1) ?? '0x45f9f', 16),
      blockNumber: parseInt(byId.get(2) ?? '0x0', 16),
      gasPriceWei: parseInt(byId.get(3) ?? '0x1e8480', 16),
      rpcUrl: VALUECHAIN_RPC_URL,
      explorerUrl: 'https://main-scan.valuechain.xyz',
      capturedAt: new Date().toISOString(),
    },
    latencyMs,
  };
}

export async function fetchLiveSoSoValueDirect(
  apiKey: string,
  fallback: SoSoValueDataset,
): Promise<{ dataset: SoSoValueDataset; latencyMs: number }> {
  const cleanKey = apiKey.trim();
  if (!cleanKey) {
    throw new Error('Please provide a valid SoSoValue Open API key.');
  }

  const headers = { 'x-soso-api-key': cleanKey };
  const start = performance.now();

  const [overviewRes, btcEtfRes, ethEtfRes, mag7Res, newsRes] = await Promise.all([
    fetchJsonWithTimeout<Record<string, unknown>>(`${SOSOVALUE_API_BASE}/market/overview`, { headers }),
    fetchJsonWithTimeout<Record<string, unknown>>(
      `${SOSOVALUE_API_BASE}/etfs/summary-history?symbol=BTC&country_code=US&limit=10`,
      { headers },
    ),
    fetchJsonWithTimeout<Record<string, unknown>>(
      `${SOSOVALUE_API_BASE}/etfs/summary-history?symbol=ETH&country_code=US&limit=10`,
      { headers },
    ),
    fetchJsonWithTimeout<unknown>(`${SOSOVALUE_API_BASE}/indices/ssimag7/constituents`, { headers }).catch(
      () => null,
    ),
    fetchJsonWithTimeout<Record<string, unknown>>(
      `${SOSOVALUE_API_BASE}/news?category=1&language=en&page=1`,
      { headers },
    ).catch(() => null),
  ]);

  const overviewBody = (overviewRes.data.data ?? overviewRes.data) as Record<string, unknown>;
  if (overviewRes.data.code && Number(overviewRes.data.code) !== 0) {
    throw new Error(String(overviewRes.data.message || 'SoSoValue API rejected the provided key'));
  }

  const btcList = Array.isArray(btcEtfRes.data.data ?? btcEtfRes.data)
    ? ((btcEtfRes.data.data ?? btcEtfRes.data) as SoSoValueDataset['btcEtfHistory'])
    : fallback.btcEtfHistory;
  const ethList = Array.isArray(ethEtfRes.data.data ?? ethEtfRes.data)
    ? ((ethEtfRes.data.data ?? ethEtfRes.data) as SoSoValueDataset['ethEtfHistory'])
    : fallback.ethEtfHistory;

  const rawMag7 = mag7Res
    ? ((mag7Res.data as { data?: unknown })?.data ?? mag7Res.data)
    : null;
  const mag7Weights = Array.isArray(rawMag7)
    ? rawMag7.map((c: Record<string, unknown>) => ({
        symbol: String(c.symbol ?? '').toUpperCase(),
        weight: Number(c.weight ?? 0),
      }))
    : fallback.ssiConstituents.ssimag7;

  const rawNewsContainer = newsRes
    ? ((newsRes.data.data as { list?: unknown[] } | unknown[]) ?? [])
    : [];
  const rawNewsList = Array.isArray(rawNewsContainer)
    ? rawNewsContainer
    : Array.isArray((rawNewsContainer as { list?: unknown[] }).list)
      ? (rawNewsContainer as { list: unknown[] }).list
      : [];

  const parsedNews =
    rawNewsList.length > 0
      ? rawNewsList.slice(0, 6).map((item, idx) => {
          const rec = item as Record<string, unknown>;
          return {
            id: String(rec.id ?? `soso-live-${idx}`),
            title: String(rec.title ?? rec.content ?? 'SoSoValue Research Alert'),
            source: String(rec.source ?? 'SoSoValue'),
            category: 'SoSoValue Live',
            publishedAt: rec.releaseTime
              ? new Date(Number(rec.releaseTime)).toISOString()
              : new Date().toISOString(),
            sentiment: 'neutral' as const,
          };
        })
      : fallback.news;

  return {
    dataset: {
      mode: 'LIVE_DIRECT',
      note: 'Connected live via browser BYOK header x-soso-api-key to openapi.sosovalue.com/openapi/v1.',
      marketOverview: {
        total_market_cap: String(overviewBody.total_market_cap ?? fallback.marketOverview.total_market_cap),
        total_market_cap_change_pct: String(
          overviewBody.total_market_cap_change_pct ?? fallback.marketOverview.total_market_cap_change_pct,
        ),
        total_volume_24h: String(overviewBody.total_volume_24h ?? fallback.marketOverview.total_volume_24h),
        eth_gas_gwei: String(overviewBody.eth_gas_gwei ?? fallback.marketOverview.eth_gas_gwei),
        btc_gas_sat_vb: String(overviewBody.btc_gas_sat_vb ?? fallback.marketOverview.btc_gas_sat_vb),
        as_of: Number(overviewBody.as_of ?? Date.now()),
      },
      btcEtfHistory: btcList,
      ethEtfHistory: ethList,
      ssiConstituents: {
        ssimag7: mag7Weights,
        ssidefi: fallback.ssiConstituents.ssidefi,
      },
      news: parsedNews,
    },
    latencyMs: Math.round(performance.now() - start),
  };
}

export interface SodexWsCallbacks {
  onPerpStatus: (connected: boolean, frames: number) => void;
  onSpotStatus: (connected: boolean, frames: number) => void;
  onPerpMarkUpdate: (update: {
    symbol: string;
    markPrice: string;
    indexPrice: string;
    fundingRate: string;
    openInterest: string;
    nextFundingTime: number;
  }) => void;
  onPerpL2Update: (symbol: string, book: OrderBookSnapshot) => void;
  onSpotL2Update: (symbol: string, book: OrderBookSnapshot) => void;
  onSpotTickerUpdate: (symbol: string, lastPx: string, bidPx: string, askPx: string, changePct: number) => void;
  onTrade: (trade: LiveTrade) => void;
}

/**
 * Dual SoDEX Mainnet WebSocket manager (Perps + Spot) with clean subscription switching.
 */
export class SodexWebSocketManager {
  private perpsWs: WebSocket | null = null;
  private spotWs: WebSocket | null = null;
  private activePerpSymbol: string;
  private activeSpotSymbol: string;
  private perpFrames = 0;
  private spotFrames = 0;
  private closed = false;
  private callbacks: SodexWsCallbacks;
  private watchedPerps = Array.from(CORE_PERP_SET);
  private watchedSpots = [
    'vBTC_vUSDC',
    'vETH_vUSDC',
    'vSOL_vUSDC',
    'vMAG7ssi_vUSDC',
    'vDEFIssi_vUSDC',
    'vMEMEssi_vUSDC',
    'vUSSI_vUSDC',
    'WSOSO_vUSDC',
  ];

  constructor(initialPerp: string, initialSpot: string, callbacks: SodexWsCallbacks) {
    this.activePerpSymbol = initialPerp;
    this.activeSpotSymbol = initialSpot;
    this.callbacks = callbacks;
  }

  public start(): void {
    this.closed = false;
    this.connectPerps();
    this.connectSpot();
  }

  public switchActivePair(perpSymbol: string, spotSymbol: string): void {
    const prevPerp = this.activePerpSymbol;
    const prevSpot = this.activeSpotSymbol;
    this.activePerpSymbol = perpSymbol;
    this.activeSpotSymbol = spotSymbol;

    if (this.perpsWs?.readyState === WebSocket.OPEN && prevPerp !== perpSymbol) {
      this.perpsWs.send(
        JSON.stringify({ op: 'unsubscribe', params: { channel: 'l2Book', symbol: prevPerp } }),
      );
      this.perpsWs.send(
        JSON.stringify({ op: 'unsubscribe', params: { channel: 'trade', symbols: [prevPerp] } }),
      );
      this.perpsWs.send(
        JSON.stringify({ op: 'subscribe', params: { channel: 'l2Book', symbol: perpSymbol } }),
      );
      this.perpsWs.send(
        JSON.stringify({ op: 'subscribe', params: { channel: 'trade', symbols: [perpSymbol] } }),
      );
    }

    if (this.spotWs?.readyState === WebSocket.OPEN && prevSpot !== spotSymbol) {
      this.spotWs.send(
        JSON.stringify({ op: 'unsubscribe', params: { channel: 'l2Book', symbol: prevSpot } }),
      );
      this.spotWs.send(
        JSON.stringify({ op: 'subscribe', params: { channel: 'l2Book', symbol: spotSymbol } }),
      );
    }
  }

  public stop(): void {
    this.closed = true;
    try {
      this.perpsWs?.close();
    } catch {
      // ignore close errors
    }
    try {
      this.spotWs?.close();
    } catch {
      // ignore close errors
    }
    this.perpsWs = null;
    this.spotWs = null;
  }

  private connectPerps(): void {
    if (this.closed || typeof WebSocket === 'undefined') return;
    try {
      const ws = new WebSocket(SODEX_PERPS_WS);
      this.perpsWs = ws;

      ws.onopen = () => {
        this.callbacks.onPerpStatus(true, this.perpFrames);
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            id: 1,
            params: { channel: 'markPrice', symbols: this.watchedPerps },
          }),
        );
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            id: 2,
            params: { channel: 'l2Book', symbol: this.activePerpSymbol },
          }),
        );
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            id: 3,
            params: { channel: 'trade', symbols: [this.activePerpSymbol] },
          }),
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (!msg.channel || !msg.data) return;
          this.perpFrames += 1;
          if (this.perpFrames % 3 === 0 || this.perpFrames <= 5) {
            this.callbacks.onPerpStatus(true, this.perpFrames);
          }

          if (msg.channel === 'markPrice' && Array.isArray(msg.data)) {
            for (const item of msg.data) {
              this.callbacks.onPerpMarkUpdate({
                symbol: item.s,
                markPrice: item.p,
                indexPrice: item.i,
                fundingRate: item.r,
                openInterest: item.oi,
                nextFundingTime: Number(item.T || 0),
              });
            }
          } else if (msg.channel === 'l2Book' && msg.data.s) {
            this.callbacks.onPerpL2Update(msg.data.s, {
              blockTime: msg.data.E,
              updateID: Number(msg.data.u || 0),
              bids: (msg.data.b || []).slice(0, 15),
              asks: (msg.data.a || []).slice(0, 15),
            });
          } else if (msg.channel === 'trade' && Array.isArray(msg.data)) {
            for (const row of msg.data) {
              this.callbacks.onTrade({
                id: `${row.s}-${row.t}`,
                symbol: row.s,
                side: row.S,
                price: Number(row.p),
                quantity: Number(row.q),
                timestamp: Number(row.T || Date.now()),
              });
            }
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        this.callbacks.onPerpStatus(false, this.perpFrames);
        if (!this.closed) {
          setTimeout(() => this.connectPerps(), 4000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.callbacks.onPerpStatus(false, this.perpFrames);
    }
  }

  private connectSpot(): void {
    if (this.closed || typeof WebSocket === 'undefined') return;
    try {
      const ws = new WebSocket(SODEX_SPOT_WS);
      this.spotWs = ws;

      ws.onopen = () => {
        this.callbacks.onSpotStatus(true, this.spotFrames);
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            id: 1,
            params: { channel: 'ticker', symbols: this.watchedSpots },
          }),
        );
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            id: 2,
            params: { channel: 'l2Book', symbol: this.activeSpotSymbol },
          }),
        );
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if (!msg.channel || !msg.data) return;
          this.spotFrames += 1;
          if (this.spotFrames % 3 === 0 || this.spotFrames <= 5) {
            this.callbacks.onSpotStatus(true, this.spotFrames);
          }

          if (msg.channel === 'l2Book' && msg.data.s) {
            this.callbacks.onSpotL2Update(msg.data.s, {
              blockTime: msg.data.E,
              updateID: Number(msg.data.u || 0),
              bids: (msg.data.b || []).slice(0, 15),
              asks: (msg.data.a || []).slice(0, 15),
            });
          } else if (msg.channel === 'ticker' && Array.isArray(msg.data)) {
            for (const row of msg.data) {
              this.callbacks.onSpotTickerUpdate(
                row.s,
                row.c,
                row.b,
                row.a,
                Number(row.P || 0),
              );
            }
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        this.callbacks.onSpotStatus(false, this.spotFrames);
        if (!this.closed) {
          setTimeout(() => this.connectSpot(), 4500);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.callbacks.onSpotStatus(false, this.spotFrames);
    }
  }
}
