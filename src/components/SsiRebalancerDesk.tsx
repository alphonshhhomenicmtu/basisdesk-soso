import { useMemo, useState } from 'react';
import {
  Code2,
  Coins,
  Layers,
  Scale,
  Sliders,
  Zap,
} from 'lucide-react';
import {
  computeSsiRebalancePlan,
  evaluatePreTradeGuardrails,
  type SsiIndexKey,
} from '../engine/ssiRebalancer';
import type {
  FeedTelemetry,
  SoSoValueDataset,
  SpotSymbolSpec,
  SpotTicker,
  SsiConstituentWeight,
  ValueChainTelemetry,
} from '../types/market';
import {
  formatBps,
  formatPct,
  formatPrice,
  formatUsd,
} from '../utils/format';
import type { StagedPaperTrade, StagedSsiBatchLeg } from './Modals';
import { TelemetryBadge } from './TelemetryBadge';

interface SsiRebalancerDeskProps {
  spotSymbols: SpotSymbolSpec[];
  spotTickers: SpotTicker[];
  valueChain: ValueChainTelemetry;
  sosovalue: SoSoValueDataset | null;
  telemetry: Record<FeedTelemetry['id'], FeedTelemetry>;
  onStagePaperTrade: (trade: StagedPaperTrade) => void;
}

const USSI_TARGETS: SsiConstituentWeight[] = [
  { symbol: 'BTC', weight: 0.55 },
  { symbol: 'ETH', weight: 0.30 },
  { symbol: 'SOL', weight: 0.15 },
];

