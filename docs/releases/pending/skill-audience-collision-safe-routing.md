# Collision-safe bundled skills and audience routing

## What changed

- Plugin-shipped protocols now materialize under `.swarm/bundled-skills/<slug>/` instead of overwriting native project skills under `.opencode/skills/`.
- Architect MODE dispatch and bundled cross-protocol links load the private runtime copies through one shared path contract.
- Static skills declare a bounded top-level `audience`; project skills can use domain tags and optional `runner:opencode`, `runner:claude`, or `runner:codex` constraints.
- `skillPropagation.audiences` declares the project/domain tags accepted by the OpenCode plugin. Domain and runner dimensions must both match.
- Explicit `SKILLS:` references are contained, readable, frontmatter-valid, and audience-checked even when automatic propagation is disabled. Companion routing uses the same eligibility contract; `SKILLS_USED_BY_CODER` remains provenance only.
- Drift checks now reject missing or invalid audience metadata on tracked static skills. Runtime-generated skills remain intentionally unscoped unless their creator has an explicit audience.
- Active skill generation reserves every bundled protocol slug, preventing a generated skill from recreating a second copy of a promoted/static protocol.
- Bundled sync rollback is regression-tested after a partial copy, and validated metadata is reused during one delegation to avoid repeated skill-file parsing.

## Why

A repository-specific skill could share a slug with a bundled protocol, but the old sync copied both to the same `.opencode/skills/<slug>` pathname and atomically overwrote the repository file. Metadata filtering alone could not recover content that had already been replaced. Private runtime storage preserves both variants, while audience routing prevents the wrong project/runner variant from being recommended or explicitly loaded.

## Migration / compatibility

- Existing repository-native skill files are preserved and are no longer sync destinations.
- Mandatory `parallel-work-check` and `ci-fix-monitor` protocols are promoted from generated lifecycle storage into the static private bundle, so retirement markers cannot disable required plugin workflows.
- Ambiguous legacy native copies are not deleted automatically because the plugin has no prior ownership manifest proving they are safe to remove.
- Untagged skills continue to match all audiences for backward compatibility.
- An explicitly empty or malformed audience fails closed.
- `skillPropagation.enabled: false` disables automatic discovery/scoring/warnings/injection, but mandatory explicit-reference integrity remains active.
