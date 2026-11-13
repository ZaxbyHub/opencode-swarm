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
#         (a receipt recorded against an unreadable git state — head
#         "unknown" — is refused outright, and the tree being validated must
#         itself be a readable git repository)
#   dirty "" (recorded from a clean tree) must match a clean tree; a 40-hex
#         sha1 digest must match the canonical CONTENT-COVERING digest of the
#         current dirty state (git diff HEAD --binary + sorted untracked
#         path/blob-id rows — porcelain alone is content-blind)
#   files every recorded file must exist in the tree and stay inside it
#
# The receipt is a tree-binding freshness token, not proof the battery passed:
# it is also unauthenticated by design (single-principal local evidence), so a
# hand-written receipt with matching values passes — validate the battery's
# own pass/fail summary alongside it.
#
# Refusals (exit 1): TREE-RECEIPT: mismatch (head or dirty binding, missing
# fields, truncated/non-JSON receipt), TREE-RECEIPT: unknown-file (missing,
# out-of-tree). Success: TREE-RECEIPT: ok (exit 0).
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

# Structural validation before field extraction: the receipt must be a
# complete JSON object. Both producer forms must pass: pretty-printed
# (JSON.stringify(..., null, 2), last line is the lone closing brace) and
# compact single-line (last line ends with the closing brace). A receipt
# truncated mid-write ends mid-value, on a comma, or on an open bracket —
# never on a closing brace.
last_line="$(tail -n 1 "$receipt" | tr -d '[:space:]')"
case "$last_line" in
  *"}") ;;
  *)
    echo "TREE-RECEIPT: mismatch (receipt is truncated or not a complete JSON object)" >&2
    exit 1
    ;;
esac

r_head="$(sed -n 's/.*"head": *"\([^"]*\)".*/\1/p' "$receipt" | head -1)"
# The dirty binding is REQUIRED: a receipt omitting it must not fall through
# to the clean-tree arm.
if ! grep -q '"dirty"' "$receipt"; then
  echo "TREE-RECEIPT: mismatch (receipt carries no dirty binding)" >&2
  exit 1
fi
r_dirty="$(sed -n 's/.*"dirty": *"\([^"]*\)".*/\1/p' "$receipt" | head -1)"
# The producer writes pretty-printed JSON (JSON.stringify(receipt, null, 2)),
# so "files": [ ... ] spans multiple lines. Extract the elements between the
# "files": [ opener and its closing ] line-sensitively; a single-line sed
# pattern would silently yield an empty set and skip file verification. Two
# modes: a single-line array (elements after the opener on the same line) or
# a multi-line array (one element per line, closed by a line starting with
# ']'). A ']' inside a multi-line element line is preserved (only a line
# whose first non-space character is ']' closes the array).
r_files="$(awk '
  /"files": *\[/ {
    line = $0
    sub(/.*"files": *\[/, "", line)
    gsub(/[[:space:]]+$/, "", line)
    # Drop a trailing object close (the producer emits "files" last) BEFORE
    # testing for the single-line array closer: `...["a"]}` must become
    # `...["a"]` so the "]"-at-end-of-line test can fire, and a "]" inside a
    # quoted filename (a]b.test.ts) stays mid-line and never terminates the
    # array (Stage-B FB-006 finding).
    sub(/\}[[:space:]]*$/, "", line)
    sub(/,[[:space:]]*$/, "", line)
    if (line ~ /\]$/) {
      sub(/\]$/, "", line)
      gsub(/"/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) {
        v = parts[i]
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        if (v != "") print v
      }
    } else {
      in_files = 1
    }
    next
  }
  in_files {
    trimmed = $0
    sub(/^[[:space:]]+/, "", trimmed)
    if (trimmed ~ /^\]/) { in_files = 0; next }
    gsub(/,$/, "", $0)
    gsub(/"/, "", $0)
    line = $0
    sub(/^[[:space:]]+|[[:space:]]+$/, "", line)
    if (line != "") print line
  }
' "$receipt" | sed '/^$/d')"
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
# Both directions of an unreadable git state fail closed: a receipt recorded
# against an unreadable git state, and a validation tree whose own git state
# cannot be read, are both refused (never compared "unknown == unknown").
if [ "$r_head" = "unknown" ]; then
  echo "TREE-RECEIPT: mismatch (receipt head is 'unknown' — it was recorded against an unreadable git state)" >&2
  exit 1
fi
if [ "$current_head" = "unknown" ]; then
  echo "TREE-RECEIPT: mismatch (the tree being validated has no readable git state: $root)" >&2
  exit 1
fi
if [ -z "$r_head" ] || [ "$r_head" != "$current_head" ]; then
  echo "TREE-RECEIPT: mismatch (receipt head ${r_head:-missing} vs current HEAD $current_head)" >&2
  exit 1
fi

# Unknown-file refusal before the dirty comparison so a receipt naming a file
# the tree does not carry is diagnosed as the file problem it is. Recorded
# paths must also stay INSIDE the tree (an absolute path or a ../ escape is
# refused: the producer never records one, and accepting one would let the
# existence check reach outside the validated root).
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    /*|../*|*/../*|.)
      echo "TREE-RECEIPT: unknown-file (recorded path escapes the validated tree: $f)" >&2
      exit 1
      ;;
  esac
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
    echo "TREE-RECEIPT: mismatch (no sha1sum or shasum available to recompute the content-covering digest)" >&2
    exit 1
  fi
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

if [ -z "$r_dirty" ]; then
  # Producer form for a clean tree: only a clean tree matches.
  if [ "$clean" = false ]; then
    echo "TREE-RECEIPT: mismatch (receipt recorded a clean tree, but the current tree is dirty)" >&2
    exit 1
  fi
elif [ "$r_dirty" = "git-unavailable" ]; then
  echo "TREE-RECEIPT: mismatch (receipt recorded an unreadable git state)" >&2
  exit 1
else
  if [ "$r_dirty" != "$current_dirty" ]; then
    echo "TREE-RECEIPT: mismatch (receipt dirty digest ${r_dirty} vs current ${current_dirty:-clean})" >&2
    exit 1
  fi
fi

echo "TREE-RECEIPT: ok (head $current_head, files verified, dirty binding verified)"
exit 0
