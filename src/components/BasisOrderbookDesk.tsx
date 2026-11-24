import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  BookOpen,
  Calculator,
  Clock,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import {
  analyzeOrderBook,
  computeDeltaNeutralCarry,
  computeOrderBookImpact,
  runMonteCarloLiquidationStress,
} from '../engine/quant';
import { evaluatePreTradeGuardrails } from '../engine/ssiRebalancer';
import type {
  BasisOpportunity,
  FeedTelemetry,
  LiveTrade,
  OrderBookSnapshot,
  PerpSymbolSpec,
  SpotSymbolSpec,
} from '../types/market';
import {
  formatBps,
  formatCompactUsd,
  formatCountdown,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatTimeUtc,
  formatUsd,
} from '../utils/format';
import { OrderBookDepthChart } from './Charts';
import type { StagedPaperTrade } from './Modals';
import { TelemetryBadge } from './TelemetryBadge';

interface BasisOrderbookDeskProps {
  selectedPerpSymbol: string;
  onSelectPerpSymbol: (sym: string) => void;
  opportunities: BasisOpportunity[];
  perpSymbols: PerpSymbolSpec[];
  spotSymbols: SpotSymbolSpec[];
  perpBooks: Record<string, OrderBookSnapshot>;
  spotBooks: Record<string, OrderBookSnapshot>;
  recentTrades: LiveTrade[];
  telemetry: Record<FeedTelemetry['id'], FeedTelemetry>;
  onStagePaperTrade: (trade: StagedPaperTrade) => void;
}

