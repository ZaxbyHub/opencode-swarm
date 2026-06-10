# Copilot publication governance + issue-tracer quality upgrade

## What changed

Made the `commit-pr` skill the **single, enforced publication path** for every agent
surface (Claude, Codex/`.agents`, opencode, and GitHub Copilot), and hardened the
GitHub Copilot custom agents so they actually load and can act on PR branches.

**Single source of truth.** `.claude/skills/commit-pr/SKILL.md` remains the only
canonical publication protocol. Discovery shims now point every surface at it:

- `.github/skills/commit-pr/SKILL.md` (new) — GitHub Copilot project-skill location.
- `.agents/skills/commit-pr/SKILL.md` — frontmatter trigger widened to cover issue
  assignment and `git push`/`gh pr create|edit|ready`.
- opencode already routes its coder agent to the canonical skill via
  `.opencode/skill-routing.yaml`.

**Instruction layer.** `.github/copilot-instructions.md` now opens with a Mandatory
PR Publication Protocol: load `commit-pr`, the exact PR title/body contract, validation
and release-fragment requirements, the issue-comment requirement, and a hard stop.

**Agent-routing layer.** `.github/agents/issue_tracer_2.md` and
`.github/agents/ci-fixer.agent.md` now route all publication through `commit-pr` instead
of an ad-hoc PR template.

**Enforcement layer.**

- `.github/workflows/pr-standards.yml` gained a `pr-standards` job that fails PRs whose
  body is missing `## Summary` / `## Invariant audit` / `## Test plan`, and fails
  source/script/test PRs that lack a `docs/releases/pending/<slug>.md` release fragment
  (docs/workflow-only changes and bot PRs are exempt; missing `Closes #` is a warning
  because it is conditional). The `check-title` job's allowed types now include `revert`
  to match the canonical skill.
- `.github/hooks/pr-publication-gate.json` + `scripts/copilot-pr-publication-gate.sh`
  add a best-effort pre-publication guardrail that blocks `gh pr create|edit|ready`
  until `.swarm/evidence/pr_body.md` and `.swarm/evidence/commit-pr-validation.md` exist.
  The `commit-pr` skill now documents writing that evidence.

**GitHub Copilot custom-agent fixes** (root-caused against the primary GitHub docs for
custom-agent configuration):

- Normalized every `.github/agents/*.agent.md` `tools:` list to the *recognized* GitHub
  cloud-agent aliases (`read`, `search`, `edit`, `execute`, `web`). The previous lists
  used VS Code-only names (`codebase`, `githubRepo`, `fetch`, `terminal`) which the
  github.com agent **silently ignores** — leaving `ci-fixer` with no usable tools, which
  is why it could not read or modify PR branches. PR-modifying agents (ci-fixer,
  issue-tracer2) now have `edit`+`execute`; read-only reviewers are least-privilege.
- Fixed `issue-tracer.agent.md`'s malformed `***` YAML frontmatter fence (it was not
  loading in the Copilot agents picker), then removed it as a duplicate of the canonical
  GitHub agent `issue_tracer_2.md`.

**Issue-tracer quality upgrade (state of the art).** Improved both the Claude skill
(`.claude/skills/issue-tracer/SKILL.md` + `references/critic-gate.md`) and the Codex
skill (`.agents/skills/issue-tracer/SKILL.md`) with: reasoning-ranked file→function→line
localization, candidate-patch sampling/select-by-test, a "tests-pass ≠ correct"
correctness gate, evidence-grounded reporting rules, and a new **Phase 4.5 Independent
Implementation Review** (a fresh context refutes the actual diff, separate from the plan
critic). The autonomous GitHub `issue_tracer_2.md` agent received the same methods as a
single-session adversarial self-review with **no human-approval gate** (it stays fully
autonomous; no extra session round-trip). Methods are cited inline (Agentless, RGFL,
AutoCodeRover, self-consistency, Anthropic agent-harness guidance).

## Why

Strong instructions alone did not stop malformed PRs or route custom agents into the
canonical workflow, and the Copilot agents were misconfigured (unrecognized tools,
broken frontmatter) so they failed to access PR branches. This makes `commit-pr` both
discoverable (instructions + skills) and enforceable (CI check + guardrail hook).

## Migration / follow-up

No code/runtime migration required. To complete the enforcement layer, a repo admin must
update branch protection / rulesets on `main` to **require** these status checks before
merge: `pr-standards`, `check-title`, and the existing `quality`, `unit`, `integration`,
`dist-check`, `package-check`, `security`, `smoke` (and `rust-sandbox-runner`,
`php-validation`) jobs. Consider "do not allow bypassing." Note: overly strict
commit-author restrictions in rulesets can block the Copilot agent from updating its own
PR branch — scope author allowances accordingly.

## Caveats

- The GitHub Copilot cloud agent's support for repository `.github/hooks/` `preToolUse`
  hooks is not documented as a supported feature at the time of writing; the hook is a
  best-effort guardrail and the **authoritative** enforcement is the `pr-standards` CI
  check plus branch protection.
