# PolyTrade

Local analytics, live trading terminal and browser-operated live bots for **Polymarket Perps**. Bun 1.3.14, strict TypeScript, SolidJS, Vite, ECharts and viem.

## Run

```powershell
cd C:\PolyTrade
bun --no-env-file install --frozen-lockfile
bun run check
bun run start:live
```

Open [PolyTrade](http://127.0.0.1:4310). The service binds only to `127.0.0.1`. `start:live` explicitly opts into the allow-listed live relay. Plain `bun start` leaves it disabled unless `POLYTRADE_LIVE_ENABLED=1` is already exported. Neither command connects a wallet, authorizes a proxy, places an order or starts a bot automatically. Market data needs network access.

## Screens

- **Overview / markets:** official volume, open interest, fees, funding, categories and searchable instruments.
- **Terminal:** candles, public WebSocket book/trades with REST fallback, real exchange positions/orders, reviewed limit or slippage-bounded IOC orders and cancellation.
- **Funding / leaderboard:** official funding history and calendar UTC rankings. Annualization is simple extrapolation.
- **Automations:** actual signed TWAP/maker sessions with explicit quantity, duration and slippage limits, confirmed order-state reconciliation and stop controls.
- **System:** source definitions, runtime health and live-session requirements.

## Live account

Use an injected EVM wallet on Polygon that signs for a registered Polymarket Perps account. Connect it and explicitly authorize the temporary proxy. Owner keys never enter the app; proxy keys and secrets remain in browser memory. Refresh/disconnect discards credentials, while nonsecret intent metadata persists for recovery. The proxy remains authorized on the exchange until expiry or revocation. Selected leverage must match confirmed exchange configuration; change it on the official terminal first.

Manual orders require review and confirmation. Signed financial requests get one attempt. An acknowledgement is not a fill; an ambiguous write blocks further submissions until reconciliation. Private reads and signed operations use a same-origin, token-guarded loopback relay. Transfers and withdrawals are not allowed.

## Live bots

Start a bot explicitly from Automations after authorizing the same live session used by the terminal. One bot controls PolyTrade execution for the account across tabs. Start requires no open exchange orders and acknowledgement of the account-wide auto-cancel scope. External terminals cannot be locked by this local app; avoid concurrent account activity while a bot runs.

The bot arms and reads back the exchange auto-cancel deadline before submitting orders, then renews it while active. TWAP submits bounded IOC slices; maker places post-only quotes and reconciles/cancels owned quotes before replacement. Executed quantities come from private exchange order records. Unfilled IOC quantity is not blindly retried, and an uncertain signed write halts execution.

Keep the browser open and awake. Closing, suspension, wallet changes, expiry or lost connectivity stops scheduling; the last confirmed exchange deadline protects resting orders. Stop cancels owned orders and leaves positions open. Reload never resumes a session automatically. Recovery metadata contains no proxy credentials.

No live owner signature, proxy registration, order, funding transaction or withdrawal was performed during development. Financial paths are tested with mocked transport; account-owner end-to-end validation remains unperformed.

## Preserved simulator

Paper controls and polling are absent from the active frontend. Legacy `paper.ts`, `bots.ts`, simulator API routes and SQLite history remain for maintenance and regression tests. Their startup scheduler is frozen. Original UI source is retained under `archive/paper-frontend/` with noncompiled `.disabled` extensions. Enabling the live relay does not convert or replay legacy simulator activity.

## Perps Quoter

`quoter/` is a separate headless liquidity-rewards quoter (post-only GTC ladder within 0–5 / 5–10 / 10–20 bps, modify-based requotes, risk manager, exchange auto-cancel). All of its REST and WebSocket traffic goes through the egress proxies in `quoter/.env`. Start with `bun run probe` and `bun run dry-run` in `quoter/`; live mode requires `mode: live`, `--live` and a declared operator jurisdiction. See [quoter/README.md](quoter/README.md) and [ADR-0003](docs/adr/0003-perps-quoter.md).

## Design and checks

See [live-only specification](specs/002-live-only/spec.md), [architecture decision](docs/adr/0002-live-only-browser-automation.md), [reference study](docs/reference-study.md) and [verification](docs/verification.md).

Official [trading](https://docs.polymarket.com/perps/trading), [authenticated sessions](https://docs.polymarket.com/perps/authenticated-sessions), [OpenAPI](https://docs.polymarket.com/api-spec/perps-openapi.json), and [auto-cancel status](https://docs.polymarket.com/api-reference/get-auto-cancel-status) define the integration. Runtime data never falls back to the evidence captures in `artifacts/`.

`bun run check` runs strict TypeScript, tests, the production build and the quoter check (strict TypeScript + tests). `bun run probe` reads public endpoints only. For UI development use `bun run dev` and `bun run dev:web` in separate terminals. No public deployment is included.
