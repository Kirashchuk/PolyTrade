# Verification — 16 October 2026

Feature `specs/002-live-only` is implemented. The active product contains live exchange trading and live browser-operated TWAP/maker sessions. Paper controls, balances, polling and simulator endpoints are absent from active browser source and compiled assets. The prior interface is preserved under `archive/paper-frontend/*.tsx.disabled`; backend simulator modules, regression tests and existing SQLite history remain intact. The production startup no longer schedules simulator ticks. The earlier delivery report is retained as `docs/verification-001.md`.

## Automated checks

`bun run check` passed on 16 October with **Bun 1.3.14, strict TypeScript, 84 tests, 0 failures and 509 assertions**, followed by the production Vite build. Output: `artifacts/live-only-check.log`.

| Behavior | Evidence |
|---|---|
| Exact EIP-712/MessagePack autoCancel signing, one PATCH attempt, authenticated deadline readback | `tests/live-session.test.ts` |
| Lost/malformed acknowledgements remain unresolved across reload; no retry | `tests/live-session.test.ts`, existing `tests/trading.test.ts` |
| Lifetime bot lock rejects cross-tab manual writes; released channels cannot continue signing | `tests/live-session.test.ts` |
| Unresolved/malformed bot journal blocks manual order creation while allowing original-owner recovery | `tests/live-session.test.ts` |
| Real TWAP/maker scheduling, explicit consent, strict bounds, native protection before orders | `tests/live-bots.test.ts` |
| Exact filled plus outstanding budget, private-history fill observations, terminal consistency, owned cancellation | `tests/live-bots.test.ts` |
| Unknown write halts, stale/close-only/cancel-only data blocks, stop/reload recovery, storage failure and preflight rejection | `tests/live-bots.test.ts` |
| Actual browser signer connected to actual live manager with fully mocked transport; partial IOC is not retried | `tests/live-integration.test.ts` |
| Existing metadata, freshness, decimal, leverage, margin, cache, source, stream and loopback security behavior | Existing venue/trading/stream/security/server suites |

The build has one non-blocking Vite chunking hint because shared order math is both statically and dynamically imported. ECharts, live signing and live bot modules retain separate output chunks. No build or type errors remain.

## Local HTTP and current public data

`bun --no-env-file scripts/verify-live-local.ts` passed against the running production build at `http://127.0.0.1:4310`. `artifacts/live-only-http.json` records the check at **2026-10-16 06:21:53 UTC**. Health, markets, overview, exchange, BTC book, candles and tape returned HTTP 200 with live snapshots; the observed response contained 89 instruments. This is a timestamped response count, not a fixed exchange limit.

The explicitly enabled relay returned official server time through an authenticated local GET. The local guard rejected an unauthenticated order request with 401, cross-origin bootstrap with 403 and an unsupported withdrawal read path with 403. The smoke test never supplies a financial signature or forwards a financial operation. Built browser assets contain no `/api/paper` or `/api/bots` references.

The service binds to loopback only, with live relay explicitly enabled. `artifacts/runtime.json` records its process. Restart with `bun run start:live`; plain `bun start` retains the opt-in switch. Starting the service never connects a wallet, authorizes a proxy, sends an order or resumes a bot.

## Browser checks

The seven pages were inspected after the live-only changes: overview, markets, terminal, funding, leaderboard, automations and system. No page contained paper controls or copy. Terminal shows actual-account unavailable states when disconnected, candles and a live public WebSocket book. The instrument selector matches the displayed market. Maker controls describe two-sided quotes and the start button remains disabled without account authorization and explicit consent.

Desktop and 390 x 844 mobile checks passed. At mobile width, the terminal panels now stack in one column, each 347 px wide; document width is 375 px within the 390 px viewport. The automation form, proxy controls, session and account panels stack without document overflow. The closed sidebar ends at x=0. The temporary viewport override was reset. The captured application console contained no warnings or errors; earlier automation-host telemetry errors were unrelated to application diagnostics.

Evidence: `artifacts/live-only-terminal.jpg`, `live-only-bots.jpg`, `live-only-terminal-mobile.jpg`, `live-only-bots-mobile.jpg`, `live-only-mobile.json`, `live-only-desktop.json` and `live-only-pages.json`. Full mobile screenshots were refreshed on 16 October after the final layout fix.

## Operational limits and recovery

