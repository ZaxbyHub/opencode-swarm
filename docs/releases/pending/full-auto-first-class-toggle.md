# Full-Auto is now a first-class session toggle

## What changed

- `/swarm full-auto on|off` no longer requires `full_auto.enabled: true` in the plugin config. Full-Auto activates immediately from the session, like switching a permission mode — the critic then reviews escalations, phase boundaries, delegations, and architect questions on your behalf, and only `ESCALATE_TO_HUMAN` verdicts (or system pause/terminate conditions) hand control back to you.
- `/swarm full-auto off` now **disarms** the run (durable status `idle`) so the session returns to normal interactive operation. Previously the off path left a `paused` record that fail-closed-blocked every non-read-only tool until the next `on`. Paused/terminated blocking is now reserved for system-initiated halts (denial limits, critic verdicts, oversight failures).
- New `/swarm full-auto on <mode>` argument (`assisted` | `supervised` | `strict`) overrides `full_auto.mode` for the run, and the permission classifier enforces the run's mode (not the init-time config mode). A bare mode token (`/swarm full-auto strict`) is treated as `on strict` — it can never silently toggle Full-Auto off.
- New `/swarm full-auto status` subcommand reports the session flag, durable run state (status, mode, counters, denials, last oversight verdict), config lock, and — when the state file is corrupt — an explicit `UNREADABLE` diagnosis instead of a misleading "none".
- New `full_auto.locked` config flag (default `false`): when `true`, runtime activation is refused — the administrative hard-off. `locked` ORs across config levels (a repo-controlled project config cannot override a user-level lock), activation fails closed when a config file exists but cannot be parsed, and `.opencode` is now in the default Full-Auto protected paths so an autonomous agent cannot edit the config that governs it. `off` and `status` always work.
- The Full-Auto v2 hooks (permission, input probe, delegation, cadence oversight, phase-approval gate) are always armed and gated by the durable per-session run state instead of being created as permanent no-ops when `full_auto.enabled` was false. The legacy reactive intercept remains gated by the in-memory session flag. This also closes a latent gap where a durable running run was silently unenforced if config disagreed.
- The durable-state read path now uses an mtime/size-keyed cache, so the always-armed hooks cost a stat (not a full read+parse) per tool call once a state file exists.
- Snapshot rehydration reconciles a restored `fullAutoMode` flag against the durable run state (kept only when the run is still `running`) instead of the config flag, failing closed toward OFF.
- The critic-model-equals-architect-model advisory now fires at activation time, and only when both models were explicitly configured (zero-config installs no longer get a standing false-positive warning).

## Why

Full-Auto previously required editing the plugin config and restarting OpenCode before the toggle worked, making autonomous execution a deployment decision rather than a session decision. This brings it in line with auto/full-access modes in other agent CLIs: on and off at will, with the critic acting as the user's reviewer-of-record while active.

## Migration

- No action needed for most users. Existing `full_auto.enabled: true` configs keep working; the flag is now deprecated as a gate and only controls the legacy init-time advisory.
- If you relied on `full_auto.enabled: false` (or its absence) to *prevent* Full-Auto activation, set `full_auto.locked: true` to restore a hard-off. Place the lock at the user level (`~/.config/opencode/opencode-swarm.json`) to make it immune to repo-controlled project configs.

## Breaking changes

None at the API level. Behavioral: `/swarm full-auto on` now succeeds without config enablement (set `full_auto.locked: true` to refuse it); `on <invalid-mode>` returns an error instead of ignoring extra arguments; `off` disarms instead of pausing (sessions are no longer write-blocked after turning Full-Auto off).

## Known caveats

- A system-paused or terminated run still blocks non-read-only tools for that session until `/swarm full-auto on` (resume) or `/swarm full-auto off` (disarm).
- A corrupt `.swarm/full-auto-state.json` (with failed `.bak` recovery) fail-closed-blocks non-read-only tools project-wide — including sessions that never used Full-Auto — until the file is restored or deleted. `/swarm full-auto status` surfaces this as `UNREADABLE`.
- Adding `locked: true` does not retro-terminate an already-running run; use `/swarm full-auto off` first.
