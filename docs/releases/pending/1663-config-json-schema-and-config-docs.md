# Generated JSON Schema + complete configuration reference for `opencode-swarm.json` (issue #1663)

## What changed

- **`opencode-swarm.schema.json` is now generated from `PluginConfigSchema` and
  shipped in the npm package.** Config files that reference it via `"$schema"`
  get validation and autocomplete in editors with JSON Schema support. The
  generated schema documents every key (descriptions come from new `.describe()`
  annotations on all 70 top-level schema fields) and flags unknown top-level
  keys as editor errors — authoring advice that until now had no edit-time
  surface at all.
- **Config files created by the plugin now include `"$schema"` automatically**:
  project init (`.opencode/opencode-swarm.json`), the `.swarm/config.example.json`
  example, and both CLI `install` templates (global + project). The reference is
  version-pinned to the plugin version that authored the file, so schema
  validation follows the version you installed (unpkg serves every published
  version; the artifact's own `$id` stays unversioned).
- **`docs/configuration.md` now documents every top-level key.** A generated
  "Top-level configuration keys" table (key, type, default, description, strict
  markers) is derived from the same schema walk; 30 previously undocumented keys
  are now covered, so the "all configuration keys" claim in `docs/index.md` is
  finally true.
- **Drift gates:** `bun run drift:check` now fails (under `DRIFT_CHECK_ENFORCE`)
  when either the checked-in schema file or the generated docs section no longer
  matches `PluginConfigSchema` — the failure message names the regenerate
  command (`bun run schema:generate`). `bun run build` regenerates both
  artifacts automatically.
- **Runtime signal for silent typos:** the root config schema is intentionally
  not strict (legacy configs must keep loading), so a typo'd top-level key
  (e.g. `guardrailz`) used to be stripped by the loader with no signal
  whatsoever. The loader now emits one advisory warning listing unknown
  top-level keys, pointing at the docs key table. Nested `.strict()` sections
  keep their existing recovery behavior (targeted key strip, preserved rest).

## Why

A single-character typo in a nested strict section made the whole config fall
back to guardrail-only defaults, and a top-level typo was silently ignored —
with nothing at edit time to catch either. Editors validating against the
shipped JSON Schema catch typos as you type; the drift gates keep the schema
and the reference docs from rotting as the config surface evolves.

## Notes

- The emitted schema intentionally sets `additionalProperties: false` at the
  root even though the runtime strips (and now warns about) unknown top-level
  keys instead of failing: the file is editor advice, not runtime semantics.
  The divergence is noted in the schema's own description.
- `"$schema"` is whitelisted in `PluginConfigSchema` (pure metadata, ignored at
  runtime) so it never trips config-doctor's unknown-key findings.
- Generated artifacts are committed (`opencode-swarm.schema.json` at the repo
  root, docs section between markers); regenerate with
  `bun run scripts/generate-config-schema.ts`.