No real account-owner signature, proxy registration, live order, cancellation, funding transaction, transfer or withdrawal was executed during development. Signed financial paths use test keys and mocked transports only. Actual owner-operated end-to-end validation remains unperformed. Use a registered Polymarket Perps signer with an injected EVM wallet on Polygon and a browser supporting secure-context Web Locks. The in-app browser can display the product without providing a wallet extension.

Bots execute in the authorized browser, so the tab must remain open and awake. Proxy credentials stay in memory and are discarded on reload/disconnect. Refresh never resumes execution. Each strategy requires bounded quantity, duration and slippage; the proxy must outlive the strategy plus its protection window. The native account-wide auto-cancel is confirmed before orders and maintained while running. It protects resting orders, not existing positions. External clients cannot be locked by PolyTrade, and their orders may be affected by the account-wide timer; starting requires no pre-existing open account orders and explicit scope consent.

Stop cancels and reconciles tracked orders before clearing native protection. If cleanup is unresolved, Stop releases local scheduling ownership for original-owner recovery but retains the durable unknown intent, owned client IDs and native protection. Manual new exposure remains blocked by the recovery journal until bot cleanup is complete. Reconnect/authorize the original owner, reconcile official order state and then use Stop/reconcile again. An expired ambiguous auto-cancel cannot be proven from a cleared deadline alone; inspect official orders, positions and timer state before the explicit operator acknowledgement. There is no automatic acknowledgement or resend.

Legacy simulator APIs remain dormant for maintenance/regression use and cannot submit upstream writes. No reference checkout was changed and no public deployment was performed.

# Perps Quoter — 19 October 2026

`quoter/` implements the liquidity-rewards quoter from `perps-quoter-architecture.md` as a separate headless Bun process. Decision record: [ADR-0003](adr/0003-perps-quoter.md). No live owner signature, proxy registration, order, cancellation or auto-cancel was sent to the real exchange.

## Network and egress

On 2026-10-19 a direct request from this machine to `https://api.perpetuals.polymarket.com/v1/info/time` did not connect (curl HTTP 000). Through each of the three configured HTTP proxies (two DE, one PL) it returned HTTP 200 in about 0.45–0.6 s. Bun 1.3.14 `fetch(url, {proxy})` and `new WebSocket(url, {proxy})` both work through them. A 3-minute concurrent WebSocket test (one connection per proxy, `bbo::45`) saw one `1006` tunnel drop on one proxy. The longest gap between BBO frames was about 4.9 s on all routes at once, which reflects market quiet rather than transport. The local clock was 2.9 s behind server time; signatures use the measured offset.

Proxy credentials live only in the gitignored `quoter/.env`. Logs mask proxy user/password, keys, secrets and signatures (`test/transport.test.ts`).

## Automated checks

`bun run check` passed: root typecheck, 84 tests, production build, then `quoter` strict typecheck and **88 tests, 0 failures**.

| Behavior | Evidence |
|---|---|
| Decimal grid (price/quantity decimals and ≤5 significant digits), decade carry, exact strings | `quoter/test/rounding.test.ts` |
| Reward bands with outward-rounded edges, $100k cap, harmonic mean, maker score, 12:00 UTC period | `quoter/test/rounding.test.ts` |
| Ladder distances, band containment after skew/session widening, post-only clamp, position stop (zero/shrink), min notional, cap warning | `quoter/test/quoteEngine.test.ts` |
| Compact operations equal the documented forms (createOrders, modifyOrdersCOID, cancelOrdersCOID, cancelAll, autoCancel, updateLeverage); EIP-712 signature recovers to the proxy | `quoter/test/signer.test.ts` |
| Slot diff (place/modify/cancel/wait), fills included in modify quantity, budget priority, one attempt per signed batch, indeterminate halts writes, whole-request rejection | `quoter/test/executorDiff.test.ts` |
| State: order events, oid fallback, sequence gaps and false-gap guard, REST reconcile, position from portfolio plus newer fills, daily PnL | `quoter/test/stateRisk.test.ts` |
| Risk: stale data pull, resync freeze, cancel-only, halts (liquidation, daily loss, settled, kill switch), volatility pause, margin scaling, post-only widen, proxy expiry | `quoter/test/stateRisk.test.ts` |
| Egress parsing/redaction, read failover, write single attempt and outcome classification (5xx/timeout/unreadable = indeterminate), jurisdiction gate, config and `.env` secret refusal | `quoter/test/transport.test.ts` |
| Full live lifecycle against a loopback mock exchange (REST + WS) with real signature verification: deadman armed, one signed ladder batch, modify-in-place after a mid move, cancelAll verified, auto-cancel disarmed; dashboard state shows exchange-held orders and contains no secret or key | `quoter/test/liveMock.test.ts` |
| Dashboard: loopback Host, Origin and `Sec-Fetch-Site` checks, CSP; Stop needs the process token, JSON and confirmation; redacted event feed | `quoter/test/dashboard.test.ts` |

