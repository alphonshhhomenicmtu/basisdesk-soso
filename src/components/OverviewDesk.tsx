import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Cpu,
  Layers,
  Newspaper,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import type { DeskSignalThesis } from '../engine/quant';
import type {
  BasisOpportunity,
  FeedTelemetry,
  PaperExecutionOrder,
  SoSoValueDataset,
  SpotTicker,
  ValueChainTelemetry,
} from '../types/market';
import {
  formatBps,
  formatCompactUsd,
  formatPct,
  formatPrice,
  formatSignedCompactUsd,
  formatSignedUsd,
  formatTimeUtc,
  formatUsd,
} from '../utils/format';
import { EtfFlowBarChart } from './Charts';
import { TelemetryBadge } from './TelemetryBadge';

interface OverviewDeskProps {
  opportunities: BasisOpportunity[];
  spotTickers: SpotTicker[];
  valueChain: ValueChainTelemetry;
  sosovalue: SoSoValueDataset | null;
  deskBrief: DeskSignalThesis;
  telemetry: Record<FeedTelemetry['id'], FeedTelemetry>;
  paperOrders: PaperExecutionOrder[];
  onSelectPairAndNavigate: (perpSymbol: string, tab: 'basis' | 'risk') => void;
  onNavigateTab: (tab: 'overview' | 'basis' | 'risk' | 'ssi' | 'diag') => void;
  onOpenTelemetry: () => void;
  onClosePaperOrder: (id: string) => void;
  onResetPaperOrders: () => void;
}

