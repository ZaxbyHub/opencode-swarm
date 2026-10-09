# Docs: Turbo and Lean Turbo guidance now says Stage B is required

## What

The Turbo banner, the Lean Turbo banner, the `/swarm turbo` enable message,
`docs/commands.md`, `docs/modes.md` and the README all said that Turbo (for
non-Tier-3 tasks) and Lean Turbo (for lane tasks) skip per-task Stage B
(reviewer + test_engineer). The runtime does not skip it. The final, locked
check in `update_task_status(completed)` always passes a fallback directory, so
the Turbo and Lean bypass branches in `checkReviewerGate` are never reached
from the real tool. They have been unreachable since the transactional
task-transition change. Only tests that call `checkReviewerGate` directly
still exercise them.

An architect that followed the old guidance completed tasks without Stage B
and was refused. The guidance now matches the runtime:
- Turbo and Lean bypass neither Stage A nor Stage B: each applies exactly
  where it would without them (Tier 0 tasks and QA-exempt phases skip
  Stage B either way);
- Turbo skips phase_complete Gates 1–5;
- Turbo lets a non-Tier-3 task be re-dispatched to the coder before Stage A;
- Lean's phase reviewer and critic are an extra gate, not a replacement for
  Stage B.

The stale `phase-complete.ts:774–827` reference in the banner is replaced by a
reference to the gate table.

The same correction now covers the remaining places that still said Turbo
bypasses QA: the `turbo_mode` description in `opencode-swarm.schema.json` and
`docs/configuration.md`, the `/swarm turbo` row in the README command table,
the Turbo row in `docs/getting-started.md`, and the Lean Turbo vs Epic answer in
`docs/modes.md`. `docs/modes.md` now cites `src/parallel/tier3-classifier.ts`
for the Tier 3 list instead of a stale `update-task-status.ts` line range. The
Turbo banner and `docs/modes.md` also say that only a task whose planned
`files_touched` are known can be re-dispatched to the coder before Stage A; a
task with unknown or empty `files_touched` keeps the block.

No behaviour changes. If the Turbo/Lean Stage B bypass is meant to work, the
fix belongs in `update_task_status`, and this text should be reverted together
with that change.