## Real public data (read-only)

`bun run probe` selected the fastest proxy, synced the clock, loaded PLTR-USD (id 45, price decimals 2, quantity decimals 4, min notional 10, max 200 orders) and received a live `bbo::45` frame through the proxy.

`dry-run` ran for 3 minutes on PLTR-USD with two redundant public feeds (de1, de2). The default ladder ($1k per level at 3.5 / 8 / 17 bps) produced 175 samples with simulated uptime 1.0 and a liquidity score of about 1,343 per snapshot. Visible competing depth within the bands was about $1.15M / $0.34M / $0.05M per side. The STOP file shut the process down cleanly. An earlier run showed a public WebSocket via proxy hanging on connect, which led to the 10 s connect timeout and redundant feeds.

## Dashboard

The local panel at `http://127.0.0.1:4320` was checked in the in-app browser during a dry-run on PLTR-USD. It showed the DRY-RUN banner, status, live mid/spread, the simulated ladder at 3.8 / 8.4 / 17.1 bps, the 10-minute mid and quote chart with the uptime strip, band usage against the $100k cap with competing depth, events and feed status. At 375 px width the document did not overflow horizontally. The Stop button (confirmation accepted) stopped the process with reason `dashboard stop`, and the page then showed the stopped state.

## Code review fixes — 20 October 2026

An independent `/code-review` (xhigh) of `main...feature/perps-quoter` reported 15 findings. All are fixed and covered by regression tests in `quoter/test/stateRisk.test.ts`, `quoteEngine.test.ts` and `liveMock.test.ts`:

