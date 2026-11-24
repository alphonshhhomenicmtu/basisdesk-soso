import { useState } from 'react';
import {
  Activity,
  BookOpen,
  Cpu,
  Layers,
  LayoutDashboard,
  Radio,
  ShieldCheck,
} from 'lucide-react';
import { BasisOrderbookDesk } from './components/BasisOrderbookDesk';
import {
  ExecutionConfirmModal,
  type StagedPaperTrade,
  TelemetrySettingsModal,
} from './components/Modals';
import { OverviewDesk } from './components/OverviewDesk';
import { RiskStressLab } from './components/RiskStressLab';
import { SsiRebalancerDesk } from './components/SsiRebalancerDesk';
import { TelemetryBadge } from './components/TelemetryBadge';
import { useDeskData } from './hooks/useDeskData';

type WorkspaceTab = 'overview' | 'basis' | 'risk' | 'ssi';

const TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview Desk', icon: LayoutDashboard },
  { id: 'basis', label: 'Basis & L2 Book', icon: BookOpen },
  { id: 'risk', label: 'Risk Stress Lab', icon: Cpu },
  { id: 'ssi', label: 'SSI Rebalancer', icon: Layers },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [selectedPerpSymbol, setSelectedPerpSymbol] = useState('BTC-USD');
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [stagedTrade, setStagedTrade] = useState<StagedPaperTrade | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const desk = useDeskData(selectedPerpSymbol);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 4200);
  };

  const handleSelectPairAndNavigate = (perpSymbol: string, tab: 'basis' | 'risk') => {
    setSelectedPerpSymbol(perpSymbol);
    setActiveTab(tab);
  };

  const handleConfirmPaperTrade = () => {
    if (!stagedTrade) return;
    desk.addPaperOrder({
      strategyType: stagedTrade.strategyType,
      symbol: stagedTrade.symbol,
      spotSymbol: stagedTrade.spotSymbol,
      direction: stagedTrade.direction,
      notionalUsd: stagedTrade.notionalUsd,
      leverage: stagedTrade.leverage,
      entrySpotPrice: stagedTrade.entrySpotPrice,
      entryPerpPrice: stagedTrade.entryPerpPrice,
      entryHourlyFundingRate: stagedTrade.entryHourlyFundingRate,
      expectedNetApyPct: stagedTrade.expectedNetApyPct,
      estimatedFeesUsd: stagedTrade.estimatedFeesUsd,
      liquidationBufferPct: stagedTrade.liquidationBufferPct,
      guardrailStatus: stagedTrade.guardrails.overallStatus === 'WARN' ? 'WARN' : 'PASS',
      notes: stagedTrade.notes,
    });
    const sym = stagedTrade.symbol;
    setStagedTrade(null);
    showToast(`Paper execution logged for ${sym} — live MTM active in Overview Blotter.`);
  };

  return (
    <div className="terminal-grid-bg min-h-screen text-slate-100">
      {/* Top Institutional Command Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#080B10]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          {/* Brand Lockup */}
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-400/40 bg-gradient-to-br from-sky-500/25 to-emerald-500/15 shadow-sm">
              <Activity className="h-5 w-5 text-sky-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base font-bold tracking-tight text-slate-50">
                  BasisDesk
                </span>
                <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                  QUANT TERMINAL
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                One-Person On-Chain Quant Desk • SoSoValue × SoDEX × ValueChain × SSI
              </p>
            </div>
          </div>

          {/* Primary Workspace Navigation */}
          <nav className="flex items-center gap-1 rounded-xl border border-slate-800/90 bg-[#0C111A] p-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition whitespace-nowrap ${
                    active
                      ? 'bg-sky-500/18 text-sky-200 shadow-sm ring-1 ring-sky-400/30'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Live Feed Telemetry Strip */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTelemetryOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0D131D] px-2.5 py-1.5 text-xs transition hover:border-sky-500/40"
              title="Inspect live API endpoints and configure SoSoValue BYOK key"
            >
              <Radio className="h-3.5 w-3.5 text-sky-400" />
              <TelemetryBadge
                status={desk.telemetry.sodex_perps.status}
                label={
                  desk.telemetry.sodex_perps.status === 'LIVE_WS'
                    ? `SODEX WS`
                    : desk.telemetry.sodex_perps.status === 'LIVE_REST'
                      ? 'SODEX REST'
                      : 'SODEX SNAP'
                }
                compact
              />
              <TelemetryBadge
                status={desk.telemetry.sosovalue_api.status}
                label={
                  desk.telemetry.sosovalue_api.status === 'LIVE_DIRECT'
                    ? 'SOSO LIVE'
                    : 'SOSO SNAP'
                }
                compact
              />
            </button>
          </div>
        </div>
      </header>

      {/* Main Terminal Content */}
      <main className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
        {toastMsg && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-500/35 bg-emerald-500/12 px-4 py-2.5 text-xs text-emerald-200">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span>{toastMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setToastMsg(null)}
              className="text-emerald-300 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'overview' && (
          <OverviewDesk
            opportunities={desk.basisOpportunities}
            spotTickers={desk.spotTickers}
            valueChain={desk.valueChain}
            sosovalue={desk.sosovalue}
            deskBrief={desk.deskBrief}
            telemetry={desk.telemetry}
            paperOrders={desk.paperOrders}
            onSelectPairAndNavigate={handleSelectPairAndNavigate}
            onNavigateTab={setActiveTab}
            onOpenTelemetry={() => setTelemetryOpen(true)}
            onClosePaperOrder={desk.closePaperOrder}
            onResetPaperOrders={desk.resetPaperOrders}
          />
        )}

        {activeTab === 'basis' && (
          <BasisOrderbookDesk
            selectedPerpSymbol={selectedPerpSymbol}
            onSelectPerpSymbol={setSelectedPerpSymbol}
            opportunities={desk.basisOpportunities}
            perpSymbols={desk.perpSymbols}
            spotSymbols={desk.spotSymbols}
            perpBooks={desk.perpBooks}
            spotBooks={desk.spotBooks}
            recentTrades={desk.recentTrades}
            telemetry={desk.telemetry}
            onStagePaperTrade={setStagedTrade}
          />
        )}

        {activeTab === 'risk' && (
          <RiskStressLab
            selectedPerpSymbol={selectedPerpSymbol}
            onSelectPerpSymbol={setSelectedPerpSymbol}
            opportunities={desk.basisOpportunities}
            perpSymbols={desk.perpSymbols}
          />
        )}

        {activeTab === 'ssi' && (
          <SsiRebalancerDesk
            spotTickers={desk.spotTickers}
            valueChain={desk.valueChain}
            sosovalue={desk.sosovalue}
            telemetry={desk.telemetry}
            onStagePaperTrade={setStagedTrade}
          />
        )}
      </main>

      {/* Institutional Compliance & Provenance Footer */}
      <footer className="mt-6 border-t border-slate-800/80 bg-[#070A0F] py-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 text-[11px] text-slate-500 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-400">BasisDesk v1.0</span>
            <span>•</span>
            <span>
              Zero custody • Paper execution simulation only • Analytical tooling, not financial advice
            </span>
          </div>
          <div className="font-mono text-[10px] text-slate-500 tabular-nums">
            SoDEX Mainnet ({desk.snapshotMeta.totalPerpMarkets} Perps / {desk.snapshotMeta.totalSpotMarkets} Spot) • ValueChain ID {desk.valueChain.chainId} • SSI Protocol
          </div>
        </div>
      </footer>

      <ExecutionConfirmModal
        staged={stagedTrade}
        onCancel={() => setStagedTrade(null)}
        onConfirm={handleConfirmPaperTrade}
      />

      <TelemetrySettingsModal
        open={telemetryOpen}
        onClose={() => setTelemetryOpen(false)}
        telemetry={desk.telemetry}
        snapshotGeneratedAt={desk.snapshotMeta.generatedAt}
        sosoConnecting={desk.sosoConnecting}
        sosoError={desk.sosoError}
        onConnectSoSoKey={desk.connectSoSoValueKey}
      />
    </div>
  );
}
