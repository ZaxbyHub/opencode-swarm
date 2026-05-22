# fix(test-runner): cap bun heap with --smol, env-gate scope:all, process-group kill on timeout

## What changed

- **`bun --smol` on every test run** (both dispatch path `src/lang/default-backend.ts` and
  legacy path `src/tools/test-runner.ts`). The `--smol` flag caps bun's heap-growth
  heuristic, matching the per-file CI pattern already used throughout the repo and
  eliminating OOM-driven OpenCode session crashes during broad test runs.

- **`scope: 'all'` is now environment-gated.** The agent-settable `allow_full_suite` argument
  has been removed from the `test_runner` schema and from `TestRunnerArgs`. The only way to
  unlock a full-suite run is the `SWARM_ALLOW_FULL_SUITE=1` environment variable, which is
  available only in CI / maintainer shell sessions and cannot be set by an LLM tool call.
  The blocked-response message deliberately does not name the env var.

- **Process-group kill on timeout.** `bunSpawn` gains an opt-in `killProcessTree: true` flag.
  When set, the test-runner spawn uses `detached: true` (Node path) and routes `kill()` calls
  through `killProcessTreeImpl`, which sends `process.kill(-pid)` on POSIX to reap all
  descendants (jest/vitest worker pools, etc.) and runs `taskkill /PID <pid> /T /F` on
  Windows. The default behaviour for all other callers (~30 non–test-runner sites) is
  unchanged.

- **Prose docs updated.** `AGENTS.md` §6, `docs/engineering-invariants.md`, and all agent-
  facing skill files are aligned with the new gate. Agent-facing docs do not reveal the env
  var name to prevent LLMs from attempting to set it.

## Why

Agents repeatedly ran the test_runner tool with unscoped or wide-scope invocations, crashing
the OpenCode session with OOM errors. Prior mitigations (prose warnings in AGENTS.md, skill
files asking agents not to do this) failed because nothing in the tool itself enforced the
limit, and the `allow_full_suite: true` argument was literally documented in the schema —
teaching agents how to bypass the block. This fix hardens the tool at the code level so that
no LLM-controlled argument can unlock an unsafe run.

## Migration

- **No migration required for users.** Plugin behaviour is identical for all existing
  scoped test runs (`files: [...]`, `scope: 'convention'`, `scope: 'graph'`).
- **CI / maintainer environments** that legitimately need full-suite runs: set
  `SWARM_ALLOW_FULL_SUITE=1` in the shell environment before invoking OpenCode.
- The `allow_full_suite` arg will now produce an "unrecognized key" Zod validation error
  if passed by old agents; they will see the normal scope-blocked response.

## Known caveats

- `--smol` plus the 50-file `MAX_SAFE_TEST_FILES` cap reduce OOM risk for typical runs
  but do not eliminate it for worst-case 50-file batches sharing one heap. Per-file
  subprocess isolation (candidate D, deferred) would be the next hardening step.
- Process-tree reaping is exercised by a smoke test; full descendant-tree coverage is
  intentionally not added (cross-platform process-tree integration tests are flaky).
- `tests/unit/tools/test-runner-scope-cap.test.ts` tests 9 and 11 remain pre-existing
  failures (they predate `MAX_SAFE_SOURCE_FILES=1` and hit the "no framework detected"
  path before the Layer guards). This PR reduces pre-existing failures from 3 to 2.
