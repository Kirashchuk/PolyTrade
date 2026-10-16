# Verification — 15 October 2026

The local implementation is complete and verified against `specs/001-polytrade/spec.md`. The reference repositories were inspected read-only; no reference service, credentials or trading state was loaded. The architecture comparison is in `docs/reference-study.md` and the accepted decision in `docs/adr/0001-polytrade-architecture.md`.

## Automated verification

`bun run check` passed using Bun 1.3.14: strict TypeScript, **58 tests, 0 failures, 308 assertions**, then the production Vite build. The complete output is `artifacts/check.log`. Coverage is behavioral rather than a percentage claim:

| Requirement | Evidence |
|---|---|
| Official metric units, null missingness, fractional funding/APR/ROI, tuple formats | `tests/venue.test.ts`; all 11 public captures normalize, including 88 instruments |
| Coalesced cache, retained stale data, source-clock freshness, 429/503 backoff | `tests/venue.test.ts` |
| Fresh non-crossed books; precise quantity/price; bounds, tiers, contingent exposure and order-count caps | `tests/trading.test.ts` |
| Partial IOC, exact PnL/fees, margin rollback, duplicate IDs and consumed-depth persistence | `tests/trading.test.ts`; file-backed restart test |
| Conservative passive limit fills at the owned limit; rollback reference and decimal-spelling regressions | `tests/trading.test.ts` |
| Pure deterministic TWAP/maker intents, bounded serial ticks, owned-order stop/kill and restart halt | `src/trading/strategies.ts`, `tests/trading.test.ts` |
| Official compact MessagePack/EIP-712 shapes, explicit review, single-attempt writes and reconciliation | `tests/trading.test.ts`, mocked owner/proxy signing and mocked transport |
| Durable nonsecret intent recovery, cross-tab locking, malformed private account data fail closed | `tests/trading.test.ts` |
| Host/origin/token guards, disabled live relay, byte-preserving signed relay and denied transfers/withdrawals | `tests/security.test.ts`, `tests/server.test.ts` |
| Guarded HTTP integration, static-path traversal, clean store shutdown and idle scheduler behavior | `tests/server.test.ts` |
| Public WS top-50 full-book shape, attested horizon, malformed/stale frame rejection | `tests/stream.test.ts`, `artifacts/websocket-probe.json` |

Vite reports a non-blocking chunking hint: the shared order-math module is imported statically for paper depth previews and dynamically from the live panel. The build succeeds; the hint does not affect execution. ECharts and the live signer load in separate chunks.

## Live public data and local HTTP checks

All 11 official public REST probes returned HTTP 200. `artifacts/probe.json` records endpoint URLs, observation times, byte counts and SHA-256 hashes; the corresponding `official-*.json` files are evidence only and are never substituted for runtime data. Official OpenAPI/AsyncAPI snapshots are retained under `docs/upstream/` with their embedded license metadata.

The public WebSocket acknowledged book/trades subscriptions and supplied fresh BTC top-50 depth frames. A second connection with the local browser Origin also received depth. The actual browser terminal displayed **WS LIVE**. Reconnect and stale handling preserve a labelled REST fallback.

`artifacts/local-smoke.json` records the final running API check: health, markets, overview, book, candles, trades, funding, leaderboard, paper and bots all returned HTTP 200. Market snapshots contained 88 instruments and the official 200-order cap. The captured BTC history contained 241 hourly candles and 24 funding rows. These counts describe the observed responses, not permanent exchange limits.

Final paper state: equity 10,000 pUSD, zero positions, zero resting orders, zero running strategies. One stopped maker session and the paper QA audit remain as records of actual local tests. The live relay is disabled. Runtime process metadata is in `artifacts/runtime.json`; the service binds only to `127.0.0.1:4310`.

## Browser verification

Verified all seven pages: overview, markets, terminal, funding, leaderboard, automations and system. Specific interactions passed: BTC search and market-to-terminal navigation; instrument and candle controls; funding sorting; leaderboard window/sort loading with 100 returned rows; paper limit placement/cancellation; paper maker start/stop; disabled-live presentation; mobile menu navigation. The paper order reserved 40 pUSD of margin and cancellation restored the available balance.

Desktop and 390 × 844 mobile layouts were inspected. On mobile, document width was 375 px within a 390 px viewport, the closed sidebar ended at x=0, the candlestick canvas rendered and the book badge was WS LIVE. The viewport override was reset after QA. The application console returned no errors or warnings; unrelated automation-host telemetry errors are not application diagnostics.

Saved evidence: `artifacts/overview.jpg`, `terminal.jpg`, `terminal-mobile.jpg`, `browser-mobile.json`, `browser-leaderboard.json` and `browser-instrument.json`. The last record confirms instrument 7 (ETH), the 5m control and the matching official candle source URL. Source, configuration, schema, test and build hashes are in `artifacts/delivery-manifest.json`.

## Explicit operational limits

No real wallet owner signature, proxy registration, order, transfer, funding transaction or withdrawal was executed. Manual live integration is implemented and tested with fixed test keys and mocked transport; actual account-owner end-to-end validation remains unperformed. A browser with an injected EVM wallet, secure-context Web Locks and a registered Polymarket account signer is required. The in-app browser can inspect the product without providing a wallet extension.

Live proxy credentials remain memory-only. Refresh discards them but retains nonsecret unresolved intent metadata; new financial requests stay blocked until reconciliation. Acknowledgement is not a fill, and transport ambiguity never causes an automatic retry. The relay must be explicitly enabled locally before any real authorization or order can be attempted.

Paper bots have no upstream write capability. Simulation uses displayed depth and estimated default fees; it excludes funding settlement, liquidation, queue priority, hidden liquidity and venue matching guarantees. APR is simple extrapolation, not a forecast. Historical and leaderboard views represent only returned official coverage. Public deployment and unattended live bots were not requested or performed.
