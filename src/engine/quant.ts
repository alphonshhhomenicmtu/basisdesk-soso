import type {
  BasisOpportunity,
  EtfDailyFlow,
  OrderBookLevel,
  OrderBookSnapshot,
  PerpMarginTier,
  PerpSymbolSpec,
  PerpTicker,
  SpotSymbolSpec,
  SpotTicker,
} from '../types/market';

export const HOURS_PER_YEAR = 8760;

export interface OrderBookImpactResult {
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  fillRatio: number;
  vwapPrice: number;
  midPrice: number;
  slippageBps: number;
  depthWithin50BpsUsd: number;
}

export interface OrderBookMetrics {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  imbalance: number; // [-1, 1]
  impactNotionalUsd: number;
  impactBidPrice: number;
  impactAskPrice: number;
  impliedPremiumBps: number;
}

export interface DeltaNeutralCarryInput {
  notionalPerLegUsd: number;
  spotPrice: number;
  perpMarkPrice: number;
  hourlyFundingRate: number;
  leverage: number;
  holdingDays: number;
  executionMode: 'MAKER' | 'TAKER';
  spotMakerFee: number;
  spotTakerFee: number;
  perpMakerFee: number;
  perpTakerFee: number;
  spotSlippageBps: number;
  perpSlippageBps: number;
  marginTiers: PerpMarginTier[];
}

export interface DeltaNeutralCarryOutput {
  totalCapitalRequiredUsd: number;
  spotCapitalUsd: number;
  perpMarginUsd: number;
  effectivePortfolioLeverage: number;
  basisBps: number;
  annualizedFundingPct: number;
  expectedFundingIncomeUsd: number;
  basisConvergenceUsd: number;
  roundTripFeesUsd: number;
  estimatedSlippageUsd: number;
  totalFrictionUsd: number;
  netProjectedPnlUsd: number;
  netApyOnCapitalPct: number;
  breakevenDays: number;
  maintenanceMarginUsd: number;
  maintenanceMarginRate: number;
  perpLiquidationPrice: number;
  liquidationBufferPct: number;
}

export type StressScenarioId =
  | 'BASELINE'
  | 'FLASH_CRASH_25'
  | 'FUNDING_INVERSION'
  | 'BASIS_BLOWOUT';

export interface MonteCarloParams {
  seed: number;
  paths: number;
  horizonDays: number;
  stepsPerDay: number;
  notionalPerLegUsd: number;
  leverage: number;
  spotPrice: number;
  perpPrice: number;
  annualVolatility: number;
  hourlyFundingRate: number;
  marginTiers: PerpMarginTier[];
  roundTripFeeBps: number;
  scenario: StressScenarioId;
}

