# PR-monitor subscription hardening follow-up (issue #2042)

This follow-up tightens the PR-monitor subscription store after review:

- publish audit-drop accounting only after the audit compaction rewrite succeeds;
- let admitted 8-64 MiB legacy stores converge during read bootstrap instead of
  rejecting valid one-time migration work;
- redact filesystem errors down to stable codes so callers do not see raw paths;
- stabilize archive-mtime regression coverage with a frozen clock in the
  adversarial suites.

The result keeps the bounded checkpoint/audit migration behavior from issue #2042
intact while closing the last review hardening gaps and keeping the PR-monitor
regression tests deterministic.
