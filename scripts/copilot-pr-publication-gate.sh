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

# Versioned, freshness-bound publication evidence (issue #2131 finding 4b).
# Presence alone authorized nothing: the receipt must match the CURRENT git
# repository, the CURRENT HEAD, and the EXACT body being published (sha256).
if [[ ! -f .swarm/evidence/publication-evidence.json ]]; then
  echo "Blocked: missing .swarm/evidence/publication-evidence.json (write the versioned publication-evidence receipt; see commit-pr SKILL.md)."
  missing=1
else
  ev_head_sha="$(sed -n 's/.*"head_sha": *"\([^"]*\)".*/\1/p' .swarm/evidence/publication-evidence.json)"
  ev_body_sha="$(sed -n 's/.*"body_sha256": *"\([^"]*\)".*/\1/p' .swarm/evidence/publication-evidence.json)"
  ev_repo="$(sed -n 's/.*"repository": *"\([^"]*\)".*/\1/p' .swarm/evidence/publication-evidence.json)"
  ev_state="$(sed -n 's/.*"state": *"\([^"]*\)".*/\1/p' .swarm/evidence/publication-evidence.json)"

  if [[ "$ev_state" != "validated" ]]; then
    echo "Blocked: publication-evidence.json state is not 'validated' (found: ${ev_state:-missing})."
    missing=1
  fi

  current_head="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$ev_head_sha" || "$ev_head_sha" != "$current_head" ]]; then
    echo "Blocked: publication-evidence.json head_sha (${ev_head_sha:-missing}) does not match current HEAD (${current_head:-unresolved}). Regenerate the receipt after any new commit."
    missing=1
  fi

  current_origin="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$ev_repo" || -z "$current_origin" ]]; then
    echo "Blocked: publication-evidence.json repository binding could not be verified (receipt: ${ev_repo:-missing}, origin: ${current_origin:-unresolved})."
    missing=1
  elif [[ "$ev_repo" != "$current_origin" ]]; then
    # Normalize the common git@github.com: vs https://github.com/ and trailing .git variance.
    norm_ev="${ev_repo%%.git}"; norm_ev="${norm_ev/git@github.com:/https:\/\/github.com\/}"
    norm_cur="${current_origin%%.git}"; norm_cur="${norm_cur/git@github.com:/https:\/\/github.com\/}"
    if [[ "$norm_ev" != "$norm_cur" ]]; then
      echo "Blocked: publication-evidence.json repository ($ev_repo) does not match this origin ($current_origin)."
      missing=1
    fi
  fi

  actual_body_sha=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual_body_sha="$(sha256sum .swarm/evidence/pr_body.md 2>/dev/null | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual_body_sha="$(shasum -a 256 .swarm/evidence/pr_body.md 2>/dev/null | cut -d' ' -f1)"
  fi
  if [[ -z "$ev_body_sha" || -z "$actual_body_sha" ]]; then
    echo "Blocked: publication-evidence.json body_sha256 could not be verified (receipt: ${ev_body_sha:-missing}, computed: ${actual_body_sha:-unavailable}). Ensure sha256sum or shasum is available and the body file exists."
    missing=1
  elif [[ "$ev_body_sha" != "$actual_body_sha" ]]; then
    echo "Blocked: publication-evidence.json body_sha256 does not match the current pr_body.md — the body changed after the receipt was written. Regenerate the receipt."
    missing=1
  fi

  if ! grep -q '"validation_commands"' .swarm/evidence/publication-evidence.json; then
    echo "Blocked: publication-evidence.json is missing validation_commands."
    missing=1
  fi
fi

if [[ "$missing" -ne 0 ]]; then
  echo "Load .claude/skills/commit-pr/SKILL.md (the single source of truth) and satisfy its checklist before publishing."
  exit 1
fi

exit 0
