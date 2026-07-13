#!/usr/bin/env bash
# Issue #1737 FR-012 — lint for bash-4+-only constructs in scripts/.
#
# Historic incident this prevents: scripts/check-invariants.sh used
# `declare -A` (bash 4+ associative arrays), which silently died on macOS's
# system bash (3.2, no associative array support) for months before it was
# noticed (issue #1729). That script has since been fixed (indexed arrays,
# no `grep -P`). This lint catches the same class of mistake recurring
# anywhere else in scripts/.
#
# NOT diff-scoped, unlike scripts/check-test-tmpdir.sh: a bash4+ construct
# is exactly as broken on macOS today as it was the day it was added — there
# is no "pre-existing debt" carve-out reason here (confirmed during issue
# #1737: no bash4+ constructs currently exist anywhere in scripts/, only
# comments mentioning the terms as documentation of this exact constraint).
# So this scans full current file content, not just the diff.
#
# Flagged constructs (each verified to be genuinely unsupported in bash 3.2,
# the macOS system bash — not guessed):
#   - `declare -A` — associative arrays, added in bash 4.0.
#   - `grep -P` — PCRE support; BSD grep (macOS) has no -P flag at all.
#   - `coproc` — coprocess keyword, added in bash 4.0.
#   - `mapfile` / `readarray` — builtins added in bash 4.0 (synonyms).
# NOT flagged: hex escapes like `\x27`. bash 3.2 DOES support `\xHH` inside
# `$'...'` ANSI-C-quoted strings (that support predates 4.0) — the actual
# check-invariants.sh incident was about `grep -P`'s `\x27`, not bash's own
# string escaping, and that's already covered by the `grep -P` check above.
# Flagging bare `\x` would false-positive on ordinary regex/string content.
#
# Portability of this script itself (it must run on the same macOS runner
# it's protecting): bash 3.2 compatible — plain indexed arrays, grep -E only,
# no `declare -A`, no `grep -P`. Verified by inspection (no bash 3.2 install
# available on this dev machine to test directly): every construct used here
# (arrays via `arr=(...)`/`"${arr[@]}"`, `[[ ]]`, `$(...)`, `grep -E`) is
# bash 3.x-era syntax, matching the same idiom already proven in CI by the
# sibling scripts (check-test-tmpdir.sh, check-test-clock.sh, etc.).
set -euo pipefail

violations=0
violation_files=()

# Every .sh file in scripts/ (recursively) — matches the set of shell scripts
# that actually exist in this repo (confirmed via `find scripts/ -name '*.sh'`
# during investigation: scripts/*.sh, scripts/ci/*.sh, scripts/lib/*.sh).
while IFS= read -r file; do
    file_has_violation=0

    # Strip comment-only lines (leading whitespace then #) before matching —
    # this script and several siblings document these exact constructs as
    # things NOT to use, in comments; without this filter every such comment
    # self-triggers as a false violation. This is a plain-text heuristic (no
    # real bash parser available), same class of tradeoff as the substring
    # matching in check-test-tmpdir.sh — it will not catch a construct
    # deliberately hidden behind a trailing inline comment marker mid-line,
    # but that's not a realistic authoring pattern for these constructs.
    code_only="$(grep -vE '^[[:space:]]*#' "$file" || true)"

    if echo "$code_only" | grep -qE 'declare[[:space:]]+-A'; then
        echo "ERROR: $file uses \`declare -A\` (bash 4+ associative arrays) — not supported on macOS's bash 3.2."
        echo "       Use a plain indexed array or parallel files instead (see scripts/check-invariants.sh for the established pattern)."
        file_has_violation=1
    fi

    if echo "$code_only" | grep -qE '\bgrep\b[^|&;]*-[a-zA-Z]*P\b'; then
        echo "ERROR: $file uses \`grep -P\` (PCRE support) — BSD grep on macOS has no -P flag."
        echo "       Use \`grep -E\` with explicit alternation instead (see scripts/check-invariants.sh for the established pattern)."
        file_has_violation=1
    fi

    if echo "$code_only" | grep -qE '(^|[^a-zA-Z0-9_])coproc([^a-zA-Z0-9_]|$)'; then
        echo "ERROR: $file uses \`coproc\` (bash 4+ keyword) — not supported on macOS's bash 3.2."
        file_has_violation=1
    fi

    if echo "$code_only" | grep -qE '(^|[^a-zA-Z0-9_])(mapfile|readarray)([^a-zA-Z0-9_]|$)'; then
        echo "ERROR: $file uses \`mapfile\`/\`readarray\` (bash 4+ builtins) — not supported on macOS's bash 3.2."
        echo "       Use a while-read loop instead (see scripts/check-invariants.sh for the established pattern)."
        file_has_violation=1
    fi

    if [ "$file_has_violation" -eq 1 ]; then
        violations=$((violations + 1))
        violation_files+=("$file")
    fi
done < <(find scripts/ -name "*.sh" -type f ! -name "check-bash-portability.sh" 2>/dev/null)
# Self-excluded: this script's own error-message text necessarily names the
# constructs it detects (e.g. the literal string "declare -A" inside an echo
# string), which would otherwise self-trigger every run. Its own source is
# bash 3.2-compatible by construction (see the portability note above) and
# was verified once by manual reasoning, not by running this checker on
# itself.

echo ""
echo "=== Summary ==="
echo "Files with bash4+-only constructs: $violations"

if [ "$violations" -gt 0 ]; then
    echo ""
    echo "Violating files:"
    for f in "${violation_files[@]}"; do
        echo "  - $f"
    done
    exit 1
fi

echo "No bash4+-only constructs found in scripts/."
