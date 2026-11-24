import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildBasisOpportunities, synthesizeDeskBrief } from '../engine/quant';
import {
  fetchLiveOrderBook,
  fetchLivePerpTrades,
  fetchLiveSodexMarkets,
  fetchLiveSoSoValueDirect,
  fetchLiveValueChainRpc,
  loadBaselineSnapshot,
  SODEX_PERPS_WS,
  SODEX_REST_BASE,
  SODEX_SPOT_WS,
  SodexWebSocketManager,
  SOSOVALUE_API_BASE,
  VALUECHAIN_RPC_URL,
} from '../services/feeds';
import type {
  FeedTelemetry,
  LiveTrade,
  MarketSnapshotPayload,
  OrderBookSnapshot,
  PaperExecutionOrder,
  PerpSymbolSpec,
  PerpTicker,
  SoSoValueDataset,
  SpotSymbolSpec,
  SpotTicker,
  ValueChainTelemetry,
} from '../types/market';

const BLOTTER_STORAGE_KEY = 'basisdesk_paper_blotter_v1';

const SEED_BLOTTER: PaperExecutionOrder[] = [
  {
    id: 'PAPER-2026-001',
    createdAtIso: '2026-11-24T01:15:00.000Z',
    strategyType: 'DELTA_NEUTRAL_BASIS',
    symbol: 'BTC-USD',
    spotSymbol: 'vBTC_vUSDC',
    direction: 'LONG_SPOT_SHORT_PERP',
    notionalUsd: 25000,
    leverage: 3,
    entrySpotPrice: 60410,
    entryPerpPrice: 60465,
    entryHourlyFundingRate: 0.0000088,
    expectedNetApyPct: 6.42,
    estimatedFeesUsd: 23.5,
    liquidationBufferPct: 32.1,
    guardrailStatus: 'PASS',
    status: 'OPEN',
    notes: 'Core BTC delta-neutral carry harvest (3x short perp hedged against vBTC spot)',
  },
  {
    id: 'PAPER-2026-002',
    createdAtIso: '2026-11-24T03:40:00.000Z',
    strategyType: 'SSI_REBALANCE',
    symbol: 'MAG7.ssi',
    spotSymbol: 'vMAG7ssi_vUSDC',
    direction: 'REBALANCE_BASKET',
    notionalUsd: 15000,
    leverage: 1,
    entrySpotPrice: 0.3915,
    entryPerpPrice: 0.3915,
    entryHourlyFundingRate: 0,
    expectedNetApyPct: 0,
    estimatedFeesUsd: 15.75,
    liquidationBufferPct: 100,
    guardrailStatus: 'PASS',
    status: 'OPEN',
    notes: 'Monthly SSI Protocol drift rebalance queued via AssetRebalancer preview',
  },
];

function loadSavedBlotter(): PaperExecutionOrder[] {
  try {
    const raw = localStorage.getItem(BLOTTER_STORAGE_KEY);
    if (!raw) return SEED_BLOTTER;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : SEED_BLOTTER;
  } catch {
    return SEED_BLOTTER;
  }
}

