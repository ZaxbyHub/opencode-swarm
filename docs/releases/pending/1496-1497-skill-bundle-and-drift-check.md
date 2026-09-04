# Bundled-skill fix (#1496) + CI drift check (#1497)

## What

Fixes four skills that were never installed into user projects and adds an
automated drift checker so the whole class of "parallel sources fell out of
sync" bugs is caught in CI.

### #1496 — missing bundled skills

`writing-tests`, `running-tests`, `engineering-conventions`, and `commit-pr`
existed under `.opencode/skills/` but were absent from the bundled-skill lists,
so `bunx opencode-swarm install` never synced them and they were never published.
They are now added to **all four** coupled surfaces that must agree (the issue
named only two; the other two are enforced by `package-smoke` and would have
broken CI):

- `BUNDLED_PROJECT_SKILLS` (`src/config/bundled-skills.ts`)
- `package.json#files`
- `REQUIRED_PROJECT_SKILL_SLUGS` (`scripts/package-smoke.mjs`)
- the `package-smoke` test fixture

A new regression test (`tests/unit/config/bundled-skills-coherence.test.ts`)
checks the bundled lists against the actual `.opencode/skills/` filesystem and
`package.json#files`, so a skill added to disk without updating the lists now
fails fast — the gap that caused #1496.

### #1497 — CI drift check

New `.github/workflows/drift-check.yml` runs `scripts/drift-check.ts` on every PR
and on `push: main`. The checker imports the real modules and compares runtime
values (no fragile grep), covering skill mirrors, bundled-skill completeness,
tool registration, commands, and agents. It emits GitHub annotations and a
sticky PR comment. CI invokes drift-check with `--enforce`; local
`bun run drift:check` remains soft-warn unless enforcement is requested. Skill mirror contracts are extracted to
`src/config/skill-mirrors.ts`, shared with the existing mirror regression test so
the two cannot diverge.

### Drift fixed by the new check

The checker immediately surfaced two real, pre-existing mirror drifts, now
repaired:

- **`phase-wrap`** — the `.claude` mirror was stale (PR #1480 updated
  `.opencode/skills/phase-wrap` with the "required agent dispatch" section but
  not the `.claude` copy). The existing `skill-mirrors.test.ts` was **red on
  main** because of this; synced `.claude` ← `.opencode`.
- **`commit-pr`** — the `.opencode` mirror was missing a secret-scan safety note
  present in the canonical `.claude` version; synced `.opencode` ← `.claude`.

## Why

Manual SHA-256 verification (PR #1480) does not scale, and nothing checked the
bundled lists against the filesystem (#1496). Both are silent-failure classes
that ship broken installs.

## Follow-ups (non-blocking)

- `writing-tests` and `running-tests` are classified as `divergent` /
  `opencode-only` pending maintainer confirmation of their intended cross-tree
  contract; promote them in `src/config/skill-mirrors.ts` if they should be
  byte-identical mirrors.
- The command and agent detectors are intentionally **parity-focused** (they
  import the real registries and check `COMMAND_NAME_SET` / `subcommandOf`
  integrity and `ALL_AGENT_NAMES`↔`AGENT_TOOL_MAP` / opt-in-map validity) rather
  than parsing adapter-shim references or the multi-swarm prefix convention as
  the issue's bash sketch did. The runtime-import approach avoids the false
  positives a textual scan would produce; the multi-swarm prefix/primary-mode
  regression class is already enforced by the AGENTS.md invariant-11 multi-swarm
  test. Shim-reference and prefix-convention detectors can be added later if that
  coverage is wanted.
- Enabling `DRIFT_CHECK_ENFORCE` to make drift blocking once the team is
  comfortable with the soft-warn signal.