export function SsiRebalancerDesk({
  spotSymbols,
  spotTickers,
  valueChain,
  sosovalue,
  telemetry,
  onStagePaperTrade,
}: SsiRebalancerDeskProps) {
  const [selectedIndex, setSelectedIndex] = useState<SsiIndexKey>('MAG7.ssi');
  const [aumUsd, setAumUsd] = useState(100_000);
  const [bufferBandPct, setBufferBandPct] = useState(0.75);
  const [driftShockPct, setDriftShockPct] = useState(25);

  const indexTargets: Record<SsiIndexKey, SsiConstituentWeight[]> = useMemo(
    () => ({
      'MAG7.ssi': sosovalue?.ssiConstituents.ssimag7 ?? [
        { symbol: 'BTC', weight: 0.31 },
        { symbol: 'ETH', weight: 0.22 },
        { symbol: 'XRP', weight: 0.14 },
        { symbol: 'SOL', weight: 0.12 },
        { symbol: 'BNB', weight: 0.10 },
        { symbol: 'DOGE', weight: 0.06 },
        { symbol: 'ADA', weight: 0.05 },
      ],
      'DEFI.ssi': sosovalue?.ssiConstituents.ssidefi ?? [
        { symbol: 'LINK', weight: 0.34 },
        { symbol: 'AAVE', weight: 0.26 },
        { symbol: 'UNI', weight: 0.22 },
        { symbol: 'HYPE', weight: 0.18 },
      ],
      USSI: USSI_TARGETS,
    }),
    [sosovalue],
  );

  const plansByIndex = useMemo(() => {
    const keys: SsiIndexKey[] = ['MAG7.ssi', 'DEFI.ssi', 'USSI'];
    return Object.fromEntries(
      keys.map((key) => [
        key,
        computeSsiRebalancePlan({
          indexKey: key,
          targetWeights: indexTargets[key],
          spotTickers,
          aumUsd,
          bufferBandPct,
          simulatedMarketDriftShockPct: driftShockPct,
          valueChain,
        }),
      ]),
    ) as Record<SsiIndexKey, ReturnType<typeof computeSsiRebalancePlan>>;
  }, [indexTargets, spotTickers, aumUsd, bufferBandPct, driftShockPct, valueChain]);

  const activePlan = plansByIndex[selectedIndex];

  const handleStageRebalance = () => {
    const guardrails = evaluatePreTradeGuardrails({
      leverage: 1,
      liquidationBufferPct: 100,
      totalSlippageBps: activePlan.totalTurnoverUsd > 0 ? 10.5 : 0,
      capitalRequiredUsd: activePlan.totalTurnoverUsd,
      deskEquityUsd: Math.max(150_000, aumUsd),
      var99Pct: 3.5,
    });

    const specBySpot = new Map(spotSymbols.map((s) => [s.name, s]));
    const activeSpotSpec = specBySpot.get(activePlan.spotMarketSymbol);
    const ssiBatchLegs: StagedSsiBatchLeg[] = activePlan.legs
      .filter((leg) => leg.action === 'BUY' || leg.action === 'SELL')
      .map((leg, idx) => {
        const sp = specBySpot.get(leg.spotPair);
        return {
          symbol: leg.symbol,
          spotPair: leg.spotPair,
          symbolID: sp?.id ?? idx + 1,
          side: leg.action === 'BUY' ? 'BUY' : 'SELL',
          price: leg.liveSpotPrice,
          quantity: leg.tradeQty,
          pricePrecision: sp?.pricePrecision ?? 2,
          quantityPrecision: sp?.quantityPrecision ?? 4,
        };
      });

    onStagePaperTrade({
      strategyType: 'SSI_REBALANCE',
      symbol: activePlan.indexKey,
      spotSymbol: activePlan.spotMarketSymbol,
      spotSymbolId: activeSpotSpec?.id ?? 1,
      spotPricePrecision: activeSpotSpec?.pricePrecision ?? 4,
      spotQuantityPrecision: activeSpotSpec?.quantityPrecision ?? 2,
      executionMode: 'MAKER',
      direction: 'REBALANCE_BASKET',
      notionalUsd: Math.max(1000, Math.round(activePlan.totalTurnoverUsd)),
      leverage: 1,
      entrySpotPrice: activePlan.marketSpotPrice,
      entryPerpPrice: activePlan.impliedNavPrice,
      entryHourlyFundingRate: 0,
      expectedNetApyPct: 0,
      estimatedFeesUsd: activePlan.estimatedSwapSlippageUsd + activePlan.estimatedValueChainGasUsd,
      liquidationBufferPct: 100,
      notes: `${activePlan.contractCallPreview.contract} rebalance (${activePlan.contractCallPreview.inTokensetCount} buys / ${activePlan.contractCallPreview.outTokensetCount} sells, ±${bufferBandPct}% buffer)`,
      guardrails,
      ssiBatchLegs,
    });
  };

  return (
    <div className="space-y-5">
      {/* Top 3 Live SSI Protocol Index Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(['MAG7.ssi', 'DEFI.ssi', 'USSI'] as const).map((key) => {
          const p = plansByIndex[key];
          const active = key === selectedIndex;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedIndex(key)}
              className={`panel-surface rounded-xl p-4 text-left transition ${
                active ? 'border-violet-400/60 ring-1 ring-violet-400/30' : 'hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-violet-400" />
                  <span className="font-mono text-sm font-bold text-slate-100">{key}</span>
                </div>
                <TelemetryBadge status={telemetry.sodex_spot.status} label={p.spotMarketSymbol} compact />
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 font-mono tabular-nums">
                <div>
                  <div className="font-sans text-[10px] text-slate-500">SoDEX Spot Price</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-100">
                    ${formatPrice(p.marketSpotPrice)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-sans text-[10px] text-slate-500">Implied iNAV</div>
                  <div className="mt-0.5 text-lg font-bold text-sky-300">
                    ${formatPrice(p.impliedNavPrice)}
                  </div>
                </div>
              </div>

              <div className="mt-2.5 flex items-center justify-between border-t border-slate-800/80 pt-2.5 text-[11px]">
                <span className="font-mono tabular-nums text-slate-400">
                  Prem/Disc:{' '}
                  <strong
                    className={
                      p.premiumDiscountBps > 0 ? 'text-emerald-400' : 'text-amber-300'
                    }
                  >
                    {formatBps(p.premiumDiscountBps)}
                  </strong>
                </span>
                <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-200">
                  {p.arbSignal.replaceAll('_', ' ')}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Controls Bar */}
      <div className="panel-surface rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Sliders className="h-4 w-4 text-violet-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                SSI Protocol Rebalance Parameters ({activePlan.indexKey})
              </h3>
              <p className="text-[11px] text-slate-400">
                Modeled directly on <code className="text-violet-300">SoSoValueLabs/ssi-protocol</code> ({activePlan.contractCallPreview.contract}) with buffer-band turnover control
              </p>
            </div>
          </div>
          <TelemetryBadge status={telemetry.valuechain_rpc.status} label={`ValueChain #${valueChain.blockNumber.toLocaleString()}`} compact />
        </div>

        <div className="mt-3.5 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Basket AUM</span>
              <span className="font-mono font-semibold text-slate-100 tabular-nums">
                {formatUsd(aumUsd, 0)}
              </span>
            </div>
            <input
              type="range"
              min={10000}
              max={1000000}
              step={10000}
              value={aumUsd}
              onChange={(e) => setAumUsd(Number(e.target.value))}
              className="mt-1.5 w-full"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">Drift Buffer Band (±%)</span>
              <span className="font-mono font-semibold text-violet-300 tabular-nums">
                ±{bufferBandPct.toFixed(1)}%
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={5.0}
              step={0.25}
              value={bufferBandPct}
              onChange={(e) => setBufferBandPct(Number(e.target.value))}
              className="mt-1.5 w-full"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-400">30D Dispersion Stress</span>
              <span className="font-mono font-semibold text-sky-300 tabular-nums">
                {formatPct(driftShockPct, 0)}
              </span>
            </div>
            <input
              type="range"
              min={-20}
              max={50}
              step={5}
              value={driftShockPct}
              onChange={(e) => setDriftShockPct(Number(e.target.value))}
              className="mt-1.5 w-full"
            />
          </div>
        </div>
      </div>

      {/* Main Split: Constituent Drift Table (Left) + Contract & Fee Preview (Right) */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="panel-surface rounded-xl xl:col-span-7">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3">
            <div className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                Constituent Weight Drift &amp; Rebalance Legs
              </h3>
            </div>
            <span className="font-mono text-xs text-slate-400 tabular-nums">
              Turnover: <strong className="text-slate-100">{activePlan.turnoverPct.toFixed(2)}%</strong> ({formatUsd(activePlan.totalTurnoverUsd, 0)})
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800/80 bg-[#080B10]/60 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="px-4 py-2.5">Asset</th>
                  <th className="px-3 py-2.5 text-right">Live Spot</th>
                  <th className="px-3 py-2.5 text-right">Target %</th>
                  <th className="px-3 py-2.5 text-right">Drifted %</th>
                  <th className="px-3 py-2.5 text-right">Drift</th>
                  <th className="px-3 py-2.5 text-center">Action</th>
                  <th className="px-4 py-2.5 text-right">Trade Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono tabular-nums">
                {activePlan.legs.map((leg) => (
                  <tr key={leg.symbol} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5">
                      <div className="font-sans font-semibold text-slate-100">{leg.symbol}</div>
                      <div className="text-[10px] text-slate-500">{leg.spotPair}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="text-slate-100">${formatPrice(leg.liveSpotPrice)}</div>
                      <div
                        className={`text-[10px] ${
                          leg.changePct24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {formatPct(leg.changePct24h, 1)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {leg.targetWeightPct.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-100">
                      {leg.currentWeightPct.toFixed(1)}%
                    </td>
                    <td
                      className={`px-3 py-2.5 text-right ${
                        Math.abs(leg.driftPct) >= bufferBandPct
                          ? leg.driftPct > 0
                            ? 'text-rose-400'
                            : 'text-emerald-400'
                          : 'text-slate-500'
                      }`}
                    >
                      {formatPct(leg.driftPct, 2)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold ${
                          leg.action === 'BUY'
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                            : leg.action === 'SELL'
                              ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                              : 'bg-slate-800/80 text-slate-400'
                        }`}
                      >
                        {leg.action === 'HOLD' ? 'IN BUFFER' : leg.action}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="text-slate-100">
                        {leg.tradeUsd > 0 ? formatUsd(leg.tradeUsd, 0) : '$0'}
                      </div>
                      {leg.tradeQty > 0 && (
                        <div className="text-[10px] text-slate-500">
                          {leg.tradeQty.toFixed(3)} {leg.symbol}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Contract Preview & ValueChain Settlement Economics */}
        <div className="flex flex-col gap-4 xl:col-span-5">
          <div className="panel-surface rounded-xl p-4">
            <div className="flex items-center gap-2">
              <Coins className="h-4 w-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                ValueChain Settlement &amp; Fee Economics
              </h3>
            </div>

            <div className="mt-3 space-y-2 rounded-lg border border-slate-800 bg-[#080B10]/80 p-3 font-mono text-xs tabular-nums">
              <div className="flex justify-between">
                <span className="font-sans text-slate-400">One-Sided Rebalance Turnover</span>
                <span className="text-slate-100">
                  {formatUsd(activePlan.totalTurnoverUsd, 0)} ({activePlan.turnoverPct.toFixed(2)}%)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="font-sans text-slate-400">Est. SoDEX Spot Swap Friction</span>
                <span className="text-amber-300">{formatUsd(activePlan.estimatedSwapSlippageUsd)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-sans text-slate-400">
                  AssetFeeManager Accrual ({activePlan.annualManagementFeePct}%/yr)
                </span>
                <span className="text-slate-200">
                  {formatUsd(activePlan.accruedMonthlyFeeUsd)} / mo
                </span>
              </div>
              <div className="flex justify-between border-t border-slate-800/70 pt-2">
                <span className="font-sans text-slate-400">ValueChain Mainnet Gas (Chain {valueChain.chainId})</span>
                <span className="text-violet-300">
                  {activePlan.estimatedValueChainGasSoso.toFixed(8)} SOSO (~${activePlan.estimatedValueChainGasUsd.toFixed(6)})
                </span>
              </div>
            </div>
          </div>

          <div className="panel-surface flex-1 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-violet-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  SSI Smart Contract Call Preview
                </h3>
              </div>
              <span className="font-mono text-[10px] text-violet-300">
                {activePlan.contractCallPreview.contract}
              </span>
            </div>

            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-[#080B10] p-3 font-mono text-[11px] leading-relaxed text-sky-200">
{`// Target: SoSoValueLabs/ssi-protocol (${activePlan.contractCallPreview.contract})
// Method: ${activePlan.contractCallPreview.method}
{
  "chainId": ${valueChain.chainId},
  "assetID": ${activePlan.contractCallPreview.assetId},
  "nonce": ${activePlan.contractCallPreview.nonce},
  "feeDecimals": ${activePlan.contractCallPreview.feeDecimals},
  "inTokensetLegs": ${activePlan.contractCallPreview.inTokensetCount},
  "outTokensetLegs": ${activePlan.contractCallPreview.outTokensetCount},
  "inTokensetPreview": [
${activePlan.legs
  .filter((l) => l.action === 'BUY')
  .slice(0, 3)
  .map((l) => `    { "symbol": "${l.symbol}", "amount1e8": "${l.tokensetScaled1e8.toString()}" }`)
  .join(',\n') || '    // All constituents within drift buffer'}
  ]
}`}
            </pre>

            <button
              type="button"
              onClick={handleStageRebalance}
              className="mt-3.5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-500 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-400"
            >
              <Zap className="h-4 w-4" />
              Sign Multi-Leg batchNewOrder / Queue Rebalance
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