export function useDeskData(selectedPerpSymbol: string) {
  const [isLoading, setIsLoading] = useState(true);
  const [snapshotMeta, setSnapshotMeta] = useState<{
    generatedAt: string;
    totalPerpMarkets: number;
    totalSpotMarkets: number;
  }>({
    generatedAt: new Date().toISOString(),
    totalPerpMarkets: 107,
    totalSpotMarkets: 48,
  });

  const [perpSymbols, setPerpSymbols] = useState<PerpSymbolSpec[]>([]);
  const [perpTickers, setPerpTickers] = useState<PerpTicker[]>([]);
  const [spotSymbols, setSpotSymbols] = useState<SpotSymbolSpec[]>([]);
  const [spotTickers, setSpotTickers] = useState<SpotTicker[]>([]);
  const [realizedVol, setRealizedVol] = useState<Record<string, number>>({});
  const [perpBooks, setPerpBooks] = useState<Record<string, OrderBookSnapshot>>({});
  const [spotBooks, setSpotBooks] = useState<Record<string, OrderBookSnapshot>>({});
  const [recentTrades, setRecentTrades] = useState<LiveTrade[]>([]);
  const [valueChain, setValueChain] = useState<ValueChainTelemetry>({
    chainId: 286623,
    blockNumber: 17316086,
    gasPriceWei: 2000000,
    rpcUrl: VALUECHAIN_RPC_URL,
    explorerUrl: 'https://main-scan.valuechain.xyz',
    capturedAt: new Date().toISOString(),
  });
  const [sosovalue, setSosovalue] = useState<SoSoValueDataset | null>(null);
  const [sosoError, setSosoError] = useState<string | null>(null);
  const [sosoConnecting, setSosoConnecting] = useState(false);

  const [telemetry, setTelemetry] = useState<Record<FeedTelemetry['id'], FeedTelemetry>>({
    sodex_perps: {
      id: 'sodex_perps',
      label: 'SoDEX Perps',
      status: 'SNAPSHOT',
      endpoint: SODEX_PERPS_WS,
      lastUpdatedIso: new Date().toISOString(),
      latencyMs: null,
      framesReceived: 0,
      detail: 'Initializing mainnet gateway...',
    },
    sodex_spot: {
      id: 'sodex_spot',
      label: 'SoDEX Spot & SSI',
      status: 'SNAPSHOT',
      endpoint: SODEX_SPOT_WS,
      lastUpdatedIso: new Date().toISOString(),
      latencyMs: null,
      framesReceived: 0,
      detail: 'Initializing spot & SSI orderbooks...',
    },
    valuechain_rpc: {
      id: 'valuechain_rpc',
      label: 'ValueChain L1 RPC',
      status: 'SNAPSHOT',
      endpoint: VALUECHAIN_RPC_URL,
      lastUpdatedIso: new Date().toISOString(),
      latencyMs: null,
      detail: 'Chain ID 286623',
    },
    sosovalue_api: {
      id: 'sosovalue_api',
      label: 'SoSoValue API v1',
      status: 'SNAPSHOT',
      endpoint: SOSOVALUE_API_BASE,
      lastUpdatedIso: new Date().toISOString(),
      latencyMs: null,
      detail: 'Hourly snapshot baseline (enter x-soso-api-key for live direct)',
    },
  });

  const [paperOrders, setPaperOrders] = useState<PaperExecutionOrder[]>(() => loadSavedBlotter());
  const wsManagerRef = useRef<SodexWebSocketManager | null>(null);
  const activeSpotSymbol = useMemo(() => {
    const base = selectedPerpSymbol.replace('-USD', '');
    return `v${base}_vUSDC`;
  }, [selectedPerpSymbol]);

  const updateTelemetry = useCallback(
    (id: FeedTelemetry['id'], patch: Partial<FeedTelemetry>) => {
      setTelemetry((prev) => ({
        ...prev,
        [id]: {
          ...prev[id],
          ...patch,
          lastUpdatedIso: new Date().toISOString(),
        },
      }));
    },
    [],
  );

  // Persist blotter
  useEffect(() => {
    try {
      localStorage.setItem(BLOTTER_STORAGE_KEY, JSON.stringify(paperOrders));
    } catch {
      // ignore storage quota errors
    }
  }, [paperOrders]);

  // Step 1: Hydrate from verified baseline snapshot + immediately upgrade to live REST/RPC/WS
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      let baseline: MarketSnapshotPayload | null = null;
      try {
        baseline = await loadBaselineSnapshot();
        if (!cancelled) {
          setSnapshotMeta({
            generatedAt: baseline.generatedAt,
            totalPerpMarkets: baseline.sodexSummary.totalPerpMarkets,
            totalSpotMarkets: baseline.sodexSummary.totalSpotMarkets,
          });
          setPerpSymbols(baseline.perps.symbols);
          setPerpTickers(baseline.perps.tickers);
          setRealizedVol(baseline.perps.realizedVol);
          setSpotSymbols(baseline.spot.symbols);
          setSpotTickers(baseline.spot.tickers);
          setPerpBooks(baseline.orderbooks.perps);
          setSpotBooks(baseline.orderbooks.spot);
          setValueChain(baseline.valueChain);
          setSosovalue(baseline.sosovalue);
          updateTelemetry('sosovalue_api', {
            status: baseline.sosovalue.mode === 'LIVE_CI_SNAPSHOT' ? 'SNAPSHOT' : 'SNAPSHOT',
            detail:
              baseline.sosovalue.mode === 'LIVE_CI_SNAPSHOT'
                ? 'Hourly GitHub Actions live snapshot'
                : 'Verified schema snapshot — add x-soso-api-key for live direct',
          });
          setIsLoading(false);
        }
      } catch (err) {
        console.warn('[desk] Baseline snapshot fetch failed:', err);
        if (!cancelled) setIsLoading(false);
      }

      // Live SoDEX REST upgrade
      try {
        const live = await fetchLiveSodexMarkets();
        if (!cancelled) {
          setPerpSymbols(live.perpSymbols);
          setPerpTickers(live.perpTickers);
          setSpotSymbols(live.spotSymbols);
          setSpotTickers(live.spotTickers);
          setSnapshotMeta((m) => ({
            ...m,
            totalPerpMarkets: live.totalPerpMarkets,
            totalSpotMarkets: live.totalSpotMarkets,
          }));
          updateTelemetry('sodex_perps', {
            status: 'LIVE_REST',
            latencyMs: live.latencyMs,
            detail: `${live.totalPerpMarkets} live mainnet perp contracts (${SODEX_REST_BASE})`,
          });
          updateTelemetry('sodex_spot', {
            status: 'LIVE_REST',
            latencyMs: live.latencyMs,
            detail: `${live.totalSpotMarkets} live spot & SSI markets`,
          });
        }
      } catch {
        if (!cancelled) {
          updateTelemetry('sodex_perps', {
            status: 'FALLBACK',
            detail: 'REST unreachable — serving verified hourly snapshot',
          });
        }
      }

      // Live ValueChain RPC upgrade
      try {
        const vc = await fetchLiveValueChainRpc();
        if (!cancelled) {
          setValueChain(vc.telemetry);
          updateTelemetry('valuechain_rpc', {
            status: 'LIVE_RPC',
            latencyMs: vc.latencyMs,
            detail: `Chain ${vc.telemetry.chainId} • Block #${vc.telemetry.blockNumber.toLocaleString()} (2s finality)`,
          });
        }
      } catch {
        if (!cancelled) {
          updateTelemetry('valuechain_rpc', {
            status: 'FALLBACK',
            detail: 'RPC unreachable — showing latest captured block height',
          });
        }
      }
    }

    bootstrap();

    // Poll ValueChain Mainnet RPC every 6 seconds to stream live block progression
    const vcInterval = setInterval(async () => {
      try {
        const vc = await fetchLiveValueChainRpc();
        if (!cancelled) {
          setValueChain(vc.telemetry);
          updateTelemetry('valuechain_rpc', {
            status: 'LIVE_RPC',
            latencyMs: vc.latencyMs,
            detail: `Chain ${vc.telemetry.chainId} • Block #${vc.telemetry.blockNumber.toLocaleString()} (2s finality)`,
          });
        }
      } catch {
        // retain prior state silently
      }
    }, 6000);

    // Dual live SoDEX WebSockets
    const manager = new SodexWebSocketManager(selectedPerpSymbol, activeSpotSymbol, {
      onPerpStatus: (connected, frames) => {
        if (cancelled) return;
        updateTelemetry('sodex_perps', {
          status: connected ? 'LIVE_WS' : 'LIVE_REST',
          framesReceived: frames,
          detail: connected
            ? `Streaming l2Book (500ms) + markPrice + tape (${frames.toLocaleString()} frames)`
            : 'WebSocket reconnecting — REST data active',
        });
      },
      onSpotStatus: (connected, frames) => {
        if (cancelled) return;
        updateTelemetry('sodex_spot', {
          status: connected ? 'LIVE_WS' : 'LIVE_REST',
          framesReceived: frames,
          detail: connected
            ? `Streaming spot & SSI orderbooks (${frames.toLocaleString()} frames)`
            : 'WebSocket reconnecting — REST data active',
        });
      },
      onPerpMarkUpdate: (upd) => {
        if (cancelled) return;
        setPerpTickers((prev) =>
          prev.map((row) =>
            row.symbol === upd.symbol
              ? {
                  ...row,
                  markPrice: upd.markPrice,
                  indexPrice: upd.indexPrice,
                  fundingRate: upd.fundingRate,
                  openInterest: upd.openInterest,
                  nextFundingTime: upd.nextFundingTime || row.nextFundingTime,
                }
              : row,
          ),
        );
      },
      onPerpL2Update: (symbol, book) => {
        if (cancelled) return;
        setPerpBooks((prev) => ({ ...prev, [symbol]: book }));
      },
      onSpotL2Update: (symbol, book) => {
        if (cancelled) return;
        setSpotBooks((prev) => ({ ...prev, [symbol]: book }));
      },
      onSpotTickerUpdate: (symbol, lastPx, bidPx, askPx, changePct) => {
        if (cancelled) return;
        setSpotTickers((prev) =>
          prev.map((row) =>
            row.symbol === symbol
              ? {
                  ...row,
                  lastPx: lastPx || row.lastPx,
                  bidPx: bidPx || row.bidPx,
                  askPx: askPx || row.askPx,
                  changePct: Number.isFinite(changePct) ? changePct : row.changePct,
                }
              : row,
          ),
        );
      },
      onTrade: (trade) => {
        if (cancelled) return;
        setRecentTrades((prev) => [trade, ...prev.filter((t) => t.id !== trade.id)].slice(0, 20));
      },
    });

    wsManagerRef.current = manager;
    manager.start();

    return () => {
      cancelled = true;
      clearInterval(vcInterval);
      manager.stop();
    };
  }, [updateTelemetry]);

  // Switch WS & fetch fresh REST book + trades when user selects another pair
  useEffect(() => {
    wsManagerRef.current?.switchActivePair(selectedPerpSymbol, activeSpotSymbol);
    let cancelled = false;
    Promise.all([
      fetchLiveOrderBook('perps', selectedPerpSymbol, 15).catch(() => null),
      fetchLiveOrderBook('spot', activeSpotSymbol, 15).catch(() => null),
      fetchLivePerpTrades(selectedPerpSymbol, 15).catch(() => null),
    ]).then(([pBook, sBook, trades]) => {
      if (cancelled) return;
      if (pBook) setPerpBooks((prev) => ({ ...prev, [selectedPerpSymbol]: pBook }));
      if (sBook) setSpotBooks((prev) => ({ ...prev, [activeSpotSymbol]: sBook }));
      if (trades) setRecentTrades(trades);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedPerpSymbol, activeSpotSymbol]);

  const connectSoSoValueKey = useCallback(
    async (apiKey: string) => {
      if (!sosovalue) return false;
      setSosoConnecting(true);
      setSosoError(null);
      try {
        const res = await fetchLiveSoSoValueDirect(apiKey, sosovalue);
        setSosovalue(res.dataset);
        updateTelemetry('sosovalue_api', {
          status: 'LIVE_DIRECT',
          latencyMs: res.latencyMs,
          detail: 'Connected live directly to openapi.sosovalue.com/openapi/v1 via BYOK',
        });
        setSosoConnecting(false);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unable to authenticate SoSoValue API key';
        setSosoError(msg);
        setSosoConnecting(false);
        return false;
      }
    },
    [sosovalue, updateTelemetry],
  );

  const basisOpportunities = useMemo(
    () => buildBasisOpportunities(perpSymbols, perpTickers, spotSymbols, spotTickers, realizedVol),
    [perpSymbols, perpTickers, spotSymbols, spotTickers, realizedVol],
  );

  const deskBrief = useMemo(
    () =>
      synthesizeDeskBrief(
        basisOpportunities,
        sosovalue?.btcEtfHistory ?? [],
        sosovalue?.ethEtfHistory ?? [],
      ),
    [basisOpportunities, sosovalue],
  );

  const addPaperOrder = useCallback((order: Omit<PaperExecutionOrder, 'id' | 'createdAtIso' | 'status'>) => {
    const newOrder: PaperExecutionOrder = {
      ...order,
      id: `PAPER-${Date.now().toString().slice(-6)}`,
      createdAtIso: new Date().toISOString(),
      status: 'OPEN',
    };
    setPaperOrders((prev) => [newOrder, ...prev]);
  }, []);

  const closePaperOrder = useCallback((orderId: string) => {
    setPaperOrders((prev) =>
      prev.map((o) => (o.id === orderId ? { ...o, status: 'CLOSED' } : o)),
    );
  }, []);

  const resetPaperOrders = useCallback(() => {
    setPaperOrders(SEED_BLOTTER);
  }, []);

  return {
    isLoading,
    snapshotMeta,
    perpSymbols,
    perpTickers,
    spotSymbols,
    spotTickers,
    realizedVol,
    perpBooks,
    spotBooks,
    recentTrades,
    valueChain,
    sosovalue,
    sosoError,
    sosoConnecting,
    connectSoSoValueKey,
    telemetry,
    basisOpportunities,
    deskBrief,
    paperOrders,
    addPaperOrder,
    closePaperOrder,
    resetPaperOrders,
  };
}
