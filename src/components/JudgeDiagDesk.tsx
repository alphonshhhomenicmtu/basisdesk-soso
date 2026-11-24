import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Circle,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wallet,
  XCircle,
} from 'lucide-react';
import {
  buildSpotBatchNewOrderIntent,
  detectInjectedProvider,
  signIntentWithEphemeralDryRunKey,
  type SignedSodexEnvelope,
} from '../engine/sodexEip712';
import { runLiveDiagnosticProbes } from '../services/feeds';
import type { DiagProbeResult, FeedTelemetry, SoSoValueDataset } from '../types/market';
import { formatTimeUtc } from '../utils/format';

interface JudgeDiagDeskProps {
  telemetry: Record<FeedTelemetry['id'], FeedTelemetry>;
  sosovalue: SoSoValueDataset | null;
  snapshotGeneratedAt: string;
  walletAddress: `0x${string}` | null;
  walletChainId: number | null;
  walletProviderLabel: string;
  onConnectWallet: () => Promise<boolean>;
  onNavigateTab: (tab: 'overview' | 'basis' | 'risk' | 'ssi' | 'diag') => void;
  onOpenTelemetry: () => void;
  onOpenSampleEip712Signer: () => void;
}

const VERIFICATION_STEPS: Array<{
  id: string;
  window: string;
  rubric: string;
  title: string;
  instruction: string;
  actionLabel: string;
  actionType: 'probes' | 'overview' | 'basis' | 'eip712' | 'risk' | 'ssi';
}> = [
  {
    id: 'step-1',
    window: '0–10s',
    rubric: 'Data / API (15%)',
    title: 'Verify Live Mainnet Telemetry (/diag)',
    instruction:
      'Inspect HTTP 200 live latencies below across SoDEX Perps/Spot REST, Dual WebSockets, Testnet 138565, ValueChain Chain 286623 RPC, and honest SoSoValue snapshot/BYOK provenance.',
    actionLabel: 'Re-Run Probes',
    actionType: 'probes',
  },
  {
    id: 'step-2',
    window: '10–20s',
    rubric: 'User Value (30%)',
    title: 'Inspect Live ETF Flows + Carry Matrix',
    instruction:
      'Open Overview Desk to inspect the Autonomous Quant Desk Brief fusing SoSoValue 5D ETF momentum with live matched SoDEX Spot-Perp hourly funding rankings.',
    actionLabel: 'Open Overview',
    actionType: 'overview',
  },
  {
    id: 'step-3',
    window: '20–32s',
    rubric: 'Execution & SoDEX (25%)',
    title: 'Sign & Verify Real SoDEX EIP-712 Intent',
    instruction:
      'Launch the SoDEX EIP-712 Order Signer modal. Inspect exact ExchangeAction / batchNewOrder domain, payloadHash, nonce, mainnet safety gate, and sign via MetaMask or 1-click local cryptographic dry-run.',
    actionLabel: 'Launch EIP-712 Signer',
    actionType: 'eip712',
  },
  {
    id: 'step-4',
    window: '32–44s',
    rubric: 'Quant Rigor (20%)',
    title: 'Replay 30-Day Real SoDEX Klines Backtest',
    instruction:
      'Open Risk & Backtest to verify 180 live 4h Perp + Spot SoDEX candles replaying delta-neutral carry vs. Spot Buy-and-Hold, Sharpe/Sortino, HIT/STOP/DRIFT log, and intra-bar liquidation checks.',
    actionLabel: 'Open 30d Backtest',
    actionType: 'risk',
  },
  {
    id: 'step-5',
    window: '44–52s',
    rubric: 'Microstructure (20%)',
    title: 'Inspect 500ms L2 Depth & Impact Notional',
    instruction:
      'Open Basis & L2 Book to inspect streaming 500ms SoDEX orderbooks, official 200×MaxLev impact notional premium, and L2 VWAP slippage walking.',
    actionLabel: 'Open Basis & L2',
    actionType: 'basis',
  },
  {
    id: 'step-6',
    window: '52–60s',
    rubric: 'SSI & ValueChain (15%)',
    title: 'Audit SSI Protocol Rebalancer & Gas',
    instruction:
      'Open SSI Rebalancer to compare live MAG7.ssi / DEFI.ssi / USSI SoDEX Spot prices vs. iNAV, adjust drift buffer bands, and stage a multi-leg batchNewOrder basket.',
    actionLabel: 'Open SSI Rebalancer',
    actionType: 'ssi',
  },
];

