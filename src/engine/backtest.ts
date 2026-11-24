import type { KlineBar, PerpMarginTier } from '../types/market';
import { createSeededRng, resolveMaintenanceMargin, sampleNormal } from './quant';

export const DEFAULT_RISK_FREE_ANNUAL_RATE = 0.045; // 4.5% USDC / US T-bill benchmark hurdle
const KLINE_MATCH_TOLERANCE_MS = 60_000; // 1-minute tolerance on 4h bars to avoid silent 1ms drops

export interface AlignedHistoricalBar {
  timestamp: number;
  dateLabel: string;
  spotOpen: number;
  spotHigh: number;
  spotLow: number;
  spotClose: number;
  perpOpen: number;
  perpHigh: number;
  perpLow: number;
  perpClose: number;
  basisBps: number;
  derivedHourlyFundingRate: number;
  barHours: number;
}

export interface BacktestEquityPoint {
  index: number;
  timestamp: number;
  dateLabel: string;
  carryEquityUsd: number;
  spotBenchmarkUsd: number;
  basisBps: number;
  hourlyFundingBps: number;
  fundingCollectedUsd: number;
  cumulativeFundingUsd: number;
  drawdownPct: number;
  isLiquidationBar: boolean;
  isPostStop: boolean;
}

export interface HistoricalSignalOutcome {
  windowId: string;
  startDate: string;
  endDate: string;
  entryBasisBps: number;
  /** Realized annualized funding collected on notional during this slice (0% if flat post-stop) */
  avgAnnualizedFundingPct: number;
  windowCarryReturnPct: number;
  spotBenchmarkReturnPct: number;
  sliceCollectedFundingUsd: number;
  sliceFeeHurdlePct: number;
  status: 'HIT' | 'STOPPED' | 'DRIFT' | 'FLAT';
  note: string;
}

export interface LiveFundingComparison {
  liveHourlyRate: number;
  liveAnnualizedPct: number;
  proxyAnnualizedPct: number;
  deltaAnnualizedPct: number;
  activeHours: number;
  fundingAtLiveRateUsd: number;
  netPnlAtLiveRateUsd: number;
  apyAtLiveRatePct: number;
}

export interface HistoricalBacktestParams {
  perpSymbol: string;
  spotSymbol: string;
  perpBars: KlineBar[];
  spotBars: KlineBar[];
  source: 'LIVE_REST' | 'SNAPSHOT' | 'SYNTHETIC';
  notionalPerLegUsd: number;
  leverage: number;
  executionMode: 'MAKER' | 'TAKER';
  spotMakerFee: number;
  spotTakerFee: number;
  perpMakerFee: number;
  perpTakerFee: number;
  marginTiers: PerpMarginTier[];
  /** Current live SoDEX hourly funding rate, used as an explicit comparison overlay against the close-basis proxy */
  liveHourlyFundingAnchor?: number;
}

export interface HistoricalBacktestResult {
  perpSymbol: string;
  spotSymbol: string;
  source: 'LIVE_REST' | 'SNAPSHOT' | 'SYNTHETIC';
  barsCount: number;
  unmatchedBarsCount: number;
  windowDays: number;
  accruedHours: number;
  startIso: string;
  endIso: string;
  initialCapitalUsd: number;
  finalCarryEquityUsd: number;
  finalSpotBenchmarkUsd: number;
  netPnlUsd: number;
  totalReturnPct: number;
  annualizedCarryApyPct: number;
  spotBenchmarkReturnPct: number;
  alphaVsSpotPct: number;
  cumulativeFundingUsd: number;
  totalFeesUsd: number;
  roundTripFeeBps: number;
  maxDrawdownPct: number;
  perpMaxMarginDrawdownPct: number;
  spotMaxDrawdownPct: number;
  /** Unannualized excess return / volatility over the observed window (excess over 4.5% USDC hurdle) */
  periodReturnToVol: number;
  /** Unannualized excess return / sample downside deviation over negative excess bars (n - 1) */
  periodDownsideRatio: number;
  riskFreeAnnualPct: number;
  /** Fraction of active bars with strictly positive return (r > 0) */
  winRatePct: number;
  avgBasisBps: number;
  maxBasisBps: number;
  minBasisBps: number;
  /** Mean close-basis proxy hourly rate annualized (not settled exchange prints) */
  avgAnnualizedFundingPct: number;
  liveFundingComparison: LiveFundingComparison | null;
  liquidationEvent: {
    barIndex: number;
    timestampIso: string;
    triggerHighPrice: number;
    liquidationThresholdPrice: number;
    equityAfterUsd: number;
    spotExitPrice: number;
  } | null;
  equityCurve: BacktestEquityPoint[];
  signalTrackRecord: HistoricalSignalOutcome[];
}

