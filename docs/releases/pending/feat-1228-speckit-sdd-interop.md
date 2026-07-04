# Spec-Kit SDD interop for `/swarm sdd`

## What changed

`/swarm sdd` now detects and consumes [GitHub Spec-Kit](https://github.com/github/spec-kit) artifacts (issue [#1228](https://github.com/ZaxbyHub/opencode-swarm/issues/1228)):

- **Detection.** A `.specify/` marker directory alongside `specs/<feature-dir>/spec.md` files is recognized as a Spec-Kit layout. `/swarm sdd status` reports it as a distinct source, separate from the OpenSpec output.
- **Projection.** `/swarm sdd project` projects a single Spec-Kit feature into `.swarm/spec.md`, preserving original `FR-###` identifiers and synthesizing stable identifiers when none are present. The resulting spec feeds drift verification, lint, and requirement coverage unchanged — identically to an OpenSpec projection.
- **`--source <openspec|speckit>`** disambiguates when both SDD layouts are present in the same repository. Without `--source`, detecting both produces a hard error naming both sources and stating the remedy.
- **`--feature <id>`** selects a specific Spec-Kit feature by its full directory name (e.g. `--feature 001-my-feature`). It is required when more than one feature directory exists and is invalid with `--source openspec` or `--source swarm`.
- **Read-only validate.** `/swarm sdd validate` checks Spec-Kit artifacts — required `spec.md` sections, task lines without a spec or requirement reference, and features with zero functional requirements — without modifying any file.

## Why

Teams already using Spec-Kit mid-project can now enforce their existing specs with the Swarm drift gate without rewriting anything into Swarm's native format. The integration is incremental: OpenSpec behavior is byte-identical to before, and all downstream consumers of the effective-spec pipeline (drift gate, lint, requirement coverage, plan hashing, preflight) are unchanged.

## How to use

```
/swarm sdd project                                             # auto-detect; single feature only
/swarm sdd project --feature 001-my-feature                   # required when multiple features exist
/swarm sdd project --source speckit --feature 001-my-feature  # explicit when both layouts are present
/swarm sdd validate --source speckit --feature 001-my-feature # validate spec.md / tasks.md read-only
/swarm sdd status                                              # shows Spec-Kit detection alongside OpenSpec
```

## Migration

No migration required. Existing OpenSpec-only repositories are unaffected; the Spec-Kit detection path only activates when `.specify/` is present.

## Known caveats and follow-ups

- **Single-feature only (v1).** When multiple `specs/<dir>` directories exist, `--feature <id>` is required; omitting it is a hard error. Multi-feature aggregation and round-trip `tasks.md` check-off are tracked in issue [#1577](https://github.com/ZaxbyHub/opencode-swarm/issues/1577).
- `--source swarm` is accepted by `status` and `validate` but is rejected by `project` — the native `.swarm/spec.md` does not require projection.

Closes: #1228
