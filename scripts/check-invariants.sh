#!/usr/bin/env bash
# Engineering invariant checks for opencode-swarm.
# Runs three grep-based checks corresponding to AGENTS.md invariants 3, 4, and 7.
# Compatible with GitHub Actions (ubuntu-latest, bash).
set -euo pipefail

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
  if [[ "$file" == *"bun-compat.ts" ]]; then
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
LEGACY_EXEMPTS=(
  "src/tools/create-tool.ts"
  "src/tools/test-runner.ts"
  "src/tools/resolve-working-directory.ts"
  "src/tools/save-plan.ts"
  "src/tools/sbom-generate.ts"
  "src/hooks/guardrails.ts"
  "src/hooks/scope-guard.ts"
)
while IFS= read -r file; do
  exempt=false
  for legacy in "${LEGACY_EXEMPTS[@]}"; do
    if [[ "$file" == *"$legacy" ]]; then
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
  echo "       To add a new mock target: append the normalized target to $ALLOWLIST_FILE with a comment"
  violations=$((violations + 1))
else
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

      # Normalize: strip all ../ segments, then leading src/, then .js extension
      # ../../../src/plan/manager.js -> src/plan/manager
      # ../../src/tools/co-change-analyzer.js -> src/tools/co-change-analyzer
      # node:child_process -> node:child_process (unchanged)
      normalized="$(echo "$target" | sed 's|^\(\.\.\/\)\+||; s|^src/||; s|\.js$||')"
      # Prepend src/ only for relative targets (not node: builtins)
      if [[ "$normalized" != node:* ]]; then
        normalized="src/$normalized"
      fi

      # Check against allowlist (exact match on normalized target)
      allowed=false
      while IFS= read -r pattern; do
        # Skip empty lines and comments in allowlist
        [[ -z "$pattern" || "$pattern" == \#* ]] && continue
        if [ "$normalized" = "$pattern" ]; then
          allowed=true
          break
        fi
      done < "$ALLOWLIST_FILE"

      if ! $allowed; then
        echo "ERROR: $file mocks '$target' (normalized: '$normalized') — not in allowlist."
        echo "       Use _internals DI seam, or add '$normalized' to $ALLOWLIST_FILE"
        violations=$((violations + 1))
      fi
    done < <(echo "$active_lines" \
      | grep -oP 'mock\.module\(\s*["\x27][^"\x27]+["\x27]' \
      | sed "s/^mock\.module(\s*[\"']//;s/[\"']$//" || true)
  done < <(grep -rl 'mock\.module(' tests/ --include="*.test.ts" \
    --exclude-dir=node_modules --exclude-dir=dist || true)
fi

echo ""
echo "=== Summary ==="
if [ "$violations" -gt 0 ]; then
  echo "$violations invariant violation(s) found."
  exit 1
fi

echo "All engineering invariant checks passed."
