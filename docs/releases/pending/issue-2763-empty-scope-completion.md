# Empty-scope task completion

Verification-only tasks that explicitly declare `files_touched: []` can now complete when the trusted coder settlement proves that no mutation was accepted. The completion and read-only gate-status paths use the same durable evidence, preserve independent advisory gates, and keep ordinary or malformed scopes fail-closed. A rejected empty-scope coder preflight records this proof only after a clean baseline confirms that no child ran; a complete `FILE:` directive remains the authoritative non-empty scope.

No configuration or migration is required. Existing tasks and terminal WAL records remain backward-compatible; only an authoritative empty-scope/no-mutation settlement may use the new path.

Raw workspace mutations observed against an empty declared scope are treated as failed mutations requiring rework rather than as no-mutation proof.
