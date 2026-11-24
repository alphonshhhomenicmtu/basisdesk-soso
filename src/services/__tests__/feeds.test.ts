import { describe, expect, it } from 'vitest';
import snapshotJson from '../../../public/data/market-snapshot.json';
import {
  formatBps,
  formatCompactUsd,
  formatCountdown,
  formatPct,
  formatPrice,
  formatSignedCompactUsd,
  formatUsd,
} from '../../utils/format';
import { fetchLiveSoSoValueDirect } from '../feeds';
import type { MarketSnapshotPayload } from '../../types/market';

const snap = snapshotJson as unknown as MarketSnapshotPayload;

describe('Hourly Market Snapshot Artifact Integrity', () => {
  it('contains valid live-captured SoDEX, ValueChain, and SoSoValue schema fields', () => {
    expect(snap.schemaVersion).toBe(1);
    expect(snap.valueChain.chainId).toBe(286623);
    expect(snap.valueChain.blockNumber).toBeGreaterThan(1_000_000);
    expect(snap.perps.tickers.length).toBeGreaterThanOrEqual(8);
    expect(snap.spot.tickers.length).toBeGreaterThanOrEqual(10);
    expect(snap.orderbooks.perps['BTC-USD']?.bids.length).toBeGreaterThan(0);
    expect(snap.orderbooks.spot['vMAG7ssi_vUSDC']?.asks.length).toBeGreaterThan(0);
    expect(snap.sosovalue.btcEtfHistory.length).toBeGreaterThanOrEqual(5);
    expect(snap.sosovalue.ssiConstituents.ssimag7.length).toBeGreaterThanOrEqual(5);
    expect(snap.klines30d?.['BTC-USD']?.perp.length).toBeGreaterThanOrEqual(100);
    expect(snap.klines30d?.['BTC-USD']?.spot.length).toBeGreaterThanOrEqual(100);
  });
});

describe('Formatting & API Validation Guards', () => {
  it('formats institutional currency, bps, percentages, prices, and countdowns cleanly', () => {
    expect(formatUsd(12345.678)).toBe('$12,345.68');
    expect(formatCompactUsd(2_450_000_000)).toBe('$2.45B');
    expect(formatSignedCompactUsd(248_600_000)).toBe('+$248.60M');
    expect(formatPrice(60465.2)).toBe('60,465.2');
    expect(formatPrice(0.3915)).toBe('0.3915');
    expect(formatBps(12.34)).toBe('+12.3 bps');
    expect(formatPct(-1.543)).toBe('-1.54%');
    expect(formatCountdown(10_000 + 75_000, 10_000)).toBe('01m 15s');
  });

  it('rejects blank SoSoValue BYOK key cleanly without leaking network calls', async () => {
    await expect(fetchLiveSoSoValueDirect('   ', snap.sosovalue)).rejects.toThrow(
      /valid SoSoValue Open API key/i,
    );
  });
});
