#!/usr/bin/env bash
# Detect flaky tests from a merge-group CI run and produce quarantine
# suggestions (issue #1782, root-cause detection phase §6).
#
# Input: a "flake annotations" file (passed as $1 or via $FLAKE_ANNOTATIONS)
# containing the relevant GitHub Actions log lines. The producing ci.yml step
# greps these from the job log:
#   - `::notice file=PATH::Passed on retry N (flaky)`  (in-job retry caught a flake)
#   - `::error file=PATH::...`                         (a hard failure)
#
# This script does NOT auto-append to quarantined-tests.txt. Auto-push needs a
# PAT + branch-protection bypass and is explicitly out of scope (issue #1782
# plan critic C1/C2). Instead it:
#   1. Extracts candidate test file paths from the annotations.
#   2. Applies conservative detection rules (see RULES below).
#   3. Writes surviving candidates to flake-suggestions.txt (an artifact).
#   4. Best-effort reports to the configured tracking issue. Standalone callers
#      without a configured issue retain title-based discovery. The
#      suggestions artifact is the durable fallback.
#
# Detection RULES (a candidate is DROPPED if any rule matches):
#   A. Already in any quarantine list (quarantined-tests*.txt,
#      quarantined-integration-tests.txt).
#   B. Infra-signature failure (runner starvation, runner offline, timeout with
#      no assertion) — these are transient infra, not test flakes.
#   C. Core-tree test (tests/unit/{scope,agents,hooks}/**) — these are core;
#      require human review rather than auto-suggestion.
#
# Portability: bash 3.2 on macOS (no associative arrays, no grep -P). Plain
# indexed arrays + grep -E / grep -F only.
set -euo pipefail

ANNOTATIONS_FILE="${1:-${FLAKE_ANNOTATIONS:-flake-annotations.txt}}"
SUGGESTIONS_FILE="${SUGGESTIONS_FILE:-flake-suggestions.txt}"
REPO="${GH_REPO:-ZaxbyHub/opencode-swarm}"

if [ ! -f "$ANNOTATIONS_FILE" ]; then
    echo "::warning::No flake annotations file found at $ANNOTATIONS_FILE — nothing to detect."
    : > "$SUGGESTIONS_FILE"
    exit 0
fi

# --- Build the combined quarantine set (all 4 files, non-comment lines) ---
QUARANTINE_TMP="$(mktemp)"
{
    for qf in scripts/ci/quarantined-tests.txt \
              scripts/ci/quarantined-tests-macos.txt \
              scripts/ci/quarantined-tests-windows.txt \
              scripts/ci/quarantined-integration-tests.txt; do
        if [ -f "$qf" ]; then
            grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$qf" || true
        fi
    done
} | sort -u > "$QUARANTINE_TMP"

is_quarantined() {
    grep -qxF "$1" "$QUARANTINE_TMP"
}

# Infra-signature patterns (plan critic rule B). Matched case-insensitively
# against the full annotation line.
INFRA_SIGNATURES=(
    "was not acquired by Runner"
    "Runner offline"
    "job was not acquired"
    "The job was canceled"
    "waiting for a runner"
    "no space left on device"
)

is_infra_flake() {
    local line="$1"
    for sig in "${INFRA_SIGNATURES[@]}"; do
        if echo "$line" | grep -qiF "$sig"; then
            return 0
        fi
    done
    return 1
}

# Core-tree prefixes (plan critic rule C). Tests under these dirs require human review.
CORE_PREFIXES=(
    "tests/unit/scope"
    "tests/unit/agents"
    "tests/unit/hooks"
)

is_core_tree() {
    local f="$1"
    for pre in "${CORE_PREFIXES[@]}"; do
        case "$f" in
            "$pre"*) return 0 ;;
        esac
    done
    return 1
}

# --- Extract candidate (file, line) pairs from annotations ---
# notice: `::notice file=PATH::...flaky...`
# error:  `::error file=PATH::...`
# Use grep -Eo to pull the file=PATH token, then strip the prefix.
CANDIDATES_TMP="$(mktemp)"
grep -hE "^::(notice|error) file=" "$ANNOTATIONS_FILE" 2>/dev/null \
    | grep -Eo "file=[^:]+::" \
    | sed -E 's/^file=//; s/::$//' \
    | sort -u > "$CANDIDATES_TMP" || true

: > "$SUGGESTIONS_FILE"
suggestion_count=0
dropped_quarantined=0
dropped_infra=0
dropped_core=0

