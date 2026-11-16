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
  # #3710: a multi-hop dotdot chain can leave a residual '..' segment that
  # the rewrite above cannot consume (e.g. 'a/../../b' -> '../b'). A value
  # that still carries a parent segment is a traversal-bearing path, so it is
  # rejected rather than returned as a success.
  #
  # The check is SEGMENT-aware and matches the TS sibling's
  # `normalized.split('/').includes('..')`: a SOLE '..' segment, a LEADING
  # '../', an INTERIOR '/../', and a TERMINAL '/..' are all parent segments,
  # while a '..' INSIDE a segment (e.g. 'a..b.ts') is not. The padded
  # '/<value>/' form makes the terminal and sole cases visible to the same
  # '/../' pattern that covers the interior ones.
  case "/$normalized/" in
    */../*)
      echo "normalize_mock_target: rejecting residual parent segment in target: $target" >&2
      return 1
      ;;
  esac
  normalized="$(echo "$normalized" | sed 's|^src/||; s|\.js$||')"
  if [[ "$normalized" != node:* ]]; then
    normalized="src/$normalized"
  fi
  echo "$normalized"
}
