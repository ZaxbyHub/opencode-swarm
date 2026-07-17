#!/usr/bin/env bash
# scan-deferred.sh — Full-Resolution Contract clause 2 gate (issue-tracer).
#
# Fails (exit 1) if the diff since the default branch introduces deferred-work
# markers on ADDED lines. Portable: resolves the default branch, scans committed
# and uncommitted work relative to the merge-base, and prints every hit so it can
# be eliminated or dispositioned.
#
# Usage:
#   scan-deferred.sh [base-ref]
# If base-ref is omitted, it is resolved from origin/HEAD, then origin/main,
# origin/master, main, master (first that exists wins).
set -eu

base="${1:-}"

if [ -z "$base" ]; then
  if base_ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"; then
    base="origin/${base_ref#refs/remotes/origin/}"
  fi
fi

if [ -z "$base" ]; then
  for cand in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$cand" >/dev/null 2>&1; then
      base="$cand"
      break
    fi
  done
fi

if [ -z "$base" ]; then
  echo "scan-deferred: could not resolve a base branch; pass one explicitly:" >&2
  echo "  scan-deferred.sh <base-ref>" >&2
  exit 2
fi

# Compare the merge-base to the working tree so committed AND uncommitted
# changes are scanned. Fall back to the base tip if merge-base is unavailable.
mb="$(git merge-base "$base" HEAD 2>/dev/null || echo "$base")"

# Deferred-work markers on added lines only.
pattern='^\+.*(TODO|FIXME|XXX|HACK|NotImplemented|raise NotImplementedError|unimplemented!|todo!)'

hits="$(git diff "$mb" | grep -nE "$pattern" || true)"

if [ -n "$hits" ]; then
  echo "scan-deferred: deferred-work markers found on added lines (base=$base):" >&2
  printf '%s\n' "$hits" >&2
  echo "" >&2
  echo "Eliminate each hit, or disposition it FALSE_POSITIVE in writing when it is" >&2
  echo "non-production content (fixtures, docs quoting, test data). Production hits" >&2
  echo "are always eliminate-or-waiver." >&2
  exit 1
fi

echo "scan-deferred: clean (base=$base) — no deferred-work markers on added lines."
exit 0
