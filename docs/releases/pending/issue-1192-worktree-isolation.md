---
type: fixed
issue: 1192
---

Standard execution-profile parallel coder dispatches now use isolated git worktrees when worktree isolation is available, reusing the Lean Turbo worktree/merge-back machinery through a shared module. If automatic isolation cannot be prepared, the session is serialized instead of allowing additional parallel coders to write into the same checkout.
