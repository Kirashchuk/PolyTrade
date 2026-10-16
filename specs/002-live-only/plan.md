# Implementation plan

1. Preserve the legacy backend simulator. Remove its use from active frontend routes and startup copy. Provide an explicit `start:live` command; the generic server retains an opt-in relay switch.
2. Share one browser live-session controller across terminal and automation pages. Private positions, orders and journal remain source-backed. Guard manual controls while the live bot owns execution, including across tabs.
3. Extend the existing EIP-712/MessagePack session with the official `autoCancel` operation and private readback, durable unknown-state recovery, plus private owned-order history reads.
4. Add a browser-only serialized live strategy manager. Reuse deterministic pure order planning, replace paper execution with actual signed submit/cancel, and positively reconcile exchange orders and executed quantities. Bound quantity, schedule and slippage; own no credentials itself.
5. Test order/deadman ambiguity, ownership, stale data, scope locks, stops and restart recovery. Run the full checks, HTTP smoke and desktop/mobile UI QA without a wallet or signed upstream requests. Update delivery documentation.

Failure model: any ambiguous financial write blocks the session; a halted bot may reconcile but must not resubmit an uncertain operation. Native account-wide cancellation can affect orders from external tools, so starting requires an idle order book and explicit scope consent. Browser suspension does not maintain the deadman; the exchange enforces the last confirmed deadline. Stopping never flattens positions.
