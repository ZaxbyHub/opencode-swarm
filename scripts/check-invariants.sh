#!/usr/bin/env bash
# Engineering invariant checks for opencode-swarm.
# Runs five static checks corresponding to AGENTS.md invariants 3, 4, and 7
# (Checks 1-3, grep-based), the mock.module allowlist growth ratchet from issue
# #1666 (Check 4, grep-based), and the knowledge-array dedup guardrail from
# issue #1821 Lane 0b (Check 5, a small POSIX awk pass — it must see across
# lines, which grep cannot do portably).
# Compatible with GitHub Actions (ubuntu-latest AND macos-latest, bash).
# Portability constraints (issue #1729 merge_group macOS failures):
#   - macOS ships bash 3.2 as /bin/bash: NO associative arrays (`declare -A`),
#     NO `[[ ${arr["x"]} ]]` subscript syntax. Use plain files + grep -Fxf.
#   - BSD grep does NOT support `-P` (Perl regex) or `\x27`. Use `grep -Eo`
#     with explicit `'...'`/`"..."` alternation instead.
#   - Empty-array expansion under `set -u`: bash 3.2 errors on
#     `"${arr[@]}"` when `arr` is declared but empty (fixed in bash 4.4;
#     Debian #529627, ShellCheck #2387). Use the `${arr[@]+"${arr[@]}"}`
#     alternate-value pattern at every site where the array could be empty.
#     scripts/check-bash-portability.sh enforces this.
set -euo pipefail

# Load shared normalization routine
source "$(dirname "$0")/lib/normalize-mock-target.sh"

violations=0

echo "=== Check 1: Subprocess timeout required (advisory) ==="
# NOTE: This check is FILE-level — it verifies that any file using spawn/spawnSync
# also contains timeout/timeoutMs SOMEWHERE in the file. This is intentionally loose
# because call-level analysis from bash is unreliable. For precise enforcement, use
# the tree-sitter-based AST checks in the build pipeline or rely on code review.
# Violations here are WARNINGS, not hard failures.
timeout_warnings=0
while IFS= read -r file; do
  # Exempt the Bun compatibility layer — allowed to use Bun.spawn without timeout
  basename_file="$(basename "$file")"
  if [[ "$basename_file" == "bun-compat.ts" ]]; then
    continue
  fi
  has_timeout=$(grep -cE "timeout:|timeoutMs" "$file" || true)
  if [ "$has_timeout" -eq 0 ]; then
    echo "WARNING: $file uses spawn/spawnSync but has no timeout property in file"
    timeout_warnings=$((timeout_warnings + 1))
  fi
done < <(grep -rl --include="*.ts" -E '\bspawnSync\(|\bspawn\(' src/ \
  --exclude="*.test.ts" --exclude="*.d.ts" \
  --exclude-dir=node_modules --exclude-dir=dist || true)
if [ "$timeout_warnings" -gt 0 ]; then
  echo "  ($timeout_warnings file(s) have spawn/spawnSync but no timeout — advisory, not blocking)"
fi

