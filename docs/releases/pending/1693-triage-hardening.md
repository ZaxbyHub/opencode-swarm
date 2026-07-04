Hardens issue #1693 triage findings across the swarm lifecycle:

- **Checkpoint/rollback**: Checkpoint restore now performs a real `git reset --hard`; `/swarm rollback` falls back to the git checkpoint log (`.swarm/checkpoints.json`) when the legacy phase manifest is absent.
- **Session isolation**: Handoff files are session-scoped via an HTML comment marker to prevent a session from re-consuming its own handoff on restart. Session snapshots now persist and restore turbo/lean-turbo/epic mode state.
- **External input hardening**: GitHub-sourced text (PR comments, issue bodies, gh-evidence) is wrapped as untrusted data via `neutralizeUntrustedMarkdown`. External skill fetches reject internal/loopback/metadata hosts with `assertSafeFetchUrl` SSRF protection (including IPv4-mapped IPv6 bypass prevention).
- **Bundled skill sync**: Sync now uses content-equality checks and atomic overwrite with rollback instead of the old missing-only cache, repairing stale or missing skills in-place.
- **Plan durability**: `savePlan` replays the ledger before writing derived projections (`plan.json`, `plan.md`) to avoid overwriting newer concurrent events.
- **Quality metrics**: `pre_check_batch` forwards `quality_budget` config (`enforce_on_globs`, `exclude_globs`). Duplication metric uses sliding-window contiguous-block counting.
- **Lean Turbo**: Merge-back failures now fail the phase while preserving worktrees and evidence for recovery. Reviewer/critic payloads include raw validation artifacts (build/test/lint).
