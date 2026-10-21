# Remove raw console.warn init-path lines that overlay the TUI (issue #3405)

## What changed

- `src/index.ts` (plugin init, `initializeOpenCodeSwarm`):
  - The unconditional startup version banner
    `console.warn("[opencode-swarm] running vX.Y.Z")` (from #2236) now rides
    the debug-gated logger (`log`, stdout under `OPENCODE_SWARM_DEBUG=1`).
    The historical raw-stderr line is still emitted, but only when the new
    opt-in env var `OPENCODE_SWARM_VERSION_BANNER=1` is set — for headless /
    CLI diagnosis and version probes that grep the exact format.
  - The two project-root ownership hints (redirect and fail-closed, from
    #2679) no longer call `console.warn` at all. Their delivery is unchanged
    otherwise: `addDeferredWarning` + `advisoryWarn` (the `/swarm diagnose`
    deferred buffer and the debug log) and the durable
    `writeBootstrapRootRedirectRecord` under the owning root.
- `spikes/v2-dual-shape/run-spike.mjs`: the spike's `isolatedEnv` now sets
  `OPENCODE_SWARM_VERSION_BANNER=1`, because the spike greps the exact
  `[opencode-swarm] running v…` stderr format as its positive plugin-load
  evidence and the debug-logger leg prepends a timestamp that breaks that
  regex.
- Tests: new `tests/unit/index-init-console-noise-3405.test.ts` (real-plugin
  boots assert the raw stderr legs are gone by default, the ownership hint
  still reaches the `/swarm diagnose` buffer, and the opt-in env var restores
  the stderr banner). `tests/unit/index-bootstrap-root-ownership-2679.test.ts`
  now asserts the redirect hint through the deferred-warning buffer instead of
  the removed stderr leg.

## Why

In an in-process OpenCode TUI, the host renders stderr writes as full-width
overlay blocks pasted over the UI and input area, corrupting the session
transcript (issue #3405, the issue #1249 `console.warn`-corrupts-bubbletea
class). All three sites fired on every boot — the banner unconditionally, the
ownership hints whenever the workspace opened in an ordinary subdirectory of a
project root. The stderr legs were also redundant: the ownership hints already
reach the operator through the double-buffered `/swarm diagnose` channel
(`advisoryWarn`'s docblock in `src/services/warning-buffer.ts` names it the
safe replacement for exactly this class), and the version line is diagnosis
data that belongs in the session log, not on the live display.

## Migration steps

- No action needed for TUI users — boots get quieter by default.
- If you relied on seeing `[opencode-swarm] running vX.Y.Z` on stderr in a
  headless/CLI context (scripts, version probes, harnesses), set
  `OPENCODE_SWARM_VERSION_BANNER=1` in the environment to restore the raw
  stderr banner. With `OPENCODE_SWARM_DEBUG=1` the banner also appears in the
  debug log (stdout, timestamped).
- The project-root ownership hints are unchanged from the operator's
  perspective in the TUI: run `/swarm diagnose` to see them.

## Known caveats

- The ownership hint is buffered twice per redirect boot (once via the direct
  `addDeferredWarning` call, once inside `advisoryWarn`, which funnels through
  the same buffer), so `/swarm diagnose` lists it twice. This duplication is
  pre-existing from #2679 and intentionally left untouched here; the issue
  asked only for the raw stderr legs to be dropped.
- `console.warn` legs that are quiet-gated (`config.quiet: false` paths, e.g.
  the full-auto critic-model warning) are a different class, fire only when a
  user explicitly disables quiet, and are unchanged.
