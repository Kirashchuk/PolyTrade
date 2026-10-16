# ADR-0001: Typed single-venue PolyTrade workbench

**Status:** Accepted for local implementation
**Date:** 2026-10-15
**Deciders:** User product request; implementation decision by Codex

The paper-first UI and simulator-only automation portions are superseded by ADR-0002 at the user's request. The stack, venue boundary and guarded signing decisions remain in force.

## Context
Arcus, BULK and RISEx use Bun/TypeScript/Solid with modular analytics and carefully separated trading. PolyTrade starts in an empty folder. Polymarket Perps exposes its own REST, WebSocket, metadata, public leaderboard, proxy credentials and EIP-712 operations; prediction-market CLOB integration cannot be reused.

## Decision
Build one typed application using Bun 1.3.14, SolidJS/Vite, ECharts and native SQLite. Reuse architecture patterns: provenance snapshots, official-versus-derived metrics, guarded local controls, pure strategy decisions, explicit write outcomes and browser-held proxy credentials. Implement a new perps adapter. Default to paper trading; expose an opt-in local relay and browser signing for manual live trading. Bots in this delivery run in paper mode.

## Options considered
| Option | Complexity | Cost | Scalability | Team familiarity |
|---|---|---|---|---|
| Typed Bun/Solid single app | Low-medium | Local process | Adequate for one venue and local user | High across all three references |
| Copy complete BULK monorepo | High migration cost | More dependencies and services | Strong modular growth | High but Solana-specific signing incompatible |
| New React/Python service stack | Medium-high | Two runtimes | Adequate | Lower than current project ecosystem |

## Trade-off analysis
The single application retains separate modules and contracts without introducing deployment coordination. Bun's native server and SQLite remove framework/storage overhead. Strict adapter boundaries permit a later shared workspace. Polling REST with request coalescing is reliable for analytics; a public browser WebSocket improves terminal updates with explicit connection status. Each source retains its own freshness; reconnect never implies continuous historical coverage.

## Consequences
Local installation is small and consistent with the existing team stack. Public deployment and unattended live bots require a separate security and operational review. History begins with real exchange history or local samples, never generated backfill. Proxy registration requires the user's own registered Polymarket signer and wallet support.

## Action items
1. Implement typed adapter and provenance-aware views.
2. Implement paper execution and tested signing primitives.
3. Add guarded local relay, auditing and responsive UI.
4. Record verification results and untested live integration limits.
