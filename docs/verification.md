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