/**
 * Close-to-close proxy of SoDEX's 8h-to-1h funding clamp (docs.sodex.com/trading-mechanics/funding):
 *   FundingRate_8h = P + clamp(InterestRate_8h - P, -0.0005, +0.0005)
 *   HourlyFunding  = clamp(FundingRate_8h / 8, -0.04, +0.04)
 *
 * NOTE: On-exchange SoDEX computes P every 5 seconds from impact-notional bid/ask vs Oracle Index.
 * Because SoDEX public REST does not expose unauthenticated market-wide funding history,
 * historical replay uses P = (perpClose - spotClose) / spotClose as a close-to-close proxy.
 */
export function computeSodexHourlyFundingFromBasis(
  perpPrice: number,
  spotPrice: number,
  interestRate8h = 0.0001,
): number {
  if (!Number.isFinite(perpPrice) || !Number.isFinite(spotPrice) || spotPrice <= 0) {
    return interestRate8h / 8;
  }
  const premium = (perpPrice - spotPrice) / spotPrice;
  const clampedDiff = Math.max(-0.0005, Math.min(0.0005, interestRate8h - premium));
  const rate8h = premium + clampedDiff;
  return Math.max(-0.04, Math.min(0.04, rate8h / 8));
}

/**
 * Computes exact isolated short-perp liquidation price from pre-breach margin balance
 * and SoDEX's tiered maintenance margin formula:
 *   marginCash + qty * (entryPerp - px) = (qty * px) * mmr - deduction
 *   => px = (marginCash + qty * entryPerp + deduction) / (qty * (1 + mmr))
 * Iterates tier lookup so mmr and deduction match the tier at the solved liquidation price.
 */
export function computeShortPerpLiquidationPrice(
  marginCash: number,
  baseQty: number,
  entryPerp: number,
  marginTiers: PerpMarginTier[],
): number {
  if (!Number.isFinite(marginCash) || !Number.isFinite(baseQty) || !Number.isFinite(entryPerp)) {
    return 0;
  }
  if (baseQty <= 0 || entryPerp <= 0) return 0;

  let px = entryPerp;
  for (let iter = 0; iter < 4; iter++) {
    const estNotional = Math.max(0, baseQty * px);
    const { maintenanceMarginRate, maintenanceDeduction } = resolveMaintenanceMargin(
      estNotional,
      marginTiers,
    );
    const nextPx =
      (marginCash + baseQty * entryPerp + maintenanceDeduction) /
      (baseQty * (1 + maintenanceMarginRate));
    if (!Number.isFinite(nextPx) || nextPx <= 0) return 0;
    if (Math.abs(nextPx - px) < 1e-6) {
      px = nextPx;
      break;
    }
    px = nextPx;
  }
  return px;
}

function formatShortDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toISOString().slice(5, 10);
}

/**
 * Aligns SoDEX Perp and Spot kline candles chronologically ascending by timestamp.
 * Matches exact timestamps first, then falls back to nearest unused spot bar within
 * KLINE_MATCH_TOLERANCE_MS (60s) so 1ms clock skew does not silently drop candles.
 */
