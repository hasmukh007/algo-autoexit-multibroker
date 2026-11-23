# Multi-Broker Algo Auto-Exit Trading Terminal 🚀
### Angel One • Dhan • Kotak Neo

A powerful **Node.js Backend & Interactive Financial Web Terminal** for multi-broker algorithmic trading, aggregated positions tracking, and automated square-off execution based on **Net Profit % of 9:00 AM Opening Balance** (accounting for all statutory charges and brokerage).

---

## 🌟 Key New Capabilities

### 1. Multi-Broker Account Management
- Add, configure, and manage multiple trading accounts:
  - **Angel One (SmartAPI)**: API Key, Client Code, PIN / Password, TOTP Secret.
  - **Dhan (DhanHQ)**: Client ID, Access Token.
  - **Kotak Neo (Trade API v2)**: Consumer Key, Mobile Number, UCC, MPIN, TOTP Secret.
- Toggle between **Simulation / Mock Mode** and **Live Trading Mode**.

### 2. Market Data Feed Subscription
- Choose whether **Kotak Neo** or **Angel One SmartAPI** serves as the primary live market quote / tick data feed. Switch with one click from the UI.

### 3. Unified Real-Time Position Tracking
- When an order executes on **ANY** broker (Angel One, Dhan, or Kotak Neo), the position automatically appears in the central positions table.
- Each position displays:
  - Broker Badge (Angel One, Dhan, Kotak Neo)
  - Symbol, Product (`MIS`, `CNC`, `NRML`), and Net Quantity
  - Average Price and live LTP (flashing green/red on ticks)
  - **Gross P&L**
  - **Estimated Charges** (Click to view full breakdown of Brokerage, STT, Exchange Txn, GST, SEBI fee, Stamp Duty)
  - **Net P&L (₹) = Gross P&L - Total Charges**
  - **Net Return % of 9:00 AM Opening Balance**

### 4. 9:00 AM Daily Opening Balance Retrieval
- **Automatic Morning Capture**: At **9:00 AM IST** daily, the scheduler queries the balance/RMS limits across all active broker accounts and locks today's baseline Opening Capital.
- **Manual Sync & Override**: You can click **"Sync Balance"** or **"Edit"** at any time to re-sync or adjust the opening capital benchmark.

### 5. Indian Regulatory & Brokerage Charges Calculator
Calculates all charges in real time based on Indian tax and exchange rules:
- **Brokerage**: Flat ₹20/order (or intraday scale).
- **STT (Securities Transaction Tax)**: 0.025% on intraday sell, 0.0625% on options sell turnover, 0.1% on delivery.
- **Exchange Turnover Charges**: NSE/BSE charges.
- **GST**: 18% on (Brokerage + Exchange Charges + SEBI).
- **SEBI Turnover Charges**: ₹10 per crore.
- **Stamp Duty**: On buy turnover.

### 6. Auto-Exit on Net Position Near / Above Target %
- **Target Net Profit (%)**: Set target return (e.g. `1.5%` of 9:00 AM Opening Balance).
- **Near Trigger Buffer (%)**: Configure proximity threshold (e.g. `98%` = fires as soon as net profit reaches 98% of target, or `100%` exact).
- **Net Stop Loss (%)**: Set maximum acceptable net loss % (e.g. `-1.0%` of Opening Balance).
- **Automated Routing**: As soon as the condition is met, the engine instantly dispatches an opposing Market order directly to the broker account holding that position!
- **Emergency Square-Off**: One-click **"Exit All"** panic button squares off all positions across all brokers.

---

## 📁 Directory Structure

```
algo-autoexit/
├── server.js                      # Main HTTP & Server-Sent Events (SSE) server
├── lib/
│   ├── multiBrokerManager.js      # Aggregates accounts, orders, positions & routes exit orders
│   ├── openingBalanceScheduler.js # 9:00 AM IST daily balance capture & storage
│   ├── chargesCalculator.js       # Indian Brokerage, STT, GST, Exch, SEBI & Stamp Duty calculator
│   ├── autoExitEngine.js          # Evaluates net profit % of opening balance and auto-exits
│   ├── totpHelper.js              # Built-in RFC 6238 TOTP generator (zero dependencies)
│   ├── configManager.js           # Configuration loader & persistent storage
│   └── brokers/
│       ├── angelOneBroker.js      # Angel One SmartAPI client (login, positions, funds, orders)
│       ├── dhanBroker.js          # DhanHQ API client (v2 REST endpoints)
│       ├── kotakNeoBroker.js      # Kotak Neo Trade API v2 adapter
│       └── mockBroker.js          # Multi-broker simulation engine with live ticks
├── public/
│   ├── index.html                 # Modern multi-broker terminal UI
│   ├── styles.css                 # Bloomberg/TradingView dark theme
│   └── app.js                     # Frontend SSE listener, reactive state & modal controller
├── data/
│   ├── accounts.json              # Configured broker accounts
│   ├── config.json                # User risk settings and mode
│   └── opening_balance.json       # Daily 9:00 AM opening balance snapshots
└── test/
    └── test_api.js                # Multi-broker end-to-end verification test suite
```

---

## 🚀 Running the Terminal

### 1. Start Server
Runs natively on standard Node.js (v20+) with **zero external npm dependencies**:
```bash
node server.js
```
or
```bash
npm start
```

### 2. Open Web Dashboard
Navigate to:
```
http://localhost:3000
```

---

## 🛠️ Configuration & Broker Setup

### Adding Angel One
1. Click **"Brokers"** in the top navigation or go to the **"Broker Accounts"** tab.
2. Click **"+ Add Broker Account"** and choose **Angel One**.
3. Enter your **SmartAPI Key**, **Client Code**, **PIN / Password**, and **TOTP Secret**.
4. Click **"Test Connection"** and **"Save Account"**.

### Adding Dhan
1. In **"Broker Accounts"**, click **"+ Add Broker Account"** and select **Dhan**.
2. Enter your **Dhan Client ID** and **Access Token** (from web.dhan.co).
3. Click **"Save Account"**.

### Adding Kotak Neo
1. Select **Kotak Neo**.
2. Enter your **Consumer Key**, **Mobile Number**, **UCC**, **MPIN**, and **TOTP Secret**.
3. Click **"Save Account"**.

---

## 📊 How the Net Profit % Auto-Exit Works

$$\text{Total Turnover} = (\text{Buy Qty} \times \text{Buy Avg}) + (\text{Sell Qty} \times \text{Sell Avg})$$

$$\text{Gross P\&L} = \text{Sell Value} - \text{Buy Value}$$

$$\text{Total Charges} = \text{Brokerage} + \text{STT} + \text{Exchange Txn} + \text{GST} + \text{SEBI} + \text{Stamp Duty}$$

$$\text{Net P\&L} = \text{Gross P\&L} - \text{Total Charges}$$

$$\text{Net Return \%} = \left(\frac{\text{Net P\&L}}{\text{9:00 AM Opening Balance}}\right) \times 100$$

When $\text{Net Return \%} \ge \text{Target Net \%} \times \text{Buffer \%}$, the auto-exit engine instantly places a Market exit order on the broker where the position is open.
