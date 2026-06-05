#!/usr/bin/env bash
#
# copilot-pr-publication-gate.sh
#
# Best-effort preToolUse guardrail for AI coding agents. It blocks
# `gh pr create|edit|ready` until the commit-pr publication evidence exists,
# nudging the agent back to the single source of truth before it publishes.
#
# This is a GUARDRAIL, not the authoritative enforcement. The authoritative
# enforcement is the `pr-standards` CI check plus branch protection on `main`.
# Whether the GitHub Copilot cloud agent invokes repository hooks under
# `.github/hooks/` is not documented as a supported feature at the time of
# writing, so do not rely on this hook alone — it is the first line of defense.
#
# The publication contract is owned by .claude/skills/commit-pr/SKILL.md.
# The two evidence files checked below are produced by that skill's
# "Publication-gate evidence" step.
#
# Input: the hook payload is read from stdin (the tool invocation, including the
# command the agent is about to run).
set -euo pipefail

payload="$(cat || true)"

# Only gate payloads that try to publish or update a pull request. `new` is
# included as a common alias of `create`. The token boundaries (non-alphanumeric
# before `gh` and after the subcommand) avoid false positives like
# "enough pr edits remain".
if ! grep -Eiq '(^|[^[:alnum:]])gh[[:space:]]+pr[[:space:]]+(create|new|edit|ready)([^[:alnum:]]|$)' <<<"$payload"; then
  exit 0
fi

missing=0

if [[ ! -f .swarm/evidence/commit-pr-validation.md ]]; then
  echo "Blocked: missing .swarm/evidence/commit-pr-validation.md (record the validation commands you ran and their results)."
  missing=1
fi

if [[ -f .swarm/evidence/pr_body.md ]]; then
  for section in "## Summary" "## Invariant audit" "## Test plan"; do
    if ! grep -Fq "$section" .swarm/evidence/pr_body.md; then
      echo "Blocked: .swarm/evidence/pr_body.md is missing required section: $section"
      missing=1
    fi
  done
else
  echo "Blocked: missing .swarm/evidence/pr_body.md (write the exact PR body you intend to publish)."
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  echo "Load .claude/skills/commit-pr/SKILL.md (the single source of truth) and satisfy its checklist before publishing."
  exit 1
fi

exit 0
