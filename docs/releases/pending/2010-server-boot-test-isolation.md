# Test-suite isolation for plugin boot: no more writes into your checkout or `~/.config`

## What changed

**Booting the plugin from a test no longer writes into the repository or the developer's real config.**

- `OpenCodeSwarm.server()` boots in the test suite are handed an isolated temp
  `directory`/`worktree` instead of `process.cwd()`, paired with an isolated
  environment (`createIsolatedTestEnv`) and a temp working dir
  (`createSafeTestDir`). Previously, `config-doctor`'s project-absent fallback
  could read *and rewrite* `.opencode/opencode-swarm.json` in the checkout, and
  drop `config-backup-*.json` / `config-doctor.json` artifacts into the repo's
  `.swarm/`.
- **`XDG_CACHE_HOME` is now isolated too.** It is read first, on every platform,
  by `src/services/version-check.ts` and `src/config/cache-paths.ts`. Without it,
  booting the plugin in a test wrote into the developer's real
  `~/.cache/opencode-swarm/version-check.json`.
- **A tracked-file byte guard.** `captureFileBytes` / `expectFileBytesUnchanged`
  (`tests/helpers/test-isolation.ts`) snapshot a tracked file's exact bytes and
  fail the suite if anything mutated it. The failure message reports byte counts
  and a short SHA-256 of each side rather than raw file content.
- **An *armed* regression test** —
  `tests/unit/config-doctor-startup-isolation.test.ts`. The byte guard alone is
  disarmed by default: the startup config-doctor autofix path requires
  `automation.mode !== 'manual'` **and** `config_doctor_on_startup` **and**
  `config_doctor_autofix`, all of which default to off, so a plain boot never
  reaches the code that rewrites a config. This test enables those capabilities
  via an isolated *user* config, plants a deterministic auto-fixable defect, runs
  the deferred startup task, and then proves the resulting backup and config
  rewrite landed in the temp dir and *not* in the repo.
- **A server-boot isolation audit test** —
  `tests/unit/server-boot-isolation-audit.test.ts` — enumerates every plugin
  `server()` boot site that appears directly in a test file and requires each to
  carry at least one recognized protection, so newly added boot sites cannot
  silently regress. Boots that happen inside a shared fixture rather than in the
  test file itself are out of the audit's scope (those fixtures carry their own
  protection).
  Detection is identifier-agnostic: any `.server(` call in a file that loads the
  plugin entry (`src/index.ts` or the built `dist/index.js`) counts, so
  `mod.default.server(...)` and `(OpenCodeSwarmPlugin as …).server(...)` are
  audited alongside `OpenCodeSwarm.server(...)`. A protection factored into a
  `tests/helpers/**` module is credited only from the body of the binding the
  test file actually imports, so importing a helper for an unrelated utility no
  longer inherits isolation it never wired.
- **A temp-dir orphan hygiene guard** —
  `tests/unit/index-commands-temp-dir-hygiene.test.ts`. `server()` queues
  background work on an unref'd `setTimeout(0)` that fires *after* the
  synchronous `afterEach` removed the test's temp dir, and then re-creates it —
  leaving a permanent orphan under `os.tmpdir()` on every run. The
  `overrideIndexInternalsForTest` scheduler stub is what prevents that, and
  nothing asserted it. The guard covers both orphan prefixes: `swarm-safe-test-*`
  in-process, and `swarm-test-*` by running
  `tests/unit/index.test.ts` and `tests/unit/index-task-42-commands.test.ts` in a
  child `bun test` process whose `TMPDIR`/`XDG_*` roots point into a sandbox it
  owns, so any orphan or `~/.cache/opencode-swarm` write those files would leak is
  counted exactly and cleaned up either way. Removing the stub wiring from either
  file now fails the suite instead of silently littering `/tmp`.