while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue

    # Re-fetch the annotation line(s) for this candidate (for infra-signature check).
    candidate_line="$(grep -F "file=$candidate" "$ANNOTATIONS_FILE" | head -1 || true)"

    if is_quarantined "$candidate"; then
        dropped_quarantined=$((dropped_quarantined + 1))
        continue
    fi

    if [ -n "$candidate_line" ] && is_infra_flake "$candidate_line"; then
        dropped_infra=$((dropped_infra + 1))
        continue
    fi

    if is_core_tree "$candidate"; then
        dropped_core=$((dropped_core + 1))
        echo "# CORE-TREE (requires human review): $candidate" >> "$SUGGESTIONS_FILE"
        continue
    fi

    echo "$candidate" >> "$SUGGESTIONS_FILE"
    suggestion_count=$((suggestion_count + 1))
done < "$CANDIDATES_TMP"

echo "=== Flake detection summary ==="
echo "Candidates scanned: $(wc -l < "$CANDIDATES_TMP" | tr -d ' ')"
echo "Dropped (already quarantined): $dropped_quarantined"
echo "Dropped (infra signature):    $dropped_infra"
echo "Dropped (core tree, flagged): $dropped_core"
echo "Quarantine suggestions:       $suggestion_count"
echo "Suggestions written to:       $SUGGESTIONS_FILE"

# --- Best-effort tracking issue (plan critic C2: may fail on token perms) ---
# Issue #3248: dedupe before creating. Every failed merge-group run used to
# file a NEW issue with this same title (97 duplicates filed in the
# 2026-09/10 cohort), so first look for an OPEN issue with the exact title
# and comment the candidates there instead. The comment carries the full
# per-run candidate list, so no detection evidence is lost by reusing one
# issue.
# Trust rule (PRR-001, the v7.188.0 lookalike-issue class — see
# scripts/check-host-contract.ts and scripts/ci/quarantine-aging.ts
# isBotAuthored): only adopt issues authored by this workflow's own bot
# identity. Issue titles are user-controllable in a public repo; a lookalike
# issue MUST NOT absorb the bot's detection comments.
# Known limitation (accepted, warn-only): two detection runs finishing
# concurrently can both find no open issue and both create — a rare duplicate
# that the next run's comment merges back onto one thread.
TRACKING_TITLE="Auto-detected flaky tests (merge-group) — review for quarantine"
if [ "$suggestion_count" -gt 0 ]; then
    echo ""
    echo "=== Reporting detection (best-effort) ==="
    existing_issue=""
    # gh's --template renders the JSON without jq (unpinned dependency per
    # the repo's other tracking scripts, which parse --json output
    # themselves); --search 'in:title <phrase>' filters server-side so the
    # 100+ open issues in the repo cannot crowd the window the way a plain
    # --limit list would.
    # Row + trust contract (review round 2, findings 1+2): rows are
    # number<TAB>TITLE with the title LAST (a 2-var read makes the title the
    # absorbing remainder, so interior tabs survive byte comparison). Titles
    # may contain tabs AND newlines (both round-trip through the API — probe
    # issue #3258), so NO positional field after the title is trustworthy: a
    # newline title can synthesize entire fake rows naming any issue number
    # with any flag values. The title byte-match therefore only SELECTS a
    # candidate number; adoption is decided by a separate AUTHORITATIVE
    # per-issue fetch (gh issue view → author.is_bot, the structural flag —
    # the gh CLI renders this workflow's own actor as `app/github-actions`
    # while the REST API renders `github-actions[bot]`, so a login literal
    # matches only one serializer; quarantine-aging.ts:13-14 observed the
    # same). A forged selection can therefore only route to an issue whose
    # REAL author is then checked — a hijacker's own issue fails the check.
    if [ -n "${FLAKE_TRACKING_ISSUE:-}" ]; then
        # This explicit issue number comes from the trusted workflow, not from
        # the triggering run's artifacts or a search of user-editable titles.
        # If it is unusable, keep the artifact and do not revive the old tracker.
        case "$FLAKE_TRACKING_ISSUE" in
            0*|*[!0-9]*)
                echo "::warning::Invalid configured flake tracking issue number."
                ;;
            *)
                if open_issue="$(gh api "repos/$REPO/issues/$FLAKE_TRACKING_ISSUE" \
                    --jq 'select(.state == "open" and (.pull_request | not)) | [.number, .repository_url] | @tsv' 2>/dev/null)" && \
                    [ "$open_issue" = "$FLAKE_TRACKING_ISSUE"$'\t'"https://api.github.com/repos/$REPO" ]; then
                    existing_issue="$FLAKE_TRACKING_ISSUE"
                else
                    echo "::warning::Configured flake tracking issue is unavailable or closed."
                fi
                ;;
        esac
    elif issue_matches="$(gh issue list --repo "$REPO" --state open \
        --search "in:title \"Auto-detected flaky tests (merge-group)\"" \
        --json number,title --limit 20 \
        --template '{{range .}}{{.number}}	{{.title}}
{{end}}' 2>/dev/null)"; then
        matched_title=0
        while IFS="	" read -r cand_number cand_title; do
            [ -n "$cand_number" ] || continue
            case "$cand_number" in
                '' | *[!0-9]*) continue ;;
            esac
            if [ "$cand_title" = "$TRACKING_TITLE" ]; then
                matched_title=1
                # Authoritative bot check on the SELECTED number (PRR-001):
                # the title match only nominates; the issue's real author
                # decides. is_bot is structural and serializer-independent.
                author_flag="$(gh issue view "$cand_number" --repo "$REPO" \
                    --json author --template '{{.author.is_bot}}' 2>/dev/null || true)"
                if [ "$author_flag" = "true" ]; then
                    existing_issue="$cand_number"
                    break
                fi
            fi
        done <<EOF
