import { describe, expect, it } from 'vitest';
import {
  computeSsiRebalancePlan,
  DEFAULT_RISK_POLICY,
  evaluatePreTradeGuardrails,
} from '../ssiRebalancer';
import type { SpotTicker, ValueChainTelemetry } from '../../types/market';

const MOCK_SPOT_TICKERS: SpotTicker[] = [
  { symbol: 'vMAG7ssi_vUSDC', lastPx: '0.3915', openPx: '0.40', highPx: '0.41', lowPx: '0.38', volume: '10000', quoteVolume: '3915', vwap: '0.39', change: '-0.0085', changePct: -2.1, askPx: '0.3916', askSz: '500', bidPx: '0.3915', bidSz: '500' },
  { symbol: 'vUSSI_vUSDC', lastPx: '0.9995', openPx: '0.9994', highPx: '1.0', lowPx: '0.999', volume: '500', quoteVolume: '500', vwap: '0.9995', change: '0.0001', changePct: 0.01, askPx: '0.9996', askSz: '1000', bidPx: '0.9994', bidSz: '1000' },
  { symbol: 'WSOSO_vUSDC', lastPx: '0.28', openPx: '0.26', highPx: '0.29', lowPx: '0.25', volume: '1000000', quoteVolume: '280000', vwap: '0.27', change: '0.02', changePct: 7.7, askPx: '0.2801', askSz: '5000', bidPx: '0.2799', bidSz: '5000' },
  { symbol: 'vBTC_vUSDC', lastPx: '60400', openPx: '61500', highPx: '62000', lowPx: '59800', volume: '10', quoteVolume: '604000', vwap: '60500', change: '-1100', changePct: -1.8, askPx: '60405', askSz: '0.5', bidPx: '60395', bidSz: '0.5' },
  { symbol: 'vETH_vUSDC', lastPx: '1700', openPx: '1750', highPx: '1760', lowPx: '1680', volume: '100', quoteVolume: '170000', vwap: '1710', change: '-50', changePct: -2.8, askPx: '1701', askSz: '5', bidPx: '1699', bidSz: '5' },
  { symbol: 'vSOL_vUSDC', lastPx: '72', openPx: '70', highPx: '74', lowPx: '69', volume: '1000', quoteVolume: '72000', vwap: '71', change: '2', changePct: 2.8, askPx: '72.05', askSz: '20', bidPx: '71.95', bidSz: '20' },
];

const MOCK_VC: ValueChainTelemetry = {
  chainId: 286623,
  blockNumber: 17316000,
  gasPriceWei: 2_000_000,
  rpcUrl: 'https://mainnet.valuechain.xyz',
  explorerUrl: 'https://main-scan.valuechain.xyz',
  capturedAt: '2026-11-24T06:00:00Z',
};

describe('SSI Protocol Rebalancer Engine', () => {
  it('suppresses unnecessary constituent swaps when buffer band widens', () => {
    const tight = computeSsiRebalancePlan({
      indexKey: 'MAG7.ssi',
      targetWeights: [
        { symbol: 'BTC', weight: 0.5 },
        { symbol: 'ETH', weight: 0.3 },
        { symbol: 'SOL', weight: 0.2 },
      ],
      spotTickers: MOCK_SPOT_TICKERS,
      aumUsd: 100_000,
      bufferBandPct: 0.25,
      valueChain: MOCK_VC,
    });

    const wide = computeSsiRebalancePlan({
      indexKey: 'MAG7.ssi',
      targetWeights: [
        { symbol: 'BTC', weight: 0.5 },
        { symbol: 'ETH', weight: 0.3 },
        { symbol: 'SOL', weight: 0.2 },
      ],
      spotTickers: MOCK_SPOT_TICKERS,
      aumUsd: 100_000,
      bufferBandPct: 12.0,
      valueChain: MOCK_VC,
    });

    expect(tight.totalTurnoverUsd).toBeGreaterThan(0);
    expect(wide.totalTurnoverUsd).toBe(0);
    expect(tight.contractCallPreview.contract).toBe('AssetRebalancer.sol');
    expect(tight.contractCallPreview.feeDecimals).toBe(8);
    expect(tight.estimatedValueChainGasSoso).toBeGreaterThan(0);
    expect(tight.estimatedValueChainGasUsd).toBeGreaterThan(0);
  });

  it('targets USSI.sol HedgeOrder lifecycle for USSI index', () => {
    const plan = computeSsiRebalancePlan({
      indexKey: 'USSI',
      targetWeights: [
        { symbol: 'BTC', weight: 0.6 },
        { symbol: 'ETH', weight: 0.4 },
      ],
      spotTickers: MOCK_SPOT_TICKERS,
      aumUsd: 50_000,
      bufferBandPct: 1.0,
      valueChain: MOCK_VC,
    });

    expect(plan.contractCallPreview.contract).toBe('USSI.sol');
    expect(plan.annualManagementFeePct).toBe(0.5);
    expect(plan.spotMarketSymbol).toBe('vUSSI_vUSDC');
  });
});

describe('Institutional Pre-Trade Risk Guardrails', () => {
  it('passes conservative 3x carry parameters within risk policy', () => {
    const res = evaluatePreTradeGuardrails(
      {
        leverage: 3,
        liquidationBufferPct: 32,
        totalSlippageBps: 4.5,
        capitalRequiredUsd: 25_000,
        deskEquityUsd: 150_000,
        var99Pct: 3.2,
      },
      DEFAULT_RISK_POLICY,
    );

    expect(res.overallStatus).toBe('PASS');
    expect(res.checks.every((c) => c.status === 'PASS')).toBe(true);
  });

  it('blocks excessive leverage, thin liquidation buffer, or excessive 99% VaR', () => {
    const res = evaluatePreTradeGuardrails(
      {
        leverage: 15,
        liquidationBufferPct: 5.5,
        totalSlippageBps: 30,
        capitalRequiredUsd: 80_000,
        deskEquityUsd: 100_000,
        var99Pct: 24,
      },
      DEFAULT_RISK_POLICY,
    );

    expect(res.overallStatus).toBe('BLOCK');
    expect(res.checks.filter((c) => c.status === 'BLOCK').length).toBeGreaterThanOrEqual(4);
  });
});
