# docs(skills): agent workflow gap fixes from issue #1144 session

Three gaps in agent skill documentation patched based on observed failure modes
during the issue #1144 run:

- `qa-sweep`: The 95% stop-condition gate now recognises user-controlled
  publication decisions (e.g. "leave for you" on a merge offer) as complete
  agent work — the gate no longer loops on actions the user has deliberately
  deferred.

- `commit-pr`: Documents that `get_status` (GitHub MCP tool) uses the legacy
  commit status API and returns `pending` even when all GitHub Actions
  check-runs are green; agents in MCP environments must use `get_check_runs`
  instead.

- `swarm-pr-feedback`: Clarifies when resolving review threads is authorised
  ("address any comments" counts; "fix the PR" does not) and adds the
  already-fixed closure workflow (verify fix in code → reply with commit SHA
  → resolve, without opening a code-change path).

## Migration
No migration required. These are internal agent workflow doc changes only.
