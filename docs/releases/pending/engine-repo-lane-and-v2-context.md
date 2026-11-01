# Engine lanes use repo lane create, and v2 context status reads the session

## What

- Architect reminders dispatch reviewer and test_engineer together, and allow a wave of disjoint coders plus advisory lanes.
- OpenCode v2 `context_status` reads `session.context` instead of the missing `session.messages` method.
- Grammar loading imports `web-tree-sitter` from the plugin package file, not at startup.
- An Engine checkout (`.jj`, `.purpose/commands.json`, and executable `bin/repo`) creates coder lanes with `repo lane create` and records `.swarm/repo-lane.json` so the lane is recognized without a git branch.
- Git merge-back is refused on an Engine root. Plain `status`, `diff`, and `log` there go through `repo vcs` (not `--porcelain` git status).
- Default land automation on Engine roots uses `repo lane publish` / `repo pr create` instead of `gh` or git merge-back.
- Forge provider selection treats fleet Forgejo (`git.centralcloud.net` and optional `forge.forgejo_hosts`) as first-class; publication hints prefer `repo`, then `fj`, then `gh`.
- `forge.gh_forgejo.enabled` defaults to **`off`** (Forgejo has no GitHub GraphQL); enable only when you explicitly want `GH_*` injection into `gh` for non-Engine Forgejo remotes.

## Config

Optional overrides in `opencode-swarm.json`:

- **`repo.lifecycle`** — CEL-shaped rules for lane land/push/PR (defaults land Engine lanes via the repo facade).
- **`forge.provider`** — `auto` | `github` | `gitlab` | `forgejo`; use `forgejo` or `auto` with a Forgejo remote on fleet/extra hosts.
- **`forge.forgejo_hosts`** — additional Forgejo/Gitea hostnames beyond the fleet default.
- **`forge.gh_forgejo`** — `{ "enabled": "off" | "auto" | "on", "host": "…" }`; leave at default **`off`** on this fleet.

Engine checkout detection requires `direnv exec <repo-root> repo …` on the devbox; lane markers live under `.swarm/repo-lane.json`.

## Operator notes

- Point OpenCode at a **local plugin path** (or rebuild after `bun run build`) when dogfooding these changes before npm publish.
- Do not use `gh pr create` against Forgejo Engine remotes; trace completion expects `record_issue_publication` with a canonical `…/pulls/N` URL on `git.centralcloud.net`.
