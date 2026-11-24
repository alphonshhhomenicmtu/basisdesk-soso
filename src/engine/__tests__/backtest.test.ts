import { describe, expect, it } from 'vitest';
import {
  alignKlinePairs,
  computeSodexHourlyFundingFromBasis,
  generateDeterministicFallbackKlines,
  runHistoricalBasisBacktest,
} from '../backtest';
import type { KlineBar, PerpMarginTier } from '../../types/market';

const BTC_TIERS: PerpMarginTier[] = [
  { maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' },
  { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' },
];

function makeBars(prices: Array<{ t: number; spot: number; perp: number; perpHigh?: number }>): {
  perpBars: KlineBar[];
  spotBars: KlineBar[];
} {
  return {
    spotBars: prices.map((p) => ({
      t: p.t,
      o: p.spot.toFixed(2),
      h: (p.spot * 1.004).toFixed(2),
      l: (p.spot * 0.996).toFixed(2),
      c: p.spot.toFixed(2),
      v: '10',
      q: String(p.spot * 10),
      n: 100,
    })),
    perpBars: prices.map((p) => ({
      t: p.t,
      o: p.perp.toFixed(2),
      h: (p.perpHigh ?? p.perp * 1.005).toFixed(2),
      l: (p.perp * 0.995).toFixed(2),
      c: p.perp.toFixed(2),
      v: '250',
      q: String(p.perp * 250),
      n: 2000,
    })),
  };
}

describe('SoDEX Official Funding Formula & 30-Day Historical Klines Backtest', () => {
  it('implements SoDEX official 8h-to-1h clamped funding formula accurately', () => {
    // When perp == spot (P = 0), clamp(0.0001 - 0, -0.0005, 0.0005) = 0.0001 -> hourly = 0.0001 / 8 = 0.0000125
    expect(computeSodexHourlyFundingFromBasis(60_000, 60_000)).toBeCloseTo(0.0000125, 9);

    // High premium (+20 bps = 0.002): clamp(0.0001 - 0.002, -0.0005, 0.0005) = -0.0005 -> 8h = 0.0015 -> 1h = 0.0001875
    expect(computeSodexHourlyFundingFromBasis(60_120, 60_000)).toBeCloseTo(0.0001875, 9);

    // Deep discount (-20 bps = -0.002): clamp(0.0001 - (-0.002), -0.0005, 0.0005) = +0.0005 -> 8h = -0.0015 -> 1h = -0.0001875
    expect(computeSodexHourlyFundingFromBasis(59_880, 60_000)).toBeCloseTo(-0.0001875, 9);

    // Hard protocol cap +/- 4%/hour
    expect(computeSodexHourlyFundingFromBasis(120_000, 60_000)).toBe(0.04);
  });

  it('replays a 30-day bear market with positive hedged carry alpha vs unhedged spot buy-and-hold', () => {
    const baseTs = Date.UTC(2026, 9, 25, 0, 0, 0);
    const barsCount = 180; // 30 days of 4h bars
    const rows = Array.from({ length: barsCount }, (_, i) => {
      // Spot falls linearly from 80,000 down to 60,000 (-25%), perp trades at steady +12 bps premium
      const spot = 80_000 - (20_000 * i) / (barsCount - 1);
      const perp = spot * 1.0012;
      return { t: baseTs + i * 4 * 3_600_000, spot, perp };
    });

    // Pass newest-first (matching SoDEX REST order) to verify chronological sorting
    const { perpBars, spotBars } = makeBars([...rows].reverse());
    const aligned = alignKlinePairs(perpBars, spotBars);
    expect(aligned).toHaveLength(180);
    expect(aligned[0].timestamp).toBeLessThan(aligned[179].timestamp);

    const res = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars,
      spotBars,
      source: 'LIVE_REST',
      notionalPerLegUsd: 50_000,
      leverage: 3,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
    });

    expect(res.source).toBe('LIVE_REST');
    expect(res.barsCount).toBe(180);
    expect(res.liquidationEvent).toBeNull();
    expect(res.spotBenchmarkReturnPct).toBeCloseTo(-25, 1);
    expect(res.cumulativeFundingUsd).toBeGreaterThan(200);
    expect(res.netPnlUsd).toBeGreaterThan(150);
    expect(res.alphaVsSpotPct).toBeGreaterThan(24);
    expect(res.maxDrawdownPct).toBeLessThan(2);
    expect(res.signalTrackRecord.length).toBeGreaterThanOrEqual(5);
  });

  it('detects intra-bar short-perp liquidation wick at 18x leverage while surviving at 3x leverage', () => {
    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    const rows = Array.from({ length: 60 }, (_, i) => {
      const spot = 60_000;
      const perp = 60_060;
      // Bar 25 has a sharp +10% upward short-squeeze wick on perpHigh (66,066)
      const perpHigh = i === 25 ? 66_066 : 60_200;
      return { t: baseTs + i * 4 * 3_600_000, spot, perp, perpHigh };
    });
    const { perpBars, spotBars } = makeBars(rows);

    const safeRun = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars,
      spotBars,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 3, // ~32% liquidation buffer -> easily survives +10% wick
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
    });

    const overLevRun = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars,
      spotBars,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 18, // 5.55% margin vs 1.25% MMR => ~4.3% buffer -> liquidated on +10% wick!
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
    });

    expect(safeRun.liquidationEvent).toBeNull();
    expect(overLevRun.liquidationEvent).not.toBeNull();
    expect(overLevRun.liquidationEvent?.barIndex).toBe(25);
    expect(overLevRun.liquidationEvent?.triggerHighPrice).toBeCloseTo(66_066, 1);
  });

  it('produces reproducible deterministic fallback klines anchored to live price', () => {
    const a = generateDeterministicFallbackKlines(60_000, 0.65, 20261124, 90);
    const b = generateDeterministicFallbackKlines(60_000, 0.65, 20261124, 90);
    expect(a.perpBars).toHaveLength(90);
    expect(a.spotBars).toHaveLength(90);
    expect(a.spotBars[89].c).toBe('60000.00');
    expect(a.perpBars[45].c).toBe(b.perpBars[45].c);
  });
});
