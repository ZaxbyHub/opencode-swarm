## What

Opted-in automation status persistence (`automation.mode` = `hybrid`/`auto`) can no longer prevent the plugin from returning its manifest. Previously the init-path write of `.swarm/automation-status.json` was an unguarded inline `mkdirSync`/`writeFileSync` inside `initializeOpenCodeSwarm`: a directory conflict (`.swarm` occupied by a regular file), an unwritable path, or a write conflict (`automation-status.json` existing as a directory) threw through `AutomationStatusArtifact.updateConfig`, rejected the plugin `server()` entry, and the host silently dropped the plugin — no agents, no tools, only a FATAL banner (issue #2669).

## Fix

- The artifact write is now registered on the wrapper-owned post-resolution task queue (`automationStatusArtifactPostInitTask`), so it runs only after the manifest is delivered; its latency no longer counts toward the init budget (AGENTS.md invariant 1, "Bounded is not free").
- The writer itself is contained: every mutator fails closed with exactly one bounded, categorized, debug-gated diagnostic (`status artifact write failed (non-fatal)` with `operation`, `category`, `code` — no paths or stacks). Categories: `dir_conflict`, `path_is_directory`, `permission`, `volume`, `missing_path`, `unknown` (documented fallback for un-mapped platform codes). The in-memory snapshot still advances.
- The preflight integration's handler-time `recordOutcome` carries its own bounded non-fatal catch (the scheduler wrapper does not cover event-handler-time calls).
- New operator docs: `docs/automation-status.md` — the artifact is optional, the failure-category table, and how to diagnose a missing status artifact without confusing it with a plugin load failure.

## Verification

- New regression tests: writer containment (`tests/unit/background/status-artifact-nonfatal-2669.test.ts`), full-boot init containment with deferred-task proof (`tests/unit/index-automation-status-init-2669.test.ts`), and a defect-class source-scan ratchet that fails if any `AutomationStatusArtifact` mutator is ever re-inlined on the awaited init path (`tests/unit/index-automation-status-init-scan-2669.test.ts`).
- New Node ESM/host harness `bun run repro:2669` (matrix: opt-in/default × normal/corrupt/read-only fixtures against the built bundle, plus a Bun bundle-load check): pre-fix the corrupt opt-in fixtures rejected `server()`; post-fix every fixture returns the mandatory manifest shape and the process exits with no leaked handle.
- Node-ESM import of the built bundle, bundle-portability, and plugin-shape suites re-run green; the v1 `{ id, server }` default export is unchanged.
