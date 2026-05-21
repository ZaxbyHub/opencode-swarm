# SWARM_PLAN legacy root artifact cleanup hardening

## What changed

- `writeCheckpoint()` now performs best-effort cleanup of legacy root-level
  `SWARM_PLAN.json` and `SWARM_PLAN.md` after writing canonical checkpoint
  artifacts to `.swarm/`.
- Cleanup fs operations routed through `_internals` DI seam for testability.
- Updated stale comments in `save-plan.ts` and `phase-complete.ts` to reflect
  `.swarm/` location instead of "root-level".
- Added regression coverage in `src/plan/checkpoint.test.ts`:
  - Full cleanup: both legacy files removed, `.swarm/` artifacts preserved
  - Partial cleanup: only one legacy file exists, correctly removed
  - EPERM error path: `unlinkSync` failure is non-blocking, `.swarm/` still written

## Why

Some environments can still have root-level `SWARM_PLAN` files from prior
sessions or older versions. Keeping migration cleanup in the checkpoint write path
ensures ongoing plan saves converge to the invariant location (`.swarm/`) and do
not leave confusing root-level artifacts behind.
