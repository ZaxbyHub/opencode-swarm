# Stop non-transient Windows command retry loops

## What changed

- Windows restricted-command wrapping now transports intact scripts with PowerShell `-EncodedCommand`, invokes validated absolute system executables, preserves safe inherited PATH entries for tools such as Python, Node, and Git, and propagates the exact child exit code.
- Tool outcomes now classify proven parser, command-not-found, sandbox-wrapper, and repeated permanent failures. Parser, command-not-found, and sandbox-wrapper categories stop immediately; a third consecutive `general_permanent` failure trips a bounded invocation-owned circuit. Successful, neutral, degraded, and transient outcomes break the streak.
- Every agent receives the shared non-transient STOP protocol, so a stopped invocation reports the failure instead of trying alternate commands indefinitely.
- Dispatch to the canonical coder role now fails before execution when scope is absent, malformed, ambiguous, stale, or identity-mismatched. The role is resolved under any user-defined swarm ID; no configured swarm name receives special behavior. Explicit scope, plan paths, and complete `FILE:` directives follow strict precedence and subset rules for standard, prefixed, and Full-Auto coders.
- Write-target enforcement now uses one resolver registry across every write-capable tool, including native patch variants, and rejects unverifiable non-architect writes. Code-block extraction validates all final collision-resolved targets before creating any directory or file.

## Migration

No configuration file or schema migration is required. Workflow migration: delegations that previously relied on empty or ambiguous scope must now provide plan `files_touched`, a matching `declare_scope`, or a complete list using one relative path per `FILE:` line.

Fixes #1875.
