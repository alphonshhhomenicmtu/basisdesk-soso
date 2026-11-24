import type { SpotTicker, SsiConstituentWeight, ValueChainTelemetry } from '../types/market';

export type SsiIndexKey = 'MAG7.ssi' | 'DEFI.ssi' | 'USSI';

export interface SsiConstituentLeg {
  symbol: string;
  spotPair: string;
  liveSpotPrice: number;
  changePct24h: number;
  targetWeightPct: number;
  currentWeightPct: number;
  driftPct: number;
  exceedsBuffer: boolean;
  action: 'BUY' | 'SELL' | 'HOLD';
  tradeUsd: number;
  tradeQty: number;
  tokensetScaled1e8: bigint;
}

export interface SsiRebalancePlan {
  indexKey: SsiIndexKey;
  spotMarketSymbol: string;
  marketSpotPrice: number;
  impliedNavPrice: number;
  premiumDiscountBps: number;
  arbSignal: 'MINT_AND_SELL_SPOT' | 'BUY_SPOT_AND_REDEEM' | 'WITHIN_NO_ARB_BAND';
  aumUsd: number;
  bufferBandPct: number;
  annualManagementFeePct: number;
  accruedMonthlyFeeUsd: number;
  totalTurnoverUsd: number;
  turnoverPct: number;
  estimatedSwapSlippageUsd: number;
  estimatedValueChainGasSoso: number;
  estimatedValueChainGasUsd: number;
  legs: SsiConstituentLeg[];
  contractCallPreview: {
    contract: 'AssetRebalancer.sol' | 'USSI.sol';
    method: string;
    assetId: number;
    feeDecimals: number;
    inTokensetCount: number;
    outTokensetCount: number;
    nonce: number;
  };
}

export interface RiskPolicy {
  maxLeverage: number;
  minLiquidationBufferPct: number;
  maxSlippageBps: number;
  maxAllocationPct: number;
  maxVar99Pct: number;
}

export interface GuardrailCheckItem {
  ruleId: string;
  label: string;
  measured: string;
  limit: string;
  status: 'PASS' | 'WARN' | 'BLOCK';
}

export interface PreTradeGuardrailResult {
  overallStatus: 'PASS' | 'WARN' | 'BLOCK';
  checks: GuardrailCheckItem[];
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  maxLeverage: 10,
  minLiquidationBufferPct: 12,
  maxSlippageBps: 25,
  maxAllocationPct: 35,
  maxVar99Pct: 15,
};

/**
 * Evaluates institutional pre-trade risk guardrails before permitting paper execution.
 */
export function evaluatePreTradeGuardrails(
  params: {
    leverage: number;
    liquidationBufferPct: number;
    totalSlippageBps: number;
    capitalRequiredUsd: number;
    deskEquityUsd: number;
    var99Pct: number;
  },
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
): PreTradeGuardrailResult {
  const allocationPct =
    params.deskEquityUsd > 0 ? (params.capitalRequiredUsd / params.deskEquityUsd) * 100 : 100;

  const checks: GuardrailCheckItem[] = [
    {
      ruleId: 'MAX_LEV',
      label: 'Perp Leverage Cap',
      measured: `${params.leverage.toFixed(1)}x`,
      limit: `<= ${policy.maxLeverage.toFixed(1)}x`,
      status:
        params.leverage > policy.maxLeverage
          ? 'BLOCK'
          : params.leverage > policy.maxLeverage * 0.75
            ? 'WARN'
            : 'PASS',
    },
    {
      ruleId: 'LIQ_BUFFER',
      label: 'Mark-to-Liquidation Buffer',
      measured: `${params.liquidationBufferPct.toFixed(1)}%`,
      limit: `>= ${policy.minLiquidationBufferPct.toFixed(1)}%`,
      status:
        params.liquidationBufferPct < policy.minLiquidationBufferPct
          ? 'BLOCK'
          : params.liquidationBufferPct < policy.minLiquidationBufferPct * 1.4
            ? 'WARN'
            : 'PASS',
    },
    {
      ruleId: 'SLIPPAGE_CAP',
      label: 'Combined L2 Book Slippage',
      measured: `${params.totalSlippageBps.toFixed(1)} bps`,
      limit: `<= ${policy.maxSlippageBps.toFixed(1)} bps`,
      status:
        params.totalSlippageBps > policy.maxSlippageBps
          ? 'BLOCK'
          : params.totalSlippageBps > policy.maxSlippageBps * 0.65
            ? 'WARN'
            : 'PASS',
    },
    {
      ruleId: 'DESK_ALLOC',
      label: 'Single-Strategy Capital Concentration',
      measured: `${allocationPct.toFixed(1)}%`,
      limit: `<= ${policy.maxAllocationPct.toFixed(1)}%`,
      status:
        allocationPct > policy.maxAllocationPct
          ? 'WARN'
          : 'PASS',
    },
    {
      ruleId: 'VAR_99',
      label: 'Monte Carlo 99% VaR Budget',
      measured: `${params.var99Pct.toFixed(2)}%`,
      limit: `<= ${policy.maxVar99Pct.toFixed(1)}%`,
      status:
        params.var99Pct > policy.maxVar99Pct
          ? 'BLOCK'
          : params.var99Pct > policy.maxVar99Pct * 0.7
            ? 'WARN'
            : 'PASS',
    },
  ];

  const overallStatus = checks.some((c) => c.status === 'BLOCK')
    ? 'BLOCK'
    : checks.some((c) => c.status === 'WARN')
      ? 'WARN'
      : 'PASS';

  return { overallStatus, checks };
}

