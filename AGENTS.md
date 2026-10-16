# PolyTrade engineering rules

Use Bun 1.3.14 and strict TypeScript. Read specs/001-polytrade before substantial changes.
Only Polymarket Perps APIs belong in the venue adapter. Prediction CLOB APIs are out of scope.
Missing metrics are null. Preserve source URL, timestamps and live/stale/unavailable state.
Never substitute sample data for unavailable official data. Decimal strings remain exact through signed operations.
Market orders are IOC limit orders with an explicit slippage bound. Check metadata, freshness, book depth and close-only/settlement state before execution.
Paper accounts and exchange accounts must remain visibly separate. Paper execution has no upstream write access.
Browser proxy credentials stay in memory and must never enter files, logs or analytics responses.
Signed financial writes get one attempt. A transport failure is indeterminate and must be reconciled before another order.
Local mutations require loopback Host and same-origin JSON requests plus a per-process control token. Live relay is opt-in and loopback only.
Do not execute live trades, fund accounts, withdraw, deploy publicly or alter any reference checkout during development.
Run bun run check and meaningful API/browser checks before delivery. Record limitations in docs/verification.md.
