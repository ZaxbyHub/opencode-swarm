---
issue: 3486
---

# fix(tools): refuse planted links on the commit-message temp directory (#3486)

## What changed

`prepare_pr_feedback_commit_message` wrote its authored message file into a
FIXED, predictable directory under the OS temp root
(`<tmp>/swarm-pr-feedback-commit-msg`). A symlink or NTFS junction planted at
that name redirected both the 24 h TTL prune (deleting stale `.txt` files in
the link target) and the authored write into an attacker-chosen directory: the
shipped "re-proof" was tautological (a `path.join` of a basename can never
escape the joined directory) and the only real check merely refused
repo-internal targets. Reachable on macOS after PR #3465 made the per-user
`$TMPDIR` writable inside sandboxed commands; bounded consequence (no code
execution, attacker controls neither filename nor content, only `*.txt` older
than 24 h were removed).

The tool now ACQUIRES the directory with a real proof before any use:

- `lstat` refusal for a planted symlink/junction or non-directory at the fixed
  name; creation at mode `0700` with a post-create re-`lstat` (recursive
  `mkdir` succeeds over an existing junction on Windows, so the re-stat is the
  actual create-race proof);
- current-user ownership required and legacy modes healed to `0700` on POSIX
  (on Windows the per-user `%TEMP%` ACL is the ownership boundary; mode bits
  are not a security boundary there);
- the TTL prune and the write use only the proven-real directory, and the
  write carries a same-tick `validateTarget` re-proof at the atomic writer's
  boundary, so a directory swapped for a link between acquisition and write is
  refused too;
- the realpath ancestor check (temp root resolving inside the repository) is
  retained.

Disclosed bound: the TTL prune itself is best-effort hygiene guarded by the
same acquisition but not write-time-re-proved — the protected operation is the
authored message write. New suite:
`tests/unit/tools/prepare-pr-feedback-commit-message-symlink.test.ts`.
