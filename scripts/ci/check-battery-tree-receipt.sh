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
# The producer writes pretty-printed JSON (JSON.stringify(receipt, null, 2)),
# so "files": [ ... ] spans multiple lines. Extract the elements between the
# "files": [ opener and its closing ] line-sensitively; a single-line sed
# pattern would silently yield an empty set and skip file verification.
r_files="$(awk '
  /"files": *\[/ { in_files = 1; line = $0; sub(/.*"files": *\[/, "", line); if (line ~ /\]/) { sub(/\].*/, "", line); if (line != "") print line; in_files = 0; next } if (line != "") print line; next }
  in_files {
    line = $0
    if (line ~ /\]/) { sub(/\].*/, "", line); if (line != "") print line; in_files = 0; next }
    if (line != "") print line
  }
' "$receipt" | tr ',' '\n' | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | sed '/^$/d')"
# Fail closed if the receipt carries a files array the extractor could not
# find at all (malformed receipt), rather than vacuously verifying nothing.
if ! grep -q '"files"' "$receipt"; then
  echo "TREE-RECEIPT: mismatch (receipt carries no files array)" >&2
  exit 1
fi
if [ -z "$r_files" ]; then
  echo "TREE-RECEIPT: mismatch (files array present but no elements extracted — empty battery or unparseable receipt)" >&2
  exit 1
fi

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

# CONTENT-COVERING dirty binding (mirrors computeDirtyDigest in
# run-test-battery.ts byte for byte — change both together): `git diff HEAD
# --binary` for tracked content, then each untracked non-ignored file's path
# and blob id (sorted, C locale). Porcelain alone is content-blind: editing an
# already-modified file would not move it. A clean tree is "".
current_dirty=""
clean=true
if [ -n "$(git -C "$root" diff HEAD --binary 2>/dev/null)" ]; then clean=false; fi
if [ -n "$(git -C "$root" ls-files --others --exclude-standard 2>/dev/null)" ]; then clean=false; fi
if [ "$clean" = false ]; then
  hash_tool=""
  if command -v sha1sum >/dev/null 2>&1; then
    hash_tool=sha1sum
  elif command -v shasum >/dev/null 2>&1; then
    hash_tool="shasum -a 1" # shellcheck disable=SC2086
  fi
  if [ -z "$hash_tool" ]; then
    current_dirty="git-unavailable"
  else
    current_dirty="$(
      {
        git -C "$root" diff HEAD --binary 2>/dev/null
        printf '\0'
        git -C "$root" ls-files --others --exclude-standard -z 2>/dev/null \
          | LC_ALL=C sort -z \
          | while IFS= read -r -d '' rel; do
              blob="$(git -C "$root" hash-object -- "$rel" 2>/dev/null)"
              printf '%s\n%s\n' "$rel" "$blob"
            done
      } | $hash_tool | cut -d' ' -f1
    )"
  fi
fi

if [ -z "$r_dirty" ]; then
  # Producer form for a clean tree: only a clean tree matches.
  if [ "$clean" = false ]; then
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
