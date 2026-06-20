#!/usr/bin/env bash
# Engineering invariant checks for opencode-swarm.
# Runs three grep-based checks corresponding to AGENTS.md invariants 3, 4, and 7.
# Compatible with GitHub Actions (ubuntu-latest, bash).
# NOTE: Requires GNU grep (uses -oP for Perl regex patterns).
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
  echo "ERROR: $ALLOWLIST_FILE not found — mock.module allowlist is required for Check 3"
  echo "       Run: scripts/generate-mock-allowlist.sh to regenerate, or manually add targets to $ALLOWLIST_FILE"
  violations=$((violations + 1))
else
  # Pre-load allowlist into associative array once so lookup is O(1) instead of O(N·M)
  declare -A allowlist
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    allowlist["$pattern"]=1
  done < "$ALLOWLIST_FILE"

  while IFS= read -r file; do
    # Filter: only non-comment lines containing mock.module(
    # This avoids false positives from commented-out code.
    active_lines=$(grep -E 'mock\.module\(' "$file" | grep -vE '^\s*//' | grep -vE '^\s*\*' || true)
    call_count=$(echo "$active_lines" | grep -cE 'mock\.module\(' || true)
    target_count=$(echo "$active_lines" | grep -oP 'mock\.module\(\s*["\x27][^"\x27]+["\x27]' | wc -l || true)
    if [ "$call_count" -ne "$target_count" ]; then
      echo "ERROR: $file has $call_count mock.module call(s) but only $target_count target(s) extracted."
      echo "       Multiline mock.module calls (target on a separate line from mock.module()) are not supported."
      echo "       Rewrite to single-line format: mock.module('target', () => ({ ... }))"
      echo "       The allowlist check cannot validate targets it cannot extract."
      violations=$((violations + 1))
      continue
    fi
    # Extract targets from the same filtered (non-comment) lines
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

      # O(1) lookup in pre-loaded associative array
      allowed=false
      if [[ ${allowlist["$normalized"]:-} == 1 ]]; then
        allowed=true
      fi

      if ! $allowed; then
        echo "ERROR: $file mocks '$target' (normalized: '$normalized') — not in allowlist."
        echo "       Use _internals DI seam, or run: scripts/generate-mock-allowlist.sh"
        violations=$((violations + 1))
      fi
    done < <(echo "$active_lines" \
      | grep -oP 'mock\.module\(\s*["\x27][^"\x27]+["\x27]' \
      | sed "s/^mock\.module(\s*[\"']//;s/[\"']$//" || true)
  done < <(grep -rl 'mock\.module(' tests/ src/ --include="*.test.ts" \
    --exclude-dir=node_modules --exclude-dir=dist || true)
fi

echo ""
echo "=== Summary ==="
if [ "$violations" -gt 0 ]; then
  echo "$violations invariant violation(s) found."
  exit 1
fi

echo "All engineering invariant checks passed."
