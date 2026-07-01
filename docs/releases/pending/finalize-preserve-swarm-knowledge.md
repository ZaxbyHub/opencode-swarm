# Fix: `/swarm finalize` no longer destroys the swarm knowledge store

## What

`/swarm finalize` (and its deprecated alias `/swarm close`) could silently delete
the entire gitignored `.swarm/` directory — including the cumulative
`knowledge.jsonl` lessons store and the archive backup bundle created earlier in
the same finalize run.

The align stage's post-merge cleanup ran a blanket `git clean -fdX`. Because
`.swarm/` is gitignored (by design — it is machine-local runtime state), the `-X`
flag (remove *ignored* paths) matched and removed the whole `.swarm/` tree, undoing
the clean stage's deliberate preservation of `knowledge.jsonl`. The same blanket
clean also removed other gitignored-but-not-build-artifact paths, including
`.claude/issue-traces/` (investigation traces) and the gitignored files inside
`.opencode/` (its `node_modules/`, `package.json`, and lockfiles, via a nested
`.opencode/.gitignore`).

The alignment cleanup is now scoped to an explicit build-artifact allowlist
(`GITIGNORED_BUILD_ARTIFACTS`, currently `dist/`) via a `git clean -fdX -- <paths>`
pathspec, so it only removes regenerable build output and never touches `.swarm/`,
`.claude/issue-traces/`, `.opencode/`, or `node_modules/`.

To keep the clean-slate guarantee that the old blanket clean provided as a side
effect, the finalize clean stage now removes the terminal `plan.json` and
`plan-ledger.jsonl` unconditionally (even when archiving failed), so the next
session cannot resurrect a CLOSED plan. This is behavior-preserving for those two
files (the old blanket clean already removed them) and leaves cumulative
`knowledge.jsonl` intact.

Error-path note: because the align clean no longer wipes all of `.swarm/`, on the
rare archive-failure path (e.g. EBUSY/EPERM/ENOSPC) non-terminal session artifacts
that fail to archive — `events.jsonl`, `swarm.db*`, `telemetry.jsonl`,
`repo-graph.json`, etc. — now survive into the next session instead of being force-
deleted. This is the archive-first data-loss guard finally working as designed; the
plan-resurrection vector stays closed because the terminal `plan.json`/
`plan-ledger.jsonl` are still removed unconditionally.

## Why

`git clean -fdX` targets *all* gitignored paths, not just build artifacts. The
previous code assumed "gitignored = safe-to-delete build output," but this repo
also gitignores durable/runtime state (`.swarm/`) and local tooling (`.claude/`,
`.opencode/`). A single `/swarm finalize` on a merged-and-pushed branch (the common
post-PR cleanup path) therefore wiped every accumulated lesson. Candidate fixes
using exclude flags (`-e .swarm/`) or pathspec excludes (`:!.swarm/`) were verified
NOT to work with `-X`; only restricting the clean to an explicit allowlist reliably
preserves runtime state.

## Breaking changes

None. Users on the merged-and-pushed finalize path will simply retain `.swarm/`
knowledge and local `.claude/issue-traces/` / `.opencode/` state that was
previously deleted.
