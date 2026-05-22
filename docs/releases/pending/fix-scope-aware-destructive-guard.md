## Scope-aware destructive command guard for coder declared scope

`checkDestructiveCommand` now accepts a `sessionID` parameter and resolves the coder agent's declared scope. When ALL target paths of a recursive delete command (`rm -rf`, `rmdir /s`, `del /s`, `Remove-Item -Recurse`, `rsync --delete`) are within the declared scope, the operation is allowed instead of being blocked by the hardcoded safe-target allowlist.

This fixes the scenario where a coder agent was tasked to delete a stale project directory like `plugins/oxlint-plugin-effect` but got blocked on every shell command (`rm -rf`, `rmdir`, `Remove-Item`) and had to resort to workarounds like `node -e fs.rmdirSync`.

**Migration:** No migration required. This is additive — existing safe-target allowlist behavior is unchanged. When `declare_scope` is not used, behavior is identical to before.
