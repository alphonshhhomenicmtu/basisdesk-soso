import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCode2,
  KeyRound,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import type { PreTradeGuardrailResult } from '../engine/ssiRebalancer';
import {
  buildPerpNewOrderIntent,
  buildSpotBatchNewOrderIntent,
  formatDecimalFixed,
  requestSwitchToValueChain,
  signIntentWithEphemeralDryRunKey,
  signIntentWithInjectedWallet,
  SODEX_NETWORKS,
  SodexNonceAllocator,
  validateSodexAccountId,
  type SignedSodexEnvelope,
  type SodexExchangeActionIntent,
} from '../engine/sodexEip712';
import type { FeedTelemetry, SodexNetwork } from '../types/market';
import { formatPct, formatTimeUtc, formatUsd } from '../utils/format';
import { TelemetryBadge } from './TelemetryBadge';

export interface StagedSsiBatchLeg {
  symbol: string;
  spotPair: string;
  symbolID: number;
  side: 'BUY' | 'SELL';
  price: number;
  quantity: number;
  pricePrecision: number;
  quantityPrecision: number;
}

export interface StagedPaperTrade {
  strategyType: 'DELTA_NEUTRAL_BASIS' | 'SSI_REBALANCE';
  symbol: string;
  spotSymbol: string;
  perpSymbolId?: number;
  spotSymbolId?: number;
  perpPricePrecision?: number;
  perpQuantityPrecision?: number;
  spotPricePrecision?: number;
  spotQuantityPrecision?: number;
  executionMode?: 'MAKER' | 'TAKER';
  direction: 'LONG_SPOT_SHORT_PERP' | 'REBALANCE_BASKET';
  notionalUsd: number;
  leverage: number;
  entrySpotPrice: number;
  entryPerpPrice: number;
  entryHourlyFundingRate: number;
  expectedNetApyPct: number;
  estimatedFeesUsd: number;
  liquidationBufferPct: number;
  notes: string;
  guardrails: PreTradeGuardrailResult;
  ssiBatchLegs?: StagedSsiBatchLeg[];
}

export interface ConfirmedExecutionMeta {
  executionChannel: 'PAPER' | 'EIP712_DRY_RUN' | 'EIP712_WALLET_SIGNED';
  eip712Network?: SodexNetwork;
  eip712Signer?: string;
  eip712Digest?: string;
  clOrdId?: string;
  typedSignaturePreview?: string;
}

export interface WalletContextView {
  address: `0x${string}` | null;
  chainId: number | null;
  providerLabel: string;
  connecting: boolean;
  error: string | null;
  sodexAccountIds: Record<SodexNetwork, { spot: number | null; perps: number | null }>;
  connect: () => Promise<boolean>;
  disconnect: () => void;
}

