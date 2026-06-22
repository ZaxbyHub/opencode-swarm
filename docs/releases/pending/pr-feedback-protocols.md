## skills: PR feedback gotchas — dirty worktree, push protection, canonical remote

Captures 3 operational lessons from PR #1472 review (memory system Phase 1) that were hitting every agent during PR feedback workflows.

### What changed
- **swarm-pr-feedback (canonical source)**: Added pre-flight "Dirty Worktree Handling" section. When the working tree has pre-existing uncommitted changes from other branches, stage files explicitly by path — never `git add -A`.
- **commit-pr (canonical source)**: Added two pre-push checks: (1) Push protection scan for Stripe/GitHub/Slack/AWS/JWT/Google API literal patterns, with string-concatenation workaround; (2) Canonical remote resolution to push to the org-owner remote first.

### Why
These three gotchas hit repeatedly across one session (Round 1 + Round 2 + Round 3 of PR #1472 review):
1. `git add -A` picked up 57 pre-existing uncommitted files in Round 1, creating a 59-file commit instead of the intended 2-file fix.
2. A test file's literal `sk_live_*` Stripe fixture blocked the first push.
3. The `zaxbysauce/*` vs `ZaxbyHub/*` remote split caused `gh pr create` to fail.

### Migration
No migration required. Documentation-only changes.
