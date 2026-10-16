# Reference study: inspected 15 October 2026

All reference folders were read-only. No keys, .env files, trading state or services were loaded. Actual source takes precedence over older README/ADR claims.

| Project | Verified stack and status | Reused principles |
|---|---|---|
| C:/Arcus-Suite | Solid/Vite/Tailwind/TanStack Query; Bun 1.3.14, Elysia, SQLite. Root is current checkout; nested Project-Arcus is an older clone. Scan, funding, carry and maker implemented. | Nullable provenance metrics, interval-aware funding, retained stale data, persisted intent before send, unknown-outcome recovery, guarded local controls. Actual code supports local and browser signing; older docs understate this. |
| C:/BulkProject | Bun workspace with Solid 1.9.15, Vite 6.4.3, ECharts 6.1, Elysia 1.4.30, SQLite WAL. Broad analytics, real terminal and integrated bot runtime. | Typed feature boundaries, centralized read budget/cache, browser-held credentials, pure reducers, serial execution, scoped cancellation, one-attempt signed writes. Solana/WASM auth is not applicable to Polymarket. |
| C:/WeAreRise! | Bun/TS/Solid/ECharts/Elysia/SQLite/viem. Root mainly S0 skeleton; analytics/execution/bot implementations are in active worktree folders, and trade UI was still a placeholder. | Source/coverage snapshots, tape coverage gaps, exact signed values, shared book hub, pure strategies and indeterminate-write halt. Do not describe the whole root as a completed terminal. |

## Evidence paths

Arcus: CLAUDE.md; src/App.tsx; src/data/client.ts; src/shared/types.ts; src/features/funding/math.ts; src/bot/engine.ts; src/bot/quote.ts; src/features/maker/browser-service.ts; src/server/public.ts.

BULK: CLAUDE.md; apps/server/src/core/{feature,gateway,budget,store}.ts; packages/contracts/src/common.ts; packages/strategies/src/types.ts; packages/engine/src/executor.ts; apps/server/src/features/bots/runtime.ts; apps/web/src/features/trade/Page.tsx; apps/web/src/components/EChart.tsx.

RISEx: CLAUDE.md; docs/roadmap.md; packages/contracts/src/common.ts; apps/server/src/core/gateway.ts; .claude/worktrees/s1-overview-f27dd0; s2-markets-d7d9fd; s3-execution-7f1f68; s4-trade-5620e0. Worktree paths are implementation evidence, not a confirmed merge status.

## Polymarket-specific integration

Official REST: https://api.perpetuals.polymarket.com. Official WS: wss://ws.perpetuals.polymarket.com/v1/ws. Schemas: https://docs.polymarket.com/api-spec/perps-openapi.json and https://docs.polymarket.com/asyncapi-perps.json. Public probes and timestamps are in artifacts/probe.json.

The perps adapter uses official instrument metadata, tickers, statistics, exchange-stats, book, candles, trades, funding and leaderboard. statistics.volume is quote notional; candle volume is base units. OI quantity times mark is a derived USD estimate; exchange-stats OI is the official one-sided sampled notional with its own timestamp. APR is a simple rate extrapolation. No prediction-market TVL or fees are imported.

Authentication uses a Polygon-chain EIP-712 owner signature for an expiring proxy, then proxy signatures over MessagePack compact-operation hashes. POST acknowledgement is not a fill. Private reads use proxy/secret headers. Default app configuration disables the live relay; manual browser trading is opt-in. Proxy secrets and keys remain in browser memory. Bots in this delivery are paper-only.

Official September 27 changelog says builder attribution and TWAP entry are switched off. PolyTrade's TWAP is a locally scheduled paper strategy, not a claim that exchange-native TWAP is enabled. Advanced unavailable order types are not presented as working.
