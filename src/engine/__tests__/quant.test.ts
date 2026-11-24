import { describe, expect, it } from 'vitest';
import {
  analyzeOrderBook,
  buildBasisOpportunities,
  computeDeltaNeutralCarry,
  computeOrderBookImpact,
  createSeededRng,
  HOURS_PER_YEAR,
  resolveMaintenanceMargin,
  runMonteCarloLiquidationStress,
  synthesizeDeskBrief,
} from '../quant';
import type { OrderBookSnapshot, PerpMarginTier } from '../../types/market';

const BTC_TIERS: PerpMarginTier[] = [
  { maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' },
  { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' },
];

describe('Deterministic PRNG & L2 Orderbook Microstructure', () => {
  it('produces identical sequence for identical seeds', () => {
    const a = createSeededRng(20261124);
    const b = createSeededRng(20261124);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it('computes exact VWAP fill and slippage across multi-level SoDEX L2 book', () => {
    const asks: [string, string][] = [
      ['60000', '0.5'], // $30,000
      ['60060', '1.0'], // $60,060
      ['60120', '2.0'], // $120,240
    ];
    const impact = computeOrderBookImpact(asks, 60000, 60000, 'BUY');
    expect(impact.fillRatio).toBe(1);
    // 30,000 @ 60,000 (0.5 BTC) + 30,000 @ 60,060 (0.4995004995 BTC) => VWAP ~ 60029.985
    expect(impact.vwapPrice).toBeCloseTo(60029.985, 2);
    expect(impact.slippageBps).toBeCloseTo(4.9975, 2);
    expect(impact.depthWithin50BpsUsd).toBeGreaterThan(200000);
  });

  it('calculates SoDEX official Impact Notional (200 * maxLeverage) and OBI', () => {
    const book: OrderBookSnapshot = {
      updateID: 1,
      bids: [
        ['60000', '2.0'],
        ['59990', '2.0'],
      ],
      asks: [
        ['60010', '1.0'],
        ['60020', '1.0'],
      ],
    };
    const metrics = analyzeOrderBook(book, 60005, 40);
    expect(metrics.impactNotionalUsd).toBe(8000);
    expect(metrics.spreadBps).toBeCloseTo((10 / 60005) * 10000, 3);
    expect(metrics.imbalance).toBeGreaterThan(0.3);
  });
});

describe('SoDEX Margin Tiers & Delta-Neutral Carry Engine', () => {
  it('resolves exact tiered maintenance margin with deduction', () => {
    const tier1 = resolveMaintenanceMargin(500_000, BTC_TIERS);
    expect(tier1.maintenanceMarginRate).toBe(0.0125);
    expect(tier1.maintenanceMarginUsd).toBeCloseTo(6250, 2);

    const tier2 = resolveMaintenanceMargin(10_000_000, BTC_TIERS);
    expect(tier2.maintenanceMarginRate).toBe(0.02);
    expect(tier2.maintenanceMarginUsd).toBeCloseTo(170_000, 2);
  });

  it('computes net carry APY, round-trip SoDEX fees, and liquidation buffer accurately', () => {
    const hourlyFundingRate = 0.00002; // 17.52% annualized
    const out = computeDeltaNeutralCarry({
      notionalPerLegUsd: 30_000,
      spotPrice: 60_000,
      perpMarkPrice: 60_060, // +10 bps basis
      hourlyFundingRate,
      leverage: 3,
      holdingDays: 30,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      spotSlippageBps: 1.0,
      perpSlippageBps: 1.0,
      marginTiers: BTC_TIERS,
    });

    expect(out.totalCapitalRequiredUsd).toBe(40_000); // 30k spot + 10k margin
    expect(out.annualizedFundingPct).toBeCloseTo(hourlyFundingRate * HOURS_PER_YEAR * 100, 4);
    expect(out.basisBps).toBeCloseTo(10, 3);
    expect(out.roundTripFeesUsd).toBeCloseTo(30_000 * 2 * (0.00035 + 0.00012), 4);
    expect(out.netProjectedPnlUsd).toBeGreaterThan(400);
    expect(out.netApyOnCapitalPct).toBeGreaterThan(10);
    // 3x margin = 33.33%, MMR = 1.25% => ~32.08% liquidation buffer
    expect(out.liquidationBufferPct).toBeCloseTo(32.083, 2);
    expect(out.perpLiquidationPrice).toBeGreaterThan(79_000);
  });

  it('ranks matched spot-perp opportunities descending by net carry APY', () => {
    const opps = buildBasisOpportunities(
      [
        {
          id: 1, name: 'BTC-USD', displayName: 'BTC-USD', baseCoin: 'BTC', quoteCoin: 'vUSDC',
          pricePrecision: 0, quantityPrecision: 5, maxLeverage: 40, initLeverage: 20,
          fundingInterval: 3600, interestRate: '0.0001', maxFundingRate: '0.04', minFundingRate: '-0.04',
          makerFee: '0.00012', takerFee: '0.0004', openInterestCapUSD: '200000000', marginTiers: BTC_TIERS, status: 'TRADING',
        },
        {
          id: 2, name: 'SOL-USD', displayName: 'SOL-USD', baseCoin: 'SOL', quoteCoin: 'vUSDC',
          pricePrecision: 2, quantityPrecision: 2, maxLeverage: 20, initLeverage: 10,
          fundingInterval: 3600, interestRate: '0.0001', maxFundingRate: '0.04', minFundingRate: '-0.04',
          makerFee: '0.00012', takerFee: '0.0004', openInterestCapUSD: '50000000', marginTiers: BTC_TIERS, status: 'TRADING',
        },
      ],
      [
        {
          symbol: 'BTC-USD', lastPx: '60050', openPx: '60000', highPx: '61000', lowPx: '59000',
          volume: '100', quoteVolume: '6000000', vwap: '60000', change: '50', changePct: 0.1,
          askPx: '60051', askSz: '1', bidPx: '60050', bidSz: '1', fundingRate: '0.00001',
          nextFundingTime: Date.now() + 1800000, indexPrice: '60040', markPrice: '60050', openInterest: '500',
        },
        {
          symbol: 'SOL-USD', lastPx: '72.1', openPx: '70', highPx: '73', lowPx: '69',
          volume: '10000', quoteVolume: '720000', vwap: '71', change: '2.1', changePct: 3.0,
          askPx: '72.15', askSz: '100', bidPx: '72.10', bidSz: '100', fundingRate: '0.000035',
          nextFundingTime: Date.now() + 1800000, indexPrice: '72.0', markPrice: '72.1', openInterest: '10000',
        },
      ],
      [
        { id: 1, name: 'vBTC_vUSDC', displayName: 'BTC/USDC', baseCoin: 'vBTC', quoteCoin: 'vUSDC', pricePrecision: 0, quantityPrecision: 5, makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING' },
        { id: 2, name: 'vSOL_vUSDC', displayName: 'SOL/USDC', baseCoin: 'vSOL', quoteCoin: 'vUSDC', pricePrecision: 2, quantityPrecision: 2, makerFee: '0.00035', takerFee: '0.00065', status: 'TRADING' },
      ],
      [
        { symbol: 'vBTC_vUSDC', lastPx: '60000', openPx: '60000', highPx: '61000', lowPx: '59000', volume: '5', quoteVolume: '300000', vwap: '60000', change: '0', changePct: 0, askPx: '60002', askSz: '1', bidPx: '59999', bidSz: '1' },
        { symbol: 'vSOL_vUSDC', lastPx: '72.0', openPx: '70', highPx: '73', lowPx: '69', volume: '500', quoteVolume: '36000', vwap: '71', change: '2', changePct: 2.8, askPx: '72.02', askSz: '10', bidPx: '71.98', bidSz: '10' },
      ],
      { 'BTC-USD': 0.55, 'SOL-USD': 0.85 },
    );

    expect(opps).toHaveLength(2);
    expect(opps[0].perpSymbol).toBe('SOL-USD');
    expect(opps[0].netCarryApyPct).toBeGreaterThan(opps[1].netCarryApyPct);
  });
});

describe('1,000-Path Deterministic Monte Carlo Liquidation Stress Engine', () => {
  it('is bitwise deterministic for the same seed and enforces VaR/CVaR ordering', () => {
    const baseParams = {
      seed: 424242,
      paths: 1000,
      horizonDays: 14,
      stepsPerDay: 4,
      notionalPerLegUsd: 50_000,
      leverage: 5,
      spotPrice: 60_000,
      perpPrice: 60_050,
      annualVolatility: 0.72,
      hourlyFundingRate: 0.000012,
      marginTiers: BTC_TIERS,
      roundTripFeeBps: 10,
      scenario: 'BASELINE' as const,
    };

    const runA = runMonteCarloLiquidationStress(baseParams);
    const runB = runMonteCarloLiquidationStress(baseParams);

    expect(runA.var99Usd).toBe(runB.var99Usd);
    expect(runA.cvar99Usd).toBe(runB.cvar99Usd);
    expect(runA.liquidatedPaths).toBe(runB.liquidatedPaths);
    expect(runA.fanChart).toHaveLength(15);
    expect(runA.histogram).toHaveLength(16);
    expect(runA.var99Usd).toBeGreaterThanOrEqual(runA.var95Usd);
    expect(runA.cvar99Usd).toBeGreaterThanOrEqual(runA.var99Usd);
  });

  it('produces strictly higher liquidation risk at 15x leverage vs 2x under basis blowout', () => {
    const lowLev = runMonteCarloLiquidationStress({
      seed: 99,
      paths: 1000,
      horizonDays: 14,
      stepsPerDay: 4,
      notionalPerLegUsd: 50_000,
      leverage: 2,
      spotPrice: 60_000,
      perpPrice: 60_050,
      annualVolatility: 0.78,
      hourlyFundingRate: 0.00001,
      marginTiers: BTC_TIERS,
      roundTripFeeBps: 10,
      scenario: 'BASIS_BLOWOUT',
    });

    const highLev = runMonteCarloLiquidationStress({
      seed: 99,
      paths: 1000,
      horizonDays: 14,
      stepsPerDay: 4,
      notionalPerLegUsd: 50_000,
      leverage: 15,
      spotPrice: 60_000,
      perpPrice: 60_050,
      annualVolatility: 0.78,
      hourlyFundingRate: 0.00001,
      marginTiers: BTC_TIERS,
      roundTripFeeBps: 10,
      scenario: 'BASIS_BLOWOUT',
    });

    expect(highLev.liquidationProbabilityPct).toBeGreaterThan(lowLev.liquidationProbabilityPct);
    expect(highLev.var99Pct).toBeGreaterThan(lowLev.var99Pct);
  });

  it('classifies ETF flow & funding regimes accurately in Desk Brief synthesizer', () => {
    const brief = synthesizeDeskBrief(
      [
        {
          baseCoin: 'BTC', perpSymbol: 'BTC-USD', spotSymbol: 'vBTC_vUSDC',
          spotPrice: 60000, perpMarkPrice: 60050, indexPrice: 60030, basisBps: 8.3,
          hourlyFundingRate: 0.00002, annualizedFundingPct: 17.52, nextFundingTime: 0,
          openInterestUsd: 58000000, volume24hUsd: 220000000, changePct24h: 1.2,
          maxLeverage: 40, makerFeeBps: 1.2, takerFeeBps: 4.0, spotTakerFeeBps: 6.5,
          netCarryApyPct: 12.8, breakevenDays: 3.2, strategySide: 'LONG_SPOT_SHORT_PERP', realizedVol: 0.55,
        },
      ],
      [
        { date: '2026-11-23', total_net_inflow: 250_000_000, total_value_traded: 3e9, total_net_assets: 90e9, cum_net_inflow: 38e9 },
        { date: '2026-11-20', total_net_inflow: 180_000_000, total_value_traded: 3e9, total_net_assets: 90e9, cum_net_inflow: 37e9 },
      ],
      [
        { date: '2026-11-23', total_net_inflow: 60_000_000, total_value_traded: 5e8, total_net_assets: 11e9, cum_net_inflow: 4e9 },
      ],
    );

    expect(brief.regime).toBe('RISK_ON_CARRY');
    expect(brief.etfPositiveStreakDays).toBe(2);
    expect(brief.convictionScore).toBeGreaterThanOrEqual(80);
  });
});