- Reconcile can no longer drop an acknowledged order: snapshots are judged against the time they were requested, reconciles never overlap a quote cycle, and an own order that surfaces outside its slot is re-adopted or cancelled as a stray (no unmanaged duplicates).
- A refused startup touches nothing: shutdown cancels only after the bot owns the book and disarms only a deadline it armed itself (mock test with a foreign order and another session's deadline).
- Two missed dead-man re-arms pull all quotes until the deadline is confirmed again; single-object acknowledgements require `status: "ok"` in the body.
- Tick moves use grid neighbours, so prices across a decade (999.99 → 1000.0) stay within 5 significant digits; off-grid prices or quantities are skipped.
- Partial portfolio frames update only the fields present. The volatility breaker precedes any freeze, and a freeze longer than `max_freeze_s` pulls quotes.
- The instrument poll matches by id. The daily-loss anchor persists across restarts. A resync requested during a reconcile survives it, and the private stream requests one after subscribing. The pull-path `cancelAll` is sent once and verified. Finished orders are pruned. Missing fees and PnL stay null. The mock-exchange test no longer races the `orders` event.

## Multiple instruments — 20 October 2026

The quoter now quotes any set of listed instruments from one process (`instruments:` in the config, or chosen in the dashboard). Account-wide pieces are shared: credentials, private stream, auto-cancel, action budget, daily-loss anchor and public sockets. Each instrument has its own book, orders, risk timers, metrics and cycle. The mock-exchange test quotes PLTR-USD and NVDA-USD together: one ladder batch per instrument, removing NVDA cancels only instrument 20 while PLTR's six orders and the account timer stay, re-adding works, and duplicates or unlisted symbols are refused. The dead man's switch is armed only after at least one instrument has taken ownership of its book; until then quotes stay paused, so a refused startup leaves another session's deadline untouched (mock test).

Dashboard checks in the in-app browser during a dry-run (PLTR-USD + NVDA-USD): asset tabs with status, uptime and score; adding TSLA-USD from the exchange catalog (89 instruments) started it within about 6 s and saved the selection; removing it restored two tabs. The catalog no longer redraws on every poll, so a click cannot be lost, and the hidden add panel now stays hidden. At 375 px the page did not overflow. Endpoint tests cover the token, JSON, confirmation and symbol checks for add/remove, and a refused add returns 409 with a redacted reason.

## Second review fixes — 20 October 2026

`docs/code-review-2026-10-20-8ab9520.md` (13 findings on `8ab9520`) was re-checked against `3ed5056`, which had already rewritten the lifecycle for several instruments. Twelve findings still reproduced; for finding 9 only the instrument-list dependency remained. Each fix has a regression test in `quoter/test/review20261020.test.ts` or `liveMock.test.ts`. Eleven of the twelve unit tests and both new mock tests fail on the code before the fixes; the remaining one depends on a helper that did not exist before.

- **Stop during startup (1).** The hub and each instrument check for Stop after every startup step. A Stop that arrives mid-startup ends it: no auto-cancel arm, private stream, timers or orders follow (mock test with a delayed `/v1/account/config`).
- **Stop during a cycle (2).** Once an instrument is stopping, the executor sends no further modify or place batch, and the instrument refuses every write except cancels. Shutdown waits for the one write in flight (egress timeout + 5 s), then cancels.
- **Unknown create outcome (3).** A create with a transport failure or malformed acknowledgement keeps its slot reserved. It is released only when the exchange reports the client id (stream, open orders or `GET /v1/account/orders?client_order_id=`), or after 330 s, when the 5-minute signature can no longer execute. Other slots keep quoting. While such a create is pending, a verified stop is not claimed, so the auto-cancel deadline stays armed.
- **Acknowledgement items (4).** Each item must have the documented shape for its position: `ok` with `oid` for creates, `ok` with `order` for modifies, `err` with an error string, and any echoed `coid` must match. Otherwise the batch is treated as indeterminate.
- **Book freshness (5).** A book is stale when its exchange event time (`ets`; `ts` for BBO) is older than `stale_book_ms` on the synced clock, even if it arrived just now. `ets = 0` falls back to the local receive time. The dashboard age includes the exchange lag.
- **Portfolio ordering (6).** Positions and margin each keep the exchange `timestamp` of the data applied. Older data, such as a slow REST reply, is ignored by both the instrument state and the account store.
- **Order updates (7).** An order update older than the last applied one (`uts` / `updated_timestamp`) is ignored, so a late modify acknowledgement cannot undo a fill.
- **Modify quantity (8).** `filled + target` is rounded down onto the quantity grid (5 significant digits). If that would not exceed `filled`, the order is replaced instead.
- **cancel-all (9).** The instrument list is not needed for `--instrument <numeric id>`. The command now fails unless the cancel is acknowledged and no open order remains.
- **Leverage (10).** Only a `status: "ok"` response reporting the requested leverage confirms the update. Anything else stops that instrument's startup.
- **Dead man's switch (11).** Disarm, and the shutdown decision to disarm, wait for any re-arm still in flight.
- **Config (12).** Unknown keys are rejected in every nested section (`risk.max_daily_losss_usd` is an error).
- **Dry-run depth (13).** Simulated quotes are no longer subtracted from the exchange book when measuring competing depth.

A read-only dry-run on real public data (PLTR-USD and TSLA-USD over two proxies, separate port and metrics directory) reached live books within 2 s. Over 30 one-second samples each book stayed `live`, with a book age including exchange lag of 133–305 ms (limit 2,000 ms). Simulated uptime was 1.0. The run stopped cleanly through its dashboard endpoint with no error lines.

## Limitations

- The live path is verified only against the mock exchange. Real acceptance of signatures, modify semantics, private `sq` numbering, `orders` event fields and margin reservation for opposite resting orders remain unverified until the account owner runs `status` and a $1k-per-level live session (spec §15, stage 6).
- The jurisdiction gate relies on the operator's declaration. It blocks the officially restricted countries and regions before any signature. The egress country is not considered.
- Private sequence gaps trigger a REST reconcile. If gaps are routine, detection is disabled for that connection and the 30 s periodic reconcile remains.
- Equity session profiles follow the NYSE weekly schedule without holidays.
- Pause/stop use `cancelAll` on the quoted instrument, and `autoCancel` is account-wide, so manual orders on the account can be affected.
- A create whose outcome stays unknown keeps its slot empty for up to 330 s if the exchange never reports the client id; order history may not list post-only rejections. During that time, removing the instrument or stopping reports an unverified cancel and leaves the auto-cancel deadline armed.
- The `cancel-all` CLI path has no automated test (the module runs on import); its changes are covered only by typecheck.
