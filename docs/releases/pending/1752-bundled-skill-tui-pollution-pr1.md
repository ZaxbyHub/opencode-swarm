# Bundled-skill TUI pollution fix + advisory helper + noConsole lint

## What

Fixes the user-visible TUI corruption caused by the bundled-skill sync writing
raw `console.warn` to stderr while the OpenCode bubbletea TUI owns the terminal
(the same failure class as the closed issue #1249). This is PR1 of the
comprehensive sweep tracked in epic #1752.

## Why it polluted the TUI

`syncBundledProjectSkillsIfMissingAsync` (`src/config/bundled-skills.ts`)
emitted one raw `console.warn` per synced slug on success, and another on
failure. The `/swarm` command path (`src/commands/registry.ts`,
`handleModeCommandWithBundledSkills`) called it **without the `quiet` argument**,
so `quiet` defaulted to `false` and the per-slug warning fired **unconditionally**
on every `/swarm` mode command run against a project missing a skill file —
mid-turn, corrupting the display.

## Changes

- **`src/services/warning-buffer.ts`** — added `advisoryWarn(msg, data?)`: the
  TUI-safe advisory helper that composes the deferred-warning buffer (surfaced
  in `/swarm diagnose`) with the debug-gated logger (`OPENCODE_SWARM_DEBUG=1`).
  It never writes raw stderr/stdout. This is the foundation for the rest of
  epic #1752 (PR2–5 migrate the broader ~95-site surface).
- **`src/config/bundled-skills.ts`** — success is now debug-gated only (a
  routine, expected event; never narrated to stderr). The failure path under
  `quiet=true` routes to `advisoryWarn` (visible in `/swarm diagnose` instead
  of silently dropped); under `quiet=false` it keeps the legacy visible warning
  for parity with other init advisories.
- **`src/commands/registry.ts`** — the command path now passes `quiet=true`
  unconditionally. It runs inside an active chat turn, so it must never write
  raw stderr regardless of the user's `config.quiet` setting.
- **Tests (the hard enforcement)** — extended
  `tests/unit/plugin-tui-safety.test.ts` to scan `bundled-skills.ts` and
  `registry.ts` (not just `src/index.ts`) for unguarded `console.warn`; added
  a command-path end-to-end guard in `tests/unit/commands/codebase-review.test.ts`
  asserting no `console.warn` fires during dispatch; added
  `tests/unit/services/warning-buffer.test.ts` covering `advisoryWarn` and the
  buffer API; updated `tests/unit/config/bundled-skills-async.test.ts` to assert
  success silence and the failure-under-quiet → buffer path. This source-scan
  test is the regression guard for the #1249 class on PR1's owned files.
  (Enabling Biome's `suspicious/noConsole` globally was considered but deferred
  to PR5 of epic #1752: in `biome ci` mode even `warn`-severity diagnostics fail
  the build, and the ~295 pre-existing sites are owned by PR2–5. PR5 flips the
  rule on once the surface is migrated and adds the biome-ignore allowlist for
  the intentional FATAL sites in `src/index.ts`.)

## How to use

No user action required. Recoverable bundled-skill sync failures that were
previously dropped under `quiet:true` are now visible in `/swarm diagnose`
under **Deferred Warnings**.

## Migration notes

- Operators who relied on the per-slug "Synchronized bundled skill ..." lines on
  stderr under `quiet:false` will no longer see them — the sync is expected
  behavior and the success narration was diagnostic noise. Set
  `OPENCODE_SWARM_DEBUG=1` to see synchronized-skill traces.
- Recoverable sync failures under `quiet:true` are no longer silently dropped;
  check `/swarm diagnose`.