echo "=== Check 2: process.cwd() ban in tools/hooks ==="
# Grep for process.cwd() in src/tools/ and src/hooks/ (excluding test files).
# Exempt known legacy usages — these predate the ctx.directory convention and
# are wrapped in explicit fallback patterns (cwd ?? process.cwd()).
# LEGACY_EXEMPTS — full file paths matched by exact equality (not substring).
# Adding a substring-style entry (e.g., "guardrails" to match
# "src/hooks/guardrails.ts") will silently fail to exempt.
LEGACY_EXEMPTS=(
  "src/tools/create-tool.ts"
  "src/tools/test-runner.ts"
  "src/tools/resolve-working-directory.ts"
  "src/tools/save-plan.ts"
  "src/tools/sbom-generate.ts"
  "src/hooks/guardrails.ts"
  "src/hooks/guardrails/file-authority.ts"
  "src/hooks/guardrails/helpers.ts"
  "src/hooks/guardrails/index.ts"
  "src/hooks/scope-guard.ts"
)
while IFS= read -r file; do
  exempt=false
  for legacy in "${LEGACY_EXEMPTS[@]}"; do
    if [[ "$file" == "$legacy" ]]; then
      exempt=true
      break
    fi
  done
  if $exempt; then
    continue
  fi
  # Comment-blind matching would fail CI on CORRECT code: a file documenting
  # "ctx.directory is injected; there is no process.cwd() here" is exactly the
  # kind of file that mentions the banned call in prose. Strip line comments and
  # block-comment bodies before deciding, then re-check for a real call. Same
  # false-positive class Check 5 handles (issue #1821).
  if ! sed -e 's://.*::' -e 's:^[[:space:]]*\*.*::' -e 's:/\*.*\*/::' "$file" \
    | grep -q 'process\.cwd()'; then
    continue
  fi
  echo "ERROR: $file uses process.cwd() — tools must use ctx.directory via resolveWorkingDirectory"
  violations=$((violations + 1))
done < <(grep -rl --include="*.ts" 'process\.cwd()' src/tools/ src/hooks/ \
  --exclude="*.test.ts" \
  --exclude-dir=node_modules --exclude-dir=dist || true)

echo "=== Check 3: mock.module allowlist ==="
# Find all test files using mock.module( and validate each target is in the allowlist.
# The allowlist is stored in scripts/mock-allowlist.txt — one normalized target per line.
# To add a new mock target: add it to scripts/mock-allowlist.txt with a comment explaining why.
ALLOWLIST_FILE="$(dirname "$0")/mock-allowlist.txt"
if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "ERROR: $ALLOWLIST_FILE not found — mock.module allowlist is required for Check 3" >&2
  echo "       Run: scripts/generate-mock-allowlist.sh to regenerate, or manually add targets to $ALLOWLIST_FILE" >&2
  violations=$((violations + 1))
