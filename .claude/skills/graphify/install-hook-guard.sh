#!/bin/sh
# Re-apply the linked-worktree guard to graphify's git hooks. Idempotent.
#
# WHY THIS EXISTS
# graphify 0.8.47 (the build installed here, under Python 3.14) writes post-commit
# and post-checkout hooks that are NOT worktree-aware. Because git shares one hooks
# directory across every linked worktree, a commit made inside .claude/worktrees/<name>/
# would rebuild a rogue worktree-local graphify-out/. That local graph then shadows the
# primary one for any session in that worktree and goes stale silently - we found one
# six weeks out of date.
#
# .git/hooks is not tracked by git, so the guard does NOT survive a fresh clone, and
# re-running `graphify hook install` rewrites the hooks and drops it. Run this script
# after either event.
#
#   sh .claude/skills/graphify/install-hook-guard.sh
#
# Exits 0 when the guard is present (whether it was already there or just added).

set -e

hooks_dir="$(git rev-parse --git-common-dir)/hooks"
[ -d "$hooks_dir" ] || { echo "no hooks dir at $hooks_dir" >&2; exit 1; }

guard_marker='_GFY_COMMONDIR'
status=0

apply() {
    hook="$hooks_dir/$1"
    marker="$2"

    if [ ! -f "$hook" ]; then
        echo "$1: not installed - run 'graphify hook install' first"
        status=1
        return
    fi
    if grep -q "$guard_marker" "$hook"; then
        echo "$1: guard already present"
        return
    fi
    if ! grep -q "^$marker\$" "$hook"; then
        echo "$1: marker '$marker' not found - hook format changed, patch by hand" >&2
        status=1
        return
    fi

    # Insert INSIDE graphify's own block (right after its start marker) so an
    # unrelated hook appended to the same file is never skipped in a worktree.
    tmp="$hook.graphify-guard.$$"
    awk -v marker="$marker" '
        { print }
        $0 == marker && !done {
            print ""
            print "# --- local patch: skip linked worktrees ---------------------------------"
            print "# graphify 0.8.47 ships no worktree guard; without this a commit inside a"
            print "# linked worktree builds a rogue worktree-local graphify-out/ that shadows"
            print "# the primary graph. Reapply with .claude/skills/graphify/install-hook-guard.sh"
            print "_GFY_GITDIR=$(cd \"$(git rev-parse --git-dir 2>/dev/null)\" 2>/dev/null && pwd)"
            print "_GFY_COMMONDIR=$(cd \"$(git rev-parse --git-common-dir 2>/dev/null)\" 2>/dev/null && pwd)"
            print "if [ -n \"$_GFY_COMMONDIR\" ] && [ \"$_GFY_GITDIR\" != \"$_GFY_COMMONDIR\" ]; then"
            print "    exit 0"
            print "fi"
            print "# --- end local patch ----------------------------------------------------"
            print ""
            done = 1
        }
    ' "$hook" > "$tmp"

    if ! sh -n "$tmp"; then
        rm -f "$tmp"
        echo "$1: patched hook failed syntax check - left unchanged" >&2
        status=1
        return
    fi

    cat "$tmp" > "$hook"   # preserve the original file mode / exec bit
    rm -f "$tmp"
    echo "$1: guard inserted"
}

apply post-commit  '# graphify-hook-start'
apply post-checkout '# graphify-checkout-hook-start'

exit $status
