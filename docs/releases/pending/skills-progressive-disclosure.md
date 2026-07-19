# `refactor(skills)`: progressive-disclosure restructure via references/ splits

## Summary

- Extracted deep/duplicated material from four oversized SKILL.md files into `references/` subdirectories, following the exemplar pattern established by `codebase-review-swarm/`:
  - **swarm-pr-review** (~1744 → ~1400 lines): parser dry-run example → `references/parser-dry-run.md`; reviewer/critic/explorer prompt templates → `references/prompt-templates.md`; COVERAGE GATE restatements collapsed to Phase 3 references
  - **writing-tests** (~948 → ~825 lines): mock.module location + dead-code _internals seam inventories → `references/mock-and-seam-inventory.md`; FR-006 splitting protocol collapsed to limit + skill pointer; Running Tests trimmed to pointer
  - **commit-pr** (~632 → ~465 lines): push-protection scan, canonical remote resolution, auto-merge race, release-please desync → `references/pr-incident-playbook.md`; PowerShell heredoc blocks collapsed; dist/ rule deduplicated
  - **swarm-pr-feedback** (~856 → ~525 lines): bot review traps + security finding verification → `references/bot-claim-verification.md`; DI seam validation + runtime/host gotchas → `references/operational-gotchas.md`; batch collection deduped against ci-failure-batching skill
- Each trimmed SKILL.md retains explicit "read `references/`" pointers so agents following the bundled copy can locate the deep material
- Updated `swarm-pr-review-dry-run.test.ts` to read from the new `references/parser-dry-run.md` path

## User-facing changes

None — pure restructuring of skill documentation. No runtime behavior, no protocol changes, no tool registration changes. The bundler copies `references/` subdirectories recursively, so bundled-skill consumers receive the extracted material as before.

## Migration notes

None required. Agents loading these skills will see `references/` pointers in the SKILL.md entrypoints and can follow them for deep material.

## Breaking changes

None.

## Caveats

- The `commit-pr` skill is classified `divergent` (PR-1 / #1692): `.claude/skills/commit-pr/` is the repo-internal canonical, `.opencode/skills/commit-pr/` is the portable project-agnostic version. The new `references/pr-incident-playbook.md` lives only under `.claude/` since its content is repo-specific.
- All test pins verified intact; `check-skill-assertions.ts` CI job validates automatically.
