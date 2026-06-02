# Structured Design-Doc Generation + Doc↔Code Drift Sync

## What changed

- **New `docs_design` agent role** (`src/agents/docs.ts`, `src/agents/index.ts`):
  the existing docs agent gains a `DocsRole` discriminator (`standard` |
  `design_docs`), mirroring how critic role variants share one base. The
  `design_docs` role authors a fixed set of language-agnostic design docs for
  the project under build. It is opt-in — registered only when
  `design_docs.enabled: true` — and inherits the built-in write/edit tools so it
  can author documentation (no new write tool).

- **New `/swarm design-docs` command** (`src/commands/design-docs.ts`) emitting a
  `[MODE: DESIGN_DOCS ...]` signal, with a matching `### MODE: DESIGN_DOCS`
  section in the architect prompt and a `.opencode/skills/design-docs/SKILL.md`
  (plus `.claude` mirror) protocol. Flags: `--out <dir>` (default `docs`),
  `--lang <name>`, `--update`.

- **Generated layout** (the issue's "idea 2"), written into the target project's
  repo under `<out>/` (default `docs/`):
  `domain.md`, `technical-spec.md`, `behavior-spec.md`,
  `reference/{reference-impl,idiom-notes}.md`, plus a machine-readable
  `reference/traceability.json` section-ID registry and an append-only
  `design-changelog.md`. Normative docs are 100% language-agnostic; all
  framework-specific material is quarantined under `reference/`.

- **Per-phase doc↔code drift sync** (`src/hooks/design-doc-drift.ts`): a
  deterministic, fail-open check at phase wrap that compares the design docs
  against code/spec mtimes via the traceability registry, writes
  `.swarm/doc-drift-phase-N.json`, and — when `DOC_STALE` — advises the architect
  to run a `docs_design` sync. Advisory and non-blocking; it never gates phase
  completion and never touches `CHANGELOG.md` or `docs/releases/pending/*`.

## Why

Swarm had no way to generate or maintain centralized, language-agnostic design
docs for the projects it builds, and no mechanism to keep those docs in sync with
the code as it changed (issue #1080). This adds both, reusing the existing docs
agent and drift machinery rather than introducing a parallel system.

## How to use

Enable it in `opencode-swarm.json`:

```json
{ "design_docs": { "enabled": true, "out_dir": "docs" } }
```

Then run `/swarm design-docs "<system description>"` to generate the docs, or
`/swarm design-docs --update` to sync them to the current code/spec. When
enabled, phase wrap surfaces a `DESIGN-DOC DRIFT` advisory when docs fall behind.

## Migration

No migration required. The feature is disabled by default (`design_docs.enabled`
defaults to `false`); repos that do not opt in are unaffected.

## Known caveats

- Section-ID stability across regenerations is backed by
  `reference/traceability.json` but reuse correctness is partly prompt-enforced;
  the drift check flags renumbering.
- The drift check is mtime/traceability based (no LLM call), so it is a coarse
  signal intended to prompt a sync, not a precise semantic diff.

Closes: #1080
