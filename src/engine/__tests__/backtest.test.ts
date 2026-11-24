import { describe, expect, it } from 'vitest';
import snapshotJson from '../../../public/data/market-snapshot.json';
import {
  alignKlinePairs,
  computeShortPerpLiquidationPrice,
  computeSodexHourlyFundingFromBasis,
  generateDeterministicFallbackKlines,
  runHistoricalBasisBacktest,
} from '../backtest';
import type { KlineBar, MarketSnapshotPayload, PerpMarginTier } from '../../types/market';

const BTC_TIERS: PerpMarginTier[] = [
  { maxNotionalValue: '4000000', maintenanceMarginRate: '0.0125', maxLeverage: 40, maintenanceDeduction: '0' },
  { maxNotionalValue: '100000000', maintenanceMarginRate: '0.02', maxLeverage: 25, maintenanceDeduction: '30000' },
];

function makeBars(prices: Array<{ t: number; spot: number; perp: number; perpHigh?: number; spotOffsetMs?: number }>): {
  perpBars: KlineBar[];
  spotBars: KlineBar[];
} {
  return {
    spotBars: prices.map((p) => ({
      t: p.t + (p.spotOffsetMs ?? 0),
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

describe('SoDEX Funding Clamp Proxy & 30-Day Historical Klines Backtest', () => {
  it('implements SoDEX 8h-to-1h clamped funding formula accurately', () => {
    // When perp == spot (P = 0), clamp(0.0001 - 0, -0.0005, 0.0005) = 0.0001 -> hourly = 0.0001 / 8 = 0.0000125
    expect(computeSodexHourlyFundingFromBasis(60_000, 60_000)).toBeCloseTo(0.0000125, 9);

    // High premium (+20 bps = 0.002): clamp(0.0001 - 0.002, -0.0005, 0.0005) = -0.0005 -> 8h = 0.0015 -> 1h = 0.0001875
    expect(computeSodexHourlyFundingFromBasis(60_120, 60_000)).toBeCloseTo(0.0001875, 9);

    // Deep discount (-20 bps = -0.002): clamp(0.0001 - (-0.002), -0.0005, 0.0005) = +0.0005 -> 8h = -0.0015 -> 1h = -0.0001875
    expect(computeSodexHourlyFundingFromBasis(59_880, 60_000)).toBeCloseTo(-0.0001875, 9);

    // Hard protocol cap +/- 4%/hour
    expect(computeSodexHourlyFundingFromBasis(120_000, 60_000)).toBe(0.04);
  });

  it('solves exact isolated short-perp maintenance liquidation price before margin mutation (~62,597 at 18x)', () => {
    const baseQty = 50_000 / 60_000;
    const entryPerp = 60_060;
    const initialMarginMinusHalfEntryFee = 50_000 / 18 - 11.75;
    const liqPx = computeShortPerpLiquidationPrice(
      initialMarginMinusHalfEntryFee,
      baseQty,
      entryPerp,
      BTC_TIERS,
    );
    expect(liqPx).toBeCloseTo(62_596.77, 0);
    expect(liqPx).toBeGreaterThan(entryPerp);
  });

  it('replays a 30-day bear market with honest round-trip fees, exact window span, and NO forced OPEN slice', () => {
    const baseTs = Date.UTC(2026, 9, 25, 0, 0, 0);
    const barsCount = 180; // 179 x 4h gaps = 716h = 29.833 days
    const rows = Array.from({ length: barsCount }, (_, i) => {
      // Spot falls linearly from 80,000 down to 60,000 (-25%), perp trades at steady +12 bps premium
      const spot = 80_000 - (20_000 * i) / (barsCount - 1);
      const perp = spot * 1.0012;
      // Add slight 100ms clock skew on every 10th spot bar to verify tolerant pairing
      return { t: baseTs + i * 4 * 3_600_000, spot, perp, spotOffsetMs: i % 10 === 0 ? 100 : 0 };
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
      liveHourlyFundingAnchor: 0.0000125,
    });

    expect(res.source).toBe('LIVE_REST');
    expect(res.barsCount).toBe(180);
    expect(res.unmatchedBarsCount).toBe(0);
    expect(res.windowDays).toBeCloseTo(29.833, 2);
    expect(res.accruedHours).toBe(716);
    expect(res.roundTripFeeBps).toBeCloseTo(9.4, 2);
    expect(res.totalFeesUsd).toBeCloseTo(47.0, 2);
    expect(res.liquidationEvent).toBeNull();
    expect(res.spotBenchmarkReturnPct).toBeCloseTo(-25, 1);
    expect(res.cumulativeFundingUsd).toBeGreaterThan(200);
    expect(res.netPnlUsd).toBeGreaterThan(150);
    expect(res.alphaVsSpotPct).toBeGreaterThan(24);
    expect(res.signalTrackRecord).toHaveLength(6);
    // Final slice W6 must NOT be forced to 'OPEN'
    const statuses = res.signalTrackRecord.map((s) => s.status);
    expect(statuses).not.toContain('OPEN');
    expect(res.signalTrackRecord[0].windowId).toBe('W6');
    expect(['HIT', 'DRIFT', 'STOPPED', 'FLAT']).toContain(res.signalTrackRecord[0].status);
  });

  it('reports realistic pre-penalty liquidation threshold, flattens spot on breach, avoids double exit fees, and marks post-stop slices FLAT', () => {
    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    const rows = Array.from({ length: 60 }, (_, i) => {
      // After bar 25, spot drops 20% to verify post-breach spot MTM is strictly frozen (flattened)
      const spot = i <= 25 ? 60_000 : 48_000;
      const perp = i <= 25 ? 60_060 : 48_048;
      // Bar 25 has a sharp +10% upward short-squeeze wick on perpHigh (66,066)
      const perpHigh = i === 25 ? 66_066 : perp * 1.003;
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
      leverage: 3,
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
      leverage: 18, // 5.55% margin vs 1.25% MMR => ~4.3% buffer -> liquidated on +10% wick
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

    // Regression: threshold must NEVER collapse to entryPerp (60,060); must reflect exact isolated maintenance price
    const thresholdPx = overLevRun.liquidationEvent!.liquidationThresholdPrice;
    expect(thresholdPx).toBeGreaterThan(62_500);
    expect(thresholdPx).toBeLessThan(66_066);

    // Regression: immediate bar-1 breach (zero prior funding) hits ~62,604 (isolated maintenance price at entry margin)
    const bar1Rows = Array.from({ length: 12 }, (_, i) => ({
      t: baseTs + i * 4 * 3_600_000,
      spot: 60_000,
      perp: 60_060,
      perpHigh: i === 1 ? 66_066 : 60_100,
    }));
    const bar1Pair = makeBars(bar1Rows);
    const bar1Breach = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars: bar1Pair.perpBars,
      spotBars: bar1Pair.spotBars,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 18,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
    });
    expect(bar1Breach.liquidationEvent?.liquidationThresholdPrice).toBeGreaterThan(62_550);
    expect(bar1Breach.liquidationEvent?.liquidationThresholdPrice).toBeLessThan(62_650);

    // Regression: post-breach spot leg is flattened at bar 25 spotClose (60,000), ignoring the -20% spot crash on bars 26..59
    const eqAtBreach = overLevRun.liquidationEvent!.equityAfterUsd;
    expect(overLevRun.finalCarryEquityUsd).toBeCloseTo(eqAtBreach, 4);
    for (let i = 26; i < overLevRun.equityCurve.length; i++) {
      expect(overLevRun.equityCurve[i].carryEquityUsd).toBeCloseTo(eqAtBreach, 4);
      expect(overLevRun.equityCurve[i].fundingCollectedUsd).toBe(0);
      expect(overLevRun.equityCurve[i].isPostStop).toBe(true);
    }

    // Regression: totalFeesUsd on breach includes entry fees + spot unwind fee only (no double perp exit fee on last bar)
    const expectedEntryFees = 50_000 * (0.00035 + 0.00012); // $23.50
    const expectedSpotExitFee = 50_000 * 0.00035; // $17.50
    expect(overLevRun.totalFeesUsd).toBeCloseTo(expectedEntryFees + expectedSpotExitFee, 2);
    expect(overLevRun.totalFeesUsd).toBeLessThan(47.0);

    // Regression: W3 is STOPPED, and subsequent slices W4/W5/W6 are strictly FLAT with 0% realized funding (never HIT or OPEN)
    const byId = new Map(overLevRun.signalTrackRecord.map((r) => [r.windowId, r]));
    expect(byId.get('W3')?.status).toBe('STOPPED');
    for (const id of ['W4', 'W5', 'W6']) {
      expect(byId.get(id)?.status).toBe('FLAT');
      expect(byId.get(id)?.avgAnnualizedFundingPct).toBe(0);
      expect(byId.get(id)?.windowCarryReturnPct).toBeCloseTo(0, 6);
    }
  });

  it('uses liveHourlyFundingAnchor actively in liveFundingComparison and does not report zero-carry slices as HIT', () => {
    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    // Flat zero-basis tape where spot==perp and funding barely clears fees
    const rows = Array.from({ length: 36 }, (_, i) => ({
      t: baseTs + i * 4 * 3_600_000,
      spot: 60_000,
      perp: 59_950, // slight discount -> ~0 or slightly negative funding
    }));
    const { perpBars, spotBars } = makeBars(rows);

    const lowAnchor = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars,
      spotBars,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 5,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
      liveHourlyFundingAnchor: 0.0000045,
    });

    const highAnchor = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars,
      spotBars,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 5,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: BTC_TIERS,
      liveHourlyFundingAnchor: 0.0001,
    });

    expect(lowAnchor.liveFundingComparison).not.toBeNull();
    expect(highAnchor.liveFundingComparison).not.toBeNull();
    expect(highAnchor.liveFundingComparison!.fundingAtLiveRateUsd).toBeGreaterThan(
      lowAnchor.liveFundingComparison!.fundingAtLiveRateUsd,
    );
    // Zero/negative carry slices must be DRIFT, not HIT
    expect(lowAnchor.signalTrackRecord.every((s) => s.status !== 'HIT')).toBe(true);
  });

  it('produces honest unannualized period risk metrics and perp margin drawdown on bundled BTC-USD snapshot (no Sharpe 15.43)', () => {
    const snap = snapshotJson as unknown as MarketSnapshotPayload;
    const btcKlines = snap.klines30d?.['BTC-USD'];
    const btcSpec = snap.perps.symbols.find((s) => s.name === 'BTC-USD');
    const btcTicker = snap.perps.tickers.find((t) => t.symbol === 'BTC-USD');

    expect(btcKlines).toBeDefined();
    const res = runHistoricalBasisBacktest({
      perpSymbol: 'BTC-USD',
      spotSymbol: 'vBTC_vUSDC',
      perpBars: btcKlines!.perp,
      spotBars: btcKlines!.spot,
      source: 'SNAPSHOT',
      notionalPerLegUsd: 50_000,
      leverage: 5,
      executionMode: 'MAKER',
      spotMakerFee: 0.00035,
      spotTakerFee: 0.00065,
      perpMakerFee: 0.00012,
      perpTakerFee: 0.0004,
      marginTiers: btcSpec?.marginTiers ?? BTC_TIERS,
      liveHourlyFundingAnchor: Number(btcTicker?.fundingRate ?? 0),
    });

    expect(res.barsCount).toBe(180);
    expect(res.accruedHours).toBe(716);
    expect(res.windowDays).toBeCloseTo(29.833, 2);
    // Regression: unannualized excess Return/Vol is realistic (~3.5), never inflated Sharpe 15.43 / Sortino 33.23
    expect(res.periodReturnToVol).toBeLessThan(6);
    expect(res.periodDownsideRatio).toBeLessThan(8);
    // Regression: captures real intra-bar basis DD (>0.11%) and 5x short-perp margin drawdown (~8.36%)
    expect(res.maxDrawdownPct).toBeGreaterThan(0.15);
    expect(res.perpMaxMarginDrawdownPct).toBeGreaterThan(5);
    // Live funding comparison exposes the gap between proxy funding and live exchange rate
    expect(res.liveFundingComparison).not.toBeNull();
    expect(res.liveFundingComparison!.liveAnnualizedPct).toBeCloseTo(3.95, 1);
    expect(res.signalTrackRecord.every((s) => s.status !== ('OPEN' as never))).toBe(true);
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