$issue_matches
EOF
        if [ -z "$existing_issue" ]; then
            if [ "$matched_title" -eq 1 ]; then
                # A same-titled open issue exists but is NOT bot-authored:
                # never comment there (PRR-001). Say why we are not deduping.
                echo "::warning::open same-titled issue is not bot-authored (authoritative author.is_bot != true); not adopting it (lookalike-issue guard). Creating a fresh tracking issue."
            else
                # Lookup succeeded but zero exact-title matches inside the
                # window: the dedupe is inert this run. Say so — a silent
                # fall-through to create would quietly resume duplicate
                # filing with no signal (PRR-006).
                echo "::warning::no open bot-authored issue with the exact tracking title; creating a new tracking issue."
            fi
        fi
    else
        # The lookup itself failed (rate limit, network): fall through to
        # create, but say so — a silent lookup failure would quietly resume
        # duplicate-filing (the exact defect this dedupe fixes).
        echo "::warning::gh issue list lookup failed; creating a new issue (possible duplicate until the lookup recovers)."
    fi
    # Build the report body via a redirect block. Using printf '%b' would
    # interpret backslash escapes in the SUGGESTIONS_FILE contents (which come
    # from test file paths and could contain backslashes on Windows) — F-009.
    issue_body_file="$(mktemp)"
    {
        echo "Flaky-test detection (issue #1782) found the following candidates"
        echo "for quarantine during a merge-group CI run:"
        echo ""
        echo '```'
        cat "$SUGGESTIONS_FILE"
        echo ''
        echo '```'
        echo ""
        echo "To quarantine: append each line to the appropriate"
        echo "\`scripts/ci/quarantined-tests*.txt\` file."
        echo ""
        if [ -n "${DETECTION_RUN_URL:-}" ]; then
            echo "Triggering CI run: ${DETECTION_RUN_URL}"
            echo ""
        fi
        if [ -n "$existing_issue" ]; then
            echo "This comment was added automatically by the flake-detection"
            echo "workflow with new detections from a merge-group run."
        else
            echo "This issue was filed automatically by the flake-detection workflow."
        fi
    } > "$issue_body_file"
    if [ -n "$existing_issue" ]; then
        if gh issue comment "$existing_issue" --repo "$REPO" \
            --body-file "$issue_body_file" 2>/dev/null; then
            echo "Commented on existing tracking issue #${existing_issue}."
        else
            # C2: do NOT fail the job. The suggestions artifact is the durable record.
            echo "::warning::gh issue comment #${existing_issue} failed (likely token permissions)."
            echo "            The flake-suggestions.txt artifact is the durable fallback."
        fi
    elif [ -n "${FLAKE_TRACKING_ISSUE:-}" ]; then
        echo "The flake-suggestions.txt artifact is the durable fallback."
    elif gh issue create --repo "$REPO" \
        --title "$TRACKING_TITLE" \
        --body-file "$issue_body_file" \
        --label "area:testing" 2>/dev/null; then
        echo "Tracking issue created."
    else
        # C2: do NOT fail the job. The suggestions artifact is the durable record.
        echo "::warning::gh issue create failed (likely token permissions or label)."
        echo "            The flake-suggestions.txt artifact is the durable fallback."
        echo "            A maintainer can file the issue manually using the artifact."
    fi
    rm -f "$issue_body_file"
fi

rm -f "$QUARANTINE_TMP" "$CANDIDATES_TMP"
# Always exit 0: detection is advisory. A detected flake is not a CI failure
# in this workflow (it already failed in the triggering ci.yml run).
exit 0
