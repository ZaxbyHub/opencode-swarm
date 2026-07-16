# swarm-model config CLI (contributor utility)

## What

Adds `scripts/swarm-model/` (Node.js, cross-platform) and `scripts/swarm-model.ps1`
(PowerShell, Windows) — an interactive helper that reads available providers and
models from `opencode.json` and rewrites an agent's `model`/`temperature` in
`opencode-swarm.json`, backing up the file before every write. Imported from
community PR #1857 and hardened during review:

- Fixed the interactive Node path, which crashed on every run because `ask` was
  never imported (the temperature step threw `ReferenceError`).
- `list`/`help` no longer hang on a TTY — the readline interface is created
  lazily instead of at import.
- Guarded agent entries that have no `model` field so agent selection no longer
  throws.
- Node `selectFromList` now offers a quit option at every selection step.
- Backup filenames use a full `YYYYMMDDHHMMSS` (second-resolution) timestamp, so
  backups within the same 10-minute window no longer overwrite each other.
- PowerShell `ConvertTo-Json` now uses `-Depth 10`, so nested agent fields
  (`fallback_models`, `reasoning`, `thinking`) are no longer truncated on write.
- Robust home-dir resolution (`os.homedir()`), graceful malformed-JSON handling,
  and a clear error on a missing `--swarm-config`/`--opencode-config` value.
- Added a `node:test` suite covering the config/backup/provider-merge logic and
  an end-to-end drive of the interactive flow.

This is a standalone contributor utility under `scripts/`; it is not part of the
published `opencode-swarm` package.
