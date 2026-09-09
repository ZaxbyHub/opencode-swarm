#!/usr/bin/env bash
# scripts/swarm-implement-pipeline.sh — gated pipeline driver for the
# swarm-implement GitHub Action (#2498, source #1224 phase 2).
#
# Usage:
#   bash scripts/swarm-implement-pipeline.sh <issue-ref>
#     <issue-ref> is the issue number, issue URL, or owner/repo#N (FIRST
#     positional argument; the ISSUE_REF environment variable is a documented
#     override only, never the primary path).
#   bash scripts/swarm-implement-pipeline.sh branch <N>
#     Prints the derived branch name for issue N and exits. Pure: no git
#     calls, no filesystem access, cwd-independent.
#
# Modes:
#   SWARM_PIPELINE_DRY_RUN=1  Records each pipeline phase and produces the
#     evidence bundle without a model, network, gh, or a git remote. The
#     swarm ci evaluation is stubbed to a passing gate table unless
#     SWARM_DRY_RUN_CI_EXIT names a different exit, and SWARM_DRY_RUN_PAUSE=1
#     simulates a Full-Auto oversight pause so callers can exercise the
#     pause path deterministically.
#
# Exit codes: 0 success; 1 evaluation violations (no PR published);
# 2 interrupted (SIGINT/SIGTERM); 3 deadline/internal error;
# 4 branch push failed (transport/auth — distinct from a gate verdict);
# 5 PR publication rejected;
# 10 Full-Auto oversight pause (terminal — never retried past).
#
# The pipeline wraps the surfaces #2497 shipped (swarm ci) and the host-driven
# pipeline phases; it reimplements none of them.
set -euo pipefail

PAUSE_EXIT_CODE=10
MAX_RETRIES=2
DRY_RUN="${SWARM_PIPELINE_DRY_RUN:-0}"
EVIDENCE_DIR=".swarm/pipeline-evidence"

trap 'exit 2' INT TERM

record_phase() {
	printf '%s\n' "$1" >> "$EVIDENCE_DIR/phases.txt"
}

append_summary() {
	# GITHUB_STEP_SUMMARY is set by the Actions runner; keep local runs quiet.
	# Best-effort: an unwritable summary must not abort the failure-reporting
	# path itself under set -e (the fallback returns zero explicitly).
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || return 0
	fi
}

issue_number_from_ref() {
	# Accepts a bare number, an issue URL, or owner/repo#N; prints the number.
	case "$1" in
		*'/issues/'*)
			# Strip query strings/fragments from issue URLs before the numeric
			# validation below; a URL fragment is not part of the issue number.
			local issue_path="${1#*/issues/}"
			issue_path="${issue_path%%\?*}"
			issue_path="${issue_path%%\#*}"
			if [[ "$issue_path" =~ ^[0-9]+$ ]]; then
				printf '%s\n' "$issue_path"
			else
				# Keep the assignment successful under set -e so the shared
				# validation below emits the standard parse error and exit 3.
				printf '\n'
			fi
			;;
		*'#'*) printf '%s\n' "$1" | sed 's/^.*#//' ;;
		*) printf '%s\n' "$1" ;;
	esac
}

oversight_pause() {
	# Full-Auto oversight denied or paused the run. Surface the reason and
	# stop; callers must treat this exit code as terminal (the bounded retry
	# wrapper below never retries it).
	printf 'OVERSIGHT_PAUSE: %s\n' "$1"
	append_summary "OVERSIGHT_PAUSE: $1"
	printf '%s\n' "OVERSIGHT_PAUSE: $1" > "$EVIDENCE_DIR/run-status.txt"
	exit "$PAUSE_EXIT_CODE"
}

run_phase() {
	# Runs one host-driven pipeline phase with a bounded retry budget
	# (MAX_RETRIES) for host/provider failures. An oversight pause is
	# terminal — the retry loop never re-proceeds past a denial.
	local name="$1"
	local command="$2"
	local attempts=0
	local output=""
	record_phase "$name"
	if [ "$DRY_RUN" = "1" ]; then
		printf '%s\n' "dry-run: recorded phase $name (command: $command)" \
			>> "$EVIDENCE_DIR/phases.txt"
		if [ "${SWARM_DRY_RUN_PAUSE:-0}" = "1" ]; then
			oversight_pause "dry-run simulated Full-Auto oversight denial"
		fi
		return 0
	fi
	while [ "$attempts" -lt "$MAX_RETRIES" ]; do
		attempts=$((attempts + 1))
		# Per-attempt timeout: a hung host session must not consume the whole
		# job budget before the bounded retry logic can make a second attempt.
		if output="$(timeout "${PHASE_TIMEOUT_SECONDS:-600}" opencode run --command "$command" --format json 2>&1)"; then
			if printf '%s' "$output" | grep -q 'OVERSIGHT_PAUSE'; then
				oversight_pause "$output"
			fi
			return 0
		fi
		if printf '%s' "$output" | grep -q 'OVERSIGHT_PAUSE'; then
			oversight_pause "$output"
		fi
		printf '%s\n' "phase $name attempt $attempts failed; retrying within MAX_RETRIES" >&2
	done
	printf '%s\n' "phase $name exhausted MAX_RETRIES attempts" >&2
	exit 3
}

if [ "${1:-}" = "branch" ]; then
	# Pure branch derivation (frozen by C5): exactly one stdout line, no side
	# effects, no git calls, cwd-independent.
	printf 'swarm/implement-%s\n' "${2:?usage: branch <issue-number>}"
	exit 0
fi

