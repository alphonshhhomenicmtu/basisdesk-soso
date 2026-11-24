# BasisDesk — Wave 3 Buildathon Specification

> **Event:** AKINDO WaveHack — *Build Your One-Person On-Chain Finance Business with SoSoValue* (`JBEQXgN4Zi2jA3wA`)
> **Active Wave:** Wave 3 — Build Phase II (`3SBElg7MvlCqonMQ2`)
> **Grant Pool:** 4,000 USDC on Ethereum (`0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) — Point-based distribution
> **Submission Deadline:** `2026-11-27T15:00:00Z` (2026-11-27 23:00 UTC+8)
> **Judging Deadline:** `2026-11-30T14:59:00Z`
> **Official Source:** `https://app.akindo.io/wave-hacks/JBEQXgN4Zi2jA3wA` (verified via `https://api.akindo.io/public/wave-hacks/JBEQXgN4Zi2jA3wA`)

---

## 1. Wave 3 Mandate & Judging Rubric

Wave 3 (*Build Phase II*) specifically evaluates:
> *"Product completion, logic refinement, UX improvement, risk control design, final demo and submission."*

### Official Judging Weights
| Category | Weight | Judging Focus | BasisDesk Engineering Target |
| :--- | :---: | :--- | :--- |
| **User Value & Practical Impact** | **30%** | Clear real-world value; helps users gain insight, make decisions, or improve execution efficiency. | End-to-end solo quant desk unifying live spot-perp funding carry discovery, ETF flow regime intelligence, Monte Carlo liquidation stress testing, SSI NAV arbitrage, and guarded paper execution. |
| **Functionality & Working Demo** | **25%** | Clear, functional demo demonstrating core features and workflow. | Live static GitHub Pages web app with real-time SoDEX WebSockets, live ValueChain RPC heartbeat, interactive 1,000-path Monte Carlo simulator, live SSI rebalancer, and 2-step risk-checked paper blotter. |
| **Logic, Workflow & Product Design** | **20%** | Clear, well-structured product logic supported by a solid analytical framework. | Deterministic, unit-tested quantitative engine (`src/engine/`) implementing SoDEX's exact hourly funding formula, exact tier-based maintenance margins, seeded GBM + jump-diffusion Monte Carlo VaR/CVaR, and SSI `AssetRebalancer` basket math. |
| **Data / API Integration** | **15%** | Effectiveness of integrating SoSoValue API, SoDEX API, and ecosystem data sources. | Genuine 4-pillar integration: SoDEX Perps & Spot REST + WebSocket (`mainnet-gw.sodex.dev`), SoSoValue Open API v1 (`openapi.sosovalue.com/openapi/v1`) with BYOK + hourly GitHub Actions snapshot pipeline, ValueChain Mainnet EVM JSON-RPC (`286623`), and SSI Protocol smart contract architecture (`SoSoValueLabs/ssi-protocol`). |
| **UX & Clarity** | **10%** | Intuitive, well-structured, easy to understand and use. | Institutional obsidian quant terminal with crisp visual hierarchy, tabular monospace numbers, honest `LIVE` / `SNAPSHOT` / `FALLBACK` telemetry badges, and zero overflow/clipping. |

### Judging Panels
- **SoSoValue**: Structured financial news, ETF flows, and market intelligence.
- **SoSoValueIndexes**: On-chain spot indexes, index methodology, and portfolio exposure.
- **SoDEX**: On-chain orderbook trading, execution infrastructure, and agent-friendly applications.

### Required & Bonus Checklist
- [x] Genuine SoSoValue Open API v1 integration (`etfs/summary-history`, `indices/{ticker}/constituents`, `indices/{ticker}/market-snapshot`, `market/overview`, `news`)
- [x] Live SoDEX Mainnet REST + WebSocket integration (Spot + Perps, 107 perps & 48 spot markets)
- [x] ValueChain Mainnet EVM JSON-RPC live chain telemetry (`Chain ID: 286623`, 2s finality)
- [x] SSI Protocol (`SoSoValueLabs/ssi-protocol`) on-chain basket rebalancing & USSI hedge-order simulation
- [x] AI-enhanced Desk Signal Synthesizer (combining ETF flow regime, funding skew, orderbook imbalance, and basis spread into structured trade theses)
- [x] Institutional risk controls: pre-trade guardrail checks, 2-step order confirmation modal, 1,000-path liquidation stress lab, zero custody / zero financial advice disclaimer

---

## 2. Verified Live API & Protocol Inventory

### A. SoDEX Mainnet Gateway (`https://mainnet-gw.sodex.dev`)
- **CORS Status:** Verified `Access-Control-Allow-Origin: *` across public REST endpoints (browser-direct compatible).
- **REST Endpoints Verified (HTTP 200, unauthenticated):**
  - `GET /api/v1/perps/markets/symbols` — 107 perp contracts including exact `marginTiers`, `fundingInterval` (`3600` seconds = 1 hour), `makerFee` (`0.00012`), `takerFee` (`0.0004`), `maxLeverage`, `openInterestCapUSD`.
  - `GET /api/v1/perps/markets/tickers` — Live 24h OHLCV, VWAP, BBO, `fundingRate`, `nextFundingTime`, `indexPrice`, `markPrice`, `openInterest`.
  - `GET /api/v1/perps/markets/{symbol}/orderbook?limit=20` — Live Level-2 bids/asks with `blockHeight`, `blockTime`, `updateID`.
  - `GET /api/v1/perps/markets/{symbol}/trades?limit=20` — Recent matching engine fills.
  - `GET /api/v1/perps/markets/{symbol}/klines?interval=1h&limit=48` — Historical candles for realized volatility estimation.
  - `GET /api/v1/spot/markets/symbols` — 48 spot pairs including SSI Protocol index tokens (`vMAG7ssi_vUSDC`, `vDEFIssi_vUSDC`, `vMEMEssi_vUSDC`, `vUSSI_vUSDC`, `WSOSO_vUSDC`) and major spot legs (`vBTC_vUSDC`, `vETH_vUSDC`, `vSOL_vUSDC`, `vBNB_vUSDC`, `vXRP_vUSDC`, `vADA_vUSDC`, `vDOGE_vUSDC`, `vLINK_vUSDC`, `vAAVE_vUSDC`, `vUNI_vUSDC`, `vAVAX_vUSDC`, `vSUI_vUSDC`, `vHYPE_vUSDC`).
  - `GET /api/v1/spot/markets/tickers` & `/orderbook?limit=20` — Live spot prices and orderbook depth.
- **WebSocket Endpoints Verified (Unauthenticated, Live Frames):**
  - `wss://mainnet-gw.sodex.dev/ws/perps`
  - `wss://mainnet-gw.sodex.dev/ws/spot`
  - Confirmed subscription payloads:
    - `{"op":"subscribe","params":{"channel":"l2Book","symbol":"BTC-USD"}}` (500ms Level-2 depth snapshots)
    - `{"op":"subscribe","params":{"channel":"markPrice","symbols":["BTC-USD",...]}}` (1000ms mark/index/funding/OI updates)
    - `{"op":"subscribe","params":{"channel":"ticker","symbols":["BTC-USD",...]}}` (1000ms 24h ticker updates)
    - `{"op":"subscribe","params":{"channel":"trade","symbols":["BTC-USD"]}}` (real-time trade tape)
- **Official Funding & Liquidation Mechanics (`docs.sodex.com`):**
  - Hourly funding settlement (`8,760` periods/year), capped at `±4%/hour`.
  - `Impact Notional = 200 USD × Max Leverage`.
  - `Funding Payment = Position Size × Oracle Price × Hourly Funding Rate`.
  - Liquidation uses **Mark Price** against tiered maintenance margin (`MMR × Notional - Maintenance Deduction`) with staged orderbook unwind → backstop liquidation → ADL.

### B. SoSoValue Open API (`https://openapi.sosovalue.com/openapi/v1`)
- **Authentication:** Requires `x-soso-api-key` header (free developer tier: 10,000 calls/month, 100 calls/min).
- **Integrated Endpoints:**
  - `GET /openapi/v1/etfs/summary-history?symbol={BTC|ETH|SOL|XRP}&country_code=US&limit=14`
  - `GET /openapi/v1/etfs?symbol={BTC|ETH}&country_code=US`
  - `GET /openapi/v1/indices`
  - `GET /openapi/v1/indices/{index_ticker}/constituents` (e.g. `ssimag7`)
  - `GET /openapi/v1/indices/{index_ticker}/market-snapshot`
  - `GET /openapi/v1/market/overview`
  - `GET /openapi/v1/news?category=1&language=en&page=1`
- **Resilience Architecture:**
  - **Tier 1 (Live Direct BYOK):** User/judge can enter their `x-soso-api-key` in the Telemetry drawer (stored in browser memory/session only) to fetch live directly from `openapi.sosovalue.com`.
  - **Tier 2 (Hourly CI Snapshot):** `docs/workflows/snapshot.yml` executes `scripts/fetch-snapshot.mjs` hourly using `secrets.SOSOVALUE_API_KEY` (when configured) + live SoDEX & ValueChain feeds, refreshing `public/data/market-snapshot.json`.
  - **Tier 3 (Honest Telemetry Labeling):** Every panel explicitly renders its true feed state (`LIVE WS`, `LIVE REST`, `LIVE RPC`, `SNAPSHOT`, or `FALLBACK`) along with exact UTC timestamp — zero hidden mocks.

### C. ValueChain Mainnet EVM JSON-RPC (`https://mainnet.valuechain.xyz`)
- **CORS Status:** Verified `200 OK` with reflected `Access-Control-Allow-Origin`.
- **Network Parameters:** Chain ID `286623` (`0x45f9f`), Native Gas Token `SOSO` (18 decimals), 2-second target slot time, single-slot finality (`safe` / `finalized` lag `latest` by 1 slot), Explorer `https://main-scan.valuechain.xyz`.
- **Live Methods Used:** `eth_chainId`, `eth_blockNumber`, `eth_gasPrice`.

### D. SSI Protocol Smart Contracts (`github.com/SoSoValueLabs/ssi-protocol`)
- **Core Contracts Modeled in Engine:**
  - `AssetToken.sol`: 8-decimal index ERC-20 (`decimals() == 8`), `tokenset_`, `basket_`, `feeDecimals = 8`, `REBALANCER_ROLE`, `FEEMANAGER_ROLE`, `rebalancing` / `rebalanceRequesting` guards.
  - `AssetRebalancer.sol`: `startRebalance(assetID)` -> `addRebalanceRequest(assetID, basket, orderInfo)` validating `inTokenset` / `outTokenset` scaled by `10^8`, ensuring `containTokenset(basket, outBasket)` and zero duplicate/zero-amount constituent tokens -> `endRebalance(assetID)`.
  - `USSI.sol`: Delta-neutral hedged yield token with `HedgeOrder` lifecycle (`MINT` / `REDEEM`, `MAX_MINT_DELAY = 1 days`, `MAX_REDEEM_DELAY = 7 days`).
  - `AssetFeeManager.sol`: `collectFeeTokenset(assetID)` & fee burn requests prior to rebalance lock.

---

## 3. Submission Deliverables Plan

1. **Public GitHub Repository** with clean English commit history, complete setup instructions, Mermaid architecture diagram, and 2-minute walkthrough demo script in `README.md`.
2. **Static Production Build** (`npm run build`) with relative base path (`base: './'`) + `docs/workflows/deploy-pages.yml` and `docs/workflows/snapshot.yml` workflow templates ready for GitHub Pages deployment.
3. **100% Passing Vitest Unit Test Suite** covering funding/basis carry math, L2 orderbook impact slippage, seeded 1,000-path Monte Carlo VaR/CVaR & liquidation probability, SSI basket iNAV & drift rebalancer, pre-trade risk guardrails, and telemetry/API adapters.
4. **4 Verified Retina Screenshots** captured via headless Chromium on the live production build (`overview`, `basis-orderbook`, `risk-stress-lab`, `ssi-rebalancer`), visually inspected for zero clipping, zero overflow, and institutional polish.
