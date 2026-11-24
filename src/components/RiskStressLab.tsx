import { useMemo, useState } from 'react';
import {
  AlertOctagon,
  BarChart3,
  Cpu,
  Flame,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  runMonteCarloLiquidationStress,
  type StressScenarioId,
} from '../engine/quant';
import type { BasisOpportunity, PerpSymbolSpec } from '../types/market';
import { formatCompactUsd, formatPct, formatSignedUsd, formatUsd } from '../utils/format';
import { MonteCarloFanChart, ReturnHistogramChart } from './Charts';

interface RiskStressLabProps {
  selectedPerpSymbol: string;
  onSelectPerpSymbol: (sym: string) => void;
  opportunities: BasisOpportunity[];
  perpSymbols: PerpSymbolSpec[];
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
}: RiskStressLabProps) {
  const activeOpp = useMemo(
    () => opportunities.find((o) => o.perpSymbol === selectedPerpSymbol) ?? opportunities[0],
    [opportunities, selectedPerpSymbol],
  );
  const perpSpec = useMemo(
    () => perpSymbols.find((s) => s.name === (activeOpp?.perpSymbol ?? selectedPerpSymbol)),
    [perpSymbols, activeOpp, selectedPerpSymbol],
  );

  const [scenario, setScenario] = useState<StressScenarioId>('BASIS_BLOWOUT');
  const [notionalUsd, setNotionalUsd] = useState(50_000);
  const [leverage, setLeverage] = useState(6);
  const [horizonDays, setHorizonDays] = useState(14);
  const [volOverridePct, setVolOverridePct] = useState<number | null>(null);
  const [seed, setSeed] = useState(20261124);

  const effectiveVol =
    volOverridePct !== null ? volOverridePct / 100 : (activeOpp?.realizedVol ?? 0.68);

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
        roundTripFeeBps: 10.0,
        scenario,
      }),
    [seed, horizonDays, notionalUsd, leverage, activeOpp, effectiveVol, perpSpec, scenario],
  );

  const terminalFan = mcResult.fanChart[mcResult.fanChart.length - 1];

  return (
    <div className="space-y-5">
      {/* Control Strip & Stress Scenarios */}
      <div className="panel-surface rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
          <div className="flex items-center gap-2.5">
            <Cpu className="h-5 w-5 text-sky-400" />
            <div>
              <h2 className="text-sm font-semibold text-slate-100">
                1,000-Path Deterministic Monte Carlo Liquidation &amp; VaR Stress Lab
              </h2>
              <p className="text-[11px] text-slate-400">
                Seeded Mulberry32 + Box-Muller coupled Spot-Perp GBM, Poisson jump shocks, OU funding &amp; SoDEX tiered maintenance margins
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
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
            <button
              type="button"
              onClick={() => setSeed((s) => ((s * 1664525 + 1013904223) >>> 0) % 9999999)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-300 hover:border-sky-500/50 hover:text-sky-300"
              title="Reseed deterministic simulation"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Seed #{seed}
            </button>
          </div>
        </div>

        {/* 4 Scenario Buttons */}
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

        {/* Parameter Sliders */}
        <div className="mt-4 grid grid-cols-1 gap-4 rounded-lg border border-slate-800/80 bg-[#080B10]/70 p-3.5 sm:grid-cols-2 lg:grid-cols-4">
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
              <span className="text-slate-400">Perp Leverage</span>
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
        </div>
      </div>

      {/* 5 Institutional Risk KPIs */}
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

      {/* Charts Row: Fan Chart (Left) + Histogram & Margin Tiers (Right) */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="panel-surface rounded-xl p-4 xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Simulated Portfolio Equity Envelopes (1,000 Paths)
              </h3>
              <p className="text-[11px] text-slate-400">
                Initial Capital {formatUsd(mcResult.totalCapitalUsd, 0)} ({formatCompactUsd(notionalUsd)} Spot +{' '}
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
          {/* Terminal Return Distribution */}
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

          {/* Exact Live SoDEX Margin Tier Schedule */}
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
    </div>
  );
}