RAW_REF="${1:-${ISSUE_REF:-}}"
if [ -z "$RAW_REF" ]; then
	printf '%s\n' "usage: swarm-implement-pipeline.sh <issue-ref>" >&2
	exit 3
fi
ISSUE_NUMBER="$(issue_number_from_ref "$RAW_REF")"
case "$ISSUE_NUMBER" in
	''|*[!0-9]*) printf '%s\n' "cannot parse an issue number from: $RAW_REF" >&2; exit 3 ;;
esac
BRANCH="swarm/implement-$ISSUE_NUMBER"

mkdir -p "$EVIDENCE_DIR"
: > "$EVIDENCE_DIR/phases.txt"

# Pipeline phases through the host (ingestion reuses /swarm issue semantics).
run_phase ingest "swarm issue $RAW_REF"
run_phase spec "swarm specify"
run_phase plan "swarm plan"
run_phase review "swarm review"

# Idempotency pre-check (frozen by C5): pure local branch existence, no
# network and no GITHUB_TOKEN dependency, so it also holds in the dry-run
# harness.
if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
	printf '%s\n' "re-attaching to existing branch $BRANCH" >&2
else
	git branch "$BRANCH"
	printf '%s\n' "created branch $BRANCH" >&2
fi
git checkout --quiet "$BRANCH"

# Evaluation via the advisory CI surface #2497 shipped. Capture the exit code
# before set -e can react (frozen by C8).
if [ "$DRY_RUN" = "1" ]; then
	SWARM_CI_EXIT="${SWARM_DRY_RUN_CI_EXIT:-0}"
else
	set +e
	timeout "${EVAL_TIMEOUT_SECONDS:-900}" bunx opencode-swarm ci
	SWARM_CI_EXIT=$?
	set -e
fi
printf '%s\n' "swarm ci exit: $SWARM_CI_EXIT" >> "$EVIDENCE_DIR/phases.txt"

# Evidence PR body (frozen by C11): plan, gate, and oversight sections.
{
	printf '%s\n' "## Plan"
	printf '%s\n' "Pipeline branch: $BRANCH (issue #$ISSUE_NUMBER). Phases recorded in .swarm/pipeline-evidence/phases.txt."
	printf '%s\n' "## Gate evaluation"
	if [ "$DRY_RUN" = "1" ]; then
		printf '%s\n' "Dry-run stub gate table: all gates green (simulated swarm ci exit $SWARM_CI_EXIT)."
	elif [ "$SWARM_CI_EXIT" -eq 0 ]; then
		printf '%s\n' "swarm ci evaluation passed (exit 0). Full gate table: .swarm/pipeline-evidence/phases.txt."
	else
		printf '%s\n' "swarm ci evaluation FAILED (exit $SWARM_CI_EXIT). Violations surfaced in the run summary; no success PR is published."
	fi
	printf '%s\n' "## Oversight record"
	if [ "$DRY_RUN" = "1" ] && [ "${SWARM_DRY_RUN_PAUSE:-0}" = "1" ]; then
		printf '%s\n' "Full-Auto oversight paused this run (OVERSIGHT_PAUSE); terminal exit $PAUSE_EXIT_CODE."
	else
		printf '%s\n' "No Full-Auto oversight pause recorded for this run."
	fi
} > "$EVIDENCE_DIR/pr-body.md"

# Publish gate (frozen by C8): PR creation happens only when the evaluation
# passed; a violations verdict is surfaced and fails the job instead.
if [ "$SWARM_CI_EXIT" -eq 0 ]; then
	if [ "$DRY_RUN" = "1" ]; then
		printf '%s\n' "publish=ready (dry-run: gh pr create deferred)" > "$EVIDENCE_DIR/publish-decision.txt"
	else
		# Idempotent at the PR boundary too: a re-trigger against an issue
		# whose PR already exists reuses it instead of failing a duplicate
		# create (the C5 idempotency contract extended from branch to PR).
		if timeout "${PR_CHECK_TIMEOUT_SECONDS:-30}" gh pr view "$BRANCH" --json url > /dev/null 2>&1; then
			printf '%s\n' "publish=existing" > "$EVIDENCE_DIR/publish-decision.txt"
			exit 0
		fi
		# GH_TOKEN authenticates the gh CLI; git itself needs credentials
		# configured (the checkout persists none by design).
		gh auth setup-git
		# Push and PR-create failures get dedicated exit codes (4/5) so an
		# observer can distinguish a transport failure from a gate verdict
		# (exit 1) without reading logs.
		if ! git push origin "$BRANCH"; then
			append_summary "git push of $BRANCH failed (exit 4): transport or credential problem, not a gate verdict."
			printf '%s\n' "publish=push-failed" > "$EVIDENCE_DIR/run-status.txt"
			exit 4
		fi
		if ! gh pr create --title "swarm: implement issue #$ISSUE_NUMBER" --body-file "$EVIDENCE_DIR/pr-body.md" --head "$BRANCH" > "$EVIDENCE_DIR/pr-url.txt"; then
			append_summary "gh pr create failed for $BRANCH (exit 5)."
			printf '%s\n' "publish=pr-create-failed" > "$EVIDENCE_DIR/run-status.txt"
			exit 5
		fi
		printf '%s\n' "publish=done" > "$EVIDENCE_DIR/publish-decision.txt"
	fi
	exit 0
fi

append_summary "swarm ci evaluation failed with exit $SWARM_CI_EXIT for issue #$ISSUE_NUMBER; violations were not bypassed and no success PR was published."
printf '%s\n' "swarm ci exit $SWARM_CI_EXIT; no PR published" > "$EVIDENCE_DIR/run-status.txt"
exit "$SWARM_CI_EXIT"
