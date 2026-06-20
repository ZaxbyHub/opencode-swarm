# `/swarm loop` compound-engineering command + compound-shortcut TUI fix

## What

Two changes.

**1. New first-class `/swarm loop` command.** A user-initiated
compound-engineering workflow that chains the existing mode skills —
brainstorm → plan → build → review → improve — into a gated, iterating loop and
ends each cycle with a learning-capture step so the next cycle is cheaper.

- New command handler (`src/commands/loop.ts`) emits a
  `[MODE: LOOP max_cycles=N autonomy=checkpoint|auto depth=standard|exhaustive resume=true|false] <objective>`
  signal, with the same prompt-injection sanitization as the other mode
  commands.
- New bundled skill `.opencode/skills/loop/SKILL.md` defines the protocol:
  ordered phases with entry/exit evidence gates, generator/critic separation
  (the coder never approves its own diff; review is report-only with a separate
  fix step), defense-in-depth stop conditions (objective met, `--max-cycles`
  budget, plateau, oscillation, unrecoverable error, user stop), durable
  resumable run state under `.swarm/loop/<run-id>/`, and a mandatory compounding
  learning-capture step before completion.
- Fully wired: registry entry (`toolPolicy: 'none'`), `swarm-loop` TUI
  shortcut, `BUNDLED_PROJECT_SKILLS` + `package.json` `files` so the skill ships
  in the npm package, and a `MODE: LOOP` dispatch block in the architect prompt.
- Flags: `--max-cycles 1..5` (default 3), `--autonomy checkpoint|auto`
  (default checkpoint), `--depth standard|exhaustive`, `--resume`.

**2. Fix: compound `/swarm <a> <b>` commands were unrecognized via their TUI
shortcuts.** OpenCode registers each shortcut under a dash-joined name (e.g.
`swarm-pr-subscribe`), which `normalizeSwarmCommandInput` strips to the single
token `pr-subscribe`. Commands registered only under a space key
(`'pr subscribe'`) had no dash form, so `resolveCommand` returned null and the
TUI showed "command not found". Added dash aliases (mirroring the existing
`config-doctor` / `doctor-tools` pattern) for all ten affected shortcuts:
`pr subscribe`, `pr unsubscribe`, `pr status`, `sdd status`, `sdd validate`,
`sdd project`, `memory status`, `memory export`, `memory import`,
`memory migrate`. Added a regression test
(`src/commands/shortcut-resolution.test.ts`) that simulates the real TUI
dispatch for **every** `swarm-*` shortcut and asserts it resolves to a handler —
the coverage that was missing when this shipped broken.

**3. Security hardening: aliases can no longer bypass the human-only Bash
guardrail.** Five of the new dash aliases (and the pre-existing `clear` →
`reset-session` alias) point to `human-only`/`restricted` commands. The Bash
CLI guardrail (`src/hooks/guardrails/tool-before.ts`) blocks an agent from
running human-only commands via shell by matching the captured token against
`HUMAN_ONLY_SWARM_COMMANDS`, which was derived only from each entry's own
`toolPolicy`. Aliases carry no `toolPolicy`, so the dash/alias form
(`bunx opencode-swarm run memory-import`) would have slipped past the gate that
blocks the space form. `HUMAN_ONLY_SWARM_COMMANDS` is now canonical-aware: any
alias whose `aliasOf` target is `human-only`/`restricted` is included, so both
the space and alias forms are blocked. This also closes a pre-existing latent
bypass via `clear` (→ restricted `reset-session`). A regression test asserts the
alias/dash forms are blocked while agent-policy aliases stay allowed.

## Why

`/swarm pr subscribe` (and nine sibling compound commands) were registered and
documented but could not be invoked from the TUI shortcut — a dead surface. The
loop command packages the project's existing brainstorm/plan/execute/phase-wrap
skills into the state-of-the-art compound-engineering loop with the
generator/critic separation and termination safety the rest of the plugin
already values.

## Migration

No breaking changes. Both changes are additive:
- The dash aliases are `deprecated`-flagged and inherit their canonical command's
  tool policy via `canonicalCommandKey` (`aliasOf`), so human-only commands
  (`pr subscribe`, `pr unsubscribe`, `sdd project`, `memory import`,
  `memory migrate`) keep their human-only gate — the dash form cannot bypass it.
- `/swarm loop` is a new opt-in command; no existing command behavior changes.

## Caveats

- The loop protocol is an architect-prompt + skill workflow, not a hard-coded
  state machine: enforcement of phase gates and stop conditions relies on the
  architect following the bundled `SKILL.md`, consistent with the other
  MODE-based commands (deep-dive, codebase-review, brainstorm).