export function OverviewDesk({
  opportunities,
  spotTickers,
  valueChain,
  sosovalue,
  deskBrief,
  telemetry,
  paperOrders,
  onSelectPairAndNavigate,
  onNavigateTab,
  onOpenTelemetry,
  onClosePaperOrder,
  onResetPaperOrders,
}: OverviewDeskProps) {
  const [etfAsset, setEtfAsset] = useState<'BTC' | 'ETH'>('BTC');

  const spotTickerMap = useMemo(
    () => new Map(spotTickers.map((t) => [t.symbol, t])),
    [spotTickers],
  );
  const oppMap = useMemo(
    () => new Map(opportunities.map((o) => [o.perpSymbol, o])),
    [opportunities],
  );

  const ssiStrip = useMemo(() => {
    const items = [
      { symbol: 'vMAG7ssi_vUSDC', label: 'MAG7.ssi', desc: 'Top-7 Flagship' },
      { symbol: 'vDEFIssi_vUSDC', label: 'DEFI.ssi', desc: 'DeFi Leaders' },
      { symbol: 'vMEMEssi_vUSDC', label: 'MEME.ssi', desc: 'Meme Sector' },
      { symbol: 'vUSSI_vUSDC', label: 'USSI', desc: 'Hedged USD' },
      { symbol: 'WSOSO_vUSDC', label: 'SOSO', desc: 'ValueChain Gas' },
    ];
    return items.map((item) => {
      const t = spotTickerMap.get(item.symbol);
      return {
        ...item,
        price: Number(t?.lastPx ?? 0),
        changePct: Number(t?.changePct ?? 0),
        volUsd: Number(t?.quoteVolume ?? 0),
      };
    });
  }, [spotTickerMap]);

  const topOpp = opportunities[0];
  const etfSeries =
    etfAsset === 'BTC' ? (sosovalue?.btcEtfHistory ?? []) : (sosovalue?.ethEtfHistory ?? []);
  const latestEtf = etfSeries[0];

  // Live mark-to-market desk summary for open paper orders
  const paperMetrics = useMemo(() => {
    const baseEquity = 150_000;
    let totalUnrealizedPnl = 0;
    let openNotional = 0;
    const enriched = paperOrders.map((order) => {
      let livePnlUsd = -order.estimatedFeesUsd;
      if (order.strategyType === 'DELTA_NEUTRAL_BASIS') {
        const liveOpp = oppMap.get(order.symbol);
        if (liveOpp && order.entrySpotPrice > 0) {
          const qty = order.notionalUsd / order.entrySpotPrice;
          const spotLegPnl = qty * (liveOpp.spotPrice - order.entrySpotPrice);
          const perpLegPnl = qty * (order.entryPerpPrice - liveOpp.perpMarkPrice);
          // Estimate accrued hourly funding since open (minimum 4 hours for visibility on seeded book)
          const elapsedHrs = Math.max(
            4,
            (Date.now() - new Date(order.createdAtIso).getTime()) / 3_600_000,
          );
          const fundingAccrued = order.notionalUsd * liveOpp.hourlyFundingRate * Math.min(elapsedHrs, 72);
          livePnlUsd = spotLegPnl + perpLegPnl + fundingAccrued - order.estimatedFeesUsd;
        }
      } else {
        const st = spotTickerMap.get(order.spotSymbol);
        if (st && order.entrySpotPrice > 0) {
          const currentPx = Number(st.lastPx) || order.entrySpotPrice;
          livePnlUsd =
            ((currentPx - order.entrySpotPrice) / order.entrySpotPrice) * order.notionalUsd -
            order.estimatedFeesUsd;
        }
      }
      if (order.status === 'OPEN') {
        totalUnrealizedPnl += livePnlUsd;
        openNotional += order.notionalUsd;
      }
      return { ...order, livePnlUsd };
    });

    return {
      deskEquity: baseEquity + totalUnrealizedPnl,
      totalUnrealizedPnl,
      openNotional,
      openCount: paperOrders.filter((o) => o.status === 'OPEN').length,
      enriched,
    };
  }, [paperOrders, oppMap, spotTickerMap]);

  const gasGwei = (valueChain.gasPriceWei / 1e9).toFixed(4);
  const sosoPrice = Number(spotTickerMap.get('WSOSO_vUSDC')?.lastPx ?? 0.28);

  return (
    <div className="space-y-5">
      {/* Row 1: 4 Institutional KPI Cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel-surface rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Top Net Carry Spread
            </span>
            <TelemetryBadge status={telemetry.sodex_perps.status} compact />
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-bold text-emerald-400 tabular-nums">
              {topOpp ? formatPct(topOpp.netCarryApyPct) : '--'}
            </span>
            <span className="rounded bg-slate-800/90 px-2 py-0.5 font-mono text-xs font-semibold text-slate-200">
              {topOpp?.perpSymbol ?? 'BTC-USD'}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
            {topOpp
              ? `1h Funding ${(topOpp.hourlyFundingRate * 10000).toFixed(2)} bps • Basis ${formatBps(topOpp.basisBps)}`
              : 'Connecting to SoDEX Mainnet...'}
          </p>
        </div>

        <div className="panel-surface rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              5D US Spot ETF Impulse
            </span>
            <TelemetryBadge status={telemetry.sosovalue_api.status} compact />
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <span
              className={`font-mono text-2xl font-bold tabular-nums ${
                deskBrief.etfFlow5dUsd >= 0 ? 'text-sky-300' : 'text-rose-400'
              }`}
            >
              {formatSignedCompactUsd(deskBrief.etfFlow5dUsd)}
            </span>
            <span className="font-mono text-xs text-slate-400">BTC + ETH</span>
          </div>
          <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
            {deskBrief.etfPositiveStreakDays}d BTC inflow streak • Mkt Cap{' '}
            {formatCompactUsd(Number(sosovalue?.marketOverview.total_market_cap ?? 0))}
          </p>
        </div>

        <div className="panel-surface rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Paper Desk Equity (MTM)
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-800/70 px-2 py-0.5 font-mono text-[10px] text-slate-300">
              PAPER ONLY
            </span>
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-bold text-slate-100 tabular-nums">
              {formatUsd(paperMetrics.deskEquity, 0)}
            </span>
            <span
              className={`font-mono text-xs font-semibold tabular-nums ${
                paperMetrics.totalUnrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {formatSignedUsd(paperMetrics.totalUnrealizedPnl)}
            </span>
          </div>
          <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
            {paperMetrics.openCount} active hedges • {formatCompactUsd(paperMetrics.openNotional)} deployed
          </p>
        </div>

        <div className="panel-surface rounded-xl p-4">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              ValueChain L1 Mainnet
            </span>
            <TelemetryBadge status={telemetry.valuechain_rpc.status} compact />
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-2">
            <span className="font-mono text-2xl font-bold text-violet-300 tabular-nums">
              #{valueChain.blockNumber.toLocaleString()}
            </span>
            <span className="font-mono text-xs text-slate-400">ID {valueChain.chainId}</span>
          </div>
          <p className="mt-1.5 text-xs text-slate-400 tabular-nums">
            2s Finality • Gas {gasGwei} gwei • SOSO ${formatPrice(sosoPrice)}
          </p>
        </div>
      </div>

      {/* Row 2: AI Quant Desk Signal Synthesizer Banner */}
      <div className="panel-surface relative overflow-hidden rounded-xl border-sky-500/25 p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300 border border-sky-500/30">
                <Sparkles className="h-3 w-3" />
                Autonomous Quant Desk Brief
              </span>
              <span
                className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold ${
                  deskBrief.regime === 'RISK_ON_CARRY'
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : deskBrief.regime === 'SELECTIVE_BASIS'
                      ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                }`}
              >
                {deskBrief.regime.replaceAll('_', ' ')}
              </span>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                Conviction <strong className="text-slate-100">{deskBrief.convictionScore}/100</strong>
              </span>
            </div>

            <h2 className="mt-2 text-sm font-semibold text-slate-100 sm:text-base">
              {deskBrief.headline}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">{deskBrief.rationale}</p>

            <div className="mt-2.5 flex flex-wrap gap-2">
              {deskBrief.riskFlags.map((flag) => (
                <span
                  key={flag}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-800 bg-[#080B10]/80 px-2.5 py-1 text-[11px] text-slate-300"
                >
                  <ShieldCheck className="h-3 w-3 text-sky-400 shrink-0" />
                  {flag}
                </span>
              ))}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2.5 lg:flex-col lg:items-stretch">
            <button
              type="button"
              onClick={() => onSelectPairAndNavigate(deskBrief.recommendedPair, 'basis')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-400"
            >
              Inspect {deskBrief.recommendedPair} Carry
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onSelectPairAndNavigate(deskBrief.recommendedPair, 'risk')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/70 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:border-sky-500/50 hover:text-sky-300"
            >
              <Cpu className="h-3.5 w-3.5" />
              Stress-Test (1,000 Paths)
            </button>
          </div>
        </div>
      </div>

      {/* Row 3: Live SoDEX Carry Matrix (Left) + SoSoValue ETF Flows & SSI Strip (Right) */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Live SoDEX Spot-Perp Carry Matrix */}
        <div className="panel-surface flex flex-col rounded-xl xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3.5">
            <div className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-emerald-400" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Live SoDEX Spot-Perp Funding &amp; Basis Matrix
                </h3>
                <p className="text-[11px] text-slate-400">
                  Matched ValueChain Spot + Perp contracts • Hourly funding (8,760/yr) • Maker 3x net APY
                </p>
              </div>
            </div>
            <TelemetryBadge status={telemetry.sodex_perps.status} compact />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800/80 bg-[#080B10]/60 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-2.5">Pair</th>
                  <th className="px-3 py-2.5 text-right">Spot / Mark</th>
                  <th className="px-3 py-2.5 text-right">Basis</th>
                  <th className="px-3 py-2.5 text-right">1h Funding</th>
                  <th className="px-3 py-2.5 text-right">Net 3x APY</th>
                  <th className="px-3 py-2.5 text-right">24h Vol</th>
                  <th className="px-4 py-2.5 text-right">Desk Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {opportunities.slice(0, 10).map((opp) => (
                  <tr
                    key={opp.perpSymbol}
                    className="transition hover:bg-slate-800/35"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-sans font-semibold text-slate-100">{opp.baseCoin}</div>
                      <div className="text-[10px] text-slate-500">
                        {opp.perpSymbol}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="text-slate-100">${formatPrice(opp.perpMarkPrice)}</div>
                      <div className="text-[10px] text-slate-500">
                        Spot ${formatPrice(opp.spotPrice)}
                      </div>
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right ${
                        opp.basisBps >= 0 ? 'text-sky-300' : 'text-amber-300'
                      }`}
                    >
                      {formatBps(opp.basisBps)}
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right ${
                        opp.hourlyFundingRate >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      <div>{(opp.hourlyFundingRate * 10000).toFixed(3)} bps</div>
                      <div className="text-[10px] text-slate-500">
                        {formatPct(opp.annualizedFundingPct, 1)} ann
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 font-semibold ${
                          opp.netCarryApyPct > 2
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : opp.netCarryApyPct >= 0
                              ? 'bg-slate-800 text-slate-200'
                              : 'bg-rose-500/15 text-rose-300'
                        }`}
                      >
                        {formatPct(opp.netCarryApyPct)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {formatCompactUsd(opp.volume24hUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-sans">
                      <button
                        type="button"
                        onClick={() => onSelectPairAndNavigate(opp.perpSymbol, 'basis')}
                        className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-sky-300 transition hover:border-sky-500/50 hover:bg-sky-500/10"
                      >
                        Analyze
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: SoSoValue ETF Flows + SSI Live Strip + Intelligence Wire */}
        <div className="flex flex-col gap-4 xl:col-span-5">
          {/* SoSoValue US Spot ETF Flows Card */}
          <div className="panel-surface rounded-xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-100">
                    SoSoValue US Spot ETF Flows
                  </h3>
                  <TelemetryBadge status={telemetry.sosovalue_api.status} compact />
                </div>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Endpoint: <code className="text-slate-300">/openapi/v1/etfs/summary-history</code>
                </p>
              </div>
              <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#080B10] p-0.5">
                {(['BTC', 'ETH'] as const).map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setEtfAsset(sym)}
                    className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold transition ${
                      etfAsset === sym
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg border border-slate-800/80 bg-[#080B10]/70 p-2.5 text-xs font-mono tabular-nums">
              <div>
                <div className="font-sans text-[10px] text-slate-500">Latest Net Flow</div>
                <div
                  className={`mt-0.5 font-semibold ${
                    Number(latestEtf?.total_net_inflow ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {formatSignedCompactUsd(Number(latestEtf?.total_net_inflow ?? 0))}
                </div>
              </div>
              <div>
                <div className="font-sans text-[10px] text-slate-500">Total Net Assets</div>
                <div className="mt-0.5 font-semibold text-slate-100">
                  {formatCompactUsd(Number(latestEtf?.total_net_assets ?? 0))}
                </div>
              </div>
              <div>
                <div className="font-sans text-[10px] text-slate-500">Cum. Net Inflow</div>
                <div className="mt-0.5 font-semibold text-sky-300">
                  {formatCompactUsd(Number(latestEtf?.cum_net_inflow ?? 0))}
                </div>
              </div>
            </div>

            <div className="mt-2">
              <EtfFlowBarChart data={etfSeries} />
            </div>

            {telemetry.sosovalue_api.status !== 'LIVE_DIRECT' && (
              <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                <span>Serving verified schema snapshot</span>
                <button
                  type="button"
                  onClick={onOpenTelemetry}
                  className="font-medium text-sky-400 hover:text-sky-300"
                >
                  Connect live API key →
                </button>
              </div>
            )}
          </div>

          {/* Live SSI Protocol Spot Markets on SoDEX */}
          <div className="panel-surface rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-violet-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  Live SSI Protocol Indices on SoDEX
                </h3>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab('ssi')}
                className="text-[11px] font-medium text-sky-400 hover:text-sky-300"
              >
                Open Rebalancer →
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ssiStrip.map((item) => (
                <button
                  key={item.symbol}
                  type="button"
                  onClick={() => onNavigateTab('ssi')}
                  className="rounded-lg border border-slate-800/90 bg-[#080B10]/75 p-2.5 text-left transition hover:border-violet-500/40"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-slate-100">
                      {item.label}
                    </span>
                    <span
                      className={`font-mono text-[10px] tabular-nums ${
                        item.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatPct(item.changePct, 1)}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold text-slate-100 tabular-nums">
                    ${formatPrice(item.price)}
                  </div>
                  <div className="text-[10px] text-slate-500">{item.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Compact SoSoValue Research Wire */}
          <div className="panel-surface rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Newspaper className="h-4 w-4 text-sky-400" />
                <h3 className="text-sm font-semibold text-slate-100">SoSoValue Research Wire</h3>
              </div>
              <span className="font-mono text-[10px] text-slate-500">/openapi/v1/news</span>
            </div>
            <div className="mt-2.5 divide-y divide-slate-800/70">
              {(sosovalue?.news ?? []).slice(0, 3).map((item) => (
                <div key={item.id} className="py-2 first:pt-0 last:pb-0">
                  <p className="text-xs font-medium leading-snug text-slate-200">{item.title}</p>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500">
                    <span className="text-sky-400">{item.category}</span>
                    <span>•</span>
                    <span>{item.source}</span>
                    <span>•</span>
                    <span className="font-mono">{formatTimeUtc(item.publishedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Row 4: Guarded Paper Execution Blotter */}
      <div className="panel-surface rounded-xl">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-sky-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Paper Execution Blotter (Live Mark-to-Market)
              </h3>
              <p className="text-[11px] text-slate-400">
                Zero custody • Local simulation ledger • Re-valued continuously against live SoDEX WebSocket prices
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onResetPaperOrders}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800"
          >
            <RotateCcw className="h-3 w-3" />
            Reset Demo Ledger
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800/80 bg-[#080B10]/60 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="px-4 py-2.5">Ticket</th>
                <th className="px-3 py-2.5">Strategy</th>
                <th className="px-3 py-2.5 text-right">Notional</th>
                <th className="px-3 py-2.5 text-right">Entry Spot / Perp</th>
                <th className="px-3 py-2.5 text-right">MTM PnL (Net)</th>
                <th className="px-3 py-2.5 text-center">Risk Gate</th>
                <th className="px-4 py-2.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
              {paperMetrics.enriched.map((row) => (
                <tr key={row.id} className="hover:bg-slate-800/25">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-semibold text-slate-200">{row.id}</span>
                      {row.executionChannel === 'EIP712_WALLET_SIGNED' && (
                        <span className="rounded border border-emerald-500/35 bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                          EIP-712 WALLET
                        </span>
                      )}
                      {row.executionChannel === 'EIP712_DRY_RUN' && (
                        <span className="rounded border border-sky-500/35 bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold text-sky-300">
                          EIP-712 VERIFIED
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {row.clOrdId ? `${row.clOrdId} • ` : ''}
                      {formatTimeUtc(row.createdAtIso)}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-sans">
                    <div className="font-medium text-slate-100">
                      {row.symbol}{' '}
                      <span className="font-mono text-[10px] text-sky-300">
                        {row.strategyType === 'DELTA_NEUTRAL_BASIS'
                          ? `${row.leverage}x Basis Hedge`
                          : 'SSI Basket Rebalance'}
                      </span>
                    </div>
                    <div className="max-w-xs truncate text-[11px] text-slate-500">{row.notes}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-200">
                    {formatUsd(row.notionalUsd, 0)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-300">
                    ${formatPrice(row.entrySpotPrice)} / ${formatPrice(row.entryPerpPrice)}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-semibold ${
                      row.livePnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {formatSignedUsd(row.livePnlUsd)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        row.guardrailStatus === 'PASS'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                      }`}
                    >
                      {row.guardrailStatus}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-sans">
                    {row.status === 'OPEN' ? (
                      <button
                        type="button"
                        onClick={() => onClosePaperOrder(row.id)}
                        className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-rose-500/50 hover:text-rose-300"
                      >
                        Close Paper
                      </button>
                    ) : (
                      <span className="font-mono text-[11px] text-slate-500">CLOSED</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
