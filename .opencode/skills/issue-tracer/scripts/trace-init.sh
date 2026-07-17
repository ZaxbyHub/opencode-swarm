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

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "usage: trace-init.sh <issue-slug>" >&2
  exit 2
fi

# Reject path traversal / separators in the slug.
case "$slug" in
  */* | *\\* | *..*)
    echo "trace-init: invalid slug (no '/', '\\', or '..'): $slug" >&2
    exit 2
    ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "trace-init: not inside a git work tree — run this from within the target repository" >&2
  exit 2
}
trace_dir="$root/.agents/issue-traces/$slug"
mkdir -p "$trace_dir"

# Ensure the trace root is excluded locally.
git_dir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || {
  echo "trace-init: could not resolve the git directory" >&2
  exit 2
}
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
