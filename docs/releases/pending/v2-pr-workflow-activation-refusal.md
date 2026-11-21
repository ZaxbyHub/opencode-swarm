---
issue: 3319
---

# Refuse unsupported PR workflows at OpenCode v2 activation

OpenCode v2's session shim currently lacks `promptAsync`, `messages`, and
`status`. PR review and PR feedback now refuse activation when any required
capability is missing, and the refusal names the missing operations. This
also applies when transitioning an existing review into feedback.

The check runs before a PR workflow is published. No migration is required.
Workflows on capable clients and ordinary v2 commands keep their behavior.
