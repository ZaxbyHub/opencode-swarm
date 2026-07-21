#!/usr/bin/env bash
# trace-init.sh — initialize an issue-tracer trace directory (issue-tracer).
#
# Creates .agents/issue-traces/<slug>/ at the repo root and ensures that path is
# excluded from version control via .git/info/exclude — a LOCAL exclusion, never
# a tracked .gitignore edit inside a fix PR. Idempotent.
#
# Usage:
#   trace-init.sh <issue-slug>
set -eu
# Force the C locale: POSIX bracket-range collation (e.g. [a-z]) is
# locale-dependent, not fixed-ASCII. Under some runner locales (observed on
# macOS CI), "dictionary order" collation makes [a-z] also match uppercase
# letters, silently defeating the slug allowlist below. C locale guarantees
# strict ASCII-only ranges regardless of the invoking environment.
export LC_ALL=C

# Native Git for Windows prints drive-qualified paths (C:/...) even when it is
# invoked from MSYS/Git Bash. Coreutils do not consistently interpret that form
# as absolute in restricted/non-login shells, so normalize Git-reported paths
# before passing them to cd, mkdir, or redirection. POSIX hosts are unchanged.
to_shell_path() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -u "$1"
        return
      fi
      ;;
  esac
  printf '%s\n' "$1"
}

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: trace-init.sh <issue-slug>" >&2
  exit 2
fi

# Positive allowlist: lowercase alphanumeric and '-' only. This also rejects
# '/', '\', '..', '.', shell metacharacters, and whitespace, since none of
# those characters are in the allowed set — a slug that fails this check can
# never traverse a path or be misread as a shell option/argument elsewhere
# the slug is embedded (e.g. `git switch -c fix/<issue-slug>`).
case "$slug" in
  *[!a-z0-9-]*)
    echo "trace-init: invalid slug — lowercase alphanumeric and '-' only: $slug" >&2
    exit 2
    ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "trace-init: not inside a git work tree — run this from within the target repository" >&2
  exit 2
}
root="$(to_shell_path "$root")"
root_real="$(cd "$root" && pwd -P)"
trace_dir="$root/.agents/issue-traces/$slug"

# Reject a symlink escape before creating anything: walk up from trace_dir to
# the nearest existing ancestor (e.g. an already-committed `.agents` that is
# actually a symlink to outside the repo) and verify it resolves inside the
# repo root. `mkdir -p` happily follows an existing symlinked ancestor, so
# this check MUST run before mkdir -p, not after.
check_dir="$trace_dir"
while [ ! -e "$check_dir" ]; do
  check_dir="$(dirname "$check_dir")"
done
check_real="$(cd "$check_dir" && pwd -P)"
case "$check_real" in
  "$root_real" | "$root_real"/*) ;;
  *)
    echo "trace-init: refusing to create trace dir — existing path '$check_dir' resolves to '$check_real', outside the repo root '$root_real' (likely a symlink escape)" >&2
    exit 2
    ;;
esac

mkdir -p "$trace_dir"

# Re-verify after creation: mkdir -p only creates the components that did not
# already exist, so this catches nothing new versus the pre-check above, but
# it is cheap defense-in-depth against the trace dir itself having become a
# symlink between the check and the mkdir.
trace_dir_real="$(cd "$trace_dir" && pwd -P)"
case "$trace_dir_real" in
  "$root_real" | "$root_real"/*) ;;
  *)
    echo "trace-init: trace dir '$trace_dir' resolved to '$trace_dir_real', outside the repo root '$root_real'; aborting" >&2
    exit 2
    ;;
esac

# Ensure the trace root is excluded locally.
#
# Use --git-common-dir, not --absolute-git-dir: in a linked worktree,
# --absolute-git-dir resolves to the worktree-private admin dir, which
# `git status --ignored` / `git check-ignore` do not consult for exclude
# rules — those read info/exclude from the shared common dir. Prefer
# --path-format=absolute (git >= 2.31) so the result is unambiguous; fall
# back to the plain form (resolved against cwd) on older git. Mirrors the
# fix in src/knowledge/cohort-identity.ts (issue #1846, PR #1851).
git_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || git_dir=""
if [ -z "$git_dir" ]; then
  git_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || {
    echo "trace-init: could not resolve the git directory" >&2
    exit 2
  }
  git_dir="$(to_shell_path "$git_dir")"
  case "$git_dir" in
    /*) ;; # already absolute
    *) git_dir="$(pwd)/$git_dir" ;;
  esac
else
  git_dir="$(to_shell_path "$git_dir")"
fi
exclude_file="$git_dir/info/exclude"
entry='.agents/issue-traces/'
mkdir -p "$(dirname "$exclude_file")"
if [ ! -f "$exclude_file" ] || ! grep -qxF "$entry" "$exclude_file" 2>/dev/null; then
  printf '%s\n' "$entry" >> "$exclude_file"
fi

# Seed state.md so the trail has a resumable starting point.
state_file="$trace_dir/state.md"
if [ ! -e "$state_file" ]; then
  cat > "$state_file" <<EOF
# Trace State: $slug

- Phase: 0 (setup)
- Completed gates:
- Active hypothesis:
- Selected fix candidate:
- Unresolved risks:
- Next action:
EOF
fi

echo "trace-init: created $trace_dir"
echo "trace-init: ensured '$entry' in $exclude_file"
