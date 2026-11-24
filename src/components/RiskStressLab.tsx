import { useMemo, useState } from 'react';
import {
  AlertOctagon,
  BarChart3,
  Cpu,
  Flame,
  History,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { runHistoricalBasisBacktest } from '../engine/backtest';
import {
  runMonteCarloLiquidationStress,
  type StressScenarioId,
} from '../engine/quant';
import type {
  BasisOpportunity,
  HistoricalKlineBundle,
  PerpSymbolSpec,
  SpotSymbolSpec,
} from '../types/market';
import {
  formatBps,
  formatCompactUsd,
  formatPct,
  formatPrice,
  formatSignedUsd,
  formatUsd,
} from '../utils/format';
import {
  HistoricalBacktestChart,
  MonteCarloFanChart,
  ReturnHistogramChart,
} from './Charts';
import { TelemetryBadge } from './TelemetryBadge';

interface RiskStressLabProps {
  selectedPerpSymbol: string;
  onSelectPerpSymbol: (sym: string) => void;
  opportunities: BasisOpportunity[];
  perpSymbols: PerpSymbolSpec[];
  spotSymbols: SpotSymbolSpec[];
  activeKlineBundle: HistoricalKlineBundle | null;
  klinesLoading: boolean;
  onRefreshKlines: () => void;
}

const SCENARIOS: Array<{
  id: StressScenarioId;
  label: string;
  desc: string;
  badge: string;
}> = [
  {
    id: 'BASELINE',
    label: 'Baseline Regime',
    desc: 'Live SoDEX realized vol + mean-reverting hourly funding',
    badge: 'Normal',
  },
  {
    id: 'FLASH_CRASH_25',
    label: 'Flash Crash (-22% Gap)',
    desc: '1.55x vol spike + heavy jump diffusion + basis dislocation',
    badge: 'Tail Shock',
  },
  {
    id: 'FUNDING_INVERSION',
    label: 'Funding Inversion',
    desc: 'Hourly funding flips to -30.7% annualized carry drain',
    badge: 'Carry Flip',
  },
  {
    id: 'BASIS_BLOWOUT',
    label: 'Basis Blowout (+180 bps)',
    desc: 'Rapid short squeeze + perp premium surge stressing short margin',
    badge: 'Liq Stress',
  },
];

export function RiskStressLab({
  selectedPerpSymbol,
  onSelectPerpSymbol,
  opportunities,
  perpSymbols,
  spotSymbols,
  activeKlineBundle,
  klinesLoading,
  onRefreshKlines,
}: RiskStressLabProps) {
  const [labMode, setLabMode] = useState<'historical' | 'montecarlo'>('historical');
  const [scenario, setScenario] = useState<StressScenarioId>('BASIS_BLOWOUT');
  const [notionalUsd, setNotionalUsd] = useState(50_000);
  const [leverage, setLeverage] = useState(5);
  const [horizonDays, setHorizonDays] = useState(14);
  const [executionMode, setExecutionMode] = useState<'MAKER' | 'TAKER'>('MAKER');
  const [volOverridePct, setVolOverridePct] = useState<number | null>(null);
  const [seed, setSeed] = useState(20261124);

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

  const effectiveVol =
    volOverridePct !== null ? volOverridePct / 100 : (activeOpp?.realizedVol ?? 0.68);

  const backtest = useMemo(
    () =>
      runHistoricalBasisBacktest({
        perpSymbol: activeOpp?.perpSymbol ?? selectedPerpSymbol,
        spotSymbol: spotSymbolName,
        perpBars: activeKlineBundle?.perpBars ?? [],
        spotBars: activeKlineBundle?.spotBars ?? [],
        source: activeKlineBundle?.source ?? 'SNAPSHOT',
        notionalPerLegUsd: notionalUsd,
        leverage,
        executionMode,
        spotMakerFee: Number(spotSpec?.makerFee ?? '0.00035'),
        spotTakerFee: Number(spotSpec?.takerFee ?? '0.00065'),
        perpMakerFee: Number(perpSpec?.makerFee ?? '0.00012'),
        perpTakerFee: Number(perpSpec?.takerFee ?? '0.0004'),
        marginTiers: perpSpec?.marginTiers ?? [],
        liveHourlyFundingAnchor: activeOpp?.hourlyFundingRate,
      }),
    [
      activeOpp,
      selectedPerpSymbol,
      spotSymbolName,
      activeKlineBundle,
      notionalUsd,
      leverage,
      executionMode,
      spotSpec,
      perpSpec,
    ],
  );

  const mcResult = useMemo(
    () =>
      runMonteCarloLiquidationStress({
        seed,
        paths: 1000,
        horizonDays,
        stepsPerDay: 4,
        notionalPerLegUsd: notionalUsd,
        leverage,
        spotPrice: activeOpp?.spotPrice ?? 60000,
        perpPrice: activeOpp?.perpMarkPrice ?? 60030,
        annualVolatility: effectiveVol,
        hourlyFundingRate: activeOpp?.hourlyFundingRate ?? 0.00001,
        marginTiers: perpSpec?.marginTiers ?? [],
        roundTripFeeBps: executionMode === 'MAKER' ? 9.4 : 21.0,
        scenario,
      }),
    [
      seed,
      horizonDays,
      notionalUsd,
      leverage,
      activeOpp,
      effectiveVol,
      perpSpec,
      executionMode,
      scenario,
    ],
  );

  const terminalFan = mcResult.fanChart[mcResult.fanChart.length - 1];
  const klineBadgeStatus =
    backtest.source === 'LIVE_REST'
      ? 'LIVE_REST'
      : backtest.source === 'SNAPSHOT'
        ? 'SNAPSHOT'
        : 'FALLBACK';
  const klineBadgeLabel =
    backtest.source === 'LIVE_REST'
      ? `LIVE KLINES (${backtest.barsCount}×4h)`
      : backtest.source === 'SNAPSHOT'
        ? `SNAPSHOT KLINES (${backtest.barsCount}×4h)`
        : 'FALLBACK KLINES';

  return (
    <div className="space-y-5">
      {/* Unified Header & Dual-Engine Switcher */}
      <div className="panel-surface rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
          <div className="flex items-center gap-2.5">
            {labMode === 'historical' ? (
              <History className="h-5 w-5 text-emerald-400" />
            ) : (
              <Cpu className="h-5 w-5 text-sky-400" />
            )}
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  {labMode === 'historical'
                    ? '30-Day Historical SoDEX Klines & Basis Proxy Replay'
                    : '1,000-Path Deterministic Monte Carlo Liquidation & VaR Lab'}
                </h2>
                {labMode === 'historical' && (
                  <TelemetryBadge status={klineBadgeStatus} label={klineBadgeLabel} compact />
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                {labMode === 'historical'
                  ? `Matched SoDEX Perp & Spot 4h candles (${backtest.startIso.slice(0, 10)} → ${backtest.endIso.slice(0, 10)}, ${backtest.windowDays.toFixed(1)}d / ${backtest.accruedHours}h) • Close-to-close proxy of 8h/8 clamp (not settled 5s impact prints) • In-sample slices • Round-trip fees (9.4 bps maker / 21.0 bps taker)`
                  : 'Model simulation (not settled exchange fills) • Seeded Mulberry32 + Box-Muller coupled Spot-Perp GBM, Poisson jump shocks, OU funding & SoDEX tiered maintenance margins'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Engine Mode Toggle */}
            <div className="inline-flex rounded-lg border border-slate-800 bg-[#080B10] p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setLabMode('historical')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition ${
                  labMode === 'historical'
                    ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/35'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <History className="h-3.5 w-3.5" />
                30d Historical Replay
              </button>
              <button
                type="button"
                onClick={() => setLabMode('montecarlo')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-semibold transition ${
                  labMode === 'montecarlo'
                    ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/35'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Cpu className="h-3.5 w-3.5" />
                1,000-Path Monte Carlo
              </button>
            </div>

            <select
              value={activeOpp?.perpSymbol ?? selectedPerpSymbol}
              onChange={(e) => {
                setVolOverridePct(null);
                onSelectPerpSymbol(e.target.value);
              }}
              className="rounded-lg border border-slate-700 bg-[#080B10] px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-sky-400 focus:outline-none"
            >
              {opportunities.map((o) => (
                <option key={o.perpSymbol} value={o.perpSymbol}>
                  {o.perpSymbol} (Vol {(o.realizedVol * 100).toFixed(0)}%)
                </option>
              ))}
            </select>

            {labMode === 'historical' ? (
              <button
                type="button"
                disabled={klinesLoading}
                onClick={onRefreshKlines}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-60"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${klinesLoading ? 'animate-spin' : ''}`} />
                Refresh Klines
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSeed((s) => ((s * 1664525 + 1013904223) >>> 0) % 9999999)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-300 hover:border-sky-500/50 hover:text-sky-300"
                title="Reseed deterministic simulation"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Seed #{seed}
              </button>
            )}
          </div>
        </div>

        {/* Shared Parameter Sliders */}
        <div className="mt-3.5 grid grid-cols-1 gap-4 rounded-lg border border-slate-800/80 bg-[#080B10]/70 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Notional / Leg</span>
              <span className="font-mono font-semibold text-slate-100 tabular-nums">
                {formatUsd(notionalUsd, 0)}
              </span>
            </div>
            <input
              type="range"
              min={10000}
              max={250000}
              step={10000}
              value={notionalUsd}
              onChange={(e) => setNotionalUsd(Number(e.target.value))}
              className="mt-1.5 w-full"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Short Perp Leverage</span>
              <span
                className={`font-mono font-semibold tabular-nums ${
                  leverage > 10 ? 'text-rose-400' : 'text-sky-300'
                }`}
              >
                {leverage.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              step={0.5}
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="mt-1.5 w-full"
            />
          </div>

          {labMode === 'historical' ? (
            <>
              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Round-Trip Fee Tier</span>
                  <span className="font-mono font-semibold text-emerald-300">
                    {executionMode} ({backtest.roundTripFeeBps.toFixed(1)} bps RT)
                  </span>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {(['MAKER', 'TAKER'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setExecutionMode(m)}
                      className={`rounded-md border py-1 font-mono text-[11px] font-semibold transition ${
                        executionMode === m
                          ? 'border-sky-400/50 bg-sky-500/15 text-sky-200'
                          : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {m} ({m === 'MAKER' ? '9.4 bps RT' : '21.0 bps RT'})
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col justify-center">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Close-Basis Proxy vs Live Funding</span>
                  <span className="font-mono font-semibold text-sky-300 tabular-nums">
                    {formatBps(backtest.avgBasisBps)} avg
                  </span>
                </div>
                <div className="mt-1.5 flex justify-between font-mono text-[11px] text-slate-400 tabular-nums">
                  <span>Proxy: {formatPct(backtest.avgAnnualizedFundingPct, 1)} ann</span>
                  <span className="text-emerald-300">
                    Live now:{' '}
                    {backtest.liveFundingComparison
                      ? `${formatPct(backtest.liveFundingComparison.liveAnnualizedPct, 1)} ann`
                      : '--'}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Stress Horizon</span>
                  <span className="font-mono font-semibold text-slate-100 tabular-nums">
                    {horizonDays} days
                  </span>
                </div>
                <input
                  type="range"
                  min={7}
                  max={60}
                  step={1}
                  value={horizonDays}
                  onChange={(e) => setHorizonDays(Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Annualized Vol (σ)</span>
                  <span className="font-mono font-semibold text-amber-300 tabular-nums">
                    {(effectiveVol * 100).toFixed(0)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={25}
                  max={180}
                  step={5}
                  value={Math.round(effectiveVol * 100)}
                  onChange={(e) => setVolOverridePct(Number(e.target.value))}
                  className="mt-1.5 w-full"
                />
              </div>
            </>
          )}
        </div>

        {/* Monte Carlo Scenario Picker (only in Monte Carlo mode) */}
        {labMode === 'montecarlo' && (
          <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {SCENARIOS.map((sc) => {
              const active = sc.id === scenario;
              return (
                <button
                  key={sc.id}
                  type="button"
                  onClick={() => setScenario(sc.id)}
                  className={`rounded-lg border p-3 text-left transition ${
                    active
                      ? 'border-sky-400/60 bg-sky-500/12'
                      : 'border-slate-800 bg-[#080B10]/70 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-100">{sc.label}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        sc.id === 'BASELINE'
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-rose-500/15 text-rose-300'
                      }`}
                    >
                      {sc.badge}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-slate-400">{sc.desc}</p>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* MODE 1: 30-DAY HISTORICAL SODEX KLINES & FUNDING REPLAY */}
      {labMode === 'historical' ? (
        <>
          {/* 5 Honest Historical Replay KPIs */}
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Model Carry PnL (Proxy)
              </span>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  backtest.netPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {formatSignedUsd(backtest.netPnlUsd, 0)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                {formatPct(backtest.totalReturnPct)} ({backtest.windowDays.toFixed(1)}d)
                {backtest.liveFundingComparison
                  ? ` • Live rate: ${formatSignedUsd(backtest.liveFundingComparison.netPnlAtLiveRateUsd, 0)}`
                  : ''}
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Hedged Spread vs. Spot B&amp;H
              </span>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  backtest.alphaVsSpotPct >= 0 ? 'text-sky-300' : 'text-amber-300'
                }`}
              >
                {formatPct(backtest.alphaVsSpotPct)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                Hedged {formatPct(backtest.totalReturnPct)} vs Spot {formatPct(backtest.spotBenchmarkReturnPct)}
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Period Excess Ret / Vol ({backtest.windowDays.toFixed(1)}d)
              </span>
              <div className="mt-2 font-mono text-xl font-bold text-slate-100 tabular-nums">
                {backtest.periodReturnToVol.toFixed(2)} / {backtest.periodDownsideRatio.toFixed(2)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                Unannualized (vs {backtest.riskFreeAnnualPct.toFixed(1)}% Rf) • r&gt;0: {backtest.winRatePct.toFixed(1)}%
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Intra-Bar DD &amp; Margin Peak
              </span>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  backtest.maxDrawdownPct > 5 ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                -{backtest.maxDrawdownPct.toFixed(2)}%
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                Perp margin DD -{backtest.perpMaxMarginDrawdownPct.toFixed(1)}% • Spot -{backtest.spotMaxDrawdownPct.toFixed(1)}%
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Wick Liquidation Check
                </span>
                <Flame
                  className={`h-3.5 w-3.5 ${
                    backtest.liquidationEvent ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                />
              </div>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  backtest.liquidationEvent ? 'text-rose-400' : 'text-emerald-400'
                }`}
              >
                {backtest.liquidationEvent ? 'WICK BREACHED' : '0 WICK BREACHES'}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                {backtest.liquidationEvent
                  ? `Wick $${formatPrice(backtest.liquidationEvent.triggerHighPrice)} vs Liq $${formatPrice(backtest.liquidationEvent.liquidationThresholdPrice)}`
                  : `Proxy fund ${formatSignedUsd(backtest.cumulativeFundingUsd, 0)} • Fees -${formatUsd(backtest.totalFeesUsd, 0)}`}
              </p>
            </div>
          </div>

          {/* Main Replay Chart (Left) + In-Sample 5-Day Slices (Right) */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <div className="panel-surface rounded-xl p-4 xl:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-emerald-400" />
                    <h3 className="text-sm font-semibold text-slate-100">
                      Model Equity Curve ({backtest.perpSymbol} vs. {backtest.spotSymbol})
                    </h3>
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Initial Capital {formatUsd(backtest.initialCapitalUsd, 0)} • {backtest.barsCount} matched 4h candles ({backtest.accruedHours}h accrued) from <code className="text-slate-300">mainnet-gw.sodex.dev</code>
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> Model Carry (Proxy)
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-slate-400" /> Spot Buy &amp; Hold
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> Basis (bps)
                  </span>
                </div>
              </div>

              <div className="mt-3">
                <HistoricalBacktestChart
                  curve={backtest.equityCurve}
                  initialCapitalUsd={backtest.initialCapitalUsd}
                />
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2.5 rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5 font-mono text-xs tabular-nums">
                <div>
                  <div className="font-sans text-[10px] text-slate-500">Final Model Equity</div>
                  <div className="font-semibold text-emerald-300">
                    {formatUsd(backtest.finalCarryEquityUsd, 0)}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] text-slate-500">Final Spot B&amp;H Equity</div>
                  <div className="font-semibold text-slate-300">
                    {formatUsd(backtest.finalSpotBenchmarkUsd, 0)}
                  </div>
                </div>
                <div>
                  <div className="font-sans text-[10px] text-slate-500">
                    Proxy Funding ({backtest.accruedHours}h)
                  </div>
                  <div
                    className={`font-semibold ${
                      backtest.cumulativeFundingUsd >= 0 ? 'text-sky-300' : 'text-rose-300'
                    }`}
                  >
                    {formatSignedUsd(backtest.cumulativeFundingUsd, 0)}
                    {backtest.liveFundingComparison && (
                      <span className="ml-1.5 text-[10px] font-normal text-slate-400">
                        (Live: {formatSignedUsd(backtest.liveFundingComparison.fundingAtLiveRateUsd, 0)})
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* In-Sample 5-Day Slices of One Continuous Position */}
            <div className="panel-surface flex flex-col justify-between rounded-xl p-4 xl:col-span-5">
              <div>
                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">
                      In-Sample 5-Day Slices of One Position
                    </h3>
                    <p className="text-[11px] text-slate-400">
                      Partition of one continuous hedge • HIT requires slice carry above pro-rata fees
                    </p>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">6 Slices</span>
                </div>

                <div className="mt-2.5 overflow-x-auto">
                  <table className="w-full text-left font-mono text-[11px] tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10px] uppercase text-slate-500">
                        <th className="py-1.5">Slice</th>
                        <th className="py-1.5 text-right">Entry Basis</th>
                        <th className="py-1.5 text-right">Carry</th>
                        <th className="py-1.5 text-right">Spot</th>
                        <th className="py-1.5 text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {backtest.signalTrackRecord.map((row) => (
                        <tr key={row.windowId} title={row.note}>
                          <td className="py-2">
                            <div className="font-semibold text-slate-200">{row.windowId}</div>
                            <div className="text-[9.5px] text-slate-500">
                              {row.startDate}→{row.endDate}
                            </div>
                          </td>
                          <td className="py-2 text-right text-sky-300">
                            {formatBps(row.entryBasisBps, 1)}
                          </td>
                          <td
                            className={`py-2 text-right font-semibold ${
                              row.status === 'FLAT'
                                ? 'text-slate-500'
                                : row.windowCarryReturnPct >= 0
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                            }`}
                          >
                            {formatPct(row.windowCarryReturnPct)}
                          </td>
                          <td
                            className={`py-2 text-right ${
                              row.spotBenchmarkReturnPct >= 0 ? 'text-slate-300' : 'text-slate-400'
                            }`}
                          >
                            {formatPct(row.spotBenchmarkReturnPct, 1)}
                          </td>
                          <td className="py-2 text-right">
                            <span
                              className={`inline-block rounded-full border px-2 py-0.5 text-[9.5px] font-semibold ${
                                row.status === 'HIT'
                                  ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                                  : row.status === 'FLAT'
                                    ? 'border-slate-600/40 bg-slate-800/70 text-slate-400'
                                    : row.status === 'DRIFT'
                                      ? 'border-amber-500/35 bg-amber-500/15 text-amber-300'
                                      : 'border-rose-500/35 bg-rose-500/15 text-rose-300'
                              }`}
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-3 flex items-start gap-2 rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5 text-[11px] text-slate-400">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
                <span>
                  Close-to-close proxy of SoDEX&apos;s 8h/8 clamp:{' '}
                  <code className="text-slate-200">(P + clamp(0.01% − P, ±0.05%)) / 8</code> from 4h OHLC closes, not the 5-second impact-notional premium. Live exchange funding is shown above for comparison. On a <code className="text-slate-200">perpHigh</code> breach, spot flattens to cash and subsequent slices mark <code className="text-slate-200">FLAT</code>.
                </span>
              </div>
            </div>
          </div>
        </>
      ) : (
        /* MODE 2: 1,000-PATH FORWARD MONTE CARLO STRESS LAB */
        <>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-5">
            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                95% Value-at-Risk
              </span>
              <div className="mt-2 font-mono text-xl font-bold text-amber-300 tabular-nums">
                -{formatUsd(mcResult.var95Usd, 0)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                -{mcResult.var95Pct.toFixed(2)}% of capital
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                99% Value-at-Risk
              </span>
              <div className="mt-2 font-mono text-xl font-bold text-rose-400 tabular-nums">
                -{formatUsd(mcResult.var99Usd, 0)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                -{mcResult.var99Pct.toFixed(2)}% of capital
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                99% CVaR (Exp. Shortfall)
              </span>
              <div className="mt-2 font-mono text-xl font-bold text-rose-300 tabular-nums">
                -{formatUsd(mcResult.cvar99Usd, 0)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                Worst 1% mean tail loss
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Perp Liquidation Prob.
                </span>
                <Flame
                  className={`h-3.5 w-3.5 ${
                    mcResult.liquidationProbabilityPct > 5 ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                />
              </div>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  mcResult.liquidationProbabilityPct > 10
                    ? 'text-rose-400'
                    : mcResult.liquidationProbabilityPct > 2
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                }`}
              >
                {mcResult.liquidationProbabilityPct.toFixed(1)}%
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                {mcResult.liquidatedPaths}/1,000 paths
                {mcResult.medianTimeToLiquidationHours !== null
                  ? ` • med ${mcResult.medianTimeToLiquidationHours.toFixed(0)}h`
                  : ' • 0 breaches'}
              </p>
            </div>

            <div className="panel-surface rounded-xl p-4">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Expected PnL / Max DD
              </span>
              <div
                className={`mt-2 font-mono text-xl font-bold tabular-nums ${
                  mcResult.expectedPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {formatSignedUsd(mcResult.expectedPnlUsd, 0)}
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                Worst DD {mcResult.worstDrawdownPct.toFixed(1)}% • SR {mcResult.annualizedSharpeProxy.toFixed(2)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <div className="panel-surface rounded-xl p-4 xl:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Simulated Portfolio Equity Envelopes (1,000 Paths — Model Only, Not Settled Fills)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Model simulation (not settled exchange fills) • Initial Capital {formatUsd(mcResult.totalCapitalUsd, 0)} ({formatCompactUsd(notionalUsd)} Spot +{' '}
                    {formatCompactUsd(notionalUsd / leverage)} Perp Margin)
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[10px] text-slate-400">
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-sky-400" /> P50 Median
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-sky-400/35" /> P25–P75 / P5–P95
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-rose-400" /> P5 Stress Floor
                  </span>
                </div>
              </div>

              <div className="mt-3">
                <MonteCarloFanChart
                  data={mcResult.fanChart}
                  initialCapitalUsd={mcResult.totalCapitalUsd}
                />
              </div>

              {terminalFan && (
                <div className="mt-3 grid grid-cols-3 gap-2.5 rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5 font-mono text-xs tabular-nums">
                  <div>
                    <div className="font-sans text-[10px] text-slate-500">Terminal P5 (Tail)</div>
                    <div className="font-semibold text-rose-300">{formatUsd(terminalFan.p5, 0)}</div>
                  </div>
                  <div>
                    <div className="font-sans text-[10px] text-slate-500">Terminal P50 (Median)</div>
                    <div className="font-semibold text-sky-300">{formatUsd(terminalFan.p50, 0)}</div>
                  </div>
                  <div>
                    <div className="font-sans text-[10px] text-slate-500">Terminal P95 (Upside)</div>
                    <div className="font-semibold text-emerald-300">{formatUsd(terminalFan.p95, 0)}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-5 xl:col-span-5">
              <div className="panel-surface rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-sky-400" />
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">
                        Terminal Return Distribution
                      </h3>
                      <p className="text-[11px] text-slate-400">
                        Crimson bars denote paths breaching the 95% VaR loss tail
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-xs text-slate-300 tabular-nums">
                    Med {formatPct(mcResult.medianReturnPct)}
                  </span>
                </div>
                <div className="mt-2">
                  <ReturnHistogramChart
                    bins={mcResult.histogram}
                    var95Pct={mcResult.var95Pct}
                  />
                </div>
              </div>

              <div className="panel-surface rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                    <h3 className="text-sm font-semibold text-slate-100">
                      Live SoDEX Margin Tiers ({activeOpp?.perpSymbol})
                    </h3>
                  </div>
                  <span className="font-mono text-[10px] text-slate-500">Staged Liquidation</span>
                </div>
                <div className="mt-2.5 overflow-x-auto">
                  <table className="w-full text-left font-mono text-[11px] tabular-nums">
                    <thead>
                      <tr className="border-b border-slate-800 text-[10px] uppercase text-slate-500">
                        <th className="py-1.5">Tier Cap</th>
                        <th className="py-1.5 text-right">Max Lev</th>
                        <th className="py-1.5 text-right">MMR</th>
                        <th className="py-1.5 text-right">Deduction</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {(perpSpec?.marginTiers ?? []).map((tier, idx) => (
                        <tr key={idx}>
                          <td className="py-1.5 text-slate-200">
                            &le; {formatCompactUsd(Number(tier.maxNotionalValue))}
                          </td>
                          <td className="py-1.5 text-right text-sky-300">{tier.maxLeverage}x</td>
                          <td className="py-1.5 text-right text-amber-300">
                            {(Number(tier.maintenanceMarginRate) * 100).toFixed(2)}%
                          </td>
                          <td className="py-1.5 text-right text-slate-400">
                            {formatCompactUsd(Number(tier.maintenanceDeduction))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-slate-800 bg-[#080B10]/70 p-2.5 text-[11px] text-slate-400">
                  <AlertOctagon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>
                    SoDEX triggers liquidation on <strong>Mark Price</strong> via staged CLOB market unwind before backstop liquidation and ADL. Keep perp leverage &le; 6x to survive basis blowouts.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
