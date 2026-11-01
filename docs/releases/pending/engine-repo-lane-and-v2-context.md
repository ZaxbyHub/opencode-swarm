# Engine lanes use repo lane create, and v2 context status reads the session

## What

- Architect reminders dispatch reviewer and test_engineer together, and allow a wave of disjoint coders plus advisory lanes.
- OpenCode v2 context status reads `session.context` instead of the missing `session.messages` method.
- Grammar loading imports `web-tree-sitter` from the plugin package file, not at startup.
- An Engine checkout (` .jj`, `.purpose/commands.json`, and executable `bin/repo`) creates coder lanes with `repo lane create` and records `.swarm/repo-lane.json` so the lane is recognized without a git branch.
- Git merge-back is refused on an Engine root. Plain `status`, `diff`, and `log` there go through `repo vcs`.
