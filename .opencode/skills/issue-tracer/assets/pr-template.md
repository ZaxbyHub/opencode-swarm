# PR Description Template

This is a drafting aid. The published PR body must satisfy the repository's own publish contract (see the repo's commit/PR skill); do not invent a parallel format. Keep the issue-closing line the PR body's first line when the PR resolves an issue.

## Root Cause

[One paragraph explaining what was broken, where, and why. Include file paths, symbols, line ranges, and triggering conditions.]

## Fix

[Concise description of the minimal patch and why it is necessary and sufficient.]

- [Specific code change]
- [Specific code change]

## Recurrence Prevention (defect class)

- Defect class: [one-sentence pattern statement]
- Sweep result: [count of hits and their dispositions]
- Guardrail: [rung + how it was demonstrated to bite]

## Tests

- Regression test: `[command]` → PASS
- Impacted suite: `[command]` → PASS
- Lint/type/build/security checks: `[commands]` → PASS
- Deferred-work scan: `.opencode/skills/issue-tracer/scripts/scan-deferred.sh` → clean

## Regression Protection

- [New/updated test path and scenario]
- [Negative/boundary/adversarial case if relevant]
- [Test drift review result]

## Acceptance Criteria → Evidence

| Acceptance criterion (from intake) | Evidence (command + output, or test name) |
|---|---|
| [criterion] | [evidence] |

## Invariant Audit

List the invariants from the repository's invariant/architecture-contract doc and mark each touched / not touched with concrete evidence (command, test output, source inspection, or grep result). If the repository has no invariant doc, state "none documented" — never fabricate an audit.

- [invariant]: touched / not touched — [evidence]

## Risk and Rollback

- Risk level: [low/medium/high]
- Rollback: [revert commit / disable flag / restore config / migration rollback]
- Residual risk: [none or explicit risk]

## Waivers (or none)

Any Full-Resolution Contract clause waived by the interactive user or a checked-in owner contract, quoted verbatim with its source. If none, write "none".

## Issue Closure

Closes #[issue-number]
