# ADR-0002: Live-only UI with browser-owned trading automation

**Status:** Accepted
**Date:** 2026-10-15
**Deciders:** User (product direction), implementation team (local architecture)

## Context

The user removed simulation from the product UI and requested real terminal and bot execution. Existing bots are simulators; changing their labels cannot satisfy the request. Proxy credentials must remain in memory, signed writes must not retry, and development must not place real trades.

## Decision

Keep the simulator modules, persistence and tests dormant. Make the active UI exclusively exchange-backed. Share the existing browser signer with a new live strategy manager. Serialize manual and bot execution with exclusive browser locks, and use the official account-wide auto-cancel deadline as the resting-order backstop. Startup of every session is explicit, bounded and requires a registered wallet account. The loopback relay remains allow-listed and opt-in.

## Options considered

| Option | Complexity | Credentials | Consequence |
|---|---|---|---|
| Browser-owned live scheduler (chosen) | Medium | Memory only | Stops scheduling on browser closure; deadman cancels resting orders |
| Background server bot | High | Needs a persistent or transferred signer | Conflicts with current browser-only credential constraint |
| Hide paper controls without live bots | Low | Existing manual signer | Does not fulfill the requested bot behavior |

## Consequences

Real strategy operations use the same validation and single-attempt reconciliation as manual orders. Acknowledgement never counts as a fill. One PolyTrade bot owns account execution, stop targets owned orders and leaves positions. The account-wide deadman requires explicit scope acknowledgement and no pre-existing orders; activity from unrelated external clients cannot be locked by the app. A suspended or closed tab cannot keep the scheduler running. Refresh preserves nonsecret recovery records but never resumes execution or credentials.

## Action items

Implement feature 002, run mocked financial failure tests and browser QA, and document actual account-owner integration as unverified until the owner performs it.
