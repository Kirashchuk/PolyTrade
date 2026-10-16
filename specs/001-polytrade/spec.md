# PolyTrade: analytics and trading on Polymarket Perps

Product update 2026-10-15: `specs/002-live-only/spec.md` supersedes the paper UI and paper automation stories below. This document retains the original baseline for the preserved simulator modules and tests.

## Goal and assumptions
Build a locally runnable app in C:/PolyTrade with the same product families as Arcus/BULK/RISEx. Reference apps inform patterns; Polymarket gets its own adapter and authentication. Default UI is a dense English trading interface, matching the reference products. Local single-user installation is the initial target; public hosting is not requested.

## User stories and acceptance
P1: As a researcher, view an exchange overview and searchable/sortable market screener with official 24h quote volume, one-sided open-interest notional, price movement, funding and category breakdown. Independent test: API snapshots contain provenance and missing values stay null; UI filters and navigates to a selected market.
P1: As a trader, inspect candles, order book, trades, funding history and slippage/depth analytics for a selected instrument. Independent test: tuple formats normalize correctly, changing instrument updates all panels, stale books cannot execute.
P1: As an operator, place and cancel paper market/limit orders, view positions, realized/unrealized PnL and an execution journal. Independent test: partial fills, reduce-only, margin, fees and restart persistence are correct. Paper outcomes are clearly labelled, and no venue write is issued.
P2: As a trader, connect an injected EVM wallet, authorize an expiring proxy, inspect a private account and submit/cancel a reviewed signed order through an explicitly enabled local relay. Independent test: official EIP-712/MessagePack shapes and guard tests, with mocked transport only. No live trade is performed during development.
P2: As a researcher, compare funding, rank traders by calendar window, and inspect API health/source definitions. Independent test: simple annualization uses the instrument funding interval; windows and leaderboard coverage are shown accurately.
P2: As an operator, run and stop paper TWAP/maker strategy sessions with bounded notional, fresh data and a kill switch. Independent test: execution is serialized, idempotent per tick and halts on invalid data.

## Edge cases and requirements
503/429/timeouts retain last good observations as stale and back off. Empty books, absent statistics, malformed payloads, unsettled metadata, retired/close-only markets, disconnected wallets, expired credentials and unknown write outcomes are explicit states. Volume uses statistics.volume; candle volume is base units. Ticker OI is base quantity; OI USD is a derived mark conversion. Funding APR is simple extrapolation, never a forecast. No invented TVL, historical series or cross-venue opportunities. Signed values preserve exact decimals. Trading checks max notional and leverage tiers; user-selected leverage is an estimate until the exchange confirms it.

## Success criteria
One documented install/build/start workflow; functioning data-backed screens, locally persisted paper activity, implementable browser signing path, passing financial/security tests and production build, browser QA at desktop/mobile widths. Evidence and remaining integration limits documented.
