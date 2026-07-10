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
#   4. Best-effort opens a tracking issue via `gh issue create` (may fail if the
#      repo's Actions token lacks issues:write — see plan critic C2). The
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
if [ "$suggestion_count" -gt 0 ]; then
    echo ""
    echo "=== Opening tracking issue (best-effort) ==="
    # Build the issue body via a heredoc to a temp file. Using printf '%b' would
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
        echo "This issue was filed automatically by the flake-detection workflow."
    } > "$issue_body_file"
    # F-005: use the existing \`area:testing\` label (there is no \`test-stability\`
    # label in the repo; --label would silently fail the issue creation).
    if gh issue create --repo "$REPO" \
        --title "Auto-detected flaky tests (merge-group) — review for quarantine" \
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
