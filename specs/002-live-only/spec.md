# Live-only terminal and automation

Date: 2026-10-15. Accepted user change: hide/freeze the paper interface and retain real trading through the terminal and bots. This supersedes the paper-first product defaults in feature 001; the original simulator remains as dormant code and regression tests.

## Stories and acceptance

P1: The terminal presents only an exchange account. No simulated balances, paper mode switch, paper order controls, simulator reset, or paper account polling appears in the frontend. Disconnected or unavailable private data is unavailable, never replaced by a simulated balance. Existing analytical screens continue to work.

P1: A connected registered account signer can explicitly authorize an expiring in-memory proxy and review/submit or cancel real orders through the opt-in loopback relay. Each signed write gets one attempt; transport ambiguity persists as an unresolved intent and blocks further orders until reconciliation. Existing freshness, metadata, depth, margin, leverage and decimal checks remain mandatory.

P1: The automation page starts actual browser-operated TWAP or maker sessions only after explicit real-trading consent, confirmed account access, configured quantity/time/slippage bounds and acknowledgement of the exchange-wide deadman cancellation scope. No simulator endpoint participates in the execution path.

P1: One bot owns the account's PolyTrade execution at a time, across tabs. Manual writes cannot overlap a running bot. Start requires no existing open exchange orders. Each order has an owned client ID; cancellation targets only owned orders. Fills come from private order history, never acknowledgements. The bot halts on ambiguous writes or invalid/stale inputs, and never retries an uncertain signed write.

P1: The exchange auto-cancel deadline is armed and positively read back before orders, then renewed while the session runs. Expiration/browser closure stops scheduling; the last exchange deadline bounds resting-order lifetime. Stop cancels/reconciles owned orders and leaves positions unchanged. Reload never resumes a bot or restores credentials automatically; nonsecret intent/session journals remain available for recovery.

## Constraints

Preserve Bun 1.3.14, strict TypeScript, existing source provenance and null missingness. Preserve legacy simulator code and database, without linking them into live product UI. No unattended server signer or stored proxy keys. No live order, wallet owner signature, account funding/withdrawal or public deployment during development. Test financial writes with mocked transport and fixed test keys only.

## Success

Production UI has no simulator controls or requests; both terminal and bots use the same real signed session. Strict checks and meaningful financial failure-path tests pass. Guarded local HTTP and desktop/mobile browser checks pass. Verification records the absence of a real account-owner end-to-end trade and the browser-lifetime operational limit.
