# Shell redirects into /dev/null are no longer treated as writes

## What changed

1. The POSIX shell write detector (`src/hooks/shell-write-detect.ts`) no longer
   reports a redirect into a sink device (`2>/dev/null`, `>/dev/null 2>&1`,
   `&>/dev/null`) as a write target. The existing `isNullDevice` helper already
   exempted `tee /dev/null` and `dd of=/dev/null`; the AST redirect path
   (`detectRedirects`, and its resolver-side twin `getWritesFromRedirectNode`)
   did not call it. Both sites now do.
2. A redirect in a command's argument list is no longer read as an empty
   argument. `getSuffixWords` used to map a redirect node to `""`, so every
   "last non-flag argument" picker (`cp`, `mv`, `install`, `ln`, `tar`,
   `unzip`) followed by any redirect reported an empty path that
   resolved to the workspace root instead of the real destination. With change
   1 alone, `cp a /etc/passwd 2>/dev/null` would have been admitted for the
   architect and other lenient roles because the `/dev/null` rejection had
   been the only thing stopping it. The picker now skips redirect nodes, so
   that command is rejected as `AUTHORITY_ROOT_ESCAPE` on `/etc/passwd`, and
   a scoped coder's `cp src/a.ts outside.txt 2>/dev/null` is rejected naming
   `outside.txt`.
3. The in-place edit picker (`sed -i`, `perl -i`, `awk -i inplace`) was
   rewritten to stop depending on that placeholder. A bare `-i` used to
   consume the next word unconditionally, which doubled as the way non-`s///`
   scripts (`sed -i '1d' f`) were skipped; with change 2 it consumed the file
   in `sed -e X -i 2>/dev/null f`. Now the word after a bare `-i` is consumed
   as the script only when no `-e`/`-f`/`--expression=`/`--file=` (sed),
   `-e`/`-E`/`-pe`-style (perl) or `-f` (awk) flag supplies one; BSD detached
   suffixes (`-i ''`, `-i .bak`) are recognised in both cases; attached
   suffixes (`-i.bak`, `-ibak`, `-iinplace`) consume nothing but the script
   that follows; `--` and bare switches (`-n`, `-E`) are never the file;
   gawk's program word is skipped unless `-f` supplied it. `sed -e X -i f`,
   `sed -e X -i.bak f`, `sed -i -- X /etc/passwd` and `sed -e X -i .env` now
   report the real file, which the previous picker missed or misread.

## Why

Any agent that silenced stderr the usual way, for example
`ls -la .swarm 2>/dev/null`, had the whole bash call rejected with
`WRITE BLOCKED ... AUTHORITY_ROOT_ESCAPE: Path blocked: target resolves outside
the working directory [agent=architect; path=../../../../dev/null]` (the `..`
depth depends on the workspace location). One swarm session recorded 18 such
rejections across the architect, coder, critic and sme roles. The containment
check runs before per-agent authority rules by design, so no `authority`
config entry could admit the path; the fix has to be in the detector.

## Safety

- The match is on the literal redirect word before any resolution. A relative
  `dev/null`, a dynamic `$X/dev/null`, or a traversal such as
  `/dev/null/../../etc/passwd` is still a write target and is still blocked.
- Only the sink-device redirect is dropped. Every other write in the same
  command (other redirects, `cp`/`mv`/`tee`, `sed -i`, inline evals) is still
  detected and checked, and the destination pickers now see the real target
  where they previously saw an empty one.
- An unprivileged process cannot replace `/dev/null`, so a write there cannot
  touch the workspace.

## Known caveat

Windows shells are unchanged: a `2>NUL` under `cmd` or PowerShell still goes
through `detectWindowsWrites`, which has no sink-device exemption.
