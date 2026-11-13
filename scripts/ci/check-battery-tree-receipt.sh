#!/usr/bin/env bash
#
# check-battery-tree-receipt.sh — merge-queue-readiness tree binding (#3605 AC7).
#
# A gate-sensitive local battery (scripts/ci/run-test-battery.ts) records the
# tree it ran on: {head, dirty, files}. This checker refuses a receipt whose
# recorded tree is not the tree it must validate (the current checkout — or,
# per the merge-queue-readiness protocol, the merged-result worktree):
#
#   head  must equal `git rev-parse HEAD` of the tree being validated
#   dirty "" (recorded from a clean tree) must match a clean tree; a 40-hex
#         sha1 digest must match the canonical digest of the current dirty
#         state (sha1 over `git status --porcelain`, CRLF-normalized)
#   files every recorded file must exist in the tree
#
# Refusals (exit 1): TREE-RECEIPT: mismatch (head or dirty binding),
# TREE-RECEIPT: unknown-file. Success: TREE-RECEIPT: ok (exit 0).
#
# Usage: check-battery-tree-receipt.sh <receipt.json> [root]
# <root> defaults to the current directory; use it to validate a receipt
# against a merged-result worktree.
set -euo pipefail
export LC_ALL=C

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: check-battery-tree-receipt.sh <receipt.json> [root]" >&2
  exit 1
fi

receipt="$1"
root="${2:-$(pwd)}"

if [ ! -f "$receipt" ]; then
  echo "TREE-RECEIPT: mismatch (receipt file not found: $receipt)" >&2
  exit 1
fi

r_head="$(sed -n 's/.*"head": *"\([^"]*\)".*/\1/p' "$receipt" | head -1)"
r_dirty="$(sed -n 's/.*"dirty": *"\([^"]*\)".*/\1/p' "$receipt" | head -1)"
r_files="$(sed -n 's/.*"files": *\[\(.*\)\].*/\1/p' "$receipt" | head -1 | tr -d '"' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"

current_head="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ -z "$r_head" ] || [ "$r_head" != "$current_head" ]; then
  echo "TREE-RECEIPT: mismatch (receipt head ${r_head:-missing} vs current HEAD $current_head)" >&2
  exit 1
fi

# Unknown-file refusal before the dirty comparison so a receipt naming a file
# the tree does not carry is diagnosed as the file problem it is.
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ ! -f "$root/$f" ]; then
    echo "TREE-RECEIPT: unknown-file (recorded file not present in the tree: $f)" >&2
    exit 1
  fi
done <<EOF
$r_files
EOF

status_out="$(git -C "$root" status --porcelain 2>/dev/null | tr -d '\r' || true)"
if [ -z "$status_out" ]; then
  current_dirty=""
else
  current_dirty="$(printf '%s\n' "$status_out" | sha1sum 2>/dev/null | cut -d' ' -f1 || sha1 -q 2>/dev/null || echo git-unavailable)"
fi

if [ -z "$r_dirty" ]; then
  # Producer form for a clean tree: only a clean tree matches.
  if [ -n "$status_out" ]; then
    echo "TREE-RECEIPT: mismatch (receipt recorded a clean tree, but the current tree is dirty)" >&2
    exit 1
  fi
else
  if [ "$r_dirty" != "$current_dirty" ]; then
    echo "TREE-RECEIPT: mismatch (receipt dirty digest ${r_dirty} vs current ${current_dirty:-clean})" >&2
    exit 1
  fi
fi

echo "TREE-RECEIPT: ok (head $current_head, files verified, dirty binding verified)"
exit 0
