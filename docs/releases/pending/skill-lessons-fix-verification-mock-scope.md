# Skill updates: empirical fix-verification and mock-cascade scope discipline

## What

Adds two lessons captured while tracing and fixing the `/swarm finalize` knowledge-
loss bug (PR #1592) to the agent skill docs, so future issue-tracer and test-writing
work benefits from them automatically:

- `.claude/skills/issue-tracer/SKILL.md` and `references/critic-gate.md`: a
  diagnosis (even one with exact file:line evidence, from another agent or a pasted
  second opinion) does not guarantee its accompanying fix is correct — especially
  for fixes that hinge on subtle CLI/subprocess flag semantics. New guidance
  requires empirically testing the exact candidate invocation in an isolated
  environment, and dry-running scoped fixes for destructive/broad-acting operations
  against the real target (not just a minimal reproduction) before finalizing scope.
  Two new critic questions (11, 12) and two new Phase 4.5 implementation-reviewer
  checklist items encode this as an active gate, not just prose.
- `.claude/skills/writing-tests/SKILL.md`: when completing a pre-existing
  incomplete `mock.module()` factory (test drift remediation) surfaces a *cascade*
  of other unrelated modules' incomplete mocks, the guidance is to stop, revert,
  and document the failure as pre-existing (with a clean-base repro) rather than
  chase the cascade to green inside an unrelated change.

## Why

During PR #1592, an externally-sourced diagnosis correctly located a
`git clean -fdX` data-loss bug, but its proposed fix (`git clean -fdX -e '.swarm/'`)
was empirically wrong — verified only by testing real git behavior in a throwaway
repo. A first candidate fix that passed a minimal two-file reproduction still turned
out to be under-scoped once dry-run against the real repository's full
`git clean -fdXn` output. Separately, completing one pre-existing test's incomplete
mock revealed the same class of gap in two more unrelated modules; chasing it would
have turned a focused bug fix into an unrelated test-infrastructure refactor.

These are narrow, evidence-grounded additions (not blanket "test everything
exhaustively" mandates) — each carries an explicit trigger condition and a concrete
action, reviewed and approved by an independent reviewer subagent before this PR.

## Migration

No migration required — these are additive documentation changes to existing skill
files; no runtime code or schema changed.

## Breaking changes

None.
