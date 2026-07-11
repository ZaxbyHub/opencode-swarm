# TUI pollution sweep — init path (PR2 of epic #1752)

## What

Migrates every unguarded `console.warn`/`console.error`/`console.log` on the
plugin-host init path (and its shared helpers) to the PR1 foundation helpers
introduced in #1752 PR1:

- Actionable advisories (malformed/oversized config, unreadable prompt files,
  git-hygiene conditions) now route through `advisoryWarn(msg)` — buffered for
  `/swarm diagnose` + emitted under `OPENCODE_SWARM_DEBUG=1`. Never raw stderr.
- Purely diagnostic skips (malformed session snapshot) route through `log(msg)`
  — debug-only, NOT buffered (would flood `/swarm diagnose`).
- The one intentionally-unguarded security warning (`.swarm/` files tracked by
  Git) is left as raw `console.warn` — it is a must-see-always remediation.

Migrated files (`src/`):
- `config/loader.ts` — all 36 `console.warn` sites across the sync and async
  load/validation paths (config-too-large, invalid-format, load-failure,
  gates-validation, external-skills-validation, preset-migration,
  merged-config-fallback, agent-prompt-read-error).
- `agents/architect.ts` — the custom-prompt designer-reference warning.
- `session/snapshot-reader.ts` — the malformed-session-skip diagnostic.
- `config/project-init.ts` — the "created opencode-swarm.json" advisory.
- `utils/gitignore-warning.ts` — the ".swarm/ not gitignored" and "Added .swarm/
  to exclude" cosmetic advisories.

## Why

Raw `console.warn` writes to stderr corrupt the OpenCode bubbletea TUI when it
owns the terminal (issue #1249 class). The init path fires these on every
`server()` call with a malformed/oversized config or a stale session snapshot —
mid-turn, with no error surfaced to the user. PR1 built the `advisoryWarn`
helper and fixed the single most frequent polluter (bundled-skill sync); this
PR closes the rest of the init-path surface so the TUI stays clean during
plugin registration.

## Migration / behavior changes

- Config-validation Zod detail dumps (`result.error.format()`) are now visible
  only under `OPENCODE_SWARM_DEBUG=1`. The headline message ("gates config
  validation failed", "Merged config validation failed", etc.) is always
  available in `/swarm diagnose`. Operators debugging a bad config without
  debug mode will see the headline in `/swarm diagnose` rather than the full
  Zod path dump on stderr.
- `writeProjectConfigIfNew(directory, quiet)` and
  `warnIfSwarmNotGitignored(directory, quiet)`: the `quiet` parameter is now a
  no-op (renamed `_quiet`). Previously `quiet:true` suppressed the advisory
  entirely; now it is always buffered for `/swarm diagnose`. This matches the
  epic's intent — a recoverable condition should be discoverable, not silently
  dropped.
- `ensureSwarmGitExcluded(directory, { quiet })`: the `quiet` option is
  deprecated/no-op for the cosmetic "Added .swarm/" advisory. The tracked-file
  security warning remains always-emitted regardless of `quiet`.
- No breaking API changes. All function signatures, return values, and default
  behavior are preserved; only the warning delivery channel changed.

## Scope notes

- Biome `suspicious/noConsole` enforcement is deferred to PR5 of epic #1752
  (per the PR1 review). This PR makes the migrated files clean so PR5 can
  enable the rule without exemptions (except the one intentional security
  warning site and the allowlisted logger/cli modules).
- The `src/agents/index.ts` deprecation/variant warning (uses the older
  hand-rolled `if (!quiet) console.warn else addDeferredWarning` pattern) is
  out of scope for this PR and unchanged.

## Testing

Updated 5 test files to assert via `getDeferredWarnings()` instead of
`spyOn(console, 'warn')`, with `clearDeferredWarnings()` in
`beforeEach`/`afterEach` to prevent cross-test buffer pollution (Invariant 7):
`tests/unit/config/loader.test.ts`, `src/agents/architect.designer-gate.test.ts`,
`tests/unit/config/project-init.test.ts`, `tests/cli/writeProjectConfigIfNew.test.ts`,
`tests/gitignore-warning.test.ts`.

Also extended `tests/unit/plugin-tui-safety.test.ts` to regression-guard the
5 migrated files (zero raw `console.warn` except the one intentional
tracked-file security site in `gitignore-warning.ts`), per the test header's
standing invitation.

`tests/unit/config/quiet-config.test.ts` requires no changes (asserts on
`src/agents/index.ts`, which is out of scope). Snapshot-reader tests have no
console assertions and are unaffected.
