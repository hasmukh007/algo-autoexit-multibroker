# Multi-Broker Algo Auto-Exit Trading Terminal

### Angel One • Dhan • Kotak Neo • Sahi • Paper Trading

A zero-dependency **Node.js Backend & Interactive Trading Web Terminal** for multi-broker Indian Options trading (`NSE_FO` / `BSE_FO`), live NIFTY Option Chain & 3-minute charting, real-time order-based charge calculation, and automated **Net Profit % / Signed Stop-Loss** management.

---

## Key Capabilities

### 1. Multi-Broker Accounts & Order Management Gating
- Supports **Angel One (SmartAPI)**, **Dhan (DhanHQ v2)**, **Kotak Neo (Trade API v2)**, **Sahi Direct API** (with automatic cross-broker option symbol translation & Protobuf WebSocket ticks), **Paper Trading** (virtual options account synced to live ticks with balance reset), and **Mock Simulation Mode**.
- **Manage Orders Checkbox**: Connected Broker Accounts include a **Manage Orders** checkbox per account. Unchecked brokers remain connected for viewing/market data feeds, while order placement, multi-broker routing, and Auto-Exit strictly manage **Checked Brokers Only**.

### 2. Automated Market Schedules (IST)
- **08:55 AM IST (`scripMasterManager.js`)**: Downloads Scrip Master data into `data/scrip-master.db` to resolve live contract `lotSize` (e.g., `65` for NIFTY) and `freezeQty`.
- **08:59 AM IST (`autoLoginScheduler.js`)**: Automatically logs into all enabled broker accounts and subscribes WebSocket feeds.
- **09:00 AM IST (`openingBalanceScheduler.js`)**: Captures daily Opening Capital per broker account (with manual **Sync Balance** and **Override** support).
- **09:00 AM – 04:00 PM IST**: Runs live NIFTY feed & portfolio polling (pauses automated REST polling during 4:00 PM – 9:00 AM quiet hours; manual **Fetch Pos/Funds/Hold/Orders** works anytime).
- **15:15 IST**: Optional auto square-off for intraday (`MIS`) positions on order-managed brokers.

### 3. Pop-Out Quick Order Window & Execution Safeguards
- **Standalone Pop-Out Window (`/order-window`)**: Compact floating popup window designed for side-by-side trading next to your broker chart. Automatically remembers its **size and screen position** across closes and re-opens.
- **Auto Quantity Sizing**: Sizes orders using $\min(\text{Opening Balance}, \text{Available Funds}) \times \text{Capital Deploy \%}$, aligned to contract lot size, and auto-splits quantities exceeding exchange `freezeQty`.
- **Routing Modes**: Execute on **Checked Broker Only** or distribute across **All Checked Brokers w/ Enough Funds**.
- **Market -> Limit Price Protection**: Market (`MKT`) orders are automatically dispatched as **Limit (`L`)** orders using the current live option price (`LTP`, rounded to `0.05` tick) to prevent market slippage.
- **On-Page Order Confirmation & Bell Chime (`order-confirm.js`)**: Plays a Web Audio bell chime and asks for explicit user confirmation on any active page before sending manual or standard algo orders to a broker.
- **Bulk Stoploss (`Send SL`) & Bulk Target (`Send Target`) on Order Window**:
  - **Bulk SL**: Sends `SL-LMT` orders across checked brokers' open positions using $\min(\text{Opening Balance}, \text{Available Balance})$ (`-ve %`: `Buying Price - %Amount`; `+ve %`: `Buying Price + Charges + %Amount` once `LTP > SL Trigger`).
  - **Bulk Target Limit**: Cancels pending SL orders and sends **Limit (`L`)** orders at `Buying Price + Charges + %Amount`, with a **Quantity % dropdown** (`100% quantity`, `50% quantity`, `25% quantity`) using **lot-ceiling** rounding (e.g., `325` qty = `5` lots at `50%` sends `ceil(5/2) = 3` lots = `195` qty).