- **Two more boot sites isolated.**
  `tests/unit/build/throw-and-verify-located.test.ts` (bare temp dir, the literal
  #2010 shape) and `tests/smoke/packaging.test.ts` (which boots the shipped
  bundle against the repo root on purpose) now redirect `XDG_CONFIG_HOME` and
  stub the post-resolution queue through `overrideIndexInternalsForTest`, which
  `dist/index.js` re-exports. The packaging smoke test additionally makes a
  best-effort restore of the checkout's `.swarm/` to its pre-test contents, so
  running it no longer leaves `config.example.json`, `evidence/`, or
  `telemetry.jsonl` behind. The restore is best-effort rather than guaranteed:
  `initTelemetry` runs on the synchronous init path and holds an open handle on
  `.swarm/telemetry.jsonl`, which can make removal fail with EBUSY on Windows.
  Leftovers there are gitignored, so they do not dirty the working tree, and the
  tracked-config byte guard still runs either way.
- **Cleanup-error primacy helpers.** `collectCleanupError(...steps)` runs every
  teardown step and *returns* the first thrown value (with an explicit `thrown`
  flag, so a falsy throw such as `0` or `''` is still reported), and
  `runWithCleanup(body, ...steps)` guarantees the body's error always wins over a
  teardown error. `withIsolatedState` now routes through `runWithCleanup` instead
  of `try/finally`.
- **Test-file splits.** `tests/unit/index-commands.test.ts` and
  `src/commands/registration-parity.test.ts` grew past the FR-006 500-line cap
  once isolation scaffolding was added, so they were split into
  `index-commands-curate.test.ts`, `index-commands-debug-leakage.test.ts`,
  `registration-parity-baselines.test.ts`, and
  `registration-parity-subcommand-shortcuts.test.ts`, with shared fixtures in
  `tests/helpers/index-commands-shared.ts`.

## Why

Issue #2010. Running the test suite mutated the developer's working tree: a
tracked `.opencode/opencode-swarm.json` came back modified, and untracked
`.swarm/` artifacts appeared. A sandboxed repro also showed the user's real
global config being rewritten — a fake XDG root's `max_iterations: 99` was reset
to `10` by merely booting the plugin in a test.

The failure was invisible because the only thing standing between a test boot and
the developer's files was the default-off state of two capability flags. Nothing
asserted the isolation itself, so any future change that flipped a default, or
any contributor who enabled config-doctor autofix locally, would have hit it
again.

## Migration steps

None. These are test-suite and test-helper changes only; no runtime, config, or
public API behavior changed.

Contributors writing new tests that call `OpenCodeSwarm.server()` should pass an
isolated temp `directory`/`worktree` and wrap the boot in `createIsolatedTestEnv()`
(or use `setupIsolatedState` / `withIsolatedState`, which compose both). The
server-boot isolation audit test will fail on any boot site that does neither.

## Breaking changes

None.

## Known caveats

- **`SWARM_TEST_FILE_PREVIEW=1` changes default diagnostic output.**
  `expectFileBytesUnchanged` deliberately omits file content from its failure
  message, because it is a generic helper that could be pointed at a tracked file
  holding a secret and the message lands in CI logs. Set
  `SWARM_TEST_FILE_PREVIEW=1` to include short byte previews of both sides when
  debugging locally. The flag is read once at module load, so it must be set in
  the environment *before* the test process starts — setting it from inside a
  test has no effect. Previews are decoded with `StringDecoder`, so a multi-byte
  character straddling the preview cutoff is dropped rather than rendered as
  `U+FFFD`.
- `os.homedir()` under Bun 1.3.11 ignores `process.env` entirely. `HOME` and
  `USERPROFILE` are set by `createIsolatedTestEnv` as defence in depth only —
  isolation relies on the `XDG_*` / `APPDATA` / `LOCALAPPDATA` variables, which
  every path helper in this repo consults ahead of `os.homedir()`.
- The armed regression test boots the real plugin and runs the real
  config-doctor, so it is slower than a typical unit test; it carries a 30s
  timeout. Two of its post-resolution tasks `void` their own promise
  (`runInitOrphanRecovery`, `syncBundledProjectSkillsIfMissingAsync`) and are
  therefore not awaitable through any seam, so the test waits for their
  observable writes to stop — condition-driven, bounded at 8s — before tearing
  down its temp dir, then asserts after teardown that it left no
  `swarm-doctor-arm-*` orphan behind.
- The temp-dir hygiene guard spawns a child `bun test` over two files, adding
  roughly three seconds to a suite run. Those two files are consequently
  executed twice in CI.
