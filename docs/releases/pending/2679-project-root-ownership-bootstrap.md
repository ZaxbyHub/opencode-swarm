# Apply project-root ownership before initialization creates runtime state

Issue: #2679

## What

- Plugin bootstrap and `mcp serve --dir` now apply the project-boundary policy (the same policy tools enforce at write time) once, synchronously, before any init-path or first-write consumer touches a directory.
- An **ordinary child directory** (no direct `.git`/`.opencode` marker) of a project root that already owns `.swarm/` state no longer receives a second runtime-state tree: the boot resolves to the owning project root, all `.swarm` state, project config, telemetry, and bundled-skill materialization land there, and one bounded always-visible hint names the owning root (plus a `/swarm diagnose` advisory and a durable `.swarm/advisories/bootstrap-root-redirect.json` record).
- Directly declared nested roots (`.git` file/dir, linked worktrees, submodules, `.opencode/` directories) and standalone roots keep owning their state exactly as before.
- If project-root ownership cannot be verified (inaccessible ancestor probes, ancestor-depth exhaustion), the boot writes NO runtime state anywhere, stays fail-open for the plugin manifest (agents/tools still register), and warns once with the reason.
- The SQLite DB, bundled-skill sync, snapshot writer (per-tool-call), telemetry, observability lineage, knowledge/curation hooks, and every teardown path honor the single resolved decision; concurrent boots of the same ordinary child cannot interleave a child write.

## Why

Before this change, opening an ordinary subdirectory while its parent project already owned `.swarm/` state silently created a complete second runtime-state tree under the child (advisories, automation status, bundled skills, telemetry, DB surfaces), splitting state from the owning project. See `docs/engineering-invariants.md` ("Bootstrap project-root ownership", invariant 4) for the full rule set and the distinction from #2667's process-global hydration eviction.

## Operator action required

- **Pre-existing child `.swarm/` trees** created by the old behavior are NOT migrated or deleted by this change. If a workspace previously booted from an ordinary subdirectory, move or delete that stray `.swarm/` directory manually; new boots write to the owning project root.
- **Redirected boots inherit the parent project's project-level config flags** (`quiet`, `version_check`, `guardrails.enabled`, `full_auto.*`, `agents.*`, `auto_review`, `memory`, `retention`, `hooks.background_submodules`, `repo_graph`, `observability.export`). In particular, the `guardrails.enabled === false` security warning now reflects the applied (parent) configuration while you opened the child directory — the redirect hint names the owning root so the attribution is traceable. A child-local `.opencode/opencode-swarm.json` is no longer read for an ordinary child; open the project root, or give the child its own `.git`/`.opencode` marker, to use a child-local config.

## Verification

Real-host boots (registered plugin `server()`), frozen acceptance checks C1–C8 under the issue trace: ordinary-child redirect (child tree absent, parent populated, hint names the parent, manifest delivered), nested git-dir/git-file/.opencode independence, standalone root, indicator-only-parent edge, concurrent double-boot race, registered late writer, and the documentation contract — all RED on base 9ba5b411f, GREEN on the fix. Measured `repro-704` init latency unchanged (marker-first short-circuit; no subprocess).
