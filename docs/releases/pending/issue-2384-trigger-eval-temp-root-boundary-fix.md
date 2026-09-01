## Summary
- Updated the PR-review test fixtures that write `.swarm/` runtime state so their disposable temp roots declare an explicit `.git` boundary before any writes.
- This makes the affected suites valid project roots under the repository boundary guard and prevents write-path failures in temp directories whose parents already contain `.swarm/`.

## Why
- `recordPendingDelegation(...)` and related persistence paths fail closed when a temp root does not clearly opt into project-root status.
- The trigger-eval provenance and collection-validation suites were using temp roots that were rejected by the project-boundary guard on this host.

## Migration
- No migration required.

## Caveats
- This is a test-only fixture fix; production behavior is unchanged.
