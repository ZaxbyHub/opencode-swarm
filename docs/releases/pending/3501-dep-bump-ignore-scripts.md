---
issue: 3501
---

# Dependency-bump channel: suppress root lifecycle scripts on every install

## What

The channel's first live dispatch (run 42048068309, the zod 4.6.7 bump) failed before pins could apply: `bun` runs the ROOT package's `prepare` script (`bun run build`, which typechecks) on plain `bun install` — including under `--frozen-lockfile` — even when `bun add` carries `--ignore-scripts`. Mid-phase installs run before the pin step that fixes the post-bump typecheck, so a source-affecting bump fails its own unsuppressed typecheck (`src/mcp/server.ts:136` TS2322 under zod 4.6).

`.github/workflows/dependency-bump.yml` now carries `--ignore-scripts` on every dependency-phase bun invocation; the explicit post-pin `bun run typecheck` step remains the authoritative gate. The frozen C7 workflow-contract suite pins the flag per-line (mutation-proven: stripping it from either install form fails the suite).

## Why

Without this, every source-affecting channel dispatch (the zod HIGH GHSA-mrhx-c7xc-m3w5 bump that #3501 AC1/AC2 require, and the #3285 fast-check declaration) fails in transport before its pins run. The zod and fast-check dispatches now re-dispatch cleanly on the fixed workflow.