export function BasisOrderbookDesk({
  selectedPerpSymbol,
  onSelectPerpSymbol,
  opportunities,
  perpSymbols,
  spotSymbols,
  perpBooks,
  spotBooks,
  recentTrades,
  telemetry,
  onStagePaperTrade,
}: BasisOrderbookDeskProps) {
  const [notionalUsd, setNotionalUsd] = useState(25_000);
  const [leverage, setLeverage] = useState(3);
  const [holdingDays, setHoldingDays] = useState(30);
  const [executionMode, setExecutionMode] = useState<'MAKER' | 'TAKER'>('MAKER');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const activeOpp = useMemo(
    () => opportunities.find((o) => o.perpSymbol === selectedPerpSymbol) ?? opportunities[0],
    [opportunities, selectedPerpSymbol],
  );

  const perpSpec = useMemo(
    () => perpSymbols.find((s) => s.name === (activeOpp?.perpSymbol ?? selectedPerpSymbol)),
    [perpSymbols, activeOpp, selectedPerpSymbol],
  );

  const spotSymbolName = activeOpp?.spotSymbol ?? `v${selectedPerpSymbol.replace('-USD', '')}_vUSDC`;
  const spotSpec = useMemo(
    () => spotSymbols.find((s) => s.name === spotSymbolName),
    [spotSymbols, spotSymbolName],
  );

  const perpBook = perpBooks[activeOpp?.perpSymbol ?? selectedPerpSymbol];
  const spotBook = spotBooks[spotSymbolName];

  const perpBookMetrics = useMemo(
    () =>
      analyzeOrderBook(
        perpBook,
        activeOpp?.indexPrice ?? 60000,
        perpSpec?.maxLeverage ?? 20,
      ),
    [perpBook, activeOpp, perpSpec],
  );

  const spotBookMetrics = useMemo(
    () => analyzeOrderBook(spotBook, activeOpp?.spotPrice ?? 60000, 1),
    [spotBook, activeOpp],
  );

  const perpImpact = useMemo(
    () =>
      computeOrderBookImpact(
        perpBook?.bids ?? [],
        notionalUsd,
        perpBookMetrics.midPrice || activeOpp?.perpMarkPrice || 1,
        'SELL',
      ),
    [perpBook, notionalUsd, perpBookMetrics.midPrice, activeOpp],
  );

  const spotImpact = useMemo(
    () =>
      computeOrderBookImpact(
        spotBook?.asks ?? [],
        notionalUsd,
        spotBookMetrics.midPrice || activeOpp?.spotPrice || 1,
        'BUY',
      ),
    [spotBook, notionalUsd, spotBookMetrics.midPrice, activeOpp],
  );

  const carry = useMemo(
    () =>
      computeDeltaNeutralCarry({
        notionalPerLegUsd: notionalUsd,
        spotPrice: activeOpp?.spotPrice ?? 60000,
        perpMarkPrice: activeOpp?.perpMarkPrice ?? 60000,
        hourlyFundingRate: activeOpp?.hourlyFundingRate ?? 0,
        leverage,
        holdingDays,
        executionMode,
        spotMakerFee: Number(spotSpec?.makerFee ?? '0.00035'),
        spotTakerFee: Number(spotSpec?.takerFee ?? '0.00065'),
        perpMakerFee: Number(perpSpec?.makerFee ?? '0.00012'),
        perpTakerFee: Number(perpSpec?.takerFee ?? '0.0004'),
        spotSlippageBps: executionMode === 'MAKER' ? 0.5 : spotImpact.slippageBps,
        perpSlippageBps: executionMode === 'MAKER' ? 0.5 : perpImpact.slippageBps,
        marginTiers: perpSpec?.marginTiers ?? [],
      }),
    [
      notionalUsd,
      activeOpp,
      leverage,
      holdingDays,
      executionMode,
      spotSpec,
      perpSpec,
      spotImpact.slippageBps,
      perpImpact.slippageBps,
    ],
  );

  // Quick 250-path seeded VaR99 estimate for live pre-trade guardrail audit
  const quickVar99Pct = useMemo(() => {
    const mc = runMonteCarloLiquidationStress({
      seed: 20261124,
      paths: 250,
      horizonDays: Math.min(14, holdingDays),
      stepsPerDay: 2,
      notionalPerLegUsd: notionalUsd,
      leverage,
      spotPrice: activeOpp?.spotPrice ?? 60000,
      perpPrice: activeOpp?.perpMarkPrice ?? 60000,
      annualVolatility: activeOpp?.realizedVol ?? 0.65,
      hourlyFundingRate: activeOpp?.hourlyFundingRate ?? 0,
      marginTiers: perpSpec?.marginTiers ?? [],
      roundTripFeeBps: executionMode === 'MAKER' ? 9.4 : 21.0,
      scenario: 'BASELINE',
    });
    return mc.var99Pct;
  }, [notionalUsd, leverage, holdingDays, activeOpp, perpSpec, executionMode]);

  const guardrails = useMemo(
    () =>
      evaluatePreTradeGuardrails({
        leverage,
        liquidationBufferPct: carry.liquidationBufferPct,
        totalSlippageBps:
          executionMode === 'MAKER' ? 1.0 : spotImpact.slippageBps + perpImpact.slippageBps,
        capitalRequiredUsd: carry.totalCapitalRequiredUsd,
        deskEquityUsd: 150_000,
        var99Pct: quickVar99Pct,
      }),
    [leverage, carry, executionMode, spotImpact.slippageBps, perpImpact.slippageBps, quickVar99Pct],
  );

  const perpAsksDisplay = useMemo(() => (perpBook?.asks ?? []).slice(0, 8).reverse(), [perpBook]);
  const perpBidsDisplay = useMemo(() => (perpBook?.bids ?? []).slice(0, 8), [perpBook]);
  const maxPerpQty = useMemo(() => {
    const qtys = [...perpAsksDisplay, ...perpBidsDisplay].map(([, q]) => Number(q) || 0);
    return Math.max(1e-6, ...qtys);
  }, [perpAsksDisplay, perpBidsDisplay]);

  const handleStageTrade = () => {
    if (!activeOpp) return;
    onStagePaperTrade({
      strategyType: 'DELTA_NEUTRAL_BASIS',
      symbol: activeOpp.perpSymbol,
      spotSymbol: activeOpp.spotSymbol,
      perpSymbolId: perpSpec?.id ?? 1,
      spotSymbolId: spotSpec?.id ?? 1,
      perpPricePrecision: perpSpec?.pricePrecision ?? 1,
      perpQuantityPrecision: perpSpec?.quantityPrecision ?? 4,
      spotPricePrecision: spotSpec?.pricePrecision ?? 2,
      spotQuantityPrecision: spotSpec?.quantityPrecision ?? 5,
      executionMode,
      direction: 'LONG_SPOT_SHORT_PERP',
      notionalUsd,
      leverage,
      entrySpotPrice: activeOpp.spotPrice,
      entryPerpPrice: activeOpp.perpMarkPrice,
      entryHourlyFundingRate: activeOpp.hourlyFundingRate,
      expectedNetApyPct: carry.netApyOnCapitalPct,
      estimatedFeesUsd: carry.totalFrictionUsd,
      liquidationBufferPct: carry.liquidationBufferPct,
      notes: `${executionMode} ${leverage}x hedged carry (${holdingDays}d horizon, ${formatBps(carry.basisBps)} live basis)`,
      guardrails,
    });
  };

  return (
    <div className="space-y-5">
      {/* Pair Selector Strip */}
      <div className="panel-surface rounded-xl p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {opportunities.slice(0, 9).map((opp) => {
              const active = opp.perpSymbol === (activeOpp?.perpSymbol ?? selectedPerpSymbol);
              return (
                <button
                  key={opp.perpSymbol}
                  type="button"
                  onClick={() => onSelectPerpSymbol(opp.perpSymbol)}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                    active
                      ? 'border-sky-400/60 bg-sky-500/15 text-sky-200'
                      : 'border-slate-800 bg-[#080B10]/70 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <span className="font-semibold">{opp.baseCoin}</span>
                  <span
                    className={`font-mono text-[10px] tabular-nums ${
                      opp.annualizedFundingPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatPct(opp.annualizedFundingPct, 1)}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
            <div className="flex items-center gap-1.5 text-slate-400">
              <Clock className="h-3.5 w-3.5 text-sky-400" />
              <span>Next 1h Funding:</span>
              <span className="font-semibold text-slate-100">
                {activeOpp?.nextFundingTime ? formatCountdown(activeOpp.nextFundingTime, nowMs) : '--'}
              </span>
            </div>
            <TelemetryBadge status={telemetry.sodex_perps.status} compact />
          </div>
        </div>
      </div>

      {/* Main 3-Column Execution & Orderbook Grid */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Column 1: Live SoDEX Perp L2 Orderbook & Tape */}
        <div className="panel-surface flex flex-col rounded-xl xl:col-span-4">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-sky-400" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {activeOpp?.perpSymbol ?? selectedPerpSymbol} Live L2 Book
                </h3>
                <p className="text-[11px] text-slate-400">
                  500ms WebSocket depth • Update #{perpBook?.updateID ?? 0}
                </p>
              </div>
            </div>
            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
              Spread {perpBookMetrics.spreadBps.toFixed(2)} bps
            </span>
          </div>

          <div className="p-3.5 font-mono text-xs tabular-nums">
            <div className="mb-1.5 grid grid-cols-3 text-[10px] uppercase text-slate-500">
              <span>Price (USD)</span>
              <span className="text-right">Size ({activeOpp?.baseCoin})</span>
              <span className="text-right">Notional</span>
            </div>

            {/* Asks */}
            <div className="space-y-0.5">
              {perpAsksDisplay.map(([px, qty], i) => {
                const p = Number(px);
                const q = Number(qty);
                const pct = Math.min(100, (q / maxPerpQty) * 100);
                return (
                  <div
                    key={`ask-${i}`}
                    className="relative grid grid-cols-3 items-center overflow-hidden rounded px-1.5 py-0.5"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 right-0 bg-rose-500/14"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="relative text-rose-400">${formatPrice(p)}</span>
                    <span className="relative text-right text-slate-200">{q.toFixed(4)}</span>
                    <span className="relative text-right text-slate-400">
                      {formatCompactUsd(p * q)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Mid / Mark / Oracle Strip */}
            <div className="my-2.5 flex items-center justify-between rounded-lg border border-slate-800 bg-[#080B10] px-3 py-2">
              <div>
                <div className="text-[10px] text-slate-500">Mark Price</div>
                <div className="text-sm font-bold text-slate-100">
                  ${formatPrice(activeOpp?.perpMarkPrice ?? perpBookMetrics.midPrice)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-slate-500">Oracle Index</div>
                <div className="text-xs font-semibold text-sky-300">
                  ${formatPrice(activeOpp?.indexPrice ?? perpBookMetrics.midPrice)}
                </div>
              </div>
            </div>

            {/* Bids */}
            <div className="space-y-0.5">
              {perpBidsDisplay.map(([px, qty], i) => {
                const p = Number(px);
                const q = Number(qty);
                const pct = Math.min(100, (q / maxPerpQty) * 100);
                return (
                  <div
                    key={`bid-${i}`}
                    className="relative grid grid-cols-3 items-center overflow-hidden rounded px-1.5 py-0.5"
                  >
                    <div
                      className="pointer-events-none absolute inset-y-0 right-0 bg-emerald-500/14"
                      style={{ width: `${pct}%` }}
                    />
                    <span className="relative text-emerald-400">${formatPrice(p)}</span>
                    <span className="relative text-right text-slate-200">{q.toFixed(4)}</span>
                    <span className="relative text-right text-slate-400">
                      {formatCompactUsd(p * q)}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Order Book Imbalance & SoDEX Impact Notional */}
            <div className="mt-3 rounded-lg border border-slate-800/80 bg-[#080B10]/70 p-2.5">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span>Orderbook Imbalance (OBI)</span>
                <span
                  className={
                    perpBookMetrics.imbalance >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }
                >
                  {formatPct(perpBookMetrics.imbalance * 100, 1)}
                </span>
              </div>
              <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-rose-500/40">
                <div
                  className="bg-emerald-400 transition-all"
                  style={{ width: `${Math.round(((perpBookMetrics.imbalance + 1) / 2) * 100)}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
                <span>Impact Notional (200×MaxLev): {formatCompactUsd(perpBookMetrics.impactNotionalUsd)}</span>
                <span className="text-sky-300">Prem: {formatBps(perpBookMetrics.impliedPremiumBps)}</span>
              </div>
            </div>
          </div>

          {/* Live Trade Tape */}
          <div className="border-t border-slate-800/80 px-4 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Live Matching Engine Tape
              </span>
              <span className="font-mono text-[10px] text-slate-500">ws/perps trade</span>
            </div>
            <div className="space-y-1 font-mono text-[11px] tabular-nums">
              {recentTrades.slice(0, 6).map((tr) => (
                <div key={tr.id} className="grid grid-cols-3 items-center">
                  <span className={tr.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                    ${formatPrice(tr.price)}
                  </span>
                  <span className="text-right text-slate-300">{tr.quantity.toFixed(4)}</span>
                  <span className="text-right text-slate-500">{formatTimeUtc(tr.timestamp).slice(0, 8)}</span>
                </div>
              ))}
              {recentTrades.length === 0 && (
                <div className="text-slate-500">Listening for fills...</div>
              )}
            </div>
          </div>
        </div>

        {/* Column 2: Cumulative Depth Curve + Live Spot Leg Microstructure */}
        <div className="flex flex-col gap-5 xl:col-span-4">
          <div className="panel-surface rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Cumulative L2 Liquidity Depth
                </h3>
                <p className="text-[11px] text-slate-400">
                  Live bid/ask resting depth across {activeOpp?.perpSymbol}
                </p>
              </div>
              <span className="font-mono text-[11px] text-emerald-300 tabular-nums">
                {formatCompactUsd(perpBookMetrics.bidDepthUsd + perpBookMetrics.askDepthUsd)} top-15
              </span>
            </div>
            <div className="mt-3">
              <OrderBookDepthChart book={perpBook} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs font-mono tabular-nums">
              <div className="rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5">
                <div className="font-sans text-[10px] text-slate-500">Perp Sell Slippage ({formatCompactUsd(notionalUsd)})</div>
                <div className="mt-0.5 font-semibold text-slate-100">
                  {perpImpact.slippageBps.toFixed(2)} bps
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5">
                <div className="font-sans text-[10px] text-slate-500">Spot Buy Slippage ({formatCompactUsd(notionalUsd)})</div>
                <div className="mt-0.5 font-semibold text-slate-100">
                  {spotImpact.slippageBps.toFixed(2)} bps
                </div>
              </div>
            </div>
          </div>

          {/* Live Paired Spot Leg Card */}
          <div className="panel-surface flex-1 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4 text-emerald-400" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Spot Hedge Leg ({spotSymbolName})
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    ValueChain Spot CLOB • Paired basis arbitrage leg
                  </p>
                </div>
              </div>
              <TelemetryBadge status={telemetry.sodex_spot.status} compact />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2.5 font-mono text-xs tabular-nums">
              <div className="rounded-lg border border-slate-800 bg-[#080B10]/75 p-3">
                <div className="font-sans text-[10px] text-slate-500">Live Spot Mid</div>
                <div className="mt-1 text-base font-bold text-slate-100">
                  ${formatPrice(spotBookMetrics.midPrice || activeOpp?.spotPrice || 0)}
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500">
                  Spread {spotBookMetrics.spreadBps.toFixed(2)} bps
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#080B10]/75 p-3">
                <div className="font-sans text-[10px] text-slate-500">Live Spot-Perp Basis</div>
                <div
                  className={`mt-1 text-base font-bold ${
                    carry.basisBps >= 0 ? 'text-sky-300' : 'text-amber-300'
                  }`}
                >
                  {formatBps(carry.basisBps)}
                </div>
                <div className="mt-0.5 text-[10px] text-slate-500">
                  Perp − Spot spread
                </div>
              </div>
            </div>

            {/* Spot Top 5 Levels */}
            <div className="mt-3 space-y-1 rounded-lg border border-slate-800/80 bg-[#080B10]/60 p-3 font-mono text-[11px] tabular-nums">
              <div className="mb-1 flex justify-between text-[10px] uppercase text-slate-500">
                <span>Top Spot Bids</span>
                <span>Top Spot Asks</span>
              </div>
              {[0, 1, 2, 3, 4].map((idx) => {
                const b = spotBook?.bids?.[idx];
                const a = spotBook?.asks?.[idx];
                return (
                  <div key={idx} className="grid grid-cols-2 gap-3">
                    <div className="flex justify-between">
                      <span className="text-emerald-400">
                        {b ? `$${formatPrice(Number(b[0]))}` : '--'}
                      </span>
                      <span className="text-slate-400">{b ? Number(b[1]).toFixed(3) : ''}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-rose-400">
                        {a ? `$${formatPrice(Number(a[0]))}` : '--'}
                      </span>
                      <span className="text-slate-400">{a ? Number(a[1]).toFixed(3) : ''}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Column 3: Delta-Neutral Carry & Guarded Paper Execution Ticket */}
        <div className="panel-surface flex flex-col justify-between rounded-xl p-4 xl:col-span-4">
          <div>
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
              <div className="flex items-center gap-2">
                <Calculator className="h-4 w-4 text-sky-400" />
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Delta-Neutral Carry Engine
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Long {spotSymbolName} + Short {activeOpp?.perpSymbol}
                  </p>
                </div>
              </div>
              <div className="flex rounded-lg border border-slate-800 bg-[#080B10] p-0.5 text-[10px] font-semibold">
                {(['MAKER', 'TAKER'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setExecutionMode(m)}
                    className={`rounded px-2 py-1 transition ${
                      executionMode === m
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Interactive Controls */}
            <div className="mt-3 space-y-2.5">
              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Notional Size (Per Leg)</span>
                  <span className="font-mono font-semibold text-slate-100 tabular-nums">
                    {formatUsd(notionalUsd, 0)}
                  </span>
                </div>
                <input
                  type="range"
                  min={5000}
                  max={100000}
                  step={5000}
                  value={notionalUsd}
                  onChange={(e) => setNotionalUsd(Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Short Perp Leverage</span>
                  <span className="font-mono font-semibold text-sky-300 tabular-nums">
                    {leverage.toFixed(1)}x (Max {perpSpec?.maxLeverage ?? 20}x)
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={15}
                  step={0.5}
                  value={leverage}
                  onChange={(e) => setLeverage(Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Target Holding Horizon</span>
                  <span className="font-mono font-semibold text-slate-100 tabular-nums">
                    {holdingDays} days
                  </span>
                </div>
                <input
                  type="range"
                  min={7}
                  max={90}
                  step={1}
                  value={holdingDays}
                  onChange={(e) => setHoldingDays(Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
              </div>
            </div>

            {/* Yield & Risk Breakdown */}
            <div className="mt-4 rounded-xl border border-slate-800 bg-[#080B10]/85 p-3.5 font-mono text-xs tabular-nums">
              <div className="flex items-baseline justify-between border-b border-slate-800/80 pb-2.5">
                <span className="font-sans text-xs text-slate-400">Net Carry APY (on Capital)</span>
                <span
                  className={`text-xl font-bold ${
                    carry.netApyOnCapitalPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {formatPct(carry.netApyOnCapitalPct)}
                </span>
              </div>

              <div className="mt-2.5 space-y-1.5 text-[11px]">
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">Total Capital Required</span>
                  <span className="text-slate-100">{formatUsd(carry.totalCapitalRequiredUsd, 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">Projected Funding ({holdingDays}d)</span>
                  <span className="text-emerald-400">{formatSignedUsd(carry.expectedFundingIncomeUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">50% Basis Convergence</span>
                  <span className="text-sky-300">{formatSignedUsd(carry.basisConvergenceUsd)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">
                    SoDEX Fees ({executionMode.toLowerCase()}) + Slippage
                  </span>
                  <span className="text-rose-400">-{formatUsd(carry.totalFrictionUsd)}</span>
                </div>
                <div className="flex justify-between border-t border-slate-800/70 pt-1.5 font-semibold">
                  <span className="font-sans text-slate-200">Net Projected PnL</span>
                  <span className={carry.netProjectedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {formatSignedUsd(carry.netProjectedPnlUsd)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">Fee Breakeven Horizon</span>
                  <span className="text-slate-200">
                    {Number.isFinite(carry.breakevenDays)
                      ? `${carry.breakevenDays.toFixed(1)} days`
                      : 'Neg. funding'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="font-sans text-slate-400">Short Perp Liq. Price (Tier MMR {(carry.maintenanceMarginRate * 100).toFixed(2)}%)</span>
                  <span className="text-amber-300">
                    ${formatPrice(carry.perpLiquidationPrice)} (+{carry.liquidationBufferPct.toFixed(1)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* Compact Live Guardrail Status */}
            <div className="mt-3 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 text-slate-300">
                <ShieldCheck
                  className={`h-4 w-4 ${
                    guardrails.overallStatus === 'PASS'
                      ? 'text-emerald-400'
                      : guardrails.overallStatus === 'WARN'
                        ? 'text-amber-400'
                        : 'text-rose-400'
                  }`}
                />
                <span>Pre-Trade Risk Gate</span>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  guardrails.overallStatus === 'PASS'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : guardrails.overallStatus === 'WARN'
                      ? 'bg-amber-500/15 text-amber-300'
                      : 'bg-rose-500/15 text-rose-300'
                }`}
              >
                {guardrails.overallStatus} • 99% VaR {quickVar99Pct.toFixed(1)}%
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={handleStageTrade}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-sky-400"
          >
            <Zap className="h-4 w-4" />
            Stage &amp; Sign SoDEX EIP-712 / Paper Order
          </button>
        </div>
      </div>
    </div>
  );
}
