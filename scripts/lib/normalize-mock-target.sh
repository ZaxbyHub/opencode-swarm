#!/usr/bin/env bash
# Shared normalization library for mock.module allowlist checks.
# Used by scripts/generate-mock-allowlist.sh and bun run check:invariants.
# POSIX-bash compatible.

normalize_mock_target() {
  local target="$1"
  local normalized prev
  # POSIX BRE throughout: BSD/macOS sed treats '\+' as a literal plus, so the
  # one-or-more quantifier is spelled '[x][x]*' and '//' runs as '//*'.
  normalized="$(echo "$target" | sed 's|^\(\.\.\/\)*||; s|^\(\.\/\)*||; s|//*|/|g')"
  # #3710: the rewrite pattern below requires a non-empty non-slash run
  # immediately before `/../`, so `foo//../bar` could never match it and the
  # loop span forever (rewrite-without-progress). Duplicate separators are
  # collapsed first (canonicalization), and a rewrite that makes no progress
  # is a diagnosed bounded rejection instead of a traversal-bearing success.
  while [[ "$normalized" == *"/../"* ]]; do
    prev="$normalized"
    normalized="$(echo "$normalized" | sed 's|[^/][^/]*/\.\./||')"
    if [[ "$normalized" == "$prev" ]]; then
      echo "normalize_mock_target: rejecting unresolvable dotdot segment in target: $target" >&2
      return 1
    fi
  done
  normalized="$(echo "$normalized" | sed 's|^src/||; s|\.js$||')"
  if [[ "$normalized" != node:* ]]; then
    normalized="src/$normalized"
  fi
  echo "$normalized"
}
