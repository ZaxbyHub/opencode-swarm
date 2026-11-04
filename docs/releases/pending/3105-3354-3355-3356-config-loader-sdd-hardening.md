---
---

## Config loader: full_auto.locked survives every recovery branch; SDD source reads are hardened, cached, and host-isolated

- **Locked configs can no longer be silently unlocked by config recovery** (#3105). A
  readable-but-schema-invalid project config used to send the loader down a recovery branch that
  rebuilt the config from the user file (or bare defaults) — dropping an administrative
  `full_auto.locked: true` without classifying the load as errored, so `/swarm full-auto on`
  (and resume) authorized a locked project. The lock is now re-applied at a single choke point
  covering every recovery branch of the shared sync+async loader core; recovery metadata and all
  non-lock keys are unchanged.
- **SDD source selection can no longer be steered by configs the loader discards** (#3354).
  `readSddSourceSetting` now derives its answer from the same loader pipeline as
  `loadPluginConfig` (in a silent diagnostics mode that neither buffers warnings nor arms
  warning-dedup state), so a project config thrown away by recovery — or refused as a
  prototype-pollution payload — cannot supply `sdd.source`, while every acceptance the loader
  performs (stripped-key recovery, legacy Epic migration, malformed-value sanitization,
  merge-dependent healing) still does. `/swarm sdd status` origin reporting follows the
  surviving file, not raw-key presence.
- **Non-regular files at config paths are never opened** (#3354). A FIFO or device at
  `.opencode/opencode-swarm.json` (or the user config path) used to block the read — reachable
  from gate/preflight paths that previously performed no synchronous config read. Both the sync
  and async raw readers now classify non-regular files fail-secure without attempting the open.
- **SDD source reads are cached per directory keyed by the config files' mtime+size** (#3354):
  unchanged files are no longer re-read on every gate call. The freshness contract is
  intentional: mtime+size is the invalidation signal (the model build tools use); a content
  change that preserves both is invisible until the next real mtime change. Bounded
  (64 directories, FIFO).
- **Host user configs no longer leak into test suites** (#3355). The bun test preload now
  neutralizes `XDG_CONFIG_HOME` unconditionally (the original value is stashed in
  `SWARM_TEST_NEUTRALIZED_XDG_CONFIG_HOME`), so a developer machine's user-level `sdd.source`
  — or any other user-level config value — cannot change suite outcomes; suites that pin their
  own XDG in `beforeEach` keep working.
- **Diagnostics note:** the `sdd.source` rejection advisory (`Ignoring sdd.source=...`) now
  also reports an invalid value in the user config even when a valid project source wins —
  previously a winning project source masked the user-side rejection entirely. The channel is
  display-only and never influences selection.
- **The `--source` > `SWARM_SDD_SOURCE` > `sdd.source` > auto-detect precedence is now
  documented** in the generated command reference and the specify/clarify-spec skill docs, and
  `docs/planning.md`'s description of the (now removed) loader/resolver divergence is corrected
  (#3356).