### 4. Options-Only Statutory Charges & Order-Based P&L
Configurable per-account Options brokerage (`Flat ₹/order` or `₹0 Zero`) and statutory rates popup (`Charges` button -> `/api/charge-settings`):
- **STT**: `0.15%` on **sell turnover only**
- **Exchange Transaction Charges**: `0.03553%` on total turnover (Buy + Sell)
- **SEBI Charges**: `₹10 / crore` on total turnover
- **IPFT Charges**: `₹0.01 / crore` on total turnover
- **Stamp Duty**: `0.003%` on **buy turnover**, ceiled to the next whole rupee per buy trade
- **GST**: `18%` on `(Brokerage + SEBI + Exchange Transaction + IPFT)`
- Computed directly from **executed orders** (`calculateChargesFromOrders`) rather than net positions alone, with a click-through charge breakdown modal and **Per Trade** table.

### 5. Per-Account Risk, Signed SL & Staged Target Auto-Exit Engine
- **Per-Account Target & SL %**: Independent target, stop-loss, and near-threshold buffer per broker account (`Accounts` modal & quick risk bar), plus per-position rule overrides.
- **Signed Stop-Loss (`-ve` = Loss SL, `+ve` = Profit SL)**:
  - **Negative SL** (e.g. `-10%`): Places charge-adjusted Loss `SL-LMT` (`Trigger` / `Trigger - 0.50`) and executes market-limit loss exit if breached.
  - **Positive SL** (e.g. `+10%`): Places Profit `SL-LMT` at charge-adjusted profit level once `LTP` moves past the trigger price.
  - Cancels all pending SL orders before sending profit target orders.
- **Staged Profit Target Lifecycle**:
  - **50% of Target**: Cancels pending SL orders and places breakeven+ `SL-LMT` (`Entry + 1.5` trigger / `Entry + 1.0` limit) for full qty (with confirmation).
  - **100% of Target**: Exits `50%` qty (`ceil(lots / 2)`) and moves `SL-LMT` to `50%` profit target for remaining qty (with confirmation), trailing every `1/3` move.
  - **150% of Target**: Cancels all pending orders and queued confirmations and sends a `125%` profit `SL-LMT` **immediately without confirmation**.

### 6. Live NIFTY Option Chain, 3-Minute Chart & Filters
- **Live Option Chain (`/option-chain`)**: Live-only `10 ITM + ATM + 10 OTM` strikes, OI Built Up, NIFTY Lot = `65`, and click-to-order modal.
- **Live NIFTY 3m Chart (`/chart`)**: SQLite-persisted candles (`data/candles.db`) with 3-day REST backfill, live candle bar countdown, Session lines, **PDH/PDL**, **Pivot Points**, `5m / 15m / 1h` **Heikin-Ashi S/R zones**, and quick order placement.
- **Order & Position Filters**: Order filters (`All`, `Completed`, `Open`, `Rejected`, `Cancelled`) and Position views (`All Net`, `Open`, `Closed`, `Per Trade`).

---

## Directory Structure

```text
algo-autoexit-multibroker/
├── server.js                      # HTTP server, REST APIs, and SSE (/api/stream)
├── lib/
│   ├── multiBrokerManager.js      # Broker lifecycle, routing, auto-sizing, freeze split & bulk SL/Target
│   ├── autoExitEngine.js          # Per-account risk, signed SL & 50%/100%/150% staged target engine
│   ├── chargesCalculator.js       # Options-only brokerage & statutory charges from executed orders
│   ├── scripMasterManager.js      # 8:55 AM Scrip Master SQLite cache (lotSize & freezeQty)
│   ├── autoLoginScheduler.js      # 8:59 AM IST automated multi-broker login & feed subscription
│   ├── openingBalanceScheduler.js # 9:00 AM IST opening balance capture & override manager
│   ├── niftyFeedManager.js        # Live-only NIFTY spot + 21-strike option chain manager
│   ├── niftyCandleManager.js      # Live WebSocket 1m/3m candle builder (SQLite + REST backfill)
│   ├── niftyChartAnalysis.js      # Session breaks, PDH/PDL, Pivot Points & multi-TF Heikin-Ashi S/R
│   ├── kotakNeoClient.js          # Kotak Neo REST Trade API v2 client
│   ├── angelOneWsClient.js        # Angel One SmartStream WebSocket client
│   ├── dhanWsClient.js            # Dhan binary WebSocket client
│   ├── kotakNeoWsClient.js        # Kotak Neo WebSocket client
│   ├── sahiWsClient.js            # Sahi Protobuf WebSocket client
│   ├── totpHelper.js              # Built-in RFC 6238 TOTP generator (zero dependencies)
│   ├── configManager.js           # Risk, charge, and trading mode persistence
│   └── brokers/
│       ├── angelOneBroker.js      # Angel One SmartAPI adapter
│       ├── dhanBroker.js          # DhanHQ v2 adapter
│       ├── kotakNeoBroker.js      # Kotak Neo adapter
│       ├── sahiBroker.js          # Sahi Direct API adapter & cross-broker option mapper
│       ├── paperBroker.js         # Paper Trading virtual options adapter
│       └── mockBroker.js          # Mock simulation broker adapter
├── public/
│   ├── index.html                 # Main multi-broker trading terminal UI
│   ├── app.js                     # Main terminal state, filters, SSE & account controls
│   ├── order-window.html          # Pop-out compact order & SL/Target window
│   ├── order-window.js            # Pop-out sizing, bounds memory & bulk SL/Target controller
│   ├── order-confirm.js           # Shared confirmation modal, Web Audio bell & popup opener
│   ├── option-chain.html / .js    # Live NIFTY Option Chain page
│   ├── chart.html / .js           # Live NIFTY 3-minute chart page
│   └── styles.css                 # Dark terminal theme
├── data/                          # Runtime configs, accounts, snapshots & SQLite DBs
└── test/
    ├── test_api.js                # Charges, brokerage, PaperBroker, AutoExit, SL/Target & routing tests
    └── test_nifty_option_chain.js # Option chain, chart, WS adapters, Scrip Master & HTTP endpoint tests
```

