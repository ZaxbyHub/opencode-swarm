# swarm-pr-feedback drives a PR to merge; new session-retrospective skill

`swarm-pr-feedback` used to stop once known feedback was closed. Driving CI, merging, and reviewing the session each needed a separate instruction every session. Run on a PR, the skill now carries the PR through to the end.

## Drive to merge (new `references/drive-to-merge.md`)
- **Intake.** The run takes this session's own review findings and every PR comment with findings, and runs the existing Stage A → Stage B → closeout gates.
- **Dispositions.** It plans every unfixed item's disposition before the closeout gate and publishes the dispositions only after the push is verified.
- **CI to green, within a budget:**
  - one rerun per infrastructure signature;
  - failures proven on the base branch become `PRE_EXISTING` dispositions, not PR fixes;
  - at most 2 fix attempts per signature and 5 fix cycles per PR.

  Under Profile A each fix is a new controller generation.
- **Merge:**
  - **Authorization.** Only the user's own words in the session naming the merge authorize it, or a yes to the run's own "merge now?" question. A skill invocation, `[MODE: PR_FEEDBACK]` signal, default prompt, monitor wake, or loop activation never does.
  - **Merge command.** It uses `--match-head-commit` on the gated head. It passes no strategy flag on a merge-queue base, and passes the repository's single allowed method on a direct base (or asks when several are allowed).
  - **Monitoring.** It monitors the merge queue until the merge commit is on the base.
- **Close out, merged or not:**
  1. re-verify every disposition on its live artifact;
  2. run a session retrospective;
  3. run the memory closeout.

  "Fixes only" skips CI and the merge; "don't merge" skips only the merge. Runs started by a PR-monitor wake keep their triage scope.

## Follow-up dispositions
- `references/followup-dispositions.md` now states two rules explicitly:
  - anything the PR introduced is fixed in the PR;
  - a verified, consequential defect is never closed on the agent's own judgment.
- In practice FILE means Priority items or user-approved Improvements.
- Every ASK item, follow-up proposal, Improvement, and enhancement idea goes through its own critic call before it reaches the user, and the critic's verdict travels with the question. The closeout critic gate does not count as that call.
- A reviewer's severity label (`nit`, `non-blocking`) never replaces verification.

## New `session-retrospective` skill
- An evidence-based retrospective of the whole session, reconstructed from the harness's own history:
  - Claude Code transcript JSONL;
  - ZCode `~/.zcode/cli/db/db.sqlite`, read-only;
  - Codex rollout JSONL;
  - OpenCode session store.
- It reports:
  - what worked and what failed;
  - tool and skill friction;
  - prioritized improvements;
  - new skill and tool proposals.
- Every proposal is critic-adjudicated before the user sees it. Analysis only.
- It lives at `.claude/skills/session-retrospective/` with an `.agents/skills` adapter, so ZCode, Codex, Claude Code, and OpenCode load it in this repository.

## swarm-ci-monitor
- Step 4a no longer tells agents to omit the merge-strategy flag on every base. A non-interactive `gh pr merge` refuses without one on a direct-merge base, so the step now requires the repository's allowed method there.

## Surfaces
- Both references, the canonical skill and its two adapters.
- The new skill and its adapter, classified `agents-only` in `src/config/skill-mirrors.ts`; the editing-skills guide now says such skills need that entry.
- `swarm-ci-monitor`.
- The `/swarm pr-feedback` help text and the regenerated `docs/commands.md`.
