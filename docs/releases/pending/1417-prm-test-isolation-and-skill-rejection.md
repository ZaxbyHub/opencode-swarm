## Fix: PRM test isolation, skill activation rejection check, and learning error test coverage

Fixes 5 defects from issue #1417 covering PRM test isolation, skill-curation defense-in-depth, and learning command error handling.

- **What**: (1) Rewrote `escalation-queue-drain.test.ts` from `vi.mock()` to `_internals` DI seam pattern, fixing 24 spurious PRM test failures. (2) Added `clearTrajectoryCache()` calls to prevent cross-file cache leaks. (3) Added unconditional `isRejectedSkillContent` check in `activateProposal` to block previously rejected skill content. (4) Added `_internals` DI seam to `learning.ts` and two new tests covering the error catch block. (5) Fixed PRM docstring from "replaces" to "complements" loop-detector.ts.
- **Why**: Fixes Issue #1417 — cascading test-isolation failure (24 false failures), missing defense-in-depth rejection check in skill activation, and untested error handling
- **Migration**: None
- **Known caveats**: SEC-PRM-001 (theoretical race on session PRM state) is deferred as a design-level change; AI-SLOP-SKILL-001 (write-only skill-improver proposals) is out of scope for this fix