export function alignKlinePairs(
  perpBars: KlineBar[],
  spotBars: KlineBar[],
  toleranceMs = KLINE_MATCH_TOLERANCE_MS,
): AlignedHistoricalBar[] {
  if (!perpBars.length || !spotBars.length) return [];

  const sortedPerps = [...perpBars]
    .filter((b) => Number(b.c) > 0 && Number(b.h) > 0)
    .sort((a, b) => a.t - b.t);
  const sortedSpots = [...spotBars]
    .filter((b) => Number(b.c) > 0)
    .sort((a, b) => a.t - b.t);

  const exactSpotByTs = new Map<number, { bar: KlineBar; idx: number }>();
  sortedSpots.forEach((sb, idx) => exactSpotByTs.set(sb.t, { bar: sb, idx }));
  const usedSpotIdx = new Set<number>();

  const findSpotMatch = (targetTs: number): KlineBar | null => {
    const exact = exactSpotByTs.get(targetTs);
    if (exact && !usedSpotIdx.has(exact.idx)) {
      usedSpotIdx.add(exact.idx);
      return exact.bar;
    }
    if (toleranceMs <= 0) return null;

    // Binary search nearest spot timestamp within toleranceMs
    let lo = 0;
    let hi = sortedSpots.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedSpots[mid].t < targetTs) lo = mid + 1;
      else hi = mid;
    }

    let bestIdx = -1;
    let bestDiff = toleranceMs + 1;
    for (const candidateIdx of [lo - 1, lo, lo + 1]) {
      if (candidateIdx < 0 || candidateIdx >= sortedSpots.length || usedSpotIdx.has(candidateIdx)) {
        continue;
      }
      const diff = Math.abs(sortedSpots[candidateIdx].t - targetTs);
      if (diff <= toleranceMs && diff < bestDiff) {
        bestDiff = diff;
        bestIdx = candidateIdx;
      }
    }
    if (bestIdx >= 0) {
      usedSpotIdx.add(bestIdx);
      return sortedSpots[bestIdx];
    }
    return null;
  };

  const aligned: AlignedHistoricalBar[] = [];
  let prevTs = 0;

  for (const pb of sortedPerps) {
    const sb = findSpotMatch(pb.t);
    if (!sb) continue;

    const spotOpen = Number(sb.o) || Number(sb.c);
    const spotClose = Number(sb.c);
    const spotHigh = Number(sb.h) || Math.max(spotOpen, spotClose);
    const spotLow = Number(sb.l) || Math.min(spotOpen, spotClose);
    const perpOpen = Number(pb.o) || Number(pb.c);
    const perpClose = Number(pb.c);
    const perpHigh = Number(pb.h) || Math.max(perpOpen, perpClose);
    const perpLow = Number(pb.l) || Math.min(perpOpen, perpClose);

    const basisBps = spotClose > 0 ? ((perpClose - spotClose) / spotClose) * 10000 : 0;
    const derivedHourlyFundingRate = computeSodexHourlyFundingFromBasis(perpClose, spotClose);
    const barHours =
      prevTs > 0 ? Math.max(1, Math.min(24, Math.round((pb.t - prevTs) / 3_600_000))) : 4;
    prevTs = pb.t;

    aligned.push({
      timestamp: pb.t,
      dateLabel: formatShortDate(pb.t),
      spotOpen,
      spotHigh,
      spotLow,
      spotClose,
      perpOpen,
      perpHigh,
      perpLow,
      perpClose,
      basisBps,
      derivedHourlyFundingRate,
      barHours,
    });
  }

  return aligned;
}

/**
 * Deterministic fallback klines generator strictly used if both live SoDEX REST
 * and snapshot klines are absent (explicitly tagged source = 'SYNTHETIC').
 */
export function generateDeterministicFallbackKlines(
  spotAnchorPrice: number,
  annualVolatility = 0.62,
  seed = 20261124,
  bars = 180,
): { perpBars: KlineBar[]; spotBars: KlineBar[] } {
  const rng = createSeededRng(seed);
  const endMs = Math.floor(Date.now() / 14_400_000) * 14_400_000;
  const dt = 4 / 8760;
  const sigma = Math.max(0.2, Math.min(1.8, annualVolatility));

  const closes: number[] = [spotAnchorPrice];
  for (let i = 1; i < bars; i++) {
    const z = sampleNormal(rng);
    const prev = closes[i - 1];
    closes.push(
      Math.max(
        spotAnchorPrice * 0.35,
        prev * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z),
      ),
    );
  }
  const scale = spotAnchorPrice / closes[closes.length - 1];

  const perpBars: KlineBar[] = [];
  const spotBars: KlineBar[] = [];
  let basis = 0.0008;

  for (let i = 0; i < bars; i++) {
    const t = endMs - (bars - 1 - i) * 14_400_000;
    const sClose = closes[i] * scale;
    const sOpen = i === 0 ? sClose : closes[i - 1] * scale;
    const wickUp = 1 + Math.abs(sampleNormal(rng)) * sigma * Math.sqrt(dt) * 0.7;
    const wickDn = 1 - Math.abs(sampleNormal(rng)) * sigma * Math.sqrt(dt) * 0.7;

    basis = Math.max(-0.004, Math.min(0.008, basis * 0.85 + 0.00012 + sampleNormal(rng) * 0.0006));
    const pOpen = sOpen * (1 + basis);
    const pClose = sClose * (1 + basis);
    const pHigh = Math.max(pOpen, pClose) * wickUp;
    const pLow = Math.min(pOpen, pClose) * Math.max(0.85, wickDn);

    spotBars.push({
      t,
      o: sOpen.toFixed(2),
      h: (Math.max(sOpen, sClose) * wickUp).toFixed(2),
      l: (Math.min(sOpen, sClose) * Math.max(0.85, wickDn)).toFixed(2),
      c: sClose.toFixed(2),
      v: '12.4',
      q: (sClose * 12.4).toFixed(2),
      n: 420,
    });
    perpBars.push({
      t,
      o: pOpen.toFixed(2),
      h: pHigh.toFixed(2),
      l: pLow.toFixed(2),
      c: pClose.toFixed(2),
      v: '310.5',
      q: (pClose * 310.5).toFixed(2),
      n: 5200,
    });
  }

  return { perpBars, spotBars };
}

