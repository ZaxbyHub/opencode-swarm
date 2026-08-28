# Truthful sandbox and autonomous-write integrity boundary

Full-Auto, guardrails, sandbox execution, and governed optimization now share a
single security-boundary contract.

- Shell commands receive one bounded compound-command classification reused by
  guardrails, Full-Auto policy, and explain output. Catastrophic and irreversible
  primary-tree operations remain hard blocks that a critic cannot waive.
- Sandbox diagnostics report filesystem, network, process, and effective
  strength separately. Weak or absent mechanisms are never presented as real
  containment. Explicit required mode fails closed; absent requirements retain
  the existing warn-once, tool-layer fail-open behavior.
- Protected evaluator, scorer, audit, promotion, sandbox, and release inputs are
  checked before and after candidate execution. Autonomous and approved writes
  carry session-isolated, mechanically enforced provenance.
- Turbo never bypasses exact coder scope enforcement; the dead scope-guard
  Turbo-skip configuration is removed.

No data migration is required. Legacy provenance remains readable. Operators who
need a mandatory OS boundary should configure required dimensions and use
`/swarm diagnose` to verify real platform capability before autonomous work.
