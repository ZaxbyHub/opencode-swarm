## What changed

Updated skill documentation files with lessons learned from PR #982 post-merge CI failure:

- **commit-pr/SKILL.md**: Added guidance for dist-check failures caused by version bumps from parallel release-please PRs (rebase + rebuild + force-with-lease push).
- **writing-tests/SKILL.md** (both `.claude/` and `.opencode/` copies): Added warning about stray `.swarm` directories at drive root blocking evidence writes — tests must use `os.tmpdir()` and clean up in `afterEach`.

## Why

PR #982 hit a dist-check failure because release-please bumped the version on main after the branch was cut. The fix (rebase + rebuild) was non-obvious and isn't documented anywhere. Separately, a test artifact left `C:\.swarm` which blocked `write_retro`, `pre_check_batch`, and `sast_scan` — this pattern needs to be called out to prevent recurrence.
