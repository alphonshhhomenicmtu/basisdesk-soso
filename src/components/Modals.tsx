import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Radio,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { PreTradeGuardrailResult } from '../engine/ssiRebalancer';
import type { FeedTelemetry } from '../types/market';
import { formatPct, formatTimeUtc, formatUsd } from '../utils/format';
import { TelemetryBadge } from './TelemetryBadge';

export interface StagedPaperTrade {
  strategyType: 'DELTA_NEUTRAL_BASIS' | 'SSI_REBALANCE';
  symbol: string;
  spotSymbol: string;
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
}

export function ExecutionConfirmModal({
  staged,
  onCancel,
  onConfirm,
}: {
  staged: StagedPaperTrade | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [ackChecked, setAckChecked] = useState(false);

  if (!staged) return null;

  const isBlocked = staged.guardrails.overallStatus === 'BLOCK';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="panel-surface w-full max-w-lg rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            {isBlocked ? (
              <ShieldAlert className="h-5 w-5 text-rose-400" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            )}
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                Pre-Trade Risk Gate &amp; Paper Confirmation
              </h3>
              <p className="text-xs text-slate-400">
                2-step institutional control check — zero custody, simulated blotter execution
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

        {/* Trade Summary */}
        <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg bg-[#080B10] p-3.5 text-xs border border-slate-800/80">
          <div>
            <span className="text-slate-500">Instrument</span>
            <p className="mt-0.5 font-mono font-semibold text-slate-100">
              {staged.symbol} / {staged.spotSymbol}
            </p>
          </div>
          <div>
            <span className="text-slate-500">Strategy Leg</span>
            <p className="mt-0.5 font-mono font-medium text-sky-300">
              {staged.direction === 'LONG_SPOT_SHORT_PERP'
                ? `Long Spot + ${staged.leverage}x Short Perp`
                : 'SSI Basket Rebalance'}
            </p>
          </div>
          <div>
            <span className="text-slate-500">Notional Size</span>
            <p className="mt-0.5 font-mono font-semibold text-slate-100 tabular-nums">
              {formatUsd(staged.notionalUsd, 0)}
            </p>
          </div>
          <div>
            <span className="text-slate-500">Est. Friction / Net APY</span>
            <p className="mt-0.5 font-mono font-semibold text-emerald-300 tabular-nums">
              {formatUsd(staged.estimatedFeesUsd)} • {formatPct(staged.expectedNetApyPct)}
            </p>
          </div>
        </div>

        {/* Guardrail Audit */}
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-slate-300">Automated Risk Guardrails</span>
            <span
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                isBlocked
                  ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                  : staged.guardrails.overallStatus === 'WARN'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
              }`}
            >
              {staged.guardrails.overallStatus}
            </span>
          </div>

          <div className="divide-y divide-slate-800/80 rounded-lg border border-slate-800 bg-[#080B10]/70">
            {staged.guardrails.checks.map((check) => (
              <div key={check.ruleId} className="flex items-center justify-between px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  {check.status === 'PASS' ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : check.status === 'WARN' ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5 text-rose-400" />
                  )}
                  <span className="text-slate-300">{check.label}</span>
                </div>
                <div className="flex items-center gap-2 font-mono tabular-nums">
                  <span className="text-slate-100">{check.measured}</span>
                  <span className="text-[10px] text-slate-500">({check.limit})</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {isBlocked ? (
          <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200">
            Execution blocked by Desk Risk Policy. Reduce leverage, tighten notional size, or switch to Maker limit execution to clear blocked rules.
          </div>
        ) : (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={ackChecked}
              onChange={(e) => setAckChecked(e.target.checked)}
              className="mt-0.5 rounded border-slate-600 bg-slate-950 text-sky-400 focus:ring-sky-500"
            />
            <span>
              I confirm this is a <strong>paper-trading simulation</strong> logged locally in BasisDesk. No private keys are stored, no live on-chain funds are moved, and analytics do not constitute financial advice.
            </span>
          </label>
        )}

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isBlocked || !ackChecked}
            onClick={() => {
              setAckChecked(false);
              onConfirm();
            }}
            className="rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-slate-950 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
          >
            Commit to Paper Blotter
          </button>
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
            Hourly CI snapshot artifact captured: <span className="font-mono text-slate-400">{formatTimeUtc(snapshotGeneratedAt)}</span>
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
