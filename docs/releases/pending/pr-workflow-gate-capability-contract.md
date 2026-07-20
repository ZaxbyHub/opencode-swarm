# Restore Mechanical PR Workflow Capability Contracts

## What

- Routes real OpenCode SDK `output.args` into the mechanical PR workflow gate,
  fixing both false denials of safe commands and false admission of mutating
  connector arguments.
- Defines explicit mode-scoped observation and validation capabilities for the
  tools required by `swarm-pr-review`, while keeping unknown and mutation-capable
  surfaces fail-closed.
- Adds controller-owned review findings and feedback-handoff artifacts with
  exact candidate coverage, phase ordering, PR-head binding, and completion
  checks.
- Adds a dedicated, revision-bound PR-feedback scope controller so verified
  coder Tasks work without fabricating an implementation plan. Active bindings
  remain exact-file scoped and recover safely from plugin-process restarts.
- Permits only the narrow post-bind `git fetch <remote> <branch>` form required
  by the review protocol; force, refspec rewrite, checkout, and compound forms
  remain blocked.

## Why

The gate read arguments from the SDK input object even though the live host
supplies them on the output object. That made the PR-review workflow unable to
perform required read-only operations and weakened argument-sensitive mutation
checks. The sibling PR-feedback workflow also documented a planless coder
carve-out that the current scope preflight no longer supported.

## Migration

No user configuration changes are required. PR review and feedback runs now use
the dedicated controller tools documented in their bundled skills; generic
writes to protected `.swarm/` workflow evidence remain blocked.