---

## Running the Terminal

Requires **Node.js (v22+ with built-in `node:sqlite`)** and zero external npm packages:

```bash
node server.js
```

or:

```bash
npm start
```

Open the dashboard at:
- Main Terminal: `http://localhost:3000/`
- Pop-Out Order Window: `http://localhost:3000/order-window`
- Live Option Chain: `http://localhost:3000/option-chain`
- Live 3m NIFTY Chart: `http://localhost:3000/chart`

---

## Key REST & SSE Endpoints

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/api/stream` | `GET` | Real-time SSE (`market_tick`, `nifty_tick`, `order_confirmation_required/resolved`, `autoexit_log`) |
| `/api/accounts` | `GET` / `POST` | List or create broker/paper accounts |
| `/api/accounts/:id/manage-orders` | `POST` | Toggle **Manage Orders** checkbox per broker without disconnecting feed |
| `/api/accounts/:id/risk-settings` | `POST` | Set per-account Target %, signed Stop-Loss %, and Near Buffer % |
| `/api/orders` | `GET` / `POST` | Order book (enriched per-trade charges) & place orders (`MKT` auto-converts to `L` @ LTP) |
| `/api/orders/calculate-quantity` | `POST` | Compute lot-aligned quantity using $\min(\text{Opening Balance}, \text{Available Funds})$ |
| `/api/orders/send-stoploss` | `POST` | Preview or place bulk `SL-LMT` orders across checked brokers' open positions |
| `/api/orders/send-target` | `POST` | Preview or place bulk Target `L` orders (`100%` / `50%` / `25%` qty, lot-ceiling) |
| `/api/pending-orders` | `GET` | Pending order confirmations awaiting user approval |
| `/api/charge-settings` | `GET` / `POST` | Read or update Options statutory charge rates |
| `/api/nifty-feed` | `GET` | Current NIFTY spot & 21-strike option chain snapshot |
| `/api/nifty-chart` | `GET` | NIFTY 3m/1m candles and HA S/R, Pivot, PDH/PDL analysis |

---

## How Net Return & Target/SL Math Works

$$\text{Total Turnover} = (\text{Buy Qty} \times \text{Buy Avg}) + (\text{Sell Qty} \times \text{Sell Avg})$$

$$\text{Gross PnL} = \text{Sell Value} - \text{Buy Value}$$

$$\text{Total Charges} = \text{Brokerage} + \text{STT} + \text{Exchange Txn} + \text{SEBI} + \text{IPFT} + \text{Stamp Duty} + \text{GST}$$

$$\text{Net PnL} = \text{Gross PnL} - \text{Total Charges}$$

$$\text{Net Return \%} = \left(\frac{\text{Net PnL}}{\text{Opening Balance}}\right) \times 100$$

---

## Verification Tests

Run both offline/mocked verification suites:

```bash
node test/test_api.js
node test/test_nifty_option_chain.js
```