export interface FanChartPoint {
  day: number;
  label: string;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

export interface HistogramBin {
  fromPct: number;
  toPct: number;
  label: string;
  count: number;
  isLoss: boolean;
}

export interface MonteCarloResult {
  paths: number;
  seed: number;
  scenario: StressScenarioId;
  totalCapitalUsd: number;
  expectedPnlUsd: number;
  expectedReturnPct: number;
  medianReturnPct: number;
  var95Usd: number;
  var99Usd: number;
  cvar95Usd: number;
  cvar99Usd: number;
  var95Pct: number;
  var99Pct: number;
  liquidationProbabilityPct: number;
  liquidatedPaths: number;
  medianTimeToLiquidationHours: number | null;
  worstDrawdownPct: number;
  annualizedSharpeProxy: number;
  fanChart: FanChartPoint[];
  histogram: HistogramBin[];
}

export interface DeskSignalThesis {
  id: string;
  regime: 'RISK_ON_CARRY' | 'SELECTIVE_BASIS' | 'DEFENSIVE_HEDGE';
  headline: string;
  rationale: string;
  recommendedPair: string;
  expectedNetApyPct: number;
  convictionScore: number; // 0-100
  etfFlow5dUsd: number;
  etfPositiveStreakDays: number;
  topCarrySymbol: string;
  riskFlags: string[];
}

/**
 * Deterministic seeded PRNG (Mulberry32) so Monte Carlo outputs are 100% reproducible and testable.
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller standard normal sample from deterministic uniform PRNG.
 */
export function sampleNormal(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];
  const clamped = Math.min(1, Math.max(0, p));
  const idx = clamped * (sortedValues.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const weight = idx - lo;
  return sortedValues[lo] * (1 - weight) + sortedValues[hi] * weight;
}

/**
 * Walks an L2 orderbook side ([price, qty][]) to compute exact VWAP fill and slippage.
 */
export function computeOrderBookImpact(
  levels: OrderBookLevel[],
  targetNotionalUsd: number,
  midPrice: number,
  side: 'BUY' | 'SELL',
): OrderBookImpactResult {
  if (!levels.length || midPrice <= 0 || targetNotionalUsd <= 0) {
    return {
      requestedNotionalUsd: targetNotionalUsd,
      filledNotionalUsd: 0,
      fillRatio: 0,
      vwapPrice: midPrice,
      midPrice,
      slippageBps: 0,
      depthWithin50BpsUsd: 0,
    };
  }

  let remainingUsd = targetNotionalUsd;
  let filledUsd = 0;
  let totalQty = 0;
  let depthWithin50BpsUsd = 0;

  for (const [pxStr, qtyStr] of levels) {
    const px = Number(pxStr);
    const qty = Number(qtyStr);
    if (!Number.isFinite(px) || !Number.isFinite(qty) || px <= 0 || qty <= 0) continue;

    const levelNotional = px * qty;
    const distBps = (Math.abs(px - midPrice) / midPrice) * 10000;
    if (distBps <= 50) {
      depthWithin50BpsUsd += levelNotional;
    }

    if (remainingUsd > 0) {
      const takeUsd = Math.min(remainingUsd, levelNotional);
      filledUsd += takeUsd;
      totalQty += takeUsd / px;
      remainingUsd -= takeUsd;
    }
  }

  const vwapPrice = totalQty > 0 ? filledUsd / totalQty : midPrice;
  const rawSlip =
    side === 'BUY'
      ? ((vwapPrice - midPrice) / midPrice) * 10000
      : ((midPrice - vwapPrice) / midPrice) * 10000;

  // If depth was exhausted before filling full target, add conservative book-tail penalty
  const fillRatio = Math.min(1, filledUsd / targetNotionalUsd);
  const unfilledPenaltyBps = fillRatio < 1 ? (1 - fillRatio) * 18 : 0;

  return {
    requestedNotionalUsd: targetNotionalUsd,
    filledNotionalUsd: filledUsd,
    fillRatio,
    vwapPrice,
    midPrice,
    slippageBps: Math.max(0, rawSlip + unfilledPenaltyBps),
    depthWithin50BpsUsd,
  };
}

/**
 * Computes SoDEX L2 microstructure metrics including official Impact Notional = 200 * maxLeverage.
 */
export function analyzeOrderBook(
  book: OrderBookSnapshot | undefined,
  oraclePrice: number,
  maxLeverage: number,
): OrderBookMetrics {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const bestBid = bids.length ? Number(bids[0][0]) : oraclePrice;
  const bestAsk = asks.length ? Number(asks[0][0]) : oraclePrice;
  const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : oraclePrice;
  const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

  const bidDepthUsd = bids.reduce((acc, [p, q]) => acc + Number(p) * Number(q), 0);
  const askDepthUsd = asks.reduce((acc, [p, q]) => acc + Number(p) * Number(q), 0);
  const totalDepth = bidDepthUsd + askDepthUsd;
  const imbalance = totalDepth > 0 ? (bidDepthUsd - askDepthUsd) / totalDepth : 0;

  const impactNotionalUsd = 200 * Math.max(1, maxLeverage);
  const impactBid = computeOrderBookImpact(bids, impactNotionalUsd, midPrice, 'SELL');
  const impactAsk = computeOrderBookImpact(asks, impactNotionalUsd, midPrice, 'BUY');

  // Official SoDEX funding premium numerator:
  // max(0, ImpactBid - Oracle) - max(0, Oracle - ImpactAsk)
  const refOracle = oraclePrice > 0 ? oraclePrice : midPrice;
  const impactDiff =
    Math.max(0, impactBid.vwapPrice - refOracle) - Math.max(0, refOracle - impactAsk.vwapPrice);
  const impliedPremiumBps = refOracle > 0 ? (impactDiff / refOracle) * 10000 : 0;

  return {
    bestBid,
    bestAsk,
    midPrice,
    spreadBps,
    bidDepthUsd,
    askDepthUsd,
    imbalance,
    impactNotionalUsd,
    impactBidPrice: impactBid.vwapPrice,
    impactAskPrice: impactAsk.vwapPrice,
    impliedPremiumBps,
  };
}

/**
 * Evaluates SoDEX tiered maintenance margin: MMR * Notional - Maintenance Deduction.
 */
export function resolveMaintenanceMargin(
  notionalUsd: number,
  tiers: PerpMarginTier[],
): { maintenanceMarginUsd: number; maintenanceMarginRate: number; tierMaxLeverage: number } {
  if (!tiers.length || notionalUsd <= 0) {
    return { maintenanceMarginUsd: notionalUsd * 0.0125, maintenanceMarginRate: 0.0125, tierMaxLeverage: 20 };
  }

  const sorted = [...tiers].sort(
    (a, b) => Number(a.maxNotionalValue) - Number(b.maxNotionalValue),
  );
  const matched =
    sorted.find((t) => notionalUsd <= Number(t.maxNotionalValue)) ?? sorted[sorted.length - 1];
  const mmr = Number(matched.maintenanceMarginRate);
  const deduction = Number(matched.maintenanceDeduction || 0);
  const maintenanceMarginUsd = Math.max(0, notionalUsd * mmr - deduction);

  return {
    maintenanceMarginUsd,
    maintenanceMarginRate: mmr,
    tierMaxLeverage: matched.maxLeverage,
  };
}

/**
 * Core Delta-Neutral Cash-and-Carry calculator (Long SoDEX Spot + Short SoDEX Perp).
 * Uses SoDEX's exact 1-hour funding schedule (8,760 intervals/year) and fee structure.
 */
export function computeDeltaNeutralCarry(
  input: DeltaNeutralCarryInput,
): DeltaNeutralCarryOutput {
  const leverage = Math.max(1, input.leverage);
  const notional = Math.max(10, input.notionalPerLegUsd);
  const holdingDays = Math.max(1, input.holdingDays);

  const spotCapitalUsd = notional;
  const perpMarginUsd = notional / leverage;
  const totalCapitalRequiredUsd = spotCapitalUsd + perpMarginUsd;
  const effectivePortfolioLeverage = (notional * 2) / totalCapitalRequiredUsd;

  const basisBps =
    input.spotPrice > 0
      ? ((input.perpMarkPrice - input.spotPrice) / input.spotPrice) * 10000
      : 0;
  const annualizedFundingPct = input.hourlyFundingRate * HOURS_PER_YEAR * 100;

  // Short perp earns positive hourly funding (paid 24 times/day)
  const expectedFundingIncomeUsd = notional * input.hourlyFundingRate * 24 * holdingDays;
  // Assume partial basis capture (50% convergence toward zero basis on exit)
  const basisConvergenceUsd = notional * (basisBps / 10000) * 0.5;

  const spotFeeRate = input.executionMode === 'MAKER' ? input.spotMakerFee : input.spotTakerFee;
  const perpFeeRate = input.executionMode === 'MAKER' ? input.perpMakerFee : input.perpTakerFee;
  // Round-trip = entry + exit on both spot and perp legs
  const roundTripFeesUsd = notional * 2 * (spotFeeRate + perpFeeRate);
  const estimatedSlippageUsd =
    notional * 2 * ((input.spotSlippageBps + input.perpSlippageBps) / 10000);
  const totalFrictionUsd = roundTripFeesUsd + estimatedSlippageUsd;

  const netProjectedPnlUsd = expectedFundingIncomeUsd + basisConvergenceUsd - totalFrictionUsd;
  const netApyOnCapitalPct =
    totalCapitalRequiredUsd > 0
      ? (netProjectedPnlUsd / totalCapitalRequiredUsd) * (365 / holdingDays) * 100
      : 0;

  const dailyFundingUsd = notional * input.hourlyFundingRate * 24;
  const breakevenDays = dailyFundingUsd > 0 ? totalFrictionUsd / dailyFundingUsd : Infinity;

  // Short perp liquidation calculation:
  // Equity = perpMargin - qty * (mark - entryPerp) = maintenanceMargin
  // => mark_liq = entryPerp * (1 + (perpMargin - maintenanceMargin) / notional)
  const { maintenanceMarginUsd, maintenanceMarginRate } = resolveMaintenanceMargin(
    notional,
    input.marginTiers,
  );
  const usableBufferUsd = Math.max(0, perpMarginUsd - maintenanceMarginUsd);
  const liquidationBufferPct = (usableBufferUsd / notional) * 100;
  const perpLiquidationPrice = input.perpMarkPrice * (1 + usableBufferUsd / notional);

  return {
    totalCapitalRequiredUsd,
    spotCapitalUsd,
    perpMarginUsd,
    effectivePortfolioLeverage,
    basisBps,
    annualizedFundingPct,
    expectedFundingIncomeUsd,
    basisConvergenceUsd,
    roundTripFeesUsd,
    estimatedSlippageUsd,
    totalFrictionUsd,
    netProjectedPnlUsd,
    netApyOnCapitalPct,
    breakevenDays,
    maintenanceMarginUsd,
    maintenanceMarginRate,
    perpLiquidationPrice,
    liquidationBufferPct,
  };
}

/**
 * Matches SoDEX live Perp tickers with SoDEX live Spot tickers to produce the Basis Carry Scanner.
 */
export function buildBasisOpportunities(
  perpSymbols: PerpSymbolSpec[],
  perpTickers: PerpTicker[],
  spotSymbols: SpotSymbolSpec[],
  spotTickers: SpotTicker[],
  realizedVolMap: Record<string, number>,
): BasisOpportunity[] {
  const perpSpecMap = new Map(perpSymbols.map((s) => [s.name, s]));
  const spotSpecMap = new Map(spotSymbols.map((s) => [s.name, s]));
  const spotTickerMap = new Map(spotTickers.map((t) => [t.symbol, t]));

  const results: BasisOpportunity[] = [];

  for (const pt of perpTickers) {
    const spec = perpSpecMap.get(pt.symbol);
    const baseCoin = spec?.baseCoin ?? pt.symbol.replace('-USD', '');
    const spotKey = `v${baseCoin}_vUSDC`;
    const st = spotTickerMap.get(spotKey);
    if (!st) continue;

    const spotPrice = Number(st.lastPx) || Number(st.bidPx) || 0;
    const perpMarkPrice = Number(pt.markPrice) || Number(pt.lastPx) || 0;
    const indexPrice = Number(pt.indexPrice) || perpMarkPrice;
    if (spotPrice <= 0 || perpMarkPrice <= 0) continue;

    const hourlyFundingRate = Number(pt.fundingRate) || 0;
    const spotSpec = spotSpecMap.get(spotKey);
    const makerFee = Number(spec?.makerFee ?? '0.00012');
    const takerFee = Number(spec?.takerFee ?? '0.0004');
    const spotMakerFee = Number(spotSpec?.makerFee ?? '0.00035');
    const spotTakerFee = Number(spotSpec?.takerFee ?? '0.00065');

    const carry = computeDeltaNeutralCarry({
      notionalPerLegUsd: 25000,
      spotPrice,
      perpMarkPrice,
      hourlyFundingRate,
      leverage: 3,
      holdingDays: 30,
      executionMode: 'MAKER',
      spotMakerFee,
      spotTakerFee,
      perpMakerFee: makerFee,
      perpTakerFee: takerFee,
      spotSlippageBps: 1.5,
      perpSlippageBps: 1.0,
      marginTiers: spec?.marginTiers ?? [],
    });

    const openInterestUsd = (Number(pt.openInterest) || 0) * perpMarkPrice;
    const volume24hUsd = Number(pt.quoteVolume) || 0;

    results.push({
      baseCoin,
      perpSymbol: pt.symbol,
      spotSymbol: spotKey,
      spotPrice,
      perpMarkPrice,
      indexPrice,
      basisBps: carry.basisBps,
      hourlyFundingRate,
      annualizedFundingPct: carry.annualizedFundingPct,
      nextFundingTime: pt.nextFundingTime,
      openInterestUsd,
      volume24hUsd,
      changePct24h: Number(pt.changePct) || 0,
      maxLeverage: spec?.maxLeverage ?? 20,
      makerFeeBps: makerFee * 10000,
      takerFeeBps: takerFee * 10000,
      spotTakerFeeBps: spotTakerFee * 10000,
      netCarryApyPct: carry.netApyOnCapitalPct,
      breakevenDays: carry.breakevenDays,
      strategySide: hourlyFundingRate >= 0 ? 'LONG_SPOT_SHORT_PERP' : 'REVERSE_CARRY_WATCH',
      realizedVol: realizedVolMap[pt.symbol] ?? 0.65,
    });
  }

  return results.sort((a, b) => b.netCarryApyPct - a.netCarryApyPct);
}

/**
 * 1,000-Path Deterministic Seeded Monte Carlo Liquidation & VaR/CVaR Stress Engine.
 *
 * Models coupled Spot GBM + Fat-Tail Jumps + Mean-Reverting Basis Blowout +
 * Mean-Reverting Hourly Funding Rate Process on a hedged Long Spot + Short Perp position.
 * Tracks perp margin equity at every step against SoDEX's exact maintenance margin tier,
 * capturing liquidation penalty and unhedged residual spot exposure after a perp leg stop-out.
 */
export function runMonteCarloLiquidationStress(
  params: MonteCarloParams,
): MonteCarloResult {
  const rng = createSeededRng(params.seed);
  const paths = Math.max(100, Math.min(5000, Math.round(params.paths)));
  const horizonDays = Math.max(1, Math.round(params.horizonDays));
  const stepsPerDay = Math.max(1, Math.round(params.stepsPerDay));
  const totalSteps = horizonDays * stepsPerDay;
  const dtYears = 1 / (365 * stepsPerDay);
  const hoursPerStep = 24 / stepsPerDay;

  const notional = Math.max(100, params.notionalPerLegUsd);
  const leverage = Math.max(1, params.leverage);
  const spotCapital = notional;
  const initialPerpMargin = notional / leverage;
  const totalCapitalUsd = spotCapital + initialPerpMargin;
  const baseQty = notional / Math.max(1e-8, params.spotPrice);
  const entryFeesUsd = notional * (params.roundTripFeeBps / 10000);

  // Scenario calibration overrides
  let volMultiplier = 1.0;
  let jumpIntensityPerYear = 4.0;
  let jumpMean = -0.02;
  let jumpStd = 0.055;
  let fundingDriftShift = 0;
  let basisShockBps = 0;
  let basisVolBpsPerSqrtDay = 14;
  let initialGapPct = 0;

  if (params.scenario === 'FLASH_CRASH_25') {
    volMultiplier = 1.55;
    jumpIntensityPerYear = 14.0;
    jumpMean = -0.06;
    jumpStd = 0.09;
    basisShockBps = 95;
    basisVolBpsPerSqrtDay = 32;
    initialGapPct = -0.22;
  } else if (params.scenario === 'FUNDING_INVERSION') {
    volMultiplier = 1.15;
    fundingDriftShift = -0.000035; // ~ -30.7% annualized funding flip
    basisShockBps = -55;
    basisVolBpsPerSqrtDay = 20;
  } else if (params.scenario === 'BASIS_BLOWOUT') {
    volMultiplier = 1.35;
    jumpIntensityPerYear = 9.0;
    jumpMean = 0.045; // sharp upside squeeze hurts leveraged short perp leg!
    jumpStd = 0.075;
    basisShockBps = 180; // +1.8% perp premium blowout
    basisVolBpsPerSqrtDay = 42;
  }

  const sigma = Math.max(0.1, params.annualVolatility * volMultiplier);
  const initialBasis =
    params.spotPrice > 0 ? (params.perpPrice - params.spotPrice) / params.spotPrice : 0;

  // Store daily portfolio equity values for percentile fan chart
  const dailyEquityMatrix: number[][] = Array.from({ length: horizonDays + 1 }, () =>
    new Array<number>(paths),
  );
  const terminalPnls: number[] = new Array<number>(paths);
  const liquidationHours: number[] = [];
  let maxDrawdownAcrossPaths = 0;

  for (let p = 0; p < paths; p++) {
    let spot = params.spotPrice * (1 + initialGapPct);
    let basis = initialBasis + basisShockBps / 10000;
    let fundingRate = params.hourlyFundingRate + fundingDriftShift;
    let perpMarginEquity = initialPerpMargin - entryFeesUsd * 0.5;
    let spotFeePaid = entryFeesUsd * 0.5;
    let perpLiquidated = false;
    let peakEquity = totalCapitalUsd;
    let pathMaxDd = 0;

    dailyEquityMatrix[0][p] = totalCapitalUsd;

    for (let step = 1; step <= totalSteps; step++) {
      // 1. Spot GBM + jump-diffusion step
      const zSpot = sampleNormal(rng);
      const jumpProb = Math.min(0.45, jumpIntensityPerYear * dtYears);
      const jump = rng() < jumpProb ? jumpMean + jumpStd * sampleNormal(rng) : 0;
      const logMove = -0.5 * sigma * sigma * dtYears + sigma * Math.sqrt(dtYears) * zSpot + jump;
      spot = Math.max(params.spotPrice * 0.05, spot * Math.exp(logMove));

      // 2. Mean-reverting basis spread (OU process) coupled weakly with sharp upside moves
      const basisReversion = 0.35 * (0 - basis) * (hoursPerStep / 24);
      const basisNoise =
        (basisVolBpsPerSqrtDay / 10000) * Math.sqrt(hoursPerStep / 24) * sampleNormal(rng);
      const squeezeImpulse = logMove > 0.05 ? logMove * 0.14 : 0;
      basis = Math.max(-0.08, Math.min(0.12, basis + basisReversion + basisNoise + squeezeImpulse));

      const perpMark = spot * (1 + basis);

      // 3. Mean-reverting hourly funding process (OU)
      const longRunFunding = params.hourlyFundingRate * 0.65 + fundingDriftShift;
      const fundingNoise = 0.000018 * Math.sqrt(hoursPerStep) * sampleNormal(rng);
      fundingRate = Math.max(
        -0.0008,
        Math.min(0.0008, fundingRate + 0.08 * (longRunFunding - fundingRate) + fundingNoise),
      );

      // 4. Update short perp equity & check SoDEX maintenance margin
      if (!perpLiquidated) {
        // Short perp funding cashflow (+ when funding > 0)
        const fundingPayment = baseQty * spot * fundingRate * hoursPerStep;
        perpMarginEquity += fundingPayment;

        const unrealizedPerpPnl = baseQty * (params.perpPrice - perpMark);
        const livePerpEquity = perpMarginEquity + unrealizedPerpPnl;
        const currentNotional = baseQty * perpMark;
        const { maintenanceMarginUsd } = resolveMaintenanceMargin(
          currentNotional,
          params.marginTiers,
        );

        if (livePerpEquity <= maintenanceMarginUsd) {
          perpLiquidated = true;
          liquidationHours.push(step * hoursPerStep);
          // Staged liquidation consumes maintenance margin plus backstop slippage penalty
          perpMarginEquity = Math.max(0, livePerpEquity - currentNotional * 0.008);
        }
      }

      // Compute total portfolio value (Spot position + Perp account equity)
      const spotValue = baseQty * spot - spotFeePaid;
      const livePerpAccount = perpLiquidated
        ? perpMarginEquity
        : perpMarginEquity + baseQty * (params.perpPrice - perpMark);
      const totalEquity = Math.max(0, spotValue + livePerpAccount);

      if (totalEquity > peakEquity) peakEquity = totalEquity;
      const dd = peakEquity > 0 ? ((peakEquity - totalEquity) / peakEquity) * 100 : 0;
      if (dd > pathMaxDd) pathMaxDd = dd;

      if (step % stepsPerDay === 0) {
        const dayIndex = step / stepsPerDay;
        dailyEquityMatrix[dayIndex][p] = totalEquity;
      }
    }

    if (pathMaxDd > maxDrawdownAcrossPaths) {
      maxDrawdownAcrossPaths = pathMaxDd;
    }

    const finalEquity = dailyEquityMatrix[horizonDays][p];
    terminalPnls[p] = finalEquity - totalCapitalUsd;
  }

  const sortedPnls = [...terminalPnls].sort((a, b) => a - b);
  const meanPnl = terminalPnls.reduce((a, b) => a + b, 0) / paths;
  const medianPnl = percentile(sortedPnls, 0.5);

  const p05Pnl = percentile(sortedPnls, 0.05);
  const p01Pnl = percentile(sortedPnls, 0.01);
  const var95Usd = Math.max(0, -p05Pnl);
  const var99Usd = Math.max(0, -p01Pnl);

  const tail95Count = Math.max(1, Math.floor(paths * 0.05));
  const tail99Count = Math.max(1, Math.floor(paths * 0.01));
  const avgTail95 =
    sortedPnls.slice(0, tail95Count).reduce((a, b) => a + b, 0) / tail95Count;
  const avgTail99 =
    sortedPnls.slice(0, tail99Count).reduce((a, b) => a + b, 0) / tail99Count;
  const cvar95Usd = Math.max(0, -avgTail95);
  const cvar99Usd = Math.max(0, -avgTail99);

  const returnSamples = terminalPnls.map((x) => x / totalCapitalUsd);
  const meanRet = returnSamples.reduce((a, b) => a + b, 0) / paths;
  const retVar =
    returnSamples.reduce((acc, r) => acc + (r - meanRet) ** 2, 0) / Math.max(1, paths - 1);
  const retStd = Math.sqrt(retVar);
  const annualizedSharpeProxy =
    retStd > 1e-9 ? (meanRet / retStd) * Math.sqrt(365 / horizonDays) : 0;

  const sortedLiqHours = [...liquidationHours].sort((a, b) => a - b);
  const medianTimeToLiquidationHours =
    sortedLiqHours.length > 0 ? percentile(sortedLiqHours, 0.5) : null;

  // Build fan chart curve
  const fanChart: FanChartPoint[] = [];
  for (let day = 0; day <= horizonDays; day++) {
    const col = [...dailyEquityMatrix[day]].sort((a, b) => a - b);
    fanChart.push({
      day,
      label: day === 0 ? 'T0' : `D${day}`,
      p5: percentile(col, 0.05),
      p25: percentile(col, 0.25),
      p50: percentile(col, 0.5),
      p75: percentile(col, 0.75),
      p95: percentile(col, 0.95),
    });
  }

  // Build 16-bin terminal return histogram clipped to P1..P99 for clean visuals
  const pctReturns = sortedPnls.map((pnl) => (pnl / totalCapitalUsd) * 100);
  const minBin = Math.min(-2, Math.floor(percentile(pctReturns, 0.01)));
  const maxBin = Math.max(2, Math.ceil(percentile(pctReturns, 0.99)));
  const binCount = 16;
  const binWidth = Math.max(0.25, (maxBin - minBin) / binCount);
  const histogram: HistogramBin[] = Array.from({ length: binCount }, (_, i) => {
    const fromPct = minBin + i * binWidth;
    const toPct = fromPct + binWidth;
    return {
      fromPct,
      toPct,
      label: `${fromPct >= 0 ? '+' : ''}${fromPct.toFixed(1)}%`,
      count: 0,
      isLoss: (fromPct + toPct) / 2 < 0,
    };
  });

  for (const r of pctReturns) {
    const rawIdx = Math.floor((r - minBin) / binWidth);
    const idx = Math.max(0, Math.min(binCount - 1, rawIdx));
    histogram[idx].count += 1;
  }

  return {
    paths,
    seed: params.seed,
    scenario: params.scenario,
    totalCapitalUsd,
    expectedPnlUsd: meanPnl,
    expectedReturnPct: (meanPnl / totalCapitalUsd) * 100,
    medianReturnPct: (medianPnl / totalCapitalUsd) * 100,
    var95Usd,
    var99Usd,
    cvar95Usd,
    cvar99Usd,
    var95Pct: (var95Usd / totalCapitalUsd) * 100,
    var99Pct: (var99Usd / totalCapitalUsd) * 100,
    liquidationProbabilityPct: (liquidationHours.length / paths) * 100,
    liquidatedPaths: liquidationHours.length,
    medianTimeToLiquidationHours,
    worstDrawdownPct: maxDrawdownAcrossPaths,
    annualizedSharpeProxy,
    fanChart,
    histogram,
  };
}

/**
 * Synthesizes an actionable Quant Desk Brief fusing SoSoValue ETF flows + live SoDEX carry metrics.
 */
export function synthesizeDeskBrief(
  opportunities: BasisOpportunity[],
  btcEtfHistory: EtfDailyFlow[],
  ethEtfHistory: EtfDailyFlow[],
): DeskSignalThesis {
  const recent5Btc = btcEtfHistory.slice(0, 5);
  const recent5Eth = ethEtfHistory.slice(0, 5);
  const etfFlow5dUsd =
    recent5Btc.reduce((acc, d) => acc + Number(d.total_net_inflow || 0), 0) +
    recent5Eth.reduce((acc, d) => acc + Number(d.total_net_inflow || 0), 0);

  let streak = 0;
  for (const row of btcEtfHistory) {
    if (Number(row.total_net_inflow) > 0) streak++;
    else break;
  }

  const topOpp = opportunities[0];
  const positiveCount = opportunities.filter((o) => o.hourlyFundingRate > 0).length;
  const positiveBreadth = opportunities.length > 0 ? positiveCount / opportunities.length : 0;

  let regime: DeskSignalThesis['regime'] = 'SELECTIVE_BASIS';
  if (etfFlow5dUsd > 350_000_000 && positiveBreadth >= 0.55) {
    regime = 'RISK_ON_CARRY';
  } else if (etfFlow5dUsd < -150_000_000 || positiveBreadth < 0.35) {
    regime = 'DEFENSIVE_HEDGE';
  }

  const topCarrySymbol = topOpp?.perpSymbol ?? 'BTC-USD';
  const expectedNetApyPct = topOpp?.netCarryApyPct ?? 0;

  const riskFlags: string[] = [];
  if (topOpp && topOpp.breakevenDays > 14) {
    riskFlags.push(`Fee recovery requires ${topOpp.breakevenDays.toFixed(1)}d at current funding`);
  }
  if (topOpp && Math.abs(topOpp.basisBps) > 25) {
    riskFlags.push(`Elevated spot-perp basis dispersion (${topOpp.basisBps.toFixed(1)} bps)`);
  }
  if (positiveBreadth < 0.5) {
    riskFlags.push('Mixed hourly funding across ValueChain perps — prefer maker limit fills');
  }
  if (riskFlags.length === 0) {
    riskFlags.push('Healthy L2 depth & positive ETF inflow impulse support 3x hedged carry');
  }

  const convictionBase =
    regime === 'RISK_ON_CARRY' ? 82 : regime === 'SELECTIVE_BASIS' ? 68 : 49;
  const convictionScore = Math.min(
    96,
    Math.max(35, Math.round(convictionBase + Math.min(12, Math.max(-10, expectedNetApyPct * 0.5)))),
  );

  const flowLabel = `${etfFlow5dUsd >= 0 ? '+' : '-'}$${(Math.abs(etfFlow5dUsd) / 1e6).toFixed(1)}M`;
  const headline =
    regime === 'RISK_ON_CARRY'
      ? `Positive Institutional Inflow Regime (${flowLabel} 5D ETF) — Harvest ${topCarrySymbol} Carry`
      : regime === 'SELECTIVE_BASIS'
        ? `Selective Carry Regime (${flowLabel} 5D ETF) — Target Maker-Only ${topCarrySymbol} Spread`
        : `Defensive Basis Regime (${flowLabel} 5D ETF) — Favor USSI / Low-Leverage Hedging`;

  const rationale = topOpp
    ? `SoSoValue US Spot BTC+ETH ETF flows total ${flowLabel} over 5 sessions (${streak}d BTC inflow streak). On SoDEX Mainnet, ${positiveCount}/${opportunities.length} paired perp markets print positive hourly funding, led by ${topOpp.perpSymbol} at ${topOpp.annualizedFundingPct.toFixed(2)}% annualized (${topOpp.netCarryApyPct.toFixed(2)}% net carry APY on 3x hedged capital with ${topOpp.basisBps.toFixed(1)} bps live basis).`
    : 'Awaiting matched SoDEX spot and perpetual telemetry to rank hedged carry spreads.';

  return {
    id: `thesis-${topCarrySymbol}-${regime}`,
    regime,
    headline,
    rationale,
    recommendedPair: topCarrySymbol,
    expectedNetApyPct,
    convictionScore,
    etfFlow5dUsd,
    etfPositiveStreakDays: streak,
    topCarrySymbol,
    riskFlags,
  };
}
