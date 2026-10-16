# Implementation plan

Use Bun 1.3.14 + strict TypeScript, native Bun HTTP server and SQLite WAL, SolidJS/Vite, ECharts, viem and MessagePack. This follows the reference ecosystem while avoiding unnecessary monorepo infrastructure for one venue.

Layers: src/shared/contracts.ts -> src/server/venue.ts (read-only official adapter/cache) -> src/server/index.ts (loopback guarded API) -> src/client (view state/charts); src/trading (exact validation, paper ledger/strategies, browser proxy signing). Separate modules own their data and lifecycle. Server starts with fresh local data/; no reference state is reused.

API: /api/health, /api/markets, /api/overview, /api/book/:id, /api/candles/:id?interval=..., /api/trades/:id, /api/funding/:id, /api/leaderboard, /api/session; guarded paper/account/bot writes; an allow-listed /api/live relay gated by POLYTRADE_LIVE_ENABLED=1.

Read cache coalesces concurrent requests and retains stale snapshots. Public read retries are bounded; signed writes never retry. SQLite stores paper account state and audit, not credentials. Strategies consume validated snapshots and emit paper intents only. Live credentials remain memory-only in the browser; the wallet signs proxy registration, proxy signs trading operations.

Verification: exact-decimal validation and PnL tests; book slippage/depth tests; stale/unknown/close-only/security tests; build/typecheck; public endpoint probe; local HTTP integration and responsive browser interaction QA. Stop server cleanly when not needed. Live relay stays disabled during tests.

Consistency analysis: no predictive-market APIs, no inferred API data, no secrets copied, signed writes separated from GET cache, actual fills distinct from acknowledgements. Builder attribution is switched off in official September changelog and excluded from current scope. Reference bot safety patterns are reused, not their venue-specific signing protocols.