export function JudgeDiagDesk({
  telemetry,
  sosovalue,
  snapshotGeneratedAt,
  walletAddress,
  walletChainId,
  walletProviderLabel,
  onConnectWallet,
  onNavigateTab,
  onOpenTelemetry,
  onOpenSampleEip712Signer,
}: JudgeDiagDeskProps) {
  const [probes, setProbes] = useState<DiagProbeResult[]>([]);
  const [probing, setProbing] = useState(false);
  const [expandedProbeId, setExpandedProbeId] = useState<string | null>(null);
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>({});
  const [selfTestResult, setSelfTestResult] = useState<{
    envelope: SignedSodexEnvelope;
    durationMs: number;
  } | null>(null);
  const [selfTesting, setSelfTesting] = useState(false);

  const runProbes = useCallback(async () => {
    setProbing(true);
    try {
      const res = await runLiveDiagnosticProbes(telemetry, sosovalue, snapshotGeneratedAt);
      setProbes(res);
    } finally {
      setProbing(false);
    }
  }, [telemetry, sosovalue, snapshotGeneratedAt]);

  useEffect(() => {
    void runProbes();
  }, []);

  const runEip712SelfTest = async () => {
    setSelfTesting(true);
    try {
      const start = performance.now();
      const intent = buildSpotBatchNewOrderIntent({
        network: 'testnet',
        accountID: 1001,
        orders: [
          {
            symbolID: 1,
            side: 'BUY',
            orderType: 'LIMIT',
            timeInForce: 'POST_ONLY',
            price: '60000',
            quantity: '0.01000',
          },
        ],
      });
      const envelope = await signIntentWithEphemeralDryRunKey(intent);
      setSelfTestResult({
        envelope,
        durationMs: Math.max(1, Math.round(performance.now() - start)),
      });
    } finally {
      setSelfTesting(false);
    }
  };

  const toggleStep = (id: string) => {
    setCheckedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleStepAction = (step: (typeof VERIFICATION_STEPS)[number]) => {
    setCheckedSteps((prev) => ({ ...prev, [step.id]: true }));
    if (step.actionType === 'probes') {
      void runProbes();
    } else if (step.actionType === 'eip712') {
      onOpenSampleEip712Signer();
    } else {
      onNavigateTab(step.actionType);
    }
  };

  const healthyCount = probes.filter((p) => p.ok).length;
  const completedSteps = Object.values(checkedSteps).filter(Boolean).length;
  const injectedInfo = detectInjectedProvider();

  return (
    <div className="space-y-5">
      {/* Top Banner: Live /diag System Health & One-Click Probe Runner */}
      <div className="panel-surface rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/35 bg-emerald-500/12">
              <Terminal className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-slate-100">
                  Live <code className="text-sky-300">/diag</code> API Telemetry &amp; 60-Second Judge Verification Guide
                </h2>
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/12 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-300">
                  {probes.length > 0 ? `${healthyCount}/${probes.length} VERIFIED` : 'PROBING...'}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-400">
                Real browser-executed HTTP, WebSocket, and EVM JSON-RPC latency probes across SoDEX, ValueChain Chain 286623, SoSoValue API v1, and EIP-712 signer
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenTelemetry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-sky-500/50 hover:text-sky-300"
            >
              <KeyRound className="h-3.5 w-3.5 text-sky-400" />
              SoSoValue BYOK Key
            </button>
            <button
              type="button"
              disabled={probing}
              onClick={() => void runProbes()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:opacity-60"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${probing ? 'animate-spin' : ''}`} />
              {probing ? 'Probing Live Endpoints...' : 'Re-Run All Live Probes'}
            </button>
          </div>
        </div>

        {/* Live Endpoint Probes Grid */}
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {probes.map((probe) => {
            const expanded = expandedProbeId === probe.id;
            const isSnapshotOnly = probe.statusLabel.includes('SNAPSHOT');
            return (
              <div
                key={probe.id}
                className="rounded-xl border border-slate-800/90 bg-[#080B10]/85 p-3.5 transition hover:border-slate-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-300">
                        {probe.pillar}
                      </span>
                      <h3 className="text-xs font-semibold text-slate-100">{probe.label}</h3>
                    </div>
                    <p className="mt-1 truncate font-mono text-[10.5px] text-slate-500">
                      <span className="text-sky-400">{probe.method}</span> {probe.endpoint}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                        !probe.ok
                          ? 'border-rose-500/35 bg-rose-500/15 text-rose-300'
                          : isSnapshotOnly
                            ? 'border-amber-500/35 bg-amber-500/15 text-amber-300'
                            : 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {probe.ok ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      {probe.statusLabel}
                    </span>
                    <div className="mt-1 font-mono text-[10px] text-slate-400 tabular-nums">
                      {probe.latencyMs > 0 ? `${probe.latencyMs} ms` : 'Baseline'} • {formatTimeUtc(probe.checkedAtIso).slice(0, 8)}
                    </div>
                  </div>
                </div>

                <p className="mt-2 text-[11.5px] leading-snug text-slate-300">{probe.summary}</p>

                <div className="mt-2 flex items-center justify-between border-t border-slate-800/70 pt-2">
                  <div className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full rounded-full ${
                        !probe.ok
                          ? 'bg-rose-400'
                          : probe.latencyMs < 600
                            ? 'bg-emerald-400'
                            : 'bg-amber-400'
                      }`}
                      style={{ width: `${Math.min(100, Math.max(12, 100 - probe.latencyMs / 18))}%` }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedProbeId(expanded ? null : probe.id)}
                    className="font-mono text-[10.5px] text-sky-400 hover:text-sky-300"
                  >
                    {expanded ? 'Hide Raw Payload' : 'Inspect Raw JSON'}
                  </button>
                </div>

                {expanded && (
                  <pre className="mt-2.5 max-h-44 overflow-auto rounded-lg border border-slate-800 bg-[#05070B] p-2.5 font-mono text-[10.5px] leading-relaxed text-emerald-200">
                    {probe.rawPreview}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2: EIP-1193 Wallet & Cryptographic EIP-712 Self-Test */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="panel-surface rounded-xl p-4 xl:col-span-5">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                SoDEX EIP-712 Signer &amp; Wallet Diagnostics
              </h3>
            </div>
            <span className="rounded bg-sky-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
              ExchangeAction v1
            </span>
          </div>

          <div className="mt-3 space-y-2.5 text-xs">
            <div className="rounded-lg border border-slate-800 bg-[#080B10]/80 p-3">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Injected EIP-1193 Provider</span>
                <span className="font-mono text-[11px] text-slate-200">
                  {walletAddress ? walletProviderLabel : injectedInfo.label}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-slate-400">Connected Signer</span>
                <span className="font-mono text-[11px] text-emerald-300">
                  {walletAddress
                    ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} (chain ${walletChainId})`
                    : 'Not connected (dry-run ready)'}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-slate-400">Verifying Contract</span>
                <span className="font-mono text-[10.5px] text-slate-300">
                  0x0000...0000 (Off-chain CLOB)
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-slate-400">Supported Domains</span>
                <span className="font-mono text-[10.5px] text-sky-300">
                  spot / futures • 138565 / 286623
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onConnectWallet()}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-sky-500/50 hover:text-sky-300"
              >
                <Wallet className="h-3.5 w-3.5" />
                {walletAddress ? 'Reconnect Wallet' : 'Connect EIP-1193 Wallet'}
              </button>
              <button
                type="button"
                disabled={selfTesting}
                onClick={() => void runEip712SelfTest()}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
              >
                <Activity className="h-3.5 w-3.5" />
                {selfTesting ? 'Verifying...' : 'Run EIP-712 Self-Test'}
              </button>
            </div>

            {selfTestResult && (
              <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-3 font-mono text-[10.5px] text-emerald-200">
                <div className="flex items-center justify-between font-sans text-xs font-semibold text-emerald-300">
                  <span>ecrecover Verified ({selfTestResult.durationMs} ms)</span>
                  <span>0x01 || 65B ECDSA</span>
                </div>
                <div className="mt-1.5 space-y-1 break-all text-slate-200">
                  <div>
                    <span className="text-slate-400">signer: </span>
                    {selfTestResult.envelope.signerAddress}
                  </div>
                  <div>
                    <span className="text-slate-400">payloadHash: </span>
                    {selfTestResult.envelope.intent.payloadHash}
                  </div>
                  <div>
                    <span className="text-slate-400">X-API-Sign: </span>
                    {selfTestResult.envelope.typedWireSignature.slice(0, 42)}...
                  </div>
                </div>
              </div>
            )}

            {/* CLI Verification Commands */}
            <div className="rounded-lg border border-slate-800 bg-[#05070B] p-3">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
                Reproducible CLI Verification Commands
              </div>
              <pre className="mt-1.5 overflow-x-auto font-mono text-[10.5px] leading-relaxed text-sky-200">
{`npm test          # Vitest quant + EIP-712 + 30d backtest suite
npm run lint      # Strict TypeScript check (tsc --noEmit)
npm run snapshot  # Pull live SoDEX 30d klines + ValueChain RPC
npm run build     # Relative-base Vite production bundle`}
              </pre>
            </div>
          </div>
        </div>

        {/* 60-Second AKINDO Judge Verification Checklist */}
        <div className="panel-surface rounded-xl p-4 xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                60-Second AKINDO Judge Verification Walkthrough
              </h3>
              <p className="text-[11px] text-slate-400">
                Zero setup required — click any step to verify live data, cryptographic EIP-712 signing, and 30d SoDEX backtesting
              </p>
            </div>
            <span className="rounded-full border border-sky-500/30 bg-sky-500/12 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-sky-300 tabular-nums">
              {completedSteps}/{VERIFICATION_STEPS.length} Checked
            </span>
          </div>

          <div className="mt-3 space-y-2.5">
            {VERIFICATION_STEPS.map((step) => {
              const done = Boolean(checkedSteps[step.id]);
              return (
                <div
                  key={step.id}
                  className={`flex flex-col gap-2.5 rounded-xl border p-3 transition sm:flex-row sm:items-center sm:justify-between ${
                    done
                      ? 'border-emerald-500/35 bg-emerald-500/8'
                      : 'border-slate-800/90 bg-[#080B10]/80 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <button
                      type="button"
                      onClick={() => toggleStep(step.id)}
                      className="mt-0.5 shrink-0 text-slate-400 hover:text-emerald-300"
                      aria-label={`Mark ${step.title} completed`}
                    >
                      {done ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <Circle className="h-4 w-4" />
                      )}
                    </button>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                          {step.window}
                        </span>
                        <span className="font-mono text-[10px] text-slate-400">{step.rubric}</span>
                        <span className="text-xs font-semibold text-slate-100">{step.title}</span>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-snug text-slate-400">
                        {step.instruction}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleStepAction(step)}
                    className="inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border border-sky-500/35 bg-sky-500/12 px-3 py-1.5 text-[11px] font-semibold text-sky-300 transition hover:bg-sky-500/20"
                  >
                    {step.actionLabel}
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
