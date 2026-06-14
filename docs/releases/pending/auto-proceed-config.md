# Auto-proceed config for phase transitions

## What changed

- **Auto-proceed for phase transitions**: Users can now configure the swarm to automatically advance from one phase to the next without the architect asking "Ready for Phase N+1?" at each boundary.
- **Three tiers of control**:
  - **Plan default**: Set `auto_proceed: boolean` (default `false`) in the plan's `execution_profile` during QA GATE SELECTION.
  - **Session override**: The `/swarm auto-proceed on|off` command toggles the setting for the current session only.
  - **First boundary nudge**: At the first phase boundary (if auto-proceed is off), the architect asks once per session whether you'd like to enable it for the remainder of the run. The nudge is recorded in `session.autoProceedNudgeDone` and is reset on snapshot rehydration.
- **Resolution order**: Session override always wins over the plan default. Resolved value is computed by `getResolvedAutoProceed(session, planAutoProceed)` and surfaced to the architect via an injected `AUTO_PROCEED STATUS` banner (in `src/config/constants.ts` and injected by `src/hooks/system-enhancer.ts`).
- **Architect-only command**: `/swarm auto-proceed` only accepts calls from the architect session (canonical role check via `stripKnownSwarmPrefix(session.agentName) === 'architect'`). Subagents calling this command receive an error.
- **Runtime toggle via swarm_command**: The architect can toggle auto-proceed at runtime by calling `swarm_command({ command: "auto-proceed", args: ["on"|"off"] })`. The command handler also marks the nudge as done.
- **Independence from full-auto**: Auto-proceed does not affect or interact with full-auto mode; the two features are independent.
- **Scope**: Auto-proceed only skips the phase-transition confirmation prompt. Blocked tasks, open questions, required architect input, and other pauses still halt execution as before.

## Why

This gives architects and users explicit, layered control over phase advancement cadence without forcing full-auto or manual "ready?" confirmations at every boundary. The nudge provides a low-friction on-ramp for users who discover the feature mid-run.

## Migration steps

None required. The feature is additive and defaults to the prior behavior (`auto_proceed: false`).

## Breaking changes

None.

## Known caveats

- The first-boundary nudge fires at most once per session.
- Session overrides (`autoProceedOverride`, `autoProceedNudgeDone`) are not persisted across sessions or plan reloads — they are reset to `undefined` on snapshot rehydration via the `TRANSIENT_SESSION_FIELDS` mechanism in `src/session/snapshot-reader.ts`. They still survive mid-session snapshot writes.
- Auto-proceed has no effect on non-phase-boundary pauses (e.g., blocked tasks, critic rejections, required input).
- The `/swarm auto-proceed` command rejects calls from non-architect sessions (e.g., coder, reviewer, tester).