else
  # Load the allowlist into a plain bash INDEXED array (NOT `declare -A`,
  # which requires bash 4.0+; macOS ships bash 3.2 as /bin/bash and aborts
  # under `set -euo pipefail` at the declaration — issue #1729 merge_group:
  # macOS printed only the Check headers then died). Indexed arrays + linear
  # scan are portable to bash 3.2 and the allowlist is small (~110 entries).
  allowlist_patterns=()
  while IFS= read -r pattern; do
    case "$pattern" in
      ''|\#*) continue ;;
    esac
    allowlist_patterns+=( "$pattern" )
  done < "$ALLOWLIST_FILE"

  allowlist_contains() {
    # Linear scan; portable to bash 3.2 (no associative arrays).
    # `${arr[@]+"${arr[@]}"}` is the bash-3.2-safe empty-array expansion
    # (issue #1922 PRR-011): allowlist_patterns is initialized empty at
    # line 99 and could legitimately be empty if the allowlist file is
    # comment-only, which would trip `set -u` on macOS bash 3.2.
    local needle="$1"
    for p in ${allowlist_patterns[@]+"${allowlist_patterns[@]}"}; do
      [ "$p" = "$needle" ] && return 0
    done
    return 1
  }

  while IFS= read -r file; do
    # Filter: only non-comment lines containing mock.module(
    # This avoids false positives from commented-out code.
    active_lines=$(grep -E 'mock\.module\(' "$file" | grep -vE '^[[:space:]]*//' | grep -vE '^[[:space:]]*\*' || true)
    call_count=$(echo "$active_lines" | grep -cE 'mock\.module\(' || true)
    # POSIX-portable extraction of mock.module('target' / mock.module("target".
    # The previous form used `grep -oP 'mock\.module\(\s*["\x27][^"\x27]+["\x27]'`
    # which requires Perl regex (BSD grep on macOS does not support -P or \x27).
    # Replace with an explicit single/double-quote alternation under grep -Eo.
    target_count=$(echo "$active_lines" \
      | grep -Eo "mock\.module\([[:space:]]*'[^']+'|mock\.module\([[:space:]]*\"[^\"]+\"" \
      | wc -l | tr -d ' ' || true)
    if [ "$call_count" -ne "$target_count" ]; then
      echo "ERROR: $file has $call_count mock.module call(s) but only $target_count target(s) extracted."
      echo "       Multiline mock.module calls (target on a separate line from mock.module()) are not supported."
      echo "       Rewrite to single-line format: mock.module('target', () => ({ ... }))"
      echo "       The allowlist check cannot validate targets it cannot extract."
      violations=$((violations + 1))
      continue
    fi
    # Extract targets from the same filtered (non-comment) lines.
    # POSIX-portable: emit the mock.module('target' / mock.module("target"
    # spans via grep -Eo, then strip the mock.module( prefix and the
    # surrounding quotes with sed. The previous grep -oP form (Perl regex)
    # is replaced with an explicit quote alternation for BSD grep on macOS.
    while IFS= read -r target; do
      # Skip empty lines
      [ -n "$target" ] || continue

      # Normalize: strip leading ../ and ./ segments, then leading src/, then .js extension
      # ../../../src/plan/manager.js -> src/plan/manager
      # ../../src/tools/co-change-analyzer.js -> src/tools/co-change-analyzer
      # ../../../src/tools/../tools/bar.js -> src/tools/bar (handles middle ..)
      # ./ledger -> ledger (handles relative imports in same dir)
      # node:child_process -> node:child_process (unchanged)
      normalized="$(normalize_mock_target "$target")"

      if allowlist_contains "$normalized"; then
        allowed=true
      else
        allowed=false
      fi

      if ! $allowed; then
        echo "ERROR: $file mocks '$target' (normalized: '$normalized') — not in allowlist."
        echo "       Use _internals DI seam, or run: scripts/generate-mock-allowlist.sh"
        violations=$((violations + 1))
      fi
    # Extract targets from the same filtered (non-comment) lines.
    # POSIX-portable: emit the mock.module('target' / mock.module("target"
    # spans via grep -Eo, then strip the mock.module( prefix and the
    # surrounding quotes with sed. The previous grep -oP form (Perl regex)
    # is replaced with an explicit quote alternation for BSD grep on macOS.
    done < <(echo "$active_lines" \
      | grep -Eo "mock\.module\([[:space:]]*'[^']+'|mock\.module\([[:space:]]*\"[^\"]]+\"" \
      | sed -E "s/^mock\.module\([[:space:]]*//; s/^'([^']+)'$/\1/; s/^\"([^\"]+)\"$/\1/" || true)
  done < <(grep -rl 'mock\.module(' tests/ src/ --include="*.test.ts" \
    --exclude-dir=node_modules --exclude-dir=dist || true)
fi

echo ""
echo "=== Check 4: mock.module allowlist growth ratchet (issue #1666) ==="
# Diff-scoped ratchet: fails CI when scripts/mock-allowlist.txt grows relative
# to the PR base, unless each newly added target has a matching standalone
# marker line  # APPROVED-NEW: <normalized-target>  somewhere in the file.
# Mirrors scripts/check-test-file-cap.sh's diff-scoped shape and the
# MOCK_ALLOWLIST_ENFORCE truth table (default-enforce-when-unset, like
# TEST_CAP_ENFORCE). Closes the remaining open item of issue #1666: the
# membership check (Check 3) cannot detect growth when the allowlist is
# regenerated via scripts/generate-mock-allowlist.sh.
ratchet_violations=0

# --- MOCK_ALLOWLIST_ENFORCE truth table (mirrors TEST_CAP_ENFORCE) ---
# unset OR any value other than 0/false/no/off → hard-fail (default enforce).
# 0/false/no/off → soft-warn (exit 0). The ratchet is scoped to *new* entries
# only (set-difference against the PR base), so defaulting to enforce in CI
# (where the var is unset) is correct.
if [ -z "${MOCK_ALLOWLIST_ENFORCE+x}" ]; then
  ratchet_enforce=1  # unset → enforce (mirror check-test-file-cap.sh:46)
