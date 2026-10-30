---
name: mock-to-internals-migration
description: Codex canon for migrating opencode-swarm tests away from Bun mock.module leakage toward _internals dependency-injection seams. Use when touching tests with mock.module, adding test seams, fixing Bun mock isolation failures, or updating source modules for injectable internals.
metadata:
  audience: swarm-plugin
---

# Mock To Internals Migration

This is the canonical Codex migration protocol (self-contained since the #2966
retired-generated-skill reconciliation; it previously delegated to a retired
generated fork). The host-agnostic rules live in AGENTS.md invariant 7 and
`.opencode/skills/writing-tests/SKILL.md`; this canon carries the migration's own
procedure and checks.

## Required Procedure

- Mirror the existing opt-in pattern when gating tools behind feature flags: a
  separate tool-map constant, a conditional merge in `src/agents/index.ts`, and
  gating tests verifying BOTH the disabled and enabled states.
- Run barrel-import-dependent tests after modifying barrel exports.
- Audit code structure integrity before editing a file that was recently
  refactored or extracted (the symbol may have moved).
- Grep for all `vi.fn()`, `vi.spyOn()`, `vi.mock()` in converted files before
  declaring the conversion complete.
- Spread the real module's exports (`...realModule`) as the base of every
  `mock.module` return object that must remain (Node built-ins especially).
- Prefer a small `_internals` seam exposing only the dependency under test over
  a new `mock.module` target — `mock.module` leaks across test files in Bun's
  shared test-runner process (AGENTS.md invariant 7; the allowlist is closed by
  `bun run check:invariants` Check 4).
- Design command-transformation pipelines as idempotent passes, not stacking
  layers.
- Run tests on the unmodified codebase before starting, to establish a failure
  baseline.
- Run the lint check (e.g. `bun run lint`) as part of pre-submit verification,
  not just the build.

## Forbidden Shortcuts

- Invent new tool-gating mechanisms for opt-in feature flags.
- Label post-change test failures as "pre-existing" without having run the
  tests before the change.

## Reviewer Checks

- Grep for import-from-barrel patterns in test files and run the affected tests
  after barrel changes.
- Grep for `mock.module` patterns that lack the `...realModule` spread.
- Confirm `bun:test` isolation patterns match the skill guidelines.
- For wrapper transforms, verify idempotency by applying the transform twice and
  confirming the output equals the single-call output.
- Run `git diff <base>..<head> --name-only` and confirm file presence before
  marking `introduced_by_pr` verdicts.

## Test Engineer Checks

- Add or update tests covering the trigger condition and the forbidden shortcut.

Also load:

1. `.agents/skills/writing-tests/SKILL.md`
2. `.agents/skills/engineering-conventions/SKILL.md` if the seam touches
   runtime-sensitive code

Codex-specific execution notes:

- Use `apply_patch` for source and test edits.
- Use focused per-file `bun --smol test <file> --timeout 30000` validation first.
- Restore any `_internals` overrides in `afterEach`.
- Prefer small seams that expose only the dependency under test.
