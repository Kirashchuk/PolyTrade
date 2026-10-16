# Local verification evidence

This directory contains generated, unversioned development evidence: test/build logs, public API probes, browser screenshots, runtime process metadata and delivery hashes. No runtime credentials belong here.

Run `bun run check` for the automated checks and production build. With the local service running through `bun run start:live`, run `bun --no-env-file scripts/verify-live-local.ts` for read-only HTTP checks. `bun run probe` refreshes public API captures. Browser screenshots require a separate responsive UI check.

The development verification report in `docs/verification.md` describes the observed local results and operational limitations. Generated evidence referenced by that report is intentionally not published with the source repository.
