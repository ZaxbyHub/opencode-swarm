#!/usr/bin/env bash
# Generate the mock.module allowlist by scanning all test files.
# This script finds all mock.module calls, extracts targets, normalizes them,
# and outputs a sorted unique set to scripts/mock-allowlist.txt.
#
# Usage: scripts/generate-mock-allowlist.sh [--check]
# NOTE: Requires GNU grep (uses -oP for Perl regex patterns).

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"
ALLOWLIST_FILE="$SCRIPT_DIR/mock-allowlist.txt"
ALLOWLIST_DISPLAY="scripts/mock-allowlist.txt"
TEMP_ALLOWLIST="$(mktemp)"
TEMP_APPROVED="$(mktemp)"
trap "rm -f '$TEMP_ALLOWLIST' '$TEMP_APPROVED'" EXIT
: > "$TEMP_APPROVED"

# Load shared normalization routine
source "$SCRIPT_DIR/lib/normalize-mock-target.sh"

CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

echo "Scanning test files for mock.module calls..." >&2

# Extract and normalize all mock.module targets in one pass via the shared library.
# Normalization runs inside a single spawned bash process (reading stdin) to
# avoid fork-per-line overhead while keeping both scripts behaviorally identical.
grep -rh "mock\.module(" tests/ src/ \
  --include="*.test.ts" \
  --exclude-dir=node_modules \
  --exclude-dir=dist 2>/dev/null | \
  grep -vE '^\s*//' | grep -vE '^\s*\*' | \
  sed "s/.*mock\.module(\s*[\"']\([^\"']*\)[\"'].*/\1/" | \
  bash -c '
    source "$1/lib/normalize-mock-target.sh"
    while IFS= read -r target; do
      normalize_mock_target "$target"
    done
  ' _ "$SCRIPT_DIR" | sort -u > "$TEMP_ALLOWLIST"

if [ "$CHECK_MODE" = true ]; then
  # In check mode, compare the generated allowlist with the current one
  CURRENT_ENTRIES=$(sed '/^#/d; /^$/d' "$ALLOWLIST_FILE" 2>/dev/null | sort -u || echo "")
  GENERATED_ENTRIES=$(cat "$TEMP_ALLOWLIST")
  
  if [ "$CURRENT_ENTRIES" != "$GENERATED_ENTRIES" ]; then
    echo "ERROR: mock-allowlist.txt is out of sync with actual mock.module usage" >&2
    echo "Run: scripts/generate-mock-allowlist.sh (without --check) to regenerate" >&2
    exit 1
  fi
  echo "✓ mock-allowlist.txt is up-to-date" >&2
else
  # In normal mode, regenerate the allowlist with headers
  #
  # Issue #1666 — preserve existing # APPROVED-NEW: <target> marker lines
  # across regeneration. Without this, the documented workflow ("run this
  # script to update the list") would silently erase every approval marker
  # and re-open the gap that scripts/check-invariants.sh Check 4 closes.
  # Harvested targets are normalized via the shared library and de-duplicated
  # via `sort -u` (mirror the existing idiom at line 41, 45).
  approved_markers=()
  if [ -f "$ALLOWLIST_FILE" ]; then
    while IFS= read -r marker_line; do
      [ -n "$marker_line" ] || continue
      # Strip leading "# APPROVED-NEW:" and surrounding whitespace.
      target="$(echo "$marker_line" \
        | sed -E 's/^#[[:space:]]*APPROVED-NEW:[[:space:]]*//' \
        | sed -E 's/[[:space:]]*$//')"
      [ -n "$target" ] || continue
      approved_markers+=( "$(normalize_mock_target "$target")" )
    done < <(grep -E '^#[[:space:]]*APPROVED-NEW:[[:space:]]*' "$ALLOWLIST_FILE" || true)
  fi
  # De-duplicate (defensive — merge artifacts, copy-paste). Indexed array
  # from sorted unique input.
  # `${arr[@]+"${arr[@]}"}` is the bash-3.2-safe empty-array expansion
  # (issue #1922 PRR-011): the outer `${#...[@]} -gt 0` guard already
  # prevents entry when approved_markers is empty, but self-documenting
  # hardening is preferable to relying on the guard surviving future edits.
  if [ "${#approved_markers[@]}" -gt 0 ]; then
    printf '%s\n' ${approved_markers[@]+"${approved_markers[@]}"} | sort -u > "$TEMP_APPROVED"
  else
    : > "$TEMP_APPROVED"
  fi

  # Helper: emit a # APPROVED-NEW: marker line if the (already-normalized)
  # generated entry is in the harvested approved set. POSIX-bash portable:
  # plain file + grep -Fx (exact-line match, no regex interpolation).
  emit_marker_if_approved() {
    local entry="$1"
    if [ -s "$TEMP_APPROVED" ] && grep -qFx "$entry" "$TEMP_APPROVED"; then
      echo "# APPROVED-NEW: $entry"
    fi
  }

  {
    echo "# mock.module Allowlist — scripts/mock-allowlist.txt"
    echo "# One normalized target per line. Blank lines and # comments are ignored."
    echo "# EXACT match only — each target must be listed individually."
    echo "#"
    echo "# Normalization: strip leading ../ and ./ sequences -> replace with src/"
    echo "#                strip trailing .js"
    echo "# Example: '../../../src/plan/manager.js' -> 'src/plan/manager'"
    echo "#"
    echo "# To add a NEW mock target: append it here with a comment explaining why."
    echo "# Prefer _internals DI seam for new code — mock.module is a legacy pattern."
    echo "#"
    echo "# The allowlist is growth-ratcheted by scripts/check-invariants.sh Check 4"
    echo "# (issue #1666). To approve a new target added in a PR, add a standalone"
    echo "# marker line:  # APPROVED-NEW: <normalized-target>"
    echo "# The marker may appear anywhere in this file (flat set-membership, not"
    echo "# adjacency); convention places it immediately above the approved entry,"
    echo "# and this script preserves that placement across regeneration."
    echo "# Escape hatch for a deliberate growth PR: MOCK_ALLOWLIST_ENFORCE=0 (soft-warn)."
    echo "#"
    echo "# Last updated: $(date -u +'%Y-%m-%d') (normalization in scripts/lib/normalize-mock-target.sh)"
    echo ""

    # Node builtins section
    if grep -q '^node:' "$TEMP_ALLOWLIST"; then
      echo "# --- Node builtins ---"
      while IFS= read -r entry; do
        emit_marker_if_approved "$entry"
        echo "$entry"
      done < <(grep '^node:' "$TEMP_ALLOWLIST" | sort)
      echo ""
    fi

    # Group by directory (e.g., src/agents, src/tools, etc.)
    grep -v '^node:' "$TEMP_ALLOWLIST" | sed 's|/.*||' | sort -u | while read -r category; do
      [ -z "$category" ] && continue
      echo "# --- $category ---"
      while IFS= read -r entry; do
        emit_marker_if_approved "$entry"
        echo "$entry"
      done < <(grep "^$category/" "$TEMP_ALLOWLIST" | sort)
      echo ""
    done
  } > "$ALLOWLIST_FILE"

  ENTRY_COUNT=$(wc -l < "$TEMP_ALLOWLIST")
  echo "✓ Updated $ALLOWLIST_DISPLAY with $ENTRY_COUNT entries" >&2
fi