else
  case "$(echo "${MOCK_ALLOWLIST_ENFORCE}" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) ratchet_enforce=0;;
    *) ratchet_enforce=1;;
  esac
fi

# --- Resolve base branch (mirror check-test-file-cap.sh:69-76) ---
ratchet_base_branch=""
for branch in origin/main origin/master main master; do
  if git rev-parse "$branch" >/dev/null 2>&1; then
    ratchet_base_branch="$branch"
    break
  fi
done

# Allowlist file path is already set at Check 3 (line 82). Re-resolve in case
# Check 3 was skipped because the file was missing (in which case there is
# nothing to ratchet anyway).
if [ -z "${ALLOWLIST_FILE:-}" ]; then
  ALLOWLIST_FILE="$(dirname "$0")/mock-allowlist.txt"
fi

if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "NOTE: $ALLOWLIST_FILE not found — Check 4 skipped (Check 3 already flagged this)."
elif [ -z "$ratchet_base_branch" ]; then
  # No PR context (local-dev run without origin/main fetched). Mirror
  # check-test-tmpdir.sh:55-58: skip non-blocking rather than false-failing.
  echo "NOTE: no base branch found (no PR context) — skipping Check 4 (non-blocking)."
  echo "      Run from a checkout with origin/main fetched to enable the growth ratchet."
else
  # --- Read head entries from the working-tree allowlist ---
  # `tr -d '\r'` normalizes CRLF→LF so a Windows contributor with
  # core.autocrlf=true does not false-trigger "every entry is new" (issue
  # #1781 re-critic B6 — same landmine as check-test-file-cap.sh:102).
  head_entries=()
  while IFS= read -r pattern; do
    case "$pattern" in
      ''|\#*) continue ;;
    esac
    head_entries+=( "$pattern" )
  done < <(tr -d '\r' < "$ALLOWLIST_FILE")

  # --- Read base entries from the PR base via `git show` ---
  # `git show <ref>:<path>` bypasses the smudge filter and always returns LF
  # content, but we still pipe through `tr -d '\r'` for symmetry/defense.
  # If the path is missing at base (allowlist newly added in this PR — not
  # realistic today but defensive), treat base as empty: everything is "new".
  base_entries=()
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    case "$pattern" in
      ''|\#*) continue ;;
    esac
    base_entries+=( "$pattern" )
  done < <(git show "${ratchet_base_branch}:scripts/mock-allowlist.txt" 2>/dev/null \
    | tr -d '\r' || true)

  # --- Linear-scan membership helper (bash 3.2 portable, mirrors
  # allowlist_contains at line 101-108) ---
  array_contains() {
    local needle="$1"
    shift
    for entry in "$@"; do
      [ "$entry" = "$needle" ] && return 0
    done
    return 1
  }

  # --- Compute added set: head entries not present at base ---
  added_entries=()
  # Bash 3.2 + `set -u` portability (issue #1922 PRR-001/002/011, macOS CI):
  # under bash 3.2 (macOS system bash), iterating `"${arr[@]}"` over a
  # declared-but-empty array aborts with "unbound variable" (fixed in bash
  # 4.4). The `${arr[@]+"${arr[@]}"}` alternate-value pattern expands to
  # nothing when the array is empty and to the array otherwise, on every
  # bash version back to 2.x. Apply at every empty-possible expansion site.
  for h in ${head_entries[@]+"${head_entries[@]}"}; do
    if ! array_contains "$h" ${base_entries[@]+"${base_entries[@]}"}; then
      added_entries+=( "$h" )
    fi
  done

  # --- Read approved markers from the working-tree allowlist ---
  # Marker format (standalone line only):  # APPROVED-NEW: <normalized-target>
  # We grep the prefix, strip it, normalize the target via
  # normalize_mock_target (already sourced at line 13), and linear-scan
  # compare. No regex interpolation of the target — the allowlist already
  # contains entries with regex metacharacters (e.g. src/config/index.ts).
  approved_markers=()
  while IFS= read -r marker_line; do
    [ -n "$marker_line" ] || continue
    # Strip the leading "# APPROVED-NEW:" and surrounding whitespace.
    target="$(echo "$marker_line" \
      | sed -E 's/^#[[:space:]]*APPROVED-NEW:[[:space:]]*//' \
      | sed -E 's/[[:space:]]*$//')"
    [ -n "$target" ] || continue
    approved_markers+=( "$(normalize_mock_target "$target")" )
  done < <(grep -E '^#[[:space:]]*APPROVED-NEW:[[:space:]]*' "$ALLOWLIST_FILE" || true)

  # --- For each added entry, require a matching approved marker ---
  # Only increment the script-level `violations` counter when enforce is on.
  # In soft-warn mode we still report each violation but do not fail the build
  # (mirrors check-test-file-cap.sh:161-169's exit-decision gating).
  for added in ${added_entries[@]+"${added_entries[@]}"}; do
    if array_contains "$added" ${approved_markers[@]+"${approved_markers[@]}"}; then
      continue
    fi
    echo "ERROR (ratchet): new mock target '$added' added to scripts/mock-allowlist.txt without approval."
    echo "       Add a standalone marker line:  # APPROVED-NEW: $added"
    echo "       OR remove the target and use the _internals DI seam instead (AGENTS.md invariant 7)."
    ratchet_violations=$((ratchet_violations + 1))
    if [ "$ratchet_enforce" -eq 1 ]; then
      violations=$((violations + 1))
    fi
  done

  # --- Summary line (per-PR annotation-style) ---
  echo "Base entries: ${#base_entries[@]} | Head entries: ${#head_entries[@]} | Added in this PR: ${#added_entries[@]} | Approved-new markers found: ${#approved_markers[@]} | Unapproved: $ratchet_violations"
  if [ "$ratchet_violations" -gt 0 ] && [ "$ratchet_enforce" -eq 0 ]; then
    echo "MOCK_ALLOWLIST_ENFORCE is off — soft-warn (non-blocking)."
  fi
