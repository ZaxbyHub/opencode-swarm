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
#   - Associative arrays — `declare -A`/`typeset -A`/`local -A`/`readonly -A`
#     (and flag-combined forms like `declare -gA`), added in bash 4.0. All
#     four declaration keywords accept `-A`; catching only `declare -A` (the
#     original cycle 1 implementation) missed `local -A`/`typeset -A`, which
#     are equally common and equally broken on macOS's bash 3.2.
#   - `grep -P` / `grep -Po` / `grep --perl-regexp` — PCRE support; BSD grep
#     (macOS) has no -P flag at all, in any position or combination. Cycle 1's
#     `-[a-zA-Z]*P\b` required P to be the LAST flag character, missing
#     `-Po`/`-Pn`-style combinations where flags follow the P — verified via
#     reviewer's independent re-derivation during issue #1737 review.
#   - `coproc` — coprocess keyword, added in bash 4.0.
#   - `mapfile` / `readarray` — builtins added in bash 4.0 (synonyms).
#   - Empty-array `"${arr[@]}"` expansion under `set -u` when the array was
#     initialized empty (`arr=()`) earlier in the file. Under bash 3.2 this
#     aborts with "unbound variable"; fixed in bash 4.4 (Debian #529627,
#     ShellCheck #2387). Issue #1922 PRR-001/002/011 — this exact class killed
#     macOS CI for the Check 4 ratchet. The fix is the `${arr[@]+"${arr[@]}"}`
#     alternate-value expansion. The detector only flags arrays with a visible
#     `name=()` empty-init earlier in the file (not arrays that are always
#     populated by construction — those cannot trip the bug).
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

    if echo "$code_only" | grep -qE '\b(declare|typeset|local|readonly)\b[[:space:]]+-[a-zA-Z]*A[a-zA-Z]*\b'; then
        echo "ERROR: $file uses an associative array (declare/typeset/local/readonly -A) — bash 4+ only, not supported on macOS's bash 3.2."
        echo "       Use a plain indexed array or parallel files instead (see scripts/check-invariants.sh for the established pattern)."
        file_has_violation=1
    fi

    if echo "$code_only" | grep -qE '\bgrep\b[^|&;]*(-[a-zA-Z]*P[a-zA-Z]*\b|--perl-regexp\b)'; then
        echo "ERROR: $file uses \`grep -P\`/PCRE mode (any flag combination, or --perl-regexp) — BSD grep on macOS has no -P support at all."
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

    # Empty-array expansion under `set -u` (issue #1922 PRR-001/002/011).
    # Under bash 3.2 + `set -u`, `"${arr[@]}"` over a declared-but-empty
    # array aborts with "unbound variable" (Debian #529627, ShellCheck #2387).
    # Heuristic: scan only scripts that use `set -.*u`, and within those,
    # for each `name=()` empty-init declaration, flag any later bare
    # `"${name[@]}"` expansion NOT guarded by the `${name[@]+...}` form.
    # This avoids false-positives on arrays always populated by construction
    # (e.g. `PAIRS=(a b c)` then `for x in "${PAIRS[@]}"`).
    if echo "$code_only" | grep -qE '(^|[[:space:]])set[[:space:]]+-[^-]*u|(^|[[:space:]])set[[:space:]]+-[^-]*[eu][^-]*u'; then
        # Find empty-init array names: lines like `name=()` or `local name=()`.
        # Use grep -oE to extract the name; bash identifier charset is [A-Za-z_][A-Za-z0-9_]*.
        empty_init_names="$(echo "$code_only" | grep -E '^[[:space:]]*(local[[:space:]]+|readonly[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=\([[:space:]]*\)' | sed -E 's/^[[:space:]]*(local[[:space:]]+|readonly[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/' | sort -u || true)"
        if [ -n "$empty_init_names" ]; then
            while IFS= read -r arr_name; do
                [ -n "$arr_name" ] || continue
                # Match a BARE `"${arr_name[@]}"` (not the guarded `${arr_name[@]+"${arr_name[@]}"}`).
                # The negative-lookbehind on `${arr_name[@]+` is approximated by
                # searching for the bare pattern and then excluding lines that
                # contain the guarded pattern.
                bare_hits="$(echo "$code_only" | grep -F "\"\${${arr_name}[@]}\"" || true)"
                guarded_hits="$(echo "$code_only" | grep -F "\${${arr_name}[@]+\"\${${arr_name}[@]}\"}" || true)"
                # Remove any line that appears in guarded_hits from bare_hits.
                # (Line-by-line set difference via grep -Fxv.)
                unguarded="$(echo "$bare_hits" | grep -Fxvf <(printf '%s\n' "$guarded_hits") || true)"
                if [ -n "$unguarded" ]; then
                    echo "ERROR: $file expands \"\${${arr_name}[@]}\" under \`set -u\` but ${arr_name}=() is initialized empty somewhere in the file."
                    echo "       Under bash 3.2 (macOS) this aborts with 'unbound variable' when ${arr_name} is empty (fixed in bash 4.4)."
                    echo "       Use the alternate-value form: \${${arr_name}[@]+\"\${${arr_name}[@]}\"}"
                    file_has_violation=1
                fi
            done <<< "$empty_init_names"
        fi
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