/**
 * Computes an SSI Protocol basket rebalance plan matching SoSoValueLabs/ssi-protocol contracts:
 * - AssetToken.sol: 8-decimal tokenset & feeDecimals = 8
 * - AssetRebalancer.sol: startRebalance -> addRebalanceRequest(assetID, basket, orderInfo) -> endRebalance
 * - USSI.sol: delta-neutral HedgeOrder mint/redeem vault
 */
export function computeSsiRebalancePlan(params: {
  indexKey: SsiIndexKey;
  targetWeights: SsiConstituentWeight[];
  spotTickers: SpotTicker[];
  aumUsd: number;
  bufferBandPct: number;
  simulatedMarketDriftShockPct?: number;
  valueChain: ValueChainTelemetry;
}): SsiRebalancePlan {
  const tickerMap = new Map(params.spotTickers.map((t) => [t.symbol, t]));
  const sosoPrice = Number(tickerMap.get('WSOSO_vUSDC')?.lastPx ?? '0.28') || 0.28;

  const spotMarketSymbol =
    params.indexKey === 'MAG7.ssi'
      ? 'vMAG7ssi_vUSDC'
      : params.indexKey === 'DEFI.ssi'
        ? 'vDEFIssi_vUSDC'
        : 'vUSSI_vUSDC';

  const indexTicker = tickerMap.get(spotMarketSymbol);
  const marketSpotPrice = Number(indexTicker?.lastPx ?? (params.indexKey === 'USSI' ? '1.0' : '0.39'));

  // Normalize target weights to sum exactly to 1.0
  const weightSum = params.targetWeights.reduce((acc, w) => acc + Math.max(0, w.weight), 0) || 1;
  const normalizedTargets = params.targetWeights.map((w) => ({
    symbol: w.symbol.toUpperCase(),
    weight: Math.max(0, w.weight) / weightSum,
  }));

  // Simulate realistic pre-rebalance weight drift driven by 24h constituent performance + optional user shock
  const shockScale = 1 + (params.simulatedMarketDriftShockPct ?? 0) / 100;
  const driftedRaw = normalizedTargets.map((item, idx) => {
    const spotPair = `v${item.symbol}_vUSDC`;
    const st = tickerMap.get(spotPair);
    const px = Number(st?.lastPx ?? '100') || 100;
    const chgPct = Number(st?.changePct ?? 0) || 0;
    // Apply amplified 30-day return drift proxy using live 24h dispersion + shock slider
    const driftFactor = Math.max(
      0.55,
      1 + (chgPct / 100) * 3.8 * shockScale + (idx === 0 ? 0.032 : idx === 1 ? -0.024 : 0.008),
    );
    return {
      ...item,
      spotPair,
      liveSpotPrice: px,
      changePct24h: chgPct,
      driftedValue: item.weight * driftFactor,
    };
  });

  const driftedSum = driftedRaw.reduce((acc, d) => acc + d.driftedValue, 0) || 1;

  // Compute implied NAV divergence vs live SoDEX Spot price
  const weightedReturn24h = driftedRaw.reduce(
    (acc, d) => acc + d.weight * (d.changePct24h / 100),
    0,
  );
  const indexChange24h = (Number(indexTicker?.changePct ?? 0) || 0) / 100;
  const impliedNavPrice =
    params.indexKey === 'USSI'
      ? 1.0004 // USSI accrues funding carry near $1.00 par
      : marketSpotPrice * (1 + (weightedReturn24h - indexChange24h) * 0.45);
  const premiumDiscountBps =
    impliedNavPrice > 0 ? ((marketSpotPrice - impliedNavPrice) / impliedNavPrice) * 10000 : 0;

  const arbSignal: SsiRebalancePlan['arbSignal'] =
    premiumDiscountBps > 12
      ? 'MINT_AND_SELL_SPOT'
      : premiumDiscountBps < -12
        ? 'BUY_SPOT_AND_REDEEM'
        : 'WITHIN_NO_ARB_BAND';

  const legs: SsiConstituentLeg[] = driftedRaw.map((item) => {
    const targetWeightPct = item.weight * 100;
    const currentWeightPct = (item.driftedValue / driftedSum) * 100;
    const driftPct = currentWeightPct - targetWeightPct;
    const exceedsBuffer = Math.abs(driftPct) >= params.bufferBandPct;

    let action: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
    let tradeUsd = 0;
    if (exceedsBuffer) {
      action = driftPct > 0 ? 'SELL' : 'BUY';
      tradeUsd = (Math.abs(driftPct) / 100) * params.aumUsd;
    }

    const tradeQty = item.liveSpotPrice > 0 ? tradeUsd / item.liveSpotPrice : 0;
    const tokensetScaled1e8 = BigInt(Math.round(tradeQty * 1e8));

    return {
      symbol: item.symbol,
      spotPair: item.spotPair,
      liveSpotPrice: item.liveSpotPrice,
      changePct24h: item.changePct24h,
      targetWeightPct,
      currentWeightPct,
      driftPct,
      exceedsBuffer,
      action,
      tradeUsd,
      tradeQty,
      tokensetScaled1e8,
    };
  });

  // One-sided turnover (average of buys + sells)
  const grossTradeUsd = legs.reduce((acc, l) => acc + l.tradeUsd, 0);
  const totalTurnoverUsd = grossTradeUsd / 2;
  const turnoverPct = params.aumUsd > 0 ? (totalTurnoverUsd / params.aumUsd) * 100 : 0;
  // SoDEX spot taker 6.5 bps + ~4 bps depth impact
  const estimatedSwapSlippageUsd = grossTradeUsd * 0.00105;

  // SSI Protocol fee math: 0.95%/yr for spot indices, 0.50%/yr for USSI
  const annualManagementFeePct = params.indexKey === 'USSI' ? 0.5 : 0.95;
  const accruedMonthlyFeeUsd = (params.aumUsd * (annualManagementFeePct / 100)) / 12;

  // ValueChain EVM gas estimation for startRebalance + addRebalanceRequest + endRebalance (~420,000 gas)
  const gasUnits = params.indexKey === 'USSI' ? 245_000 : 420_000;
  const gasPriceWei = Math.max(1_000_000, params.valueChain.gasPriceWei || 2_000_000);
  const estimatedValueChainGasSoso = (gasUnits * gasPriceWei) / 1e18;
  const estimatedValueChainGasUsd = estimatedValueChainGasSoso * sosoPrice;

  const inTokensetCount = legs.filter((l) => l.action === 'BUY').length;
  const outTokensetCount = legs.filter((l) => l.action === 'SELL').length;

  return {
    indexKey: params.indexKey,
    spotMarketSymbol,
    marketSpotPrice,
    impliedNavPrice,
    premiumDiscountBps,
    arbSignal,
    aumUsd: params.aumUsd,
    bufferBandPct: params.bufferBandPct,
    annualManagementFeePct,
    accruedMonthlyFeeUsd,
    totalTurnoverUsd,
    turnoverPct,
    estimatedSwapSlippageUsd,
    estimatedValueChainGasSoso,
    estimatedValueChainGasUsd,
    legs,
    contractCallPreview: {
      contract: params.indexKey === 'USSI' ? 'USSI.sol' : 'AssetRebalancer.sol',
      method:
        params.indexKey === 'USSI'
          ? 'applyMint(HedgeOrder memory hedgeOrder)'
          : 'addRebalanceRequest(uint256 assetID, Token[] basket, OrderInfo orderInfo)',
      assetId: params.indexKey === 'MAG7.ssi' ? 1 : params.indexKey === 'DEFI.ssi' ? 2 : 9,
      feeDecimals: 8,
      inTokensetCount,
      outTokensetCount,
      nonce: Math.max(1, params.valueChain.blockNumber % 10000),
    },
  };
}
