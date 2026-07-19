# Stop hard-blocking `python -m <module>` shell commands (interpreter-eval false positive)

## What changed

- The shell-write scope guard no longer treats `python -m <module>` (e.g. `python -m pytest`, `python -m ruff`, `python -m build`) as an unverifiable "interpreter eval" write. `-m` runs an *installed module as a program* — equivalent to invoking the tool directly (`pytest`, `ruff`) — so it is no longer flagged. Previously every such command was hard-blocked with a misleading `BLOCKED: bash/shell write operation with unresolvable path target — rejecting for safety`, before any scope/authority check and regardless of `guardrails` config. This blocked Python projects outright (and even the swarm's own `test_runner`-generated `python -m pytest` invocations). Genuine inline-code eval (`python -c`, `node -e`, `bun -e`, `ruby -e`, `perl -e`, `php -r`) is still treated as an unverifiable write and stays fail-closed, so it cannot be used to bypass the scope/config-zone protections.
- The remaining fail-closed cases now return an accurate, actionable message instead of the old "unresolvable path target" text:
  - inline eval → explains the inline code can't be scope-verified and to write via the file tools or invoke installed tools directly;
  - a dynamic redirect target (`echo x > $VAR`, `> $(cmd)`) → says the path is a shell variable / command substitution that can't be statically resolved;
  - a bare here-doc marker (`<< EOF` with no file redirect) is no longer mistaken for a write — it feeds stdin, and any accompanying `> file` redirect is scope-checked on its own.

## Migration

No configuration or schema migration is required. If a run was stuck with `BLOCKED: … unresolvable path target` on commands like `python -m pytest … 2>&1`, update the plugin and re-run — those module invocations now pass the write guard (their actual file writes remain contained by declared scope and the OS sandbox wrapper).

Fixes #1902. Surfaced during the #1896 investigation.
