# Abort timeout recurrence guardrail hardening

The Windows-safe timeout migration now has an AST-based regression guard instead of an exact-text check. CI detects native `AbortSignal.timeout` access through whitespace, optional chaining, bracket notation, aliases, and destructuring, and verifies the shared cancellable helper is called at every affected runtime path.

This closes a recurrence-detection gap discovered while validating issue #1964 after the runtime migration had already landed. No migration or configuration change is required.
