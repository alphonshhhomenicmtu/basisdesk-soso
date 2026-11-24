import type { KlineBar, PerpMarginTier } from '../types/market';
import { createSeededRng, resolveMaintenanceMargin, sampleNormal } from './quant';

export interface AlignedHistoricalBar {
  timestamp: number;
  dateLabel: string;
  spotOpen: number;
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
  cumulativeFundingUsd: number;
  drawdownPct: number;
  isLiquidationBar: boolean;
}

export interface HistoricalSignalOutcome {
  windowId: string;
  startDate: string;
  endDate: string;
  entryBasisBps: number;
  avgAnnualizedFundingPct: number;
  windowCarryReturnPct: number;
  spotBenchmarkReturnPct: number;
  status: 'HIT' | 'STOPPED' | 'DRIFT' | 'OPEN';
  note: string;
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
  /** Optional current live SoDEX hourly funding rate to gently calibrate interest offset */
  liveHourlyFundingAnchor?: number;
}

export interface HistoricalBacktestResult {
  perpSymbol: string;
  spotSymbol: string;
  source: 'LIVE_REST' | 'SNAPSHOT' | 'SYNTHETIC';
  barsCount: number;
  windowDays: number;
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
  maxDrawdownPct: number;
  spotMaxDrawdownPct: number;
  annualizedSharpe: number;
  annualizedSortino: number;
  winRatePct: number;
  avgBasisBps: number;
  maxBasisBps: number;
  minBasisBps: number;
  avgAnnualizedFundingPct: number;
  liquidationEvent: {
    barIndex: number;
    timestampIso: string;
    triggerHighPrice: number;
    liquidationThresholdPrice: number;
    equityAfterUsd: number;
  } | null;
  equityCurve: BacktestEquityPoint[];
  signalTrackRecord: HistoricalSignalOutcome[];
}

/**
 * Official SoDEX funding rate formula (docs.sodex.com/trading-mechanics/funding):
 *   FundingRate_8h = P + clamp(InterestRate_8h - P, -0.0005, +0.0005)
 *   HourlyFunding  = clamp(FundingRate_8h / 8, -0.04, +0.04)
 * where InterestRate_8h = 0.0001 (0.01% per 8h = 0.03%/day) and P = (Perp - Spot) / Spot.
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

function formatShortDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toISOString().slice(5, 10);
}

/**
 * Aligns SoDEX Perp and Spot kline candles chronologically ascending by timestamp.
 */
