# Lean lane provider-error regression complement (issue #3162)

## Tests

Adds a complement regression suite for the lean lane runner's provider-error
handling shipped in d480b3363 (test-only; no runtime behavior change in this
PR). `tests/unit/turbo/lean/runner-provider-message-error-3162.test.ts` +
`runner-provider-error-3162-fixtures.ts` pin, beyond the base
`runner-provider-error.test.ts`: the formatted provider-error shape on the 429
and 403 legs (including the sanitized display tail), the failure branch's
abort/scope-binding/agent-state teardown observability with the #2123
abort-before-delete ordering, classifier readability both ways, the
`MessageOutputLengthError` truncated-reply carve-out, and the #1896
model-fallback chain end to end (activation, 403 non-failover, exhaustion,
timeout race).

No user-facing behavior change ships in this PR; it lands alongside the
d480b3363 fix's release.
