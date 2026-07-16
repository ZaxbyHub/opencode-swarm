# TUI safety closeout hardening

## What changed

- Replaced the curated console regression list with a recursive scan of
  production TypeScript under `src/`. The CLI, logger, and warning-buffer
  implementations keep narrow file-wide exemptions; every other intentional
  raw console call requires a reasoned inline exception.
- Removed three unused file-wide Biome exemptions so future hook changes cannot
  silently bypass `noConsole` enforcement.
- Routed malformed design-doc configuration, invalid primary-agent fallback,
  unusable council overrides, and cherry-pick tip-only degradation through the
  deferred operator advisory channel.
- Removed the leaking state-module mock from the reset command suite and
  restored that suite to the isolated CI matrix.
- Repaired UTF-8 BOM and mojibake damage in runtime source and curator prompts.

## Why

The original issue migration was present, but its prevention test covered only
a hand-maintained subset of source and the reset regression suite remained
quarantined. This closeout makes the prevention boundary mechanical and keeps
actionable failures discoverable without writing into the live terminal UI.

## Migration

No user action is required. Existing debug logging and `/swarm diagnose`
behavior remain compatible.