export function ExecutionConfirmModal({
  staged,
  wallet,
  onCancel,
  onConfirm,
}: {
  staged: StagedPaperTrade | null;
  wallet: WalletContextView;
  onCancel: () => void;
  onConfirm: (meta: ConfirmedExecutionMeta) => void;
}) {
  const [mode, setMode] = useState<'eip712' | 'paper'>('eip712');
  const [network, setNetwork] = useState<SodexNetwork>('testnet');
  const [legChoice, setLegChoice] = useState<'spot' | 'perp'>('spot');
  const [accountIdInput, setAccountIdInput] = useState<string>('');
  const [builderIdInput, setBuilderIdInput] = useState<string>('');
  const [builderFeeInput, setBuilderFeeInput] = useState<string>('10');
  const nonceAllocatorRef = useRef<SodexNonceAllocator>(new SodexNonceAllocator());
  const [nonceSeed, setNonceSeed] = useState<bigint>(() => nonceAllocatorRef.current.next());
  const [signedNoncesByLeg, setSignedNoncesByLeg] = useState<{ spot?: string; perp?: string }>({});
  const [mainnetSafetyAck, setMainnetSafetyAck] = useState(false);
  const [paperAckChecked, setPaperAckChecked] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signedEnvelope, setSignedEnvelope] = useState<SignedSodexEnvelope | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const allocateFreshNonce = () => {
    const next = nonceAllocatorRef.current.next();
    setNonceSeed(next);
    return next;
  };

  // Reset per-order signing state whenever a new trade is staged
  useEffect(() => {
    if (!staged) return;
    setMode('eip712');
    setNetwork('testnet');
    setLegChoice('spot');
    setNonceSeed(nonceAllocatorRef.current.next());
    setSignedNoncesByLeg({});
    setMainnetSafetyAck(false);
    setPaperAckChecked(false);
    setSignedEnvelope(null);
    setSignError(null);
    setShowRawJson(false);
  }, [staged]);

  const isSpotAction = staged?.strategyType === 'SSI_REBALANCE' || legChoice === 'spot';
  const activeDomainKey: 'spot' | 'perps' = isSpotAction ? 'spot' : 'perps';
  const resolvedAccountId = wallet.sodexAccountIds[network][activeDomainKey];

  // Sync resolved live SoDEX accountID when wallet connects, network toggles, or leg switches
  useEffect(() => {
    if (resolvedAccountId && resolvedAccountId > 0) {
      setAccountIdInput(String(resolvedAccountId));
    } else {
      setAccountIdInput('');
    }
  }, [resolvedAccountId, network, activeDomainKey]);

  const parsedAccountId = validateSodexAccountId(accountIdInput);
  const parsedBuilderId = validateSodexAccountId(builderIdInput);
  const parsedBuilderFee = /^\d+$/.test(builderFeeInput.trim())
    ? Number.parseInt(builderFeeInput.trim(), 10)
    : 0;
  const activeBuilder =
    parsedBuilderId !== null
      ? { id: parsedBuilderId, fee: Math.max(0, Math.min(100, parsedBuilderFee)) }
      : undefined;
  const hasResolvedAccountId =
    resolvedAccountId !== null && parsedAccountId !== null && parsedAccountId === resolvedAccountId;

  const activeIntent = useMemo<SodexExchangeActionIntent | null>(() => {
    if (!staged || parsedAccountId === null) return null;
    const tif = staged.executionMode === 'TAKER' ? 'IOC' : 'POST_ONLY';
    const orderType = staged.executionMode === 'TAKER' ? 'MARKET' : 'LIMIT';

    if (staged.strategyType === 'SSI_REBALANCE' || legChoice === 'spot') {
      if (staged.ssiBatchLegs && staged.ssiBatchLegs.length > 0) {
        return buildSpotBatchNewOrderIntent({
          network,
          accountID: parsedAccountId,
          nonce: nonceSeed,
          builder: activeBuilder,
          orders: staged.ssiBatchLegs.map((leg) => ({
            symbolID: leg.symbolID,
            side: leg.side,
            orderType: 'LIMIT',
            timeInForce: 'GTC',
            price: formatDecimalFixed(leg.price, leg.pricePrecision, 0.0001),
            quantity: formatDecimalFixed(leg.quantity, leg.quantityPrecision, 0.0001),
          })),
        });
      }

      const spotQty =
        staged.entrySpotPrice > 0 ? staged.notionalUsd / staged.entrySpotPrice : 0.01;
      return buildSpotBatchNewOrderIntent({
        network,
        accountID: parsedAccountId,
        nonce: nonceSeed,
        builder: activeBuilder,
        orders: [
          {
            symbolID: staged.spotSymbolId ?? 1,
            side: 'BUY',
            orderType,
            timeInForce: tif,
            price: formatDecimalFixed(staged.entrySpotPrice, staged.spotPricePrecision ?? 2, 0.0001),
            quantity: formatDecimalFixed(spotQty, staged.spotQuantityPrecision ?? 5, 0.0001),
          },
        ],
      });
    }

    const perpQty =
      staged.entryPerpPrice > 0 ? staged.notionalUsd / staged.entryPerpPrice : 0.01;
    return buildPerpNewOrderIntent({
      network,
      accountID: parsedAccountId,
      symbolID: staged.perpSymbolId ?? 1,
      nonce: nonceSeed,
      builder: activeBuilder,
      side: 'SELL', // Short perp hedges Long spot
      orderType,
      timeInForce: tif,
      price: formatDecimalFixed(staged.entryPerpPrice, staged.perpPricePrecision ?? 1, 0.0001),
      quantity: formatDecimalFixed(perpQty, staged.perpQuantityPrecision ?? 4, 0.0001),
      reduceOnly: false,
    });
  }, [staged, legChoice, network, parsedAccountId, nonceSeed, activeBuilder]);

  if (!staged) return null;

  const isBlocked = staged.guardrails.overallStatus === 'BLOCK';
  const netCfg = SODEX_NETWORKS[network];
  const needsMainnetAck = network === 'mainnet' && !mainnetSafetyAck;
  const accountStatePath = isSpotAction
    ? `/spot/accounts/{address}/state`
    : `/perps/accounts/{address}/state`;
  const previewEndpointUrl = `${netCfg.restBase}${isSpotAction ? '/spot/trade/orders/batch' : '/perps/trade/orders'}`;
  const canCopySubmitCurl =
    Boolean(signedEnvelope) &&
    signedEnvelope?.mode === 'WALLET_EIP1193' &&
    hasResolvedAccountId;

  const handleConnectOrSignWallet = async () => {
    setSignError(null);
    if (!wallet.address) {
      await wallet.connect();
      return;
    }
    if (!hasResolvedAccountId || !activeIntent) {
      setSignError(
        `Wallet signing is blocked until an activated ${activeDomainKey} accountID is resolved from ${accountStatePath} on ${netCfg.label}.`,
      );
      return;
    }
    setSigning(true);
    try {
      const env = await signIntentWithInjectedWallet(activeIntent, wallet.address);
      setSignedEnvelope(env);
      setSignedNoncesByLeg((prev) => ({
        ...prev,
        [isSpotAction ? 'spot' : 'perp']: env.intent.nonceStr,
      }));
    } catch (err) {
      setSignError(err instanceof Error ? err.message : 'Wallet EIP-712 signing rejected or failed');
    } finally {
      setSigning(false);
    }
  };

  const handleDryRunSign = async () => {
    setSignError(null);
    if (!activeIntent) {
      setSignError(
        'Enter a positive numeric test accountID (or connect an activated SoDEX wallet) before running local ecrecover verification.',
      );
      return;
    }
    setSigning(true);
    try {
      const env = await signIntentWithEphemeralDryRunKey(activeIntent);
      setSignedEnvelope(env);
      setSignedNoncesByLeg((prev) => ({
        ...prev,
        [isSpotAction ? 'spot' : 'perp']: env.intent.nonceStr,
      }));
    } catch (err) {
      setSignError(err instanceof Error ? err.message : 'Local cryptographic dry-run failed');
    } finally {
      setSigning(false);
    }
  };

  const handleCopyCurl = async () => {
    if (!signedEnvelope || !canCopySubmitCurl) return;
    try {
      await navigator.clipboard.writeText(signedEnvelope.curlCommand);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    } catch {
      // ignore clipboard errors in headless environments
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm">
      <div className="panel-surface max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-xl p-4 sm:p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2.5">
            {isBlocked ? (
              <ShieldAlert className="h-5 w-5 text-rose-400" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            )}
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Pre-Trade Risk Gate &amp; SoDEX EIP-712 Order Signer
              </h3>
              <p className="text-xs text-slate-400">
                Non-custodial <code className="text-sky-300">ExchangeAction</code> typed-data builder &amp; cryptographic verifier (zero silent broadcast)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Mode Switcher */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-lg border border-slate-800 bg-[#080B10] p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('eip712')}
              className={`rounded-md px-3 py-1 font-semibold transition ${
                mode === 'eip712'
                  ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/35'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              SoDEX EIP-712 Signer
            </button>
            <button
              type="button"
              onClick={() => setMode('paper')}
              className={`rounded-md px-3 py-1 font-semibold transition ${
                mode === 'paper'
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Paper Blotter Only
            </button>
          </div>

          <span
            className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
              isBlocked
                ? 'border border-rose-500/35 bg-rose-500/15 text-rose-300'
                : staged.guardrails.overallStatus === 'WARN'
                  ? 'border border-amber-500/35 bg-amber-500/15 text-amber-300'
                  : 'border border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
            }`}
          >
            RISK GATE: {staged.guardrails.overallStatus}
          </span>
        </div>

        {/* Compact Trade & Guardrail Summary */}
        <div className="mt-2.5 grid grid-cols-2 gap-2 rounded-lg border border-slate-800/80 bg-[#080B10] px-3 py-2 text-xs sm:grid-cols-4">
          <div>
            <span className="text-[10px] uppercase text-slate-500">Instrument</span>
            <p className="font-mono font-semibold text-slate-100">{staged.symbol}</p>
          </div>
          <div>
            <span className="text-[10px] uppercase text-slate-500">Spot Leg</span>
            <p className="truncate font-mono text-sky-300">{staged.spotSymbol}</p>
          </div>
          <div>
            <span className="text-[10px] uppercase text-slate-500">Notional / Lev</span>
            <p className="font-mono font-semibold text-slate-100 tabular-nums">
              {formatUsd(staged.notionalUsd, 0)} • {staged.leverage}x
            </p>
          </div>
          <div>
            <span className="text-[10px] uppercase text-slate-500">Est. Fees / APY</span>
            <p className="font-mono font-semibold text-emerald-300 tabular-nums">
              {formatUsd(staged.estimatedFeesUsd)} • {formatPct(staged.expectedNetApyPct)}
            </p>
          </div>
        </div>

        {/* Guardrail Checks Compact Bar */}
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {staged.guardrails.checks.map((check) => (
            <div
              key={check.ruleId}
              className="flex flex-col justify-between rounded-lg border border-slate-800/80 bg-[#080B10]/60 px-2 py-1.5 text-[10px]"
            >
              <div className="flex items-center gap-1 truncate">
                {check.status === 'PASS' ? (
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />
                ) : check.status === 'WARN' ? (
                  <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
                ) : (
                  <ShieldAlert className="h-3 w-3 shrink-0 text-rose-400" />
                )}
                <span className="truncate text-slate-400">{check.ruleId.replace('_', ' ')}</span>
              </div>
              <span className="mt-0.5 font-mono text-[11px] font-semibold text-slate-100 tabular-nums">
                {check.measured}
              </span>
            </div>
          ))}
        </div>

        {isBlocked ? (
          <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/12 p-3 text-xs text-rose-200">
            Execution blocked by Desk Risk Policy. Reduce leverage, lower notional size, or switch to Maker Post-Only execution to clear blocked rules before signing.
          </div>
        ) : mode === 'eip712' ? (
          <div className="mt-3 space-y-2.5">
            {/* Target Network + Leg + AccountID Controls */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <div className="rounded-lg border border-slate-800 bg-[#080B10]/80 p-2 sm:col-span-4">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Signing Domain Chain
                </span>
                <div className="mt-1 grid grid-cols-2 gap-1">
                  {(['testnet', 'mainnet'] as const).map((net) => (
                    <button
                      key={net}
                      type="button"
                      onClick={() => {
                        setNetwork(net);
                        allocateFreshNonce();
                        setSignedEnvelope(null);
                        setMainnetSafetyAck(false);
                      }}
                      className={`whitespace-nowrap rounded px-2 py-1 font-mono text-[10.5px] font-semibold transition ${
                        network === net
                          ? net === 'mainnet'
                            ? 'bg-rose-500/20 text-rose-200 ring-1 ring-rose-500/45'
                            : 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-500/40'
                          : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {net === 'testnet' ? 'Test 138565' : 'Main 286623'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#080B10]/80 p-2 sm:col-span-5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  SoDEX Action Type (Distinct Nonce / Leg)
                </span>
                {staged.strategyType === 'DELTA_NEUTRAL_BASIS' ? (
                  <div className="mt-1 grid grid-cols-2 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (legChoice !== 'spot') {
                          setLegChoice('spot');
                          allocateFreshNonce();
                          setSignedEnvelope(null);
                        }
                      }}
                      className={`whitespace-nowrap rounded px-2 py-1 font-mono text-[10.5px] font-semibold transition ${
                        legChoice === 'spot'
                          ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/40'
                          : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Spot batchNewOrder
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (legChoice !== 'perp') {
                          setLegChoice('perp');
                          allocateFreshNonce();
                          setSignedEnvelope(null);
                        }
                      }}
                      className={`whitespace-nowrap rounded px-2 py-1 font-mono text-[10.5px] font-semibold transition ${
                        legChoice === 'perp'
                          ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-400/40'
                          : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Perp newOrder
                    </button>
                  </div>
                ) : (
                  <div className="mt-1.5 font-mono text-[11px] font-semibold text-violet-300">
                    spot / batchNewOrder ({staged.ssiBatchLegs?.length ?? 1} legs)
                  </div>
                )}
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#080B10]/80 p-2 sm:col-span-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {activeDomainKey} accountID
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      allocateFreshNonce();
                      setSignedEnvelope(null);
                    }}
                    className="font-mono text-[10px] text-sky-400 hover:text-sky-300"
                  >
                    New Nonce
                  </button>
                </div>
                <input
                  type="number"
                  min={1}
                  placeholder="Unresolved"
                  value={accountIdInput}
                  onChange={(e) => {
                    setAccountIdInput(e.target.value);
                    setSignedEnvelope(null);
                  }}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs text-slate-100 placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                />
              </div>
            </div>

            {/* Optional SoDEX Builder Fee Attribution + Per-Order Cost Breakdown */}
            <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-800/80 bg-[#080B10]/80 p-2.5 sm:grid-cols-12">
              <div className="sm:col-span-5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Optional SoDEX Builder Attribution (omitempty)
                  </span>
                  <span className="font-mono text-[9.5px] text-slate-500">
                    {activeBuilder ? `id:${activeBuilder.id} fee:${(activeBuilder.fee / 10).toFixed(1)}bp` : 'Omitted'}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  <input
                    type="number"
                    min={1}
                    placeholder="builder.id"
                    value={builderIdInput}
                    onChange={(e) => {
                      setBuilderIdInput(e.target.value);
                      allocateFreshNonce();
                      setSignedEnvelope(null);
                    }}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    placeholder="fee (0.1bp)"
                    value={builderFeeInput}
                    onChange={(e) => {
                      setBuilderFeeInput(e.target.value);
                      allocateFreshNonce();
                      setSignedEnvelope(null);
                    }}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[11px] text-slate-100 placeholder:text-slate-600 focus:border-sky-400 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-4 gap-1.5 font-mono text-[10.5px] tabular-nums sm:col-span-7">
                <div className="rounded border border-slate-800/80 bg-slate-950/70 px-2 py-1">
                  <div className="font-sans text-[9.5px] text-slate-500">Margin ({staged.leverage}x)</div>
                  <div className="text-slate-200">{formatUsd(staged.notionalUsd / Math.max(1, staged.leverage), 0)}</div>
                </div>
                <div className="rounded border border-slate-800/80 bg-slate-950/70 px-2 py-1">
                  <div className="font-sans text-[9.5px] text-slate-500">SoDEX Fee</div>
                  <div className="text-rose-300">-{formatUsd(staged.estimatedFeesUsd)}</div>
                </div>
                <div className="rounded border border-slate-800/80 bg-slate-950/70 px-2 py-1">
                  <div className="font-sans text-[9.5px] text-slate-500">Builder Fee</div>
                  <div className="text-amber-300">
                    {activeBuilder
                      ? `-${formatUsd(staged.notionalUsd * (activeBuilder.fee / 100000))}`
                      : '$0.00'}
                  </div>
                </div>
                <div className="rounded border border-slate-800/80 bg-slate-950/70 px-2 py-1">
                  <div className="font-sans text-[9.5px] text-slate-500">24h Funding</div>
                  <div className="text-emerald-300">
                    {staged.entryHourlyFundingRate >= 0 ? '+' : ''}
                    {formatUsd(staged.notionalUsd * staged.entryHourlyFundingRate * 24)}
                  </div>
                </div>
              </div>
            </div>

            {/* Resolved AccountID Status Gate */}
            {hasResolvedAccountId ? (
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200">
                <span>
                  Resolved live {activeDomainKey} accountID{' '}
                  <strong className="font-mono">{resolvedAccountId}</strong> from{' '}
                  <code className="text-emerald-100">{accountStatePath}</code>
                </span>
                <span className="font-mono text-[10px] text-emerald-300">ACCOUNT VERIFIED</span>
              </div>
            ) : (
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <strong className="text-amber-100">Account ID not resolved from SoDEX state:</strong>{' '}
                No activated <code className="text-amber-100">{activeDomainKey}</code> accountID was returned by{' '}
                <code className="text-amber-100">{accountStatePath}</code> on {netCfg.label}. Wallet signing and cURL submit copy remain disabled until a live accountID resolves. You may enter a positive test ID above solely for non-submittable local <code className="text-amber-100">ecrecover</code> schema checks.
              </div>
            )}

            {/* Explicit Mainnet Safety Gate */}
            {network === 'mainnet' && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                <input
                  type="checkbox"
                  checked={mainnetSafetyAck}
                  onChange={(e) => setMainnetSafetyAck(e.target.checked)}
                  className="mt-0.5 rounded border-rose-500 bg-slate-950 text-rose-500 focus:ring-rose-500"
                />
                <span>
                  <strong className="text-rose-100">MAINNET SAFETY CONFIRMATION (Chain ID 286623):</strong>{' '}
                  I understand this builds a real SoDEX ValueChain Mainnet <code className="text-rose-100">ExchangeAction</code> EIP-712 signature. BasisDesk signs locally for verification only and will <strong>never auto-broadcast</strong> to <code className="text-rose-100">mainnet-gw.sodex.dev</code>.
                </span>
              </label>
            )}

            {/* Exact EIP-712 Typed Data Breakdown */}
            <div className="rounded-xl border border-slate-800 bg-[#070A10] p-3.5 font-mono text-[11px]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2">
                <div className="flex items-center gap-1.5 font-sans text-xs font-semibold text-slate-100">
                  <FileCode2 className="h-3.5 w-3.5 text-sky-400" />
                  <span>EIP-712 ExchangeAction Typed-Data Envelope</span>
                </div>
                {activeIntent && (
                  <button
                    type="button"
                    onClick={() => setShowRawJson((v) => !v)}
                    className="text-[10.5px] text-sky-400 hover:text-sky-300"
                  >
                    {showRawJson ? 'Hide Canonical JSON' : 'Inspect Full Typed JSON'}
                  </button>
                )}
              </div>

              <div className="mt-2.5 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">domain.name / version</span>
                  <span className="text-sky-300">
                    &quot;{isSpotAction ? 'spot' : 'futures'}&quot; / v1
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">domain.chainId</span>
                  <span className={network === 'mainnet' ? 'text-rose-300' : 'text-emerald-300'}>
                    {netCfg.chainId} ({netCfg.chainIdHex})
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">primaryType</span>
                  <span className="text-slate-100">ExchangeAction</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">nonce (monotonic uint64)</span>
                  <span className="text-slate-200 tabular-nums">{nonceSeed.toString()}</span>
                </div>
                {(signedNoncesByLeg.spot || signedNoncesByLeg.perp) && (
                  <div className="flex justify-between gap-2 sm:col-span-2">
                    <span className="shrink-0 text-slate-500">Session leg nonces</span>
                    <span className="truncate text-emerald-300 tabular-nums">
                      Spot: {signedNoncesByLeg.spot ?? 'pending'} • Perp: {signedNoncesByLeg.perp ?? 'pending'}
                    </span>
                  </div>
                )}
                <div className="flex justify-between gap-2 sm:col-span-2">
                  <span className="shrink-0 text-slate-500">verifyingContract</span>
                  <span className="truncate text-slate-300">
                    {netCfg.verifyingContract}
                  </span>
                </div>
                <div className="flex justify-between gap-2 sm:col-span-2">
                  <span className="shrink-0 text-slate-500">payloadHash (bytes32)</span>
                  <span className="truncate text-emerald-300">
                    {activeIntent ? activeIntent.payloadHash : 'Awaiting valid accountID'}
                  </span>
                </div>
                <div className="flex justify-between gap-2 sm:col-span-2">
                  <span className="shrink-0 text-slate-500">EIP-712 digest</span>
                  <span className="truncate text-violet-300">
                    {activeIntent ? activeIntent.typedDataHash : 'Awaiting valid accountID'}
                  </span>
                </div>
                <div className="flex justify-between gap-2 sm:col-span-2">
                  <span className="shrink-0 text-slate-500">Target Endpoint</span>
                  <span className="truncate text-slate-300">
                    POST {activeIntent ? activeIntent.endpointUrl : previewEndpointUrl}
                  </span>
                </div>
              </div>

              {showRawJson && activeIntent && (
                <pre className="mt-2.5 max-h-44 overflow-auto rounded-lg border border-slate-800 bg-[#04060A] p-2.5 text-[10px] leading-relaxed text-sky-200">
                  {JSON.stringify(
                    {
                      eth_signTypedData_v4: activeIntent.ethSignTypedDataV4Payload,
                      canonicalSignedObject: JSON.parse(activeIntent.canonicalSigningJson),
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
            </div>

            {/* Action Buttons: Wallet Sign (requires resolved accountID) OR Local Cryptographic Dry-Run */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={
                  signing ||
                  wallet.connecting ||
                  (Boolean(wallet.address) && (!hasResolvedAccountId || needsMainnetAck))
                }
                onClick={() => void handleConnectOrSignWallet()}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2.5 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
              >
                <Wallet className="h-3.5 w-3.5" />
                {signing
                  ? 'Awaiting Signature...'
                  : !wallet.address
                    ? 'Connect Wallet to Resolve accountID'
                    : hasResolvedAccountId
                      ? `Sign via Wallet (${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)})`
                      : `Wallet Sign Blocked (No ${activeDomainKey} accountID)`}
              </button>

              <button
                type="button"
                disabled={signing || needsMainnetAck || !activeIntent}
                onClick={() => void handleDryRunSign()}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/12 px-3.5 py-2.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                {activeIntent
                  ? 'Local ecrecover Schema Check (Non-Submittable)'
                  : 'Enter Test ID for Local ecrecover Check'}
              </button>
            </div>

            {wallet.address && wallet.chainId !== netCfg.chainId && (
              <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                <span>
                  Wallet connected on Chain {wallet.chainId}; signing domain targets Chain {netCfg.chainId}.
                </span>
                <button
                  type="button"
                  onClick={() => void requestSwitchToValueChain(network).catch(() => undefined)}
                  className="ml-2 shrink-0 rounded bg-amber-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-100 hover:bg-amber-500/30"
                >
                  Switch Chain
                </button>
              </div>
            )}

            {(signError || wallet.error) && (
              <div className="rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                {signError ?? wallet.error}
              </div>
            )}

            {/* Verified Signature Output Panel */}
            {signedEnvelope && (
              <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/8 p-3 font-mono text-[10.5px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-sans text-xs font-semibold text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    <span>
                      {signedEnvelope.verified
                        ? 'Local secp256k1 ecrecover MATCH (0x01 Prefix Verified)'
                        : 'Signature Verification Mismatch'}
                    </span>
                  </div>
                  <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                    {signedEnvelope.mode === 'WALLET_EIP1193'
                      ? 'EIP-1193 WALLET SIGNED'
                      : 'EPHEMERAL DRY-RUN (UNREGISTERED)'}
                  </span>
                </div>

                <div className="mt-1.5 space-y-0.5 break-all text-[10.5px] text-slate-200">
                  <div>
                    <span className="text-slate-400">Signer / Recovered: </span>
                    <span className="text-emerald-300">{signedEnvelope.recoveredAddress}</span>
                    <span className="ml-3 text-slate-400">clOrdID: </span>
                    <span>{signedEnvelope.intent.clOrdIds.join(', ')}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">X-API-Sign (66B, 0x01 prefix): </span>
                    <span className="text-sky-200">{signedEnvelope.typedWireSignature}</span>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-emerald-500/20 pt-2">
                  <span className="max-w-lg font-sans text-[11px] leading-snug text-slate-300">
                    Master-wallet signatures omit <code className="text-sky-300">X-API-Key</code>; a registered API key is what SoDEX recommends for trading. This dry-run key is not registered and must not be posted.
                  </span>
                  <button
                    type="button"
                    disabled={!canCopySubmitCurl}
                    onClick={() => void handleCopyCurl()}
                    title={
                      canCopySubmitCurl
                        ? 'Copy signed cURL for manual submission'
                        : 'Submit cURL copy is disabled unless signed by a connected wallet with a live accountID resolved from SoDEX account state'
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2.5 py-1 font-sans text-[11px] font-medium text-slate-200 hover:border-sky-500/50 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {copiedCurl ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-400" />
                        Copied Signed cURL
                      </>
                    ) : canCopySubmitCurl ? (
                      <>
                        <Copy className="h-3 w-3" />
                        Copy Signed cURL
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        cURL Copy Disabled (Dry-Run)
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={paperAckChecked}
              onChange={(e) => setPaperAckChecked(e.target.checked)}
              className="mt-0.5 rounded border-slate-600 bg-slate-950 text-sky-400 focus:ring-sky-500"
            />
            <span>
              I confirm this is a <strong>paper-trading simulation</strong> logged locally in BasisDesk. No private keys are stored, no live on-chain funds are moved, and analytics do not constitute financial advice.
            </span>
          </label>
        )}

        {/* Footer Actions */}
        <div className="mt-3.5 flex items-center justify-end gap-2.5 border-t border-slate-800/80 pt-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>

          {mode === 'eip712' ? (
            <button
              type="button"
              disabled={isBlocked || !signedEnvelope?.verified}
              onClick={() => {
                if (!signedEnvelope) return;
                onConfirm({
                  executionChannel:
                    signedEnvelope.mode === 'WALLET_EIP1193'
                      ? 'EIP712_WALLET_SIGNED'
                      : 'EIP712_DRY_RUN',
                  eip712Network: signedEnvelope.intent.network,
                  eip712Signer: signedEnvelope.recoveredAddress,
                  eip712Digest: signedEnvelope.intent.typedDataHash,
                  clOrdId: signedEnvelope.intent.clOrdIds[0],
                  typedSignaturePreview: `${signedEnvelope.typedWireSignature.slice(0, 18)}...${signedEnvelope.typedWireSignature.slice(-8)}`,
                });
              }}
              className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                isBlocked || !signedEnvelope?.verified
                  ? 'cursor-not-allowed bg-slate-800 text-slate-500'
                  : 'bg-emerald-500 text-slate-950 shadow-sm hover:bg-emerald-400'
              }`}
            >
              Log Verified EIP-712 Intent to Blotter
            </button>
          ) : (
            <button
              type="button"
              disabled={isBlocked || !paperAckChecked}
              onClick={() => {
                setPaperAckChecked(false);
                onConfirm({ executionChannel: 'PAPER' });
              }}
              className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              Commit to Paper Blotter
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function TelemetrySettingsModal({
  open,
  onClose,
  telemetry,
  snapshotGeneratedAt,
  sosoConnecting,
  sosoError,
  onConnectSoSoKey,
}: {
  open: boolean;
  onClose: () => void;
  telemetry: Record<FeedTelemetry['id'], FeedTelemetry>;
  snapshotGeneratedAt: string;
  sosoConnecting: boolean;
  sosoError: string | null;
  onConnectSoSoKey: (key: string) => Promise<boolean>;
}) {
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connectedBanner, setConnectedBanner] = useState(false);

  if (!open) return null;

  const list = Object.values(telemetry);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="panel-surface w-full max-w-2xl rounded-xl p-6">
        <div className="flex items-start justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <Radio className="h-5 w-5 text-sky-400" />
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Data Provenance &amp; Live Feed Telemetry
              </h3>
              <p className="text-xs text-slate-400">
                Honest status across SoDEX Mainnet, ValueChain EVM RPC, and SoSoValue Open API v1
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Feed Status Grid */}
        <div className="mt-4 space-y-2.5">
          {list.map((feed) => (
            <div
              key={feed.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/90 bg-[#080B10]/80 px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-100">{feed.label}</span>
                  <TelemetryBadge status={feed.status} compact />
                </div>
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                  {feed.endpoint}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">{feed.detail}</p>
              </div>
              <div className="text-right font-mono text-[11px] text-slate-400 tabular-nums">
                <div>{feed.latencyMs !== null ? `${feed.latencyMs} ms` : 'Streaming'}</div>
                <div className="text-[10px] text-slate-500">{formatTimeUtc(feed.lastUpdatedIso)}</div>
              </div>
            </div>
          ))}
        </div>

        {/* BYOK SoSoValue Open API Section */}
        <div className="mt-5 rounded-xl border border-sky-500/25 bg-sky-500/5 p-4">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-sky-400" />
            <h4 className="text-xs font-semibold text-slate-100">
              Upgrade SoSoValue Open API v1 to Live Direct Mode (BYOK)
            </h4>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
            SoDEX Mainnet REST/WS and ValueChain EVM RPC stream publicly with zero API keys. SoSoValue Open API v1 (<code className="text-sky-300">openapi.sosovalue.com</code>) supports browser CORS with your free <code className="text-sky-300">x-soso-api-key</code> header. Keys remain strictly in browser memory and are never persisted.
          </p>

          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={async (e) => {
              e.preventDefault();
              setConnectedBanner(false);
              const ok = await onConnectSoSoKey(apiKeyInput);
              if (ok) {
                setConnectedBanner(true);
                setApiKeyInput('');
              }
            }}
          >
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="Paste x-soso-api-key (optional — free tier 10k calls/mo)"
              className="flex-1 rounded-lg border border-slate-700 bg-[#080B10] px-3 py-2 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
            />
            <button
              type="submit"
              disabled={sosoConnecting || !apiKeyInput.trim()}
              className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              {sosoConnecting ? 'Verifying...' : 'Connect Live Direct'}
            </button>
          </form>

          {sosoError && (
            <p className="mt-2 text-xs text-rose-300">Authentication error: {sosoError}</p>
          )}
          {connectedBanner && (
            <p className="mt-2 text-xs text-emerald-300">
              Verified! ETF flows, macro overview, SSI constituents, and research wire are now streaming live direct from SoSoValue Open API v1.
            </p>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>
            Snapshot artifact captured: <span className="font-mono text-slate-400">{formatTimeUtc(snapshotGeneratedAt)}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