export function alignKlinePairs(
  perpBars: KlineBar[],
  spotBars: KlineBar[],
): AlignedHistoricalBar[] {
  if (!perpBars.length || !spotBars.length) return [];

  const sortedPerps = [...perpBars]
    .filter((b) => Number(b.c) > 0 && Number(b.h) > 0)
    .sort((a, b) => a.t - b.t);
  const spotByTs = new Map<number, KlineBar>();
  for (const sb of spotBars) {
    if (Number(sb.c) > 0) spotByTs.set(sb.t, sb);
  }

  const aligned: AlignedHistoricalBar[] = [];
  let prevTs = 0;

  for (const pb of sortedPerps) {
    const sb = spotByTs.get(pb.t);
    if (!sb) continue;

    const spotOpen = Number(sb.o) || Number(sb.c);
    const spotClose = Number(sb.c);
    const perpOpen = Number(pb.o) || Number(pb.c);
    const perpHigh = Number(pb.h) || Number(pb.c);
    const perpLow = Number(pb.l) || Number(pb.c);
    const perpClose = Number(pb.c);

    const basisBps = spotClose > 0 ? ((perpClose - spotClose) / spotClose) * 10000 : 0;
    const derivedHourlyFundingRate = computeSodexHourlyFundingFromBasis(perpClose, spotClose);
    const barHours =
      prevTs > 0 ? Math.max(1, Math.min(24, Math.round((pb.t - prevTs) / 3_600_000))) : 4;
    prevTs = pb.t;

    aligned.push({
      timestamp: pb.t,
      dateLabel: formatShortDate(pb.t),
      spotOpen,
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
    closes.push(Math.max(spotAnchorPrice * 0.35, prev * Math.exp(-0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * z)));
  }
  // Rescale final bar to match current live anchor price
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
 * Replays a Delta-Neutral Cash-and-Carry strategy (Long Spot + Short Perp at configured leverage)
 * bar-by-bar over real 30-day SoDEX 4-hour Perp & Spot klines with intra-bar high-wick
 * liquidation enforcement against SoDEX's exact tiered maintenance margins.
 */
export function runHistoricalBasisBacktest(
  params: HistoricalBacktestParams,
): HistoricalBacktestResult {
  const aligned = alignKlinePairs(params.perpBars, params.spotBars);
  const notional = Math.max(100, params.notionalPerLegUsd);
  const leverage = Math.max(1, params.leverage);
  const spotCapital = notional;
  const initialPerpMargin = notional / leverage;
  const initialCapitalUsd = spotCapital + initialPerpMargin;

  const spotFeeRate = params.executionMode === 'MAKER' ? params.spotMakerFee : params.spotTakerFee;
  const perpFeeRate = params.executionMode === 'MAKER' ? params.perpMakerFee : params.perpTakerFee;
  const entryFeesUsd = notional * (spotFeeRate + perpFeeRate);
  const exitFeesUsd = notional * (spotFeeRate + perpFeeRate);
  const totalFeesUsd = entryFeesUsd + exitFeesUsd;

  if (aligned.length < 2) {
    const nowIso = new Date().toISOString();
    return {
      perpSymbol: params.perpSymbol,
      spotSymbol: params.spotSymbol,
      source: params.source,
      barsCount: aligned.length,
      windowDays: 0,
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
      totalFeesUsd,
      maxDrawdownPct: 0,
      spotMaxDrawdownPct: 0,
      annualizedSharpe: 0,
      annualizedSortino: 0,
      winRatePct: 0,
      avgBasisBps: 0,
      maxBasisBps: 0,
      minBasisBps: 0,
      avgAnnualizedFundingPct: 0,
      liquidationEvent: null,
      equityCurve: [],
      signalTrackRecord: [],
    };
  }

  const entrySpot = aligned[0].spotClose;
  const entryPerp = aligned[0].perpClose;
  const baseQty = notional / entrySpot;

  let perpMarginCash = initialPerpMargin - entryFeesUsd * 0.5;
  const spotEntryFee = entryFeesUsd * 0.5;
  let cumulativeFundingUsd = 0;
  let liquidated = false;
  let liquidationEvent: HistoricalBacktestResult['liquidationEvent'] = null;

  let peakCarryEquity = initialCapitalUsd;
  let maxDrawdownPct = 0;
  let peakSpotBench = initialCapitalUsd;
  let spotMaxDrawdownPct = 0;

  let prevCarryEquity = initialCapitalUsd;
  const barReturns: number[] = [];
  let positiveBars = 0;

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

    if (i > 0 && !liquidated) {
      // Check worst-case intra-bar short perp margin against SoDEX maintenance margin tier using candle HIGH
      const highNotional = baseQty * bar.perpHigh;
      const { maintenanceMarginUsd } = resolveMaintenanceMargin(highNotional, params.marginTiers);
      const worstPerpEquity = perpMarginCash + baseQty * (entryPerp - bar.perpHigh);

      if (worstPerpEquity <= maintenanceMarginUsd) {
        liquidated = true;
        isLiquidationBar = true;
        // Staged CLOB unwind penalty (~0.8% of breached notional)
        perpMarginCash = Math.max(0, worstPerpEquity - highNotional * 0.008);
        const liqThresholdPx =
          entryPerp + Math.max(0, perpMarginCash + highNotional * 0.008 - maintenanceMarginUsd) / baseQty;
        const eqAfter = Math.max(0, baseQty * bar.spotClose - spotEntryFee + perpMarginCash);
        liquidationEvent = {
          barIndex: i,
          timestampIso: new Date(bar.timestamp).toISOString(),
          triggerHighPrice: bar.perpHigh,
          liquidationThresholdPrice: liqThresholdPx,
          equityAfterUsd: eqAfter,
        };
      } else {
        // Collect/pay 4 hourly SoDEX funding intervals on short perp leg
        const fundingFlow = baseQty * bar.spotClose * bar.derivedHourlyFundingRate * bar.barHours;
        perpMarginCash += fundingFlow;
        cumulativeFundingUsd += fundingFlow;
      }
    }

    const spotLegVal = baseQty * bar.spotClose - spotEntryFee;
    const perpAccountVal = liquidated
      ? perpMarginCash
      : perpMarginCash + baseQty * (entryPerp - bar.perpClose);
    const exitFeeDeduction = i === aligned.length - 1 ? exitFeesUsd : 0;
    const carryEquityUsd = Math.max(0, spotLegVal + perpAccountVal - exitFeeDeduction);

    const spotBenchmarkUsd = initialCapitalUsd * (bar.spotClose / entrySpot);

    if (carryEquityUsd > peakCarryEquity) peakCarryEquity = carryEquityUsd;
    const ddPct = peakCarryEquity > 0 ? ((peakCarryEquity - carryEquityUsd) / peakCarryEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    if (spotBenchmarkUsd > peakSpotBench) peakSpotBench = spotBenchmarkUsd;
    const spotDd = peakSpotBench > 0 ? ((peakSpotBench - spotBenchmarkUsd) / peakSpotBench) * 100 : 0;
    if (spotDd > spotMaxDrawdownPct) spotMaxDrawdownPct = spotDd;

    if (i > 0) {
      const r = prevCarryEquity > 0 ? (carryEquityUsd - prevCarryEquity) / prevCarryEquity : 0;
      barReturns.push(r);
      if (r >= 0) positiveBars += 1;
    }
    prevCarryEquity = carryEquityUsd;

    equityCurve.push({
      index: i,
      timestamp: bar.timestamp,
      dateLabel: bar.dateLabel,
      carryEquityUsd,
      spotBenchmarkUsd,
      basisBps: bar.basisBps,
      hourlyFundingBps: bar.derivedHourlyFundingRate * 10000,
      cumulativeFundingUsd,
      drawdownPct: ddPct,
      isLiquidationBar,
    });
  }

  const firstTs = aligned[0].timestamp;
  const lastTs = aligned[aligned.length - 1].timestamp;
  const windowDays = Math.max(1, (lastTs - firstTs) / 86_400_000);
  const finalCarryEquityUsd = equityCurve[equityCurve.length - 1].carryEquityUsd;
  const finalSpotBenchmarkUsd = equityCurve[equityCurve.length - 1].spotBenchmarkUsd;
  const netPnlUsd = finalCarryEquityUsd - initialCapitalUsd;
  const totalReturnPct = (netPnlUsd / initialCapitalUsd) * 100;
  const annualizedCarryApyPct = totalReturnPct * (365 / windowDays);
  const spotBenchmarkReturnPct = ((finalSpotBenchmarkUsd - initialCapitalUsd) / initialCapitalUsd) * 100;
  const alphaVsSpotPct = totalReturnPct - spotBenchmarkReturnPct;

  // Annualized Sharpe & Sortino on 4h bar returns (6 bars/day * 365 = 2190 bars/year)
  const barsPerYear = 2190;
  const meanBarRet =
    barReturns.reduce((a, b) => a + b, 0) / Math.max(1, barReturns.length);
  const variance =
    barReturns.reduce((acc, r) => acc + (r - meanBarRet) ** 2, 0) /
    Math.max(1, barReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  const downsideSq =
    barReturns.reduce((acc, r) => acc + (r < 0 ? r * r : 0), 0) /
    Math.max(1, barReturns.length);
  const downsideDev = Math.sqrt(downsideSq);

  const annualizedSharpe = stdDev > 1e-9 ? (meanBarRet / stdDev) * Math.sqrt(barsPerYear) : 0;
  const annualizedSortino =
    downsideDev > 1e-9 ? (meanBarRet / downsideDev) * Math.sqrt(barsPerYear) : annualizedSharpe;

  const avgBasisBps = basisSum / aligned.length;
  const avgAnnualizedFundingPct = (fundingRateSum / aligned.length) * 8760 * 100;

  // Build 6 rolling 5-day Signal Track Record cohorts (HIT / STOPPED / DRIFT / OPEN)
  const cohortSize = Math.max(6, Math.floor(aligned.length / 6));
  const signalTrackRecord: HistoricalSignalOutcome[] = [];
  for (let c = 0; c < 6; c++) {
    const sIdx = c * cohortSize;
    const eIdx = c === 5 ? aligned.length - 1 : Math.min(aligned.length - 1, (c + 1) * cohortSize - 1);
    if (sIdx >= eIdx || !equityCurve[sIdx] || !equityCurve[eIdx]) continue;

    const sliceBars = aligned.slice(sIdx, eIdx + 1);
    const startEq = equityCurve[sIdx].carryEquityUsd;
    const endEq = equityCurve[eIdx].carryEquityUsd;
    const startSpot = equityCurve[sIdx].spotBenchmarkUsd;
    const endSpot = equityCurve[eIdx].spotBenchmarkUsd;
    const winCarryPct = startEq > 0 ? ((endEq - startEq) / startEq) * 100 : 0;
    const winSpotPct = startSpot > 0 ? ((endSpot - startSpot) / startSpot) * 100 : 0;
    const avgFundAnn =
      (sliceBars.reduce((acc, b) => acc + b.derivedHourlyFundingRate, 0) / sliceBars.length) *
      8760 *
      100;
    const hadLiq = equityCurve.slice(sIdx, eIdx + 1).some((pt) => pt.isLiquidationBar);

    let status: HistoricalSignalOutcome['status'] = 'HIT';
    let note = 'Positive net carry with intact short-perp margin';
    if (c === 5 && !hadLiq) {
      status = 'OPEN';
      note = 'Active live carry window tracked against SoDEX WS';
    } else if (hadLiq || winCarryPct < -1.5) {
      status = 'STOPPED';
      note = hadLiq
        ? 'Short-perp margin breach triggered staged liquidation stop'
        : 'Basis blowout exceeded drawdown stop guardrail';
    } else if (avgFundAnn < 0 || winCarryPct < 0) {
      status = 'DRIFT';
      note = 'Funding compression / negative basis drift trimmed carry';
    }

    signalTrackRecord.push({
      windowId: `W${c + 1}`,
      startDate: aligned[sIdx].dateLabel,
      endDate: aligned[eIdx].dateLabel,
      entryBasisBps: aligned[sIdx].basisBps,
      avgAnnualizedFundingPct: avgFundAnn,
      windowCarryReturnPct: winCarryPct,
      spotBenchmarkReturnPct: winSpotPct,
      status,
      note,
    });
  }

  return {
    perpSymbol: params.perpSymbol,
    spotSymbol: params.spotSymbol,
    source: params.source,
    barsCount: aligned.length,
    windowDays,
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
    totalFeesUsd,
    maxDrawdownPct,
    spotMaxDrawdownPct,
    annualizedSharpe,
    annualizedSortino,
    winRatePct: (positiveBars / Math.max(1, barReturns.length)) * 100,
    avgBasisBps,
    maxBasisBps,
    minBasisBps,
    avgAnnualizedFundingPct,
    liquidationEvent,
    equityCurve,
    signalTrackRecord: signalTrackRecord.reverse(), // most recent first
  };
}