/**
 * Replays a single continuous Long Spot + Short Perp position bar-by-bar over matched
 * SoDEX 4-hour Perp & Spot klines using a close-to-close basis proxy of SoDEX's 8h/8 funding
 * clamp, with intra-bar high-wick maintenance margin checks and immediate post-breach flattening.
 */
export function runHistoricalBasisBacktest(
  params: HistoricalBacktestParams,
): HistoricalBacktestResult {
  const validPerpsCount = params.perpBars.filter((b) => Number(b.c) > 0 && Number(b.h) > 0).length;
  const aligned = alignKlinePairs(params.perpBars, params.spotBars);
  const unmatchedBarsCount = Math.max(0, validPerpsCount - aligned.length);

  const notional = Math.max(100, params.notionalPerLegUsd);
  const leverage = Math.max(1, params.leverage);
  const spotCapital = notional;
  const initialPerpMargin = notional / leverage;
  const initialCapitalUsd = spotCapital + initialPerpMargin;

  const spotFeeRate = params.executionMode === 'MAKER' ? params.spotMakerFee : params.spotTakerFee;
  const perpFeeRate = params.executionMode === 'MAKER' ? params.perpMakerFee : params.perpTakerFee;
  const spotEntryFee = notional * spotFeeRate;
  const perpEntryFee = notional * perpFeeRate;
  const entryFeesUsd = spotEntryFee + perpEntryFee;
  const scheduledExitFeesUsd = notional * (spotFeeRate + perpFeeRate);
  const roundTripFeeBps = (spotFeeRate + perpFeeRate) * 2 * 10000;

  if (aligned.length < 2) {
    const nowIso = new Date().toISOString();
    return {
      perpSymbol: params.perpSymbol,
      spotSymbol: params.spotSymbol,
      source: params.source,
      barsCount: aligned.length,
      unmatchedBarsCount,
      windowDays: 0,
      accruedHours: 0,
      startIso: nowIso,
      endIso: nowIso,
      initialCapitalUsd,
      finalCarryEquityUsd: initialCapitalUsd,
      finalSpotBenchmarkUsd: initialCapitalUsd,
      netPnlUsd: 0,
      totalReturnPct: 0,
      annualizedCarryApyPct: 0,
      spotBenchmarkReturnPct: 0,
      alphaVsSpotPct: 0,
      cumulativeFundingUsd: 0,
      totalFeesUsd: entryFeesUsd + scheduledExitFeesUsd,
      roundTripFeeBps,
      maxDrawdownPct: 0,
      perpMaxMarginDrawdownPct: 0,
      spotMaxDrawdownPct: 0,
      periodReturnToVol: 0,
      periodDownsideRatio: 0,
      riskFreeAnnualPct: DEFAULT_RISK_FREE_ANNUAL_RATE * 100,
      winRatePct: 0,
      avgBasisBps: 0,
      maxBasisBps: 0,
      minBasisBps: 0,
      avgAnnualizedFundingPct: 0,
      liveFundingComparison: null,
      liquidationEvent: null,
      equityCurve: [],
      signalTrackRecord: [],
    };
  }

  const entrySpot = aligned[0].spotClose;
  const entryPerp = aligned[0].perpClose;
  const baseQty = notional / entrySpot;

  let perpMarginCash = initialPerpMargin - perpEntryFee;
  let cumulativeFundingUsd = 0;
  let accruedHours = 0;
  let liveRateFundingSumUsd = 0;
  let realizedFeesUsd = entryFeesUsd;
  let liquidated = false;
  let liquidationBarIndex: number | null = null;
  let flattenedCashUsd = 0;
  let liquidationEvent: HistoricalBacktestResult['liquidationEvent'] = null;

  let peakCarryEquity = initialCapitalUsd;
  let maxDrawdownPct = 0;
  let perpMaxMarginDrawdownPct = 0;
  let peakSpotBench = initialCapitalUsd;
  let spotMaxDrawdownPct = 0;

  let prevCarryEquity = initialCapitalUsd;
  const activeBarReturns: number[] = [];
  const activeBarHours: number[] = [];
  let strictlyPositiveBars = 0;

  let basisSum = 0;
  let maxBasisBps = -Infinity;
  let minBasisBps = Infinity;
  let fundingRateSum = 0;

  const equityCurve: BacktestEquityPoint[] = [];

  for (let i = 0; i < aligned.length; i++) {
    const bar = aligned[i];
    basisSum += bar.basisBps;
    if (bar.basisBps > maxBasisBps) maxBasisBps = bar.basisBps;
    if (bar.basisBps < minBasisBps) minBasisBps = bar.basisBps;
    fundingRateSum += bar.derivedHourlyFundingRate;

    let isLiquidationBar = false;
    let barFundingCollectedUsd = 0;
    const wasStoppedBeforeBar = liquidated;

    if (i > 0 && !liquidated) {
      // Check worst-case intra-bar short perp margin against SoDEX maintenance margin tier using candle HIGH
      const highNotional = baseQty * bar.perpHigh;
      const { maintenanceMarginUsd } = resolveMaintenanceMargin(highNotional, params.marginTiers);
      const worstPerpEquity = perpMarginCash + baseQty * (entryPerp - bar.perpHigh);

      // Track peak-to-trough isolated short-perp margin utilization drawdown
      if (initialPerpMargin > 0) {
        const perpMarginDdPct = Math.min(
          100,
          Math.max(0, ((initialPerpMargin - worstPerpEquity) / initialPerpMargin) * 100),
        );
        if (perpMarginDdPct > perpMaxMarginDrawdownPct) {
          perpMaxMarginDrawdownPct = perpMarginDdPct;
        }
      }

      if (worstPerpEquity <= maintenanceMarginUsd) {
        // Compute exact isolated liquidation threshold BEFORE mutating perpMarginCash
        const liqThresholdPx = computeShortPerpLiquidationPrice(
          perpMarginCash,
          baseQty,
          entryPerp,
          params.marginTiers,
        );

        liquidated = true;
        liquidationBarIndex = i;
        isLiquidationBar = true;
        perpMaxMarginDrawdownPct = 100;

        // Staged CLOB unwind penalty (~0.8% of breached perp notional)
        perpMarginCash = Math.max(0, worstPerpEquity - highNotional * 0.008);

        // Flatten spot leg immediately at bar.spotClose and stop further MTM/funding
        const spotExitNotional = baseQty * bar.spotClose;
        const spotExitFeeOnStop = spotExitNotional * spotFeeRate;
        realizedFeesUsd = entryFeesUsd + spotExitFeeOnStop;
        flattenedCashUsd = Math.max(
          0,
          spotExitNotional - spotEntryFee - spotExitFeeOnStop + perpMarginCash,
        );

        liquidationEvent = {
          barIndex: i,
          timestampIso: new Date(bar.timestamp).toISOString(),
          triggerHighPrice: bar.perpHigh,
          liquidationThresholdPrice: liqThresholdPx,
          equityAfterUsd: flattenedCashUsd,
          spotExitPrice: bar.spotClose,
        };
      } else {
        // Track intra-bar basis MTM excursion (perpHigh vs spotHigh and perpLow vs spotLow)
        const eqAtHigh =
          baseQty * bar.spotHigh - spotEntryFee + perpMarginCash + baseQty * (entryPerp - bar.perpHigh);
        const eqAtLow =
          baseQty * bar.spotLow - spotEntryFee + perpMarginCash + baseQty * (entryPerp - bar.perpLow);
        const worstIntraBarEq = Math.max(0, Math.min(eqAtHigh, eqAtLow));
        if (peakCarryEquity > 0) {
          const intraDdPct = ((peakCarryEquity - worstIntraBarEq) / peakCarryEquity) * 100;
          if (intraDdPct > maxDrawdownPct) maxDrawdownPct = intraDdPct;
        }

        // Accrue close-basis proxy funding on active hours
        barFundingCollectedUsd = baseQty * bar.spotClose * bar.derivedHourlyFundingRate * bar.barHours;
        perpMarginCash += barFundingCollectedUsd;
        cumulativeFundingUsd += barFundingCollectedUsd;
        accruedHours += bar.barHours;

        if (
          params.liveHourlyFundingAnchor !== undefined &&
          Number.isFinite(params.liveHourlyFundingAnchor)
        ) {
          liveRateFundingSumUsd +=
            baseQty * bar.spotClose * params.liveHourlyFundingAnchor * bar.barHours;
        }
      }
    }

    let carryEquityUsd: number;
    if (liquidated) {
      // Position is flat cash after liquidation stop — no spot MTM, no funding, no double exit fee
      carryEquityUsd = flattenedCashUsd;
    } else {
      const spotLegVal = baseQty * bar.spotClose - spotEntryFee;
      const perpAccountVal = perpMarginCash + baseQty * (entryPerp - bar.perpClose);
      const isFinalBar = i === aligned.length - 1;
      const exitFeeDeduction = isFinalBar ? scheduledExitFeesUsd : 0;
      if (isFinalBar) {
        realizedFeesUsd = entryFeesUsd + scheduledExitFeesUsd;
      }
      carryEquityUsd = Math.max(0, spotLegVal + perpAccountVal - exitFeeDeduction);
    }

    const spotBenchmarkUsd = initialCapitalUsd * (bar.spotClose / entrySpot);

    if (carryEquityUsd > peakCarryEquity) peakCarryEquity = carryEquityUsd;
    const ddPct = peakCarryEquity > 0 ? ((peakCarryEquity - carryEquityUsd) / peakCarryEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    if (spotBenchmarkUsd > peakSpotBench) peakSpotBench = spotBenchmarkUsd;
    const spotDd = peakSpotBench > 0 ? ((peakSpotBench - spotBenchmarkUsd) / peakSpotBench) * 100 : 0;
    if (spotDd > spotMaxDrawdownPct) spotMaxDrawdownPct = spotDd;

    // Record return only on active bars (including the liquidation bar itself, excluding flat post-stop bars)
    if (i > 0 && !wasStoppedBeforeBar) {
      const r = prevCarryEquity > 0 ? (carryEquityUsd - prevCarryEquity) / prevCarryEquity : 0;
      activeBarReturns.push(r);
      activeBarHours.push(bar.barHours);
      if (r > 0) strictlyPositiveBars += 1;
    }
    prevCarryEquity = carryEquityUsd;

    equityCurve.push({
      index: i,
      timestamp: bar.timestamp,
      dateLabel: bar.dateLabel,
      carryEquityUsd,
      spotBenchmarkUsd,
      basisBps: bar.basisBps,
      hourlyFundingBps: wasStoppedBeforeBar || isLiquidationBar ? 0 : bar.derivedHourlyFundingRate * 10000,
      fundingCollectedUsd: barFundingCollectedUsd,
      cumulativeFundingUsd,
      drawdownPct: ddPct,
      isLiquidationBar,
      isPostStop: wasStoppedBeforeBar,
    });
  }

  const firstTs = aligned[0].timestamp;
  const lastTs = aligned[aligned.length - 1].timestamp;
  const windowDays = Math.max(1 / 6, (lastTs - firstTs) / 86_400_000);
  const finalCarryEquityUsd = equityCurve[equityCurve.length - 1].carryEquityUsd;
  const finalSpotBenchmarkUsd = equityCurve[equityCurve.length - 1].spotBenchmarkUsd;
  const netPnlUsd = finalCarryEquityUsd - initialCapitalUsd;
  const totalReturnPct = (netPnlUsd / initialCapitalUsd) * 100;
  const annualizedCarryApyPct = totalReturnPct * (365 / windowDays);
  const spotBenchmarkReturnPct = ((finalSpotBenchmarkUsd - initialCapitalUsd) / initialCapitalUsd) * 100;
  const alphaVsSpotPct = totalReturnPct - spotBenchmarkReturnPct;

  // Unannualized observed-window risk-adjusted ratios (excess over 4.5% USDC hurdle,
  // consistent n - 1 sample denominator for both total stdDev and downside semi-deviation).
  // Deliberately unannualized: extrapolating a 30-day hedged basis path by sqrt(2190) manufactures
  // misleading mid-teens Sharpe ratios.
  const nActive = activeBarReturns.length;
  const excessReturns = activeBarReturns.map(
    (r, idx) => r - DEFAULT_RISK_FREE_ANNUAL_RATE * (activeBarHours[idx] / 8760),
  );
  const meanExcess =
    excessReturns.reduce((a, b) => a + b, 0) / Math.max(1, nActive);
  const excessVar =
    nActive > 1
      ? excessReturns.reduce((acc, r) => acc + (r - meanExcess) ** 2, 0) / (nActive - 1)
      : 0;
  const barStdDev = Math.sqrt(excessVar);

  const negExcess = excessReturns.filter((r) => r < 0);
  const downsideVar =
    negExcess.length > 1
      ? negExcess.reduce((acc, r) => acc + r * r, 0) / (negExcess.length - 1)
      : negExcess.length === 1
        ? negExcess[0] * negExcess[0]
        : 0;
  const downsideDev = Math.sqrt(downsideVar);

  const periodReturnToVol =
    barStdDev > 1e-9 && nActive > 1 ? (meanExcess / barStdDev) * Math.sqrt(nActive) : 0;
  const periodDownsideRatio =
    downsideDev > 1e-9 && nActive > 1
      ? (meanExcess / downsideDev) * Math.sqrt(nActive)
      : periodReturnToVol;

  const avgBasisBps = basisSum / aligned.length;
  const avgAnnualizedFundingPct = (fundingRateSum / aligned.length) * 8760 * 100;

  let liveFundingComparison: LiveFundingComparison | null = null;
  if (
    params.liveHourlyFundingAnchor !== undefined &&
    Number.isFinite(params.liveHourlyFundingAnchor)
  ) {
    const liveAnnualizedPct = params.liveHourlyFundingAnchor * 8760 * 100;
    const netPnlAtLiveRateUsd = liveRateFundingSumUsd - realizedFeesUsd;
    const apyAtLiveRatePct =
      initialCapitalUsd > 0
        ? (netPnlAtLiveRateUsd / initialCapitalUsd) * (365 / windowDays) * 100
        : 0;
    liveFundingComparison = {
      liveHourlyRate: params.liveHourlyFundingAnchor,
      liveAnnualizedPct,
      proxyAnnualizedPct: avgAnnualizedFundingPct,
      deltaAnnualizedPct: avgAnnualizedFundingPct - liveAnnualizedPct,
      activeHours: accruedHours,
      fundingAtLiveRateUsd: liveRateFundingSumUsd,
      netPnlAtLiveRateUsd,
      apyAtLiveRatePct,
    };
  }

  // Partition the single continuous position into 6 in-sample ~5-day slices (HIT / DRIFT / STOPPED / FLAT).
  // No forced OPEN status: historical tapes already ended, and post-stop slices are explicitly FLAT.
  const sliceCount = 6;
  const cohortSize = Math.max(2, Math.floor(aligned.length / sliceCount));
  const sliceProRataFeeUsd = realizedFeesUsd / sliceCount;
  const signalTrackRecord: HistoricalSignalOutcome[] = [];

  for (let c = 0; c < sliceCount; c++) {
    const sIdx = c * cohortSize;
    const eIdx =
      c === sliceCount - 1
        ? aligned.length - 1
        : Math.min(aligned.length - 1, (c + 1) * cohortSize - 1);
    if (sIdx >= eIdx || !equityCurve[sIdx] || !equityCurve[eIdx]) continue;

    // Compare slice close against the immediately preceding bar's equity so slice returns partition the full path
    const refIdx = sIdx > 0 ? sIdx - 1 : sIdx;
    const startEq = equityCurve[refIdx].carryEquityUsd;
    const endEq = equityCurve[eIdx].carryEquityUsd;
    const startSpot = equityCurve[refIdx].spotBenchmarkUsd;
    const endSpot = equityCurve[eIdx].spotBenchmarkUsd;

    const winCarryPct = startEq > 0 ? ((endEq - startEq) / startEq) * 100 : 0;
    const winSpotPct = startSpot > 0 ? ((endSpot - startSpot) / startSpot) * 100 : 0;

    const slicePoints = equityCurve.slice(sIdx, eIdx + 1);
    const hadLiq = slicePoints.some((pt) => pt.isLiquidationBar);
    const wasAlreadyStopped = liquidationBarIndex !== null && sIdx > liquidationBarIndex;

    let sliceCollectedFundingUsd = 0;
    let sliceActiveHours = 0;
    for (let k = sIdx; k <= eIdx; k++) {
      sliceCollectedFundingUsd += equityCurve[k].fundingCollectedUsd;
      if (k > 0 && !equityCurve[k].isPostStop && !equityCurve[k].isLiquidationBar) {
        sliceActiveHours += aligned[k].barHours;
      }
    }

    const realizedSliceAnnFundingPct =
      sliceActiveHours > 0
        ? (sliceCollectedFundingUsd / notional) * (8760 / sliceActiveHours) * 100
        : 0;
    const sliceFeeHurdlePct = startEq > 0 ? (sliceProRataFeeUsd / startEq) * 100 : 0;

    let status: HistoricalSignalOutcome['status'];
    let note: string;

    if (hadLiq) {
      status = 'STOPPED';
      note = 'Intra-bar perpHigh wick breached maintenance margin; position flattened to cash';
    } else if (wasAlreadyStopped) {
      status = 'FLAT';
      note = 'Position already flattened after prior liquidation stop (0% exposure)';
    } else if (winCarryPct < -1.5) {
      status = 'STOPPED';
      note = 'Basis widening exceeded -1.5% slice drawdown guardrail';
    } else if (winCarryPct > sliceFeeHurdlePct && sliceCollectedFundingUsd > 0) {
      status = 'HIT';
      note = 'Slice net carry cleared pro-rata round-trip fee hurdle with margin intact';
    } else {
      status = 'DRIFT';
      note = 'Slice net carry did not clear pro-rata fee hurdle or funding compressed';
    }

    signalTrackRecord.push({
      windowId: `W${c + 1}`,
      startDate: aligned[sIdx].dateLabel,
      endDate: aligned[eIdx].dateLabel,
      entryBasisBps: aligned[sIdx].basisBps,
      avgAnnualizedFundingPct: realizedSliceAnnFundingPct,
      windowCarryReturnPct: winCarryPct,
      spotBenchmarkReturnPct: winSpotPct,
      sliceCollectedFundingUsd,
      sliceFeeHurdlePct,
      status,
      note,
    });
  }

  return {
    perpSymbol: params.perpSymbol,
    spotSymbol: params.spotSymbol,
    source: params.source,
    barsCount: aligned.length,
    unmatchedBarsCount,
    windowDays,
    accruedHours,
    startIso: new Date(firstTs).toISOString(),
    endIso: new Date(lastTs).toISOString(),
    initialCapitalUsd,
    finalCarryEquityUsd,
    finalSpotBenchmarkUsd,
    netPnlUsd,
    totalReturnPct,
    annualizedCarryApyPct,
    spotBenchmarkReturnPct,
    alphaVsSpotPct,
    cumulativeFundingUsd,
    totalFeesUsd: realizedFeesUsd,
    roundTripFeeBps,
    maxDrawdownPct,
    perpMaxMarginDrawdownPct,
    spotMaxDrawdownPct,
    periodReturnToVol,
    periodDownsideRatio,
    riskFreeAnnualPct: DEFAULT_RISK_FREE_ANNUAL_RATE * 100,
    winRatePct: nActive > 0 ? (strictlyPositiveBars / nActive) * 100 : 0,
    avgBasisBps,
    maxBasisBps,
    minBasisBps,
    avgAnnualizedFundingPct,
    liveFundingComparison,
    liquidationEvent,
    equityCurve,
    signalTrackRecord: signalTrackRecord.reverse(), // most recent slice first
  };
}
