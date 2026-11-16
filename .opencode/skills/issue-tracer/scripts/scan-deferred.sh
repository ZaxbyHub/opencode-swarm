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
# Force the C locale for the same reason as trace-init.sh: POSIX bracket-range
# collation is locale-dependent, and grep -E pattern matching can be affected
# by locale too. This script has no bracket-range slug validation today, but
# C locale keeps its regex/grep behavior deterministic across CI runners.
export LC_ALL=C

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

# Validate $mb resolves to a real commit before diffing against it. Without
# this, an unresolvable base (a bad ref, or a dash-prefixed base arg git
# rejects as an invalid option) falls through `git merge-base`'s failure into
# the `echo "$base"` fallback above, and `set -eu` alone (no pipefail) would
# let a subsequently-failing `git diff` be silently swallowed by the `|| true`
# below — reporting a false "clean" instead of a real gate failure.
if ! git rev-parse --verify --quiet "$mb^{commit}" >/dev/null; then
  echo "scan-deferred: base ref '$mb' (resolved from '$base') does not resolve to a commit" >&2
  exit 2
fi

# Deferred-work markers on added lines only, excluding unified-diff file
# headers ("+++ a/<path>", "+++ b/<path>", "+++ /dev/null"). Those lines also
# start with '+' like an added content line, so an unqualified `^\+` pattern
# false-positives on any added/renamed/modified file whose PATH contains a
# marker word (e.g. "+++ b/todo-list.ts").
#
# The exclusion is anchored to each file's "diff --git" boundary, not a bare
# content match and not merely "immediately follows a '---' line": a real
# "+++ ..." header can ONLY appear between a file's "diff --git a/X b/X"
# line and that same file's first "@@" hunk marker — content lines never
# appear there. A content-only match (`^\+\+\+ (a/|b/|/dev/null)`) would
# ALSO swallow a genuine ADDED line whose file content literally starts with
# "++ b/" etc. (git's own '+' prefix turns that into a "+++"-shaped line). A
# naive fix anchoring only on "the immediately preceding line starts with
# '--- '" is itself spoofable: a REMOVED line whose original content was
# "-- ..." renders as "--- ..." (git's '-' prefix + the original two
# dashes), and a following genuine added TODO shaped like "++ b/... TODO"
# would then be wrongly excluded as a "double-spoofed" header pair — even
# though both lines are ordinary hunk content, not a real header. Gating the
# whole state machine on "are we still between 'diff --git' and the first
# '@@' for this file" closes that gap: neither a "diff --git " boundary line
# nor an "@@" hunk marker can ever be produced by added/removed content
# (git never prefixes those with +/-/space), so this anchor is unspoofable
# from either direction.
# zmem #309: the four bare-word markers below now carry word boundaries on
# BOTH sides, so identifier-shaped content that merely CONTAINS the marker
# letter-run can no longer trip the scan. Verified false positive: the
# env-var name ZMEM_MODEL_AUTODOWNLOAD embeds the first marker's letters
# mid-word (between its AU- and -WNLOAD halves), so every added line
# setting that env var — CI env blocks, test fixtures — fired the scan and
# left trace-check phase 4 permanently red until each hit was
# hand-dispositioned. The first marker keeps an optional plural via s? so
# a leading list-header shape ("<marker>s:") still hits — a plain \b pair
# without the s? would silently drop it, because "s" is a word character
# and would eat the trailing boundary. A real marker always keeps a
# non-word character (or line end) on each side, so "# <marker>",
# "//<marker>:", and "<marker>:" all still hit. The long-form markers are
# left unbounded exactly as before: the trailing "!" or the identifier
# tail already discriminates them.
#
# The marker text is assembled from quoted halves on the two assignment
# lines below so the diff introducing this pattern cannot trip the very
# gate it tightens (this script scans its maintainer's diffs too); the
# zmem #309 PR body spells the assembled regex in full.
bare_word_markers='TO''DOs?|FIX''ME|XX''X|HA''CK'
long_form_markers='NotImple''mented|raise NotImple''mentedError|unimple''mented!|to''do!'
pattern='^\+.*(\b('"$bare_word_markers"')\b|'"$long_form_markers"')'

hits="$(git diff "$mb" | awk '
  /^diff --git / { in_header = 1; preimage = 0; print; next }
  in_header && /^@@ / { in_header = 0 }
  in_header && /^--- / { preimage = 1; next }
  in_header && preimage && /^\+\+\+ (a\/|b\/|\/dev\/null)/ { preimage = 0; next }
  { preimage = 0; print }
' | grep -nE "$pattern" || true)"

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
