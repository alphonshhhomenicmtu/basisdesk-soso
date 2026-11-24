import { useState } from 'react';
import {
  Activity,
  BookOpen,
  Cpu,
  Layers,
  LayoutDashboard,
  Radio,
  ShieldCheck,
  Terminal,
  Wallet,
} from 'lucide-react';
import { BasisOrderbookDesk } from './components/BasisOrderbookDesk';
import { JudgeDiagDesk } from './components/JudgeDiagDesk';
import {
  type ConfirmedExecutionMeta,
  ExecutionConfirmModal,
  type StagedPaperTrade,
  TelemetrySettingsModal,
} from './components/Modals';
import { OverviewDesk } from './components/OverviewDesk';
import { RiskStressLab } from './components/RiskStressLab';
import { SsiRebalancerDesk } from './components/SsiRebalancerDesk';
import { TelemetryBadge } from './components/TelemetryBadge';
import { evaluatePreTradeGuardrails } from './engine/ssiRebalancer';
import { useDeskData } from './hooks/useDeskData';

type WorkspaceTab = 'overview' | 'basis' | 'risk' | 'ssi' | 'diag';

const TABS: Array<{ id: WorkspaceTab; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'basis', label: 'Basis & L2', icon: BookOpen },
  { id: 'risk', label: 'Risk & Backtest', icon: Cpu },
  { id: 'ssi', label: 'SSI Rebalancer', icon: Layers },
  { id: 'diag', label: 'Judge Guide & /diag', icon: Terminal },
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
    setTimeout(() => setToastMsg(null), 4600);
  };

  const handleSelectPairAndNavigate = (perpSymbol: string, tab: 'basis' | 'risk') => {
    setSelectedPerpSymbol(perpSymbol);
    setActiveTab(tab);
  };

  const handleOpenSampleEip712Signer = () => {
    const opp =
      desk.basisOpportunities.find((o) => o.perpSymbol === selectedPerpSymbol) ??
      desk.basisOpportunities[0];
    const perpSpec = desk.perpSymbols.find((s) => s.name === (opp?.perpSymbol ?? 'BTC-USD'));
    const spotSpec = desk.spotSymbols.find((s) => s.name === (opp?.spotSymbol ?? 'vBTC_vUSDC'));
    const guardrails = evaluatePreTradeGuardrails({
      leverage: 3,
      liquidationBufferPct: 32.1,
      totalSlippageBps: 1.0,
      capitalRequiredUsd: 33_333,
      deskEquityUsd: 150_000,
      var99Pct: 3.2,
    });

    setStagedTrade({
      strategyType: 'DELTA_NEUTRAL_BASIS',
      symbol: opp?.perpSymbol ?? 'BTC-USD',
      spotSymbol: opp?.spotSymbol ?? 'vBTC_vUSDC',
      perpSymbolId: perpSpec?.id ?? 1,
      spotSymbolId: spotSpec?.id ?? 1,
      perpPricePrecision: perpSpec?.pricePrecision ?? 1,
      perpQuantityPrecision: perpSpec?.quantityPrecision ?? 4,
      spotPricePrecision: spotSpec?.pricePrecision ?? 2,
      spotQuantityPrecision: spotSpec?.quantityPrecision ?? 5,
      executionMode: 'MAKER',
      direction: 'LONG_SPOT_SHORT_PERP',
      notionalUsd: 25_000,
      leverage: 3,
      entrySpotPrice: opp?.spotPrice ?? 60_000,
      entryPerpPrice: opp?.perpMarkPrice ?? 60_050,
      entryHourlyFundingRate: opp?.hourlyFundingRate ?? 0.0000125,
      expectedNetApyPct: opp?.netCarryApyPct ?? 6.5,
      estimatedFeesUsd: 23.5,
      liquidationBufferPct: 32.1,
      notes: 'Judge verification sample: Maker 3x delta-neutral SoDEX EIP-712 intent',
      guardrails,
    });
  };

  const handleConfirmExecution = (meta: ConfirmedExecutionMeta) => {
    if (!stagedTrade) return;
    const channelNote =
      meta.executionChannel === 'EIP712_WALLET_SIGNED'
        ? `[EIP-712 Wallet Signed • ${meta.eip712Network?.toUpperCase()} • ${meta.typedSignaturePreview}] `
        : meta.executionChannel === 'EIP712_DRY_RUN'
          ? `[EIP-712 Verified Dry-Run • ${meta.eip712Network?.toUpperCase()} • ${meta.typedSignaturePreview}] `
          : '';

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
      notes: `${channelNote}${stagedTrade.notes}`,
      executionChannel: meta.executionChannel,
      eip712Network: meta.eip712Network,
      eip712Signer: meta.eip712Signer,
      eip712Digest: meta.eip712Digest,
      clOrdId: meta.clOrdId,
      typedSignaturePreview: meta.typedSignaturePreview,
    });
    const sym = stagedTrade.symbol;
    setStagedTrade(null);
    showToast(
      meta.executionChannel === 'PAPER'
        ? `Paper execution logged for ${sym} — live MTM active in Overview Blotter.`
        : `Verified SoDEX EIP-712 intent (${meta.clOrdId ?? sym}) logged to Overview Blotter.`,
    );
  };

  return (
    <div className="terminal-grid-bg min-h-screen text-slate-100">
      {/* Top Institutional Command Header */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#080B10]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2.5 px-4 py-2.5 sm:px-6">
          {/* Brand Lockup */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-sky-400/40 bg-gradient-to-br from-sky-500/25 to-emerald-500/15 shadow-sm">
              <Activity className="h-4 w-4 text-sky-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold tracking-tight text-slate-50 sm:text-base">
                  BasisDesk
                </span>
                <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300">
                  V2 QUANT
                </span>
              </div>
              <p className="text-[10.5px] text-slate-400">
                SoSoValue × SoDEX EIP-712 × ValueChain × SSI
              </p>
            </div>
          </div>

          {/* Primary Workspace Navigation */}
          <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800/90 bg-[#0C111A] p-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition whitespace-nowrap ${
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

          {/* Wallet + Live Feed Telemetry Strip */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                desk.wallet.address ? desk.wallet.disconnect() : void desk.wallet.connect()
              }
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-mono text-[11px] font-medium transition whitespace-nowrap ${
                desk.wallet.address
                  ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-200 hover:bg-emerald-500/20'
                  : 'border-slate-800 bg-[#0D131D] text-slate-300 hover:border-sky-500/40 hover:text-sky-200'
              }`}
              title={
                desk.wallet.address
                  ? `Connected via ${desk.wallet.providerLabel} (Click to disconnect)`
                  : 'Connect MetaMask / EIP-1193 wallet for real SoDEX EIP-712 signing'
              }
            >
              <Wallet className="h-3.5 w-3.5 text-sky-400" />
              <span>
                {desk.wallet.address
                  ? `${desk.wallet.address.slice(0, 6)}...${desk.wallet.address.slice(-4)}`
                  : 'EIP-712 Wallet'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setTelemetryOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-[#0D131D] px-2.5 py-1.5 text-xs transition hover:border-sky-500/40"
              title="Inspect live API endpoints and configure SoSoValue BYOK key"
            >
              <Radio className="h-3.5 w-3.5 text-sky-400" />
              <TelemetryBadge
                status={desk.telemetry.sodex_perps.status}
                label={
                  desk.telemetry.sodex_perps.status === 'LIVE_WS'
                    ? 'SODEX WS'
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
            spotSymbols={desk.spotSymbols}
            activeKlineBundle={desk.activeKlineBundle}
            klinesLoading={desk.klinesLoading}
            onRefreshKlines={() => void desk.refreshKlines30d()}
          />
        )}

        {activeTab === 'ssi' && (
          <SsiRebalancerDesk
            spotSymbols={desk.spotSymbols}
            spotTickers={desk.spotTickers}
            valueChain={desk.valueChain}
            sosovalue={desk.sosovalue}
            telemetry={desk.telemetry}
            onStagePaperTrade={setStagedTrade}
          />
        )}

        {activeTab === 'diag' && (
          <JudgeDiagDesk
            telemetry={desk.telemetry}
            sosovalue={desk.sosovalue}
            snapshotGeneratedAt={desk.snapshotMeta.generatedAt}
            walletAddress={desk.wallet.address}
            walletChainId={desk.wallet.chainId}
            walletProviderLabel={desk.wallet.providerLabel}
            onConnectWallet={desk.wallet.connect}
            onNavigateTab={setActiveTab}
            onOpenTelemetry={() => setTelemetryOpen(true)}
            onOpenSampleEip712Signer={handleOpenSampleEip712Signer}
          />
        )}
      </main>

      {/* Institutional Compliance & Provenance Footer */}
      <footer className="mt-6 border-t border-slate-800/80 bg-[#070A0F] py-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 text-[11px] text-slate-500 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-400">BasisDesk v2.0</span>
            <span>•</span>
            <span>
              Non-custodial EIP-712 dry-run &amp; paper blotter • Zero silent mainnet broadcast • Analytical tooling, not financial advice
            </span>
          </div>
          <div className="font-mono text-[10px] text-slate-500 tabular-nums">
            SoDEX Mainnet ({desk.snapshotMeta.totalPerpMarkets} Perps / {desk.snapshotMeta.totalSpotMarkets} Spot) • ValueChain ID {desk.valueChain.chainId} • EIP-712 ExchangeAction v1
          </div>
        </div>
      </footer>

      <ExecutionConfirmModal
        staged={stagedTrade}
        wallet={desk.wallet}
        onCancel={() => setStagedTrade(null)}
        onConfirm={handleConfirmExecution}
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