fi

echo ""
echo "=== Check 5: knowledge array dedup guardrail (issue #1821 Lane 0b) ==="
# A positional `.slice(0, 20)` on a knowledge array field keeps the FIRST 20
# items without deduplicating: duplicates survive AND, because the cap is
# positional, a run of duplicates evicts distinct values off the end. The class
# recurred at six call sites (knowledge-add tags + actionability arrays,
# knowledge-curator insight tags, micro-reflector candidate fields, curator
# arrayOfStrings + evidence_refs). All six now route through `dedupeCapped()`
# in src/hooks/knowledge-store.ts, which orders truncate -> dedupe -> cap.
#
# The expected match count is ZERO and there is deliberately NO exempt list: a
# new match is a new instance of the defect, not pre-existing debt. Scope is
# limited to the knowledge parse/write surface where the class lives.
#
# MULTI-LINE AWARE, deliberately. A line-anchored grep would be blind to the
# form Biome actually emits once the receiver expression is long enough:
#
#     ).slice(
#         0,
#         20,
#     )
#
# Eight such wrapped `.slice(` calls already exist inside the scanned files, so
# reintroducing the defect on any long expression would defeat a grep-only
# check. Instead a small awk pass anchors on each line containing `.slice(`,
# joins it with the next three lines of CODE, strips whitespace and a trailing
# comma before `)`, and matches the literal `.slice(0,20)`. `index()` is used
# rather than a regex so no metacharacter escaping is involved. awk is POSIX
# and present on every supported runner; no bash-4 or GNU-only construct is
# used.
#
# COMMENTS ARE STRIPPED FROM THE WHOLE WINDOW, not just the anchor line. These
# files necessarily discuss the banned pattern in prose, so a naive window join
# both false-POSITIVES (a `.slice(` wrapped over two lines followed by a comment
# that mentions `.slice(0, 20)`) and false-NEGATIVES (a genuine violation with a
# comment or blank line between its arguments). Comment-only and blank lines are
# skipped when filling the window and trailing `// …` text is dropped, which
# closes both.
#
# Colocated *.test.ts files matching the globs (e.g.
# src/tools/knowledge-tools.integration.test.ts) are skipped by path, not by a
# text filter, so a violating line whose own text mentions ".test.ts:" is still
# reported.
#
# Known residual blind spots (accepted; this is a recurrence tripwire, not a
# type system): a cap written as a named constant (`.slice(0, TAG_CAP)`), a
# different constant (`.slice(0, 50)`), a receiver split so wide that `20,`
# falls outside the 3-code-line window, and files outside the four globs.
#
# The scope is also ASSERTED: if a glob or literal path resolves to nothing
# (file renamed or deleted), that is a hard error rather than a silent drop to
# zero coverage while still printing "expected 0".
KNOWLEDGE_DEDUP_SCOPE="src/tools/knowledge-*.ts src/hooks/knowledge-*.ts src/hooks/curator.ts src/hooks/micro-reflector.ts"
slice_violations=0
slice_scanned=0
for scoped_file in $KNOWLEDGE_DEDUP_SCOPE; do
  case "$scoped_file" in
    *.test.ts) continue ;;
  esac
  if [ ! -f "$scoped_file" ]; then
    echo "ERROR: Check 5 scope entry '$scoped_file' resolved to no file."
    echo "       The guardrail would silently scan less than it claims."
    echo "       Update KNOWLEDGE_DEDUP_SCOPE in $0 after the rename/deletion."
    violations=$((violations + 1))
    continue
  fi
  slice_scanned=$((slice_scanned + 1))
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    echo "ERROR: $hit"
    echo "       Positional .slice(0, 20) with no dedup on a knowledge array field."
    echo "       Use dedupeCapped(values, { cap: 20 }) from src/hooks/knowledge-store.ts"
    echo "       (add itemMaxChars when the site also truncates each item)."
    slice_violations=$((slice_violations + 1))
    violations=$((violations + 1))
  done < <(awk '
    function code_of(s) { sub(/\/\/.*$/, "", s); return s }
    function is_comment(s) { return (s ~ /^[ \t]*(\/\/|\*|\/\*)/) }
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (is_comment(line[i])) continue
        anchor = code_of(line[i])
        if (index(anchor, ".slice(") == 0) continue
        joined = anchor
        taken = 0
        for (k = i + 1; k <= NR && taken < 3; k++) {
          if (is_comment(line[k])) continue
          piece = code_of(line[k])
          gsub(/[ \t]/, "", piece)
          if (piece == "") continue
          joined = joined piece
          taken++
        }
        gsub(/[ \t]/, "", joined)
        gsub(/,\)/, ")", joined)
        if (index(joined, ".slice(0,20)") > 0) {
          printf "%s:%d:%s\n", FILENAME, i, line[i]
        }
      }
    }
  ' "$scoped_file" || true)
done
echo "Scope: $KNOWLEDGE_DEDUP_SCOPE"
echo "Files scanned: $slice_scanned"
echo "Unguarded positional caps: $slice_violations (expected 0 — no exempt list by design)"

echo ""
echo "=== Summary ==="
echo "Checks run: 1 (subprocess timeout, advisory) | 2 (process.cwd ban) |"
echo "            3 (mock.module allowlist) | 4 (allowlist growth ratchet) |"
echo "            5 (knowledge array dedup guardrail)"
if [ "$violations" -gt 0 ]; then
  echo "$violations invariant violation(s) found."
  exit 1
fi

echo "All engineering invariant checks passed."
