# Shell redirects into /dev/null are no longer treated as writes

## What changed

1. The POSIX shell write detector (`src/hooks/shell-write-detect.ts`) no longer
   reports a redirect into a sink device (`2>/dev/null`, `>/dev/null 2>&1`,
   `&>/dev/null`) as a write target. The exempt sink devices are exactly
   `/dev/null`, `/dev/zero` and `/dev/urandom`, the set the existing
   `isNullDevice` helper already used for `tee` and `dd of=`. Every other
   device path, including `/dev/stderr`, `/dev/stdout`, `/dev/tty` and
   `/dev/fd/N`, is still reported as a write target. The redirect collector
   inside `resolveWriteTargets` (`getWritesFromRedirectNode`) skips the same
   sink devices, so a sink write reported by the Windows detectors resolves
   against the caller's working directory instead of the POSIX `cd` tracker's
   context.
2. A redirect in a command's argument list is no longer read as an empty
   argument. `getSuffixWords` is shared by every argument-reading detector:
   the builtin writers (`cp`, `mv`, `install`, `ln`, `truncate`, `unlink`,
   `rmdir`, `dd`, `tee`), the in-place editors (`sed`, `perl`, `awk`), the
   interpreter-eval detector, the network downloaders (`curl`, `wget`, `scp`),
   the archive extractors (`tar`, `unzip`, `gunzip`, `gzip`, `bzip2`, `xz`,
   `7z`, `rar`) and the destructive-`git` detector. It used to map a redirect
   node to `""`, so the destination pickers (the last argument of `cp`, `mv`,
   `install` and `ln`, `tar -C`, `unzip -d`) reported an empty path that
   resolved to the workspace root instead of the real destination. With
   change 1 alone, `cp a /etc/passwd 2>/dev/null` would have been admitted for
   the architect and other lenient roles, because the `/dev/null` rejection had
   been the only thing stopping it. Redirect nodes are now skipped, so that
   command is rejected as `AUTHORITY_ROOT_ESCAPE` on `/etc/passwd`, and a
   scoped coder's `cp src/a.ts outside.txt 2>/dev/null` is rejected naming
   `outside.txt`.
3. The in-place edit picker (`sed -i`, `perl -i`, `awk -i inplace`) was
   rewritten so that it no longer depends on that empty placeholder. The word
   after a bare `-i` is taken as the script only when no option supplies one.
   Script options are recognised detached and attached: `-e X`, `-e1d`,
   `-e's/a/b/'`, `-fs.sed`, `-ne1p`, `--expression=X` and `--file=F` for sed;
   `-e`, `-E`, `-pe`, `-lne`, `-wpe1` and `-0777pe1` style bundles for perl;
   `-f prog`, `-fprog`, `--file=p.awk`, `-e PROG`, `-e'PROG'` and
   `--source=PROG` for gawk. Only options before `--` count. So
   `sed -i -e's/a/b/' /etc/passwd`, `sed -i -e1d .env`, `perl -i -pe1 F`,
   `awk -i inplace -fprog F` and `awk -i inplace -e'{...}' F` report the real
   file. BSD and GNU sed read the word after a bare `-i` differently: BSD
   takes `-i ''` / `-i .bak` as a backup suffix, GNU takes it as the script
   (`sed -n -i '' F` runs the empty script and truncates `F`) and every
   later word as a file. After a bare `-i` with an empty or dot-word suffix
   candidate and more words, the BSD reading (skip the next word as the
   script) is used only when that word is shaped like a sed script and a
   file still follows it. Script-shaped means a command with an address or
   a negation (`1d`, `$d`, `1,3p`, `$!d`, `!d`, `3q`), an `s` or `y` command
   (`s/a/b/`, `s|a|b|`), or a slash-free word not starting with `.` that
   holds `;`, `{` or `}` (`N;P;D`). A bare letter (`p`, `d`, `P`) can be a
   file name, so it is not script-shaped. Otherwise the GNU reading is used
   and that word is reported as a file. A word with `;`, `{` or `}` that
   also holds a `/` or starts with `.` (`/opt/a;b`, `../{a}`) is a path, not
   a script. sed, `perl -i` and `awk -i inplace` now report every file of
   a multi-file in-place edit (`sed -i X f1 f2` and
   `perl -i -pe X src/a.ts /etc/passwd` report both words), so a dangerous
   file can no longer sit behind a harmless one. Before this change sed,
   perl and awk reported only one file. perl's script and awk's program
   slot keep their rules (the first positional, unless `-e`/`-f`/`--file=`
   /`--source=` supplies it); an awk `var=val` operand is not a file but
   is reported too (fail-safe over-report). A word with a `..` path
   component, with components split on `/` and on `\` (a path separator
   for Git Bash and MSYS tools on win32), is never taken for a script,
   whatever its delimiter (`s-x-/../../victim` or `s-x-\..\..\victim`
   after `-i ''` is a file to GNU sed), so it is reported:
   `sed -i '' 's-x-/../../victim' f` and `sed -i '' 's-x-\..\..\victim' f`
   report both words. A word with `;`, `{` or `}` is taken for a script
   only when it has no `/`, `\` or `:` and does not start with `.`; this
   `\` / `:` rejection is what makes `x;\..\.env`, `C:\Temp\x;y`, `D:x;y`
   and `\\srv\share\x;y` paths. A separate drive-absolute rule decides
   `s` / `y` words: one that starts with a drive letter, `:` and a
   separator (`s:/a:/b:`, `y:/:_:`, naming drive S: or Y: on win32) is a
   path. A backslash that is not part of a `..` component (`s/\t/ /g`,
   `s/a\/b/c/`, `s/\(a\)/\1/`) keeps an `s` / `y` word a script. These
   rules over-report some real scripts in this slot; see Known caveats.
   The BSD reading applies only to a pure literal word: a word
   with a parameter, command or arithmetic expansion (`$D`, `${D}`,
   `$(pwd)`, backticks), a brace expansion (`{..,a}`) or a glob character
   (`*`, `?`, `[`) is always reported, because the shell turns it into
   another word, possibly an absolute path. The parser drops quotes, so a
   quoted brace or glob character counts too. The GNU script slot (the
   first positional word when no script option is given, before or after
   `-i`) follows the same principle: a word with an unquoted expansion or
   an unquoted brace expansion can become several words (`S='1d ../../x'; sed -i $S
   f`, `sed -i {1d,../../v} f`), the first being the script and the rest
   files, so it is never consumed as the script and is reported. Glob
   characters do not count there, so quoted regex scripts such as
   `'/^\s*$/d'` stay the script. In either slot an expansion or brace word
   is never consumed as the script. An expansion or brace in ANY flag word
   (`X=' 1d ../v'; sed -i$X f`, `sed -e$X -i f`, `sed -n$X -i f`,
   `--expression=$X`, `--file=$X`, `-e{1d,x}`) can split it into options,
   a script and files, so the flag word is reported as a dynamic candidate
   (blocked, as before this change) and never supplies or consumes the
   script; with one present no word is taken for the implicit script, and
   every positional is reported as a file. The same applies to the
   detached argument of an option (`sed -e $X`, `-f $X`, `-l $X`,
   `--expression $X`, awk `-v`/`-F`/`-i $X`, perl `-e $X`): when it may
   expand to several words it is reported as a dynamic candidate instead of
   being skipped as the option's argument, and the option does not count
   as supplying the script. "May expand" is decided fail-safe: a word may
   expand when it has an expansion outside double quotes, a brace
   expansion whose braces and separator are outside quotes and backslash
   escapes (`{1d,../v}` and `{1d,'../v'}` split; `'{print $1,$2}'`,
   `'{gsub(/\t/," ")}1'` and `\{1d,x}` are one word), a command or
   arithmetic substitution (`$(`, `$((`, a backtick) anywhere, quoted or not, or a list expansion (`$@`, `$*`,
   `${A[@]}`, `${A[*]}`, `${!P@}`), quoted or not, since these split even
   inside double quotes. Only a plain double-quoted parameter expansion
   (`"$X"`, `"${X}"`, `"${X:-a b}"`, `"s/$a/$b/"`) is taken to stay one
   word and keeps the old handling, so `sed -i -e "s/$a/$b/" f` and
   `sed -i "$EXPR" f` are unaffected. Every other word with an expansion is
   reported, including in the GNU script slot (`sed -i "$@" f`,
   `sed -i "$(cat s.sed)" f`). Those quoted substitution forms are
   reported as dynamic targets and so blocked, a deliberate over-block.
   A quoted word in a file slot is dropped as a script only when the text
   inside the quotes is itself an `s///` or `y///` script without a `..`
   component (`sed -e 1d -i "s/$a/$b/" f`); any other quoted word is a file
   and is reported. A quoted dynamic FILE operand (`sed -i -e 1d "$FILE"`,
   `perl -i -pe X "$FILE"`, `"${D}"`, `"$D/f"`, `"a$D"`) is therefore now
   blocked as a dynamic path target for every role, the same as the
   unquoted `$FILE` was at the base; before this change it was filtered as
   a quoted script and the write went unreported
   (`X=/etc/passwd; sed -i -e 1d "$X"` was allowed for the architect).
   This is a documented over-block of a target that used to be missed.
   A word shaped like `s/../../x`, `s/..\..\x` or `y/../../x` in a file
   slot is a path with a `..` component (split on `/` and `\`) and is
   reported, not dropped as a script.
   A glob in a detached option argument splits it too: the shell expands
   `sed -i --file ../[ab].sed src/a.ts` into the script file `../a.sed` and
   the files `../b.sed` and `src/a.ts`. The argument of a file-taking
   option (sed `-f`/`--file`, awk `-f` and gawk `-i <library>`) is treated
   as splitting on any `*`, `?` or `[`; any other detached argument (a
   script, `-l N`, awk `-v`/`-F`/`-e`) only on one outside quotes and
   backslash escapes, read from the command's source text, so
   `sed -i -e 's/a*/b/' f`, `awk -i inplace -F '[,;]' '{print}' f` and
   `awk -i inplace -v 're=[0-9]*' ...` are unaffected. Quoted C escapes
   are unaffected too: the parser decodes `\t`, `\n`, `\r`, `\xHH`, octal
   and similar escapes inside quotes, and that difference from the source
   text is accounted for, so `sed -i -e 's/\t/ /g' f`,
   `perl -i -pe 's/\r//' f` and `awk -i inplace -e '{gsub(/\t/," ")}1' f`
   report only `f`, as before this change. `awk -i inplace -F '\t' '{print}'
   f` and `awk -i inplace -F, '{print $1,$2}' f` report only `f` too; the
   code before this change reported the `-F` word and missed `f`. Inside double quotes a backslash before a character other
   than `$`, a backtick, `"`, `\` or a newline stays a backslash
   (`"../\[ab]"` is one word). The parser counts source offsets in code
   points, so the source text is located correctly after a character
   outside the BMP (`echo 😀; sed -i -e * ../v f` still reports `*`). A word
   whose source text cannot be matched to the parsed word is treated as
   holding a glob (fail-safe). Such an argument is
   reported (the guardrail resolves it as a literal path: `../[ab].sed`
   resolves outside the root and is blocked) and every positional with it.
   An unquoted glob in a script argument (`sed -i -e s/a*/b/ f`) is now
   reported too, which over-blocks a scoped coder. The GNU and BSD script
   slots keep their rule below (a glob there is not treated as splitting).
   The guardrail's dynamic-path check does not recognise `$@`, `$*` or a
   positional `$1`, so a reported `"$@"` word is resolved as a literal
   in-project path and is not blocked (see Known caveats).
   Accepted
   residual: an unquoted glob word in the GNU script slot (`sed -E -i.bak
   * f g`, where the glob's first match is a valid sed script) expands to
   several words and is consumed as the script; the code before this change
   reported `*` as dynamic and blocked it. The extra files stay inside the
   current directory, and globs are left out on purpose so quoted regex
   scripts such as `'/^\s*$/d'` keep working. The residual is a literal
   file named like a sed script with no `..` component, in the slot after
   the suffix word: an addressed command (`1d`, a single-quoted `'$d'`,
   `3q`, `'$!d'`), a word with `;`, `{` or `}` and no `/`, `\` or `:`, or an `s` / `y`
   command with a non-`/` delimiter (`s-a-b-g`, `y,ab,xy,`). It can be
   taken for the BSD script and not reported; a literal relative name
   without a `..` component stays under the shell's current directory. For
   those shapes the code before this
   change reported the word and blocked: a scoped coder running
   `sed -i '' 1d src/a.ts -n`, which GNU sed reads as editing a file
   literally named `1d`, was rejected and is now allowed. That is a
   deliberate trade-off so the common macOS `sed -i '' 1d f` is not
   over-blocked. A
   macOS BSD script that is a bare letter is over-reported instead:
   `sed -i '' d f` reports both `d` and `f`, so a scoped role must have
   both in scope. The detached suffix is recognised for `sed` only; perl has
   none, so `perl -i ./s.pl F` reports `F`. Only the first `-i` places the
   implicit script, which also keeps a long run of repeated `-i` flags
   linear. Option arguments are found in one left-to-right scan, the way
   getopt reads them: an option that takes a detached argument consumes the
   next word whatever it looks like (`awk -i inplace -F -f '{...}' f` sets
   FS to `-f`), and that word is never parsed again as an option, a flag,
   the script or the awk program. Before this, such a dash-word argument was
   re-read as an option: the `-f` in `-F -f` skipped `{...}` as its own
   argument, the real file was taken for the program, and nothing was
   reported. GNU sed permutes its arguments, so it reads options anywhere
   before `--`. perl and gawk do not: they stop reading options at the
   first operand (the script or program, or the first file once `-e`/`-f`
   supplied it), and every later word, including one that starts with `-`,
   is reported as a file (`awk -i inplace '{print}' f -v ../v` edits f, a
   file named `-v` and ../v; before this change `-v` was read as an option
   and ../v as its argument). For the same reason an option word the
   picker does not model, or an option argument that may split, ends perl
   and awk option parsing (the word may consume what follows or be followed
   by operands), so every later word is reported too: a deliberate
   over-report such as `perl -i -MO=Deparse -pe 1 f` reporting `-pe` and
   `1` as well. GNU sed's long in-place flag `--in-place` and
   `--in-place=SUFFIX` now count as the in-place flag, like `-i` and
   `-iSUFFIX` (it takes no detached BSD suffix), so `sed --in-place s/a/b/
   ../v`, `sed -s --in-place 1d ../v`, `sed --in-place=.bak -e 1d ../v` and
   `sed --in-place 1d -i ../v` report ../v; before this change they
   reported nothing (or `1d`). An abbreviation (`--in`, `--in-pl=.bak`) is
   also seen as in-place, and as an unrecognised option it is reported
   with every positional. Taken together,
   every word of an in-place command is a flag (reported if it may expand
   or is not recognised), a consumed option argument (skipped as that
   argument and never re-parsed; reported only if it may expand), a script
   word (taken only when it is a pure literal), or a reported file or
   dynamic candidate. The remaining blind spots are the documented ones:
   an unquoted glob in the GNU script slot, an in-place flag hidden in an
   expansion (`sed $Y f`), wrapper commands, the guardrail resolving a
   brace word as a literal path, and the other items under Known caveats.
   Any option word the picker does not recognise is reported and stops the
   implicit script from being taken, so an unknown option over-reports
   instead of under-reporting. The picker recognises, per command: for sed
   the argument-less switches `-n -r -E -s -z -u -b` alone or bundled,
   `-e`/`-f`/`-l` (detached, attached, or after those switches), `-i` and
   `-i<suffix>`, the full long names `--quiet`, `--silent`, `--debug`,
   `--follow-symlinks`, `--binary`, `--posix`, `--regexp-extended`,
   `--separate`, `--sandbox`, `--unbuffered`, `--null-data`,
   `--zero-terminated`, `--help`, `--version`, and `--expression`,
   `--file`, `--line-length`, `--in-place` with or without `=`; for perl a
   bundle of `0-9AacSlnpstTuUwWX` optionally ending in `-e`/`-E` and its
   script, `-i...` and `-I<dir>`; for awk `-f -e -v -F -i -l` (detached or
   attached), `-P -c -r -S -V -h`, `--file=`, `--source=`, `--lint[=...]`,
   `--posix`, `--traditional`, `--re-interval`, `--sandbox`, `--version`
   and `--help`. Anything else before `--` (a GNU long-option abbreviation
   such as `--expr=`, `--e=`, `--fil=`, `--sourc=`; a bundle with another
   letter such as perl `-fpe...`, `-pde...`, `-MO=Deparse` or awk `-be...`;
   awk `-W`, `-E`, `-b`, `-M`, `--exec=`) is reported as a candidate, no
   later word is taken for the sed/perl script or the awk program, and
   every remaining positional is reported. Before
   this change such a word was read as an argument-less switch, the real
   file was taken for the script, and nothing was reported:
   `sed -i --expr=s/a/X/ ../v`, `sed --e=s/a/X/ -i /etc/passwd`,
   `perl -i -fpes/a/X/ /etc/passwd` and
   `awk -i inplace --sourc='{print "X"}' ../v` were allowed for every role.
   They are now blocked. `sed -i -bes/a/X/ /etc/passwd` reports
   `/etc/passwd`, because `-b` (`--binary`) is a sed switch and `-be...`
   attaches the script. A benign command using an option outside these
   lists (for example `perl -i -MList::Util -pe ... f`) now reports the
   option word as well, so a scoped role is over-blocked rather than a
   write going unreported.
4. Two older sed gaps in the same picker are closed:
   - A script placed before the in-place flag. GNU sed permutes its
     arguments, so with no script option the first positional word is the
     script wherever it sits: `sed 1d -i F` and `sed s/a/b/ -i ../x` edit `F`
     and `../x`. Previously the script word was taken for the file (or
     dropped) and the word after `-i` for the script, so `sed 1d -i ../x`
     reported `1d` and `sed s/a/b/ -i F` reported nothing. Now that first
     word is the script, no word after `-i` is, and every other positional is
     reported. The argument of `-l N` / `--line-length N` is neither the
     script nor a file.
   - A dot-word after a bare `-i` when a script option is present. GNU sed
     edits it as a file (`sed -e 1d -i .env f` edits `.env` and `f`); BSD
     sed takes it as a backup suffix. It used to be read as a suffix always,
     so `sed -e s/a/b/ -i ../x f` reported only `f`. Now only a conventional
     backup suffix without `/` (`.bak`, `.orig`, `.old`, `.save`,
     `.backup`, `.tmp`, `.swp`, `.~`) is read as the BSD suffix; any other
     dot-word (`.env`, `.bashrc`, `./x`, `../x`, `.a/b`) is reported with
     the other files. `sed -i .bak -e 's/a/b/' src/f` still reports only
     `src/f`. The residual is a file literally named like one of those
     suffixes, in that slot: it is not reported. It is created in the
     shell's current directory, so after a `cd` out of the workspace
     (`cd /tmp && sed -e 1d -i .bak /abs/src/a.ts`) that write is outside
     the root and goes unreported. A macOS suffix outside the list
     (`sed -i .prev -e X src/f`) is reported as a file, so a scoped role must
     have it in scope.

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
  The redirect word is read as bash reads it: its source text after quote
  removal, without C-escape decoding. `>"/dev/null"`, `>'/dev/null'` and
  `>/dev/nul''l` are exempt; `>'/dev/nul\154'`, `>'/dev\x2fnull'` and
  `>'/dev/nul\x6c'` (which bash writes as a literal file, though the parser
  decodes them to `/dev/null`) are write targets and are blocked. A redirect
  word without source text is not exempt.
- Only the sink-device redirect is dropped. Other redirects, builtin writes,
  in-place edits and inline evals in the same command are still detected and
  checked.
- An unprivileged process cannot replace `/dev/null`, so a write there cannot
  touch the workspace.

## Known caveats

- Windows shells are unchanged: a `2>NUL` or `2>/dev/null` under `cmd` or
  PowerShell still goes through `detectWindowsWrites`, which has no
  sink-device exemption.
- `sed -ni` (and `-ni` bundles) and `gawk -i inplace` are not detected
  as in-place edits (`sed --in-place` is, see item 3). `perl -pi -e X f` is
  reported only as an inline eval, and `perl -pie X f` is not reported at
  all. All of these limitations predate this change; a follow-up is
  recommended.
- Also predating this change and unchanged (follow-up recommended):
  wrapper commands (`env`, `command`, `sudo`, `nice`, `time`, `exec`,
  `nohup`) hide `sed` from in-place detection; and sed's own `w` command
  and `s///w` flag write files that are not reported. (A quoted dynamic
  file operand such as `"$D"` is now reported, see item 3.)
- Also predating this change and unchanged (follow-up recommended): an
  in-place flag that only appears after expansion (`Y='-i 1d ../v'; sed $Y
  f`, `sed -n$X f`) is not seen as an in-place edit; the guardrail resolves
  a reported brace word as a literal path, so `sed -i {1d,/etc/passwd} f`
  is allowed for the architect (any detector is affected, e.g.
  `cp a {x,/etc/passwd}`); and an unquoted `s/.../.../` script word in the
  GNU slot that contains an expansion (`s/$a/$b/`) is dropped by the
  script-shape filter even if field splitting would add files; and the
  guardrail's dynamic-path check does not recognise `$@`, `$*` or a
  positional `$1`, so a reported `"$@"` word is resolved as a literal
  in-project path (`set -- 1d /etc/passwd; sed -e"$@" -i src/f.ts` is
  allowed for the architect at the base and here; widening the check would
  also affect every other detector, for example `cp "$@" dir`).
- Also predating this change and unchanged at the base and here
  (follow-up recommended): only a command named exactly `sed`, `perl` or
  `awk` is checked, so `/usr/bin/sed -i 1d ../v`, `gsed -i ...`,
  `busybox sed -i ...` and `command sed -i ...` report nothing; an in-place
  flag built by an expansion inside a bundle (`sed -n${X}i 1d ../v`,
  `sed -${X}i 1d ../v`) or spelled with a Unicode minus sign is not seen;
  gawk `-l lib` is not read as taking an argument, so
  `awk -i inplace -l lib '{print}' ../v` takes `lib` for the program and
  over-reports `{print}` (the real file ../v is reported, since perl and
  awk now report every file); and a command inside a compound or function
  body (`for ...; do sed -i 1d ../v; done`, `if`, `while`, `case`,
  `f(){ ...; }`) or on a line with an array assignment
  (`A=(1 2); sed -i 1d ../v`) gives no write. `perl -i -pfe1 ../v`, which
  also reported nothing before, is now reported by the unknown-option
  rule in item 3.
- Over-blocks introduced by the win32 path rules for sed's BSD script
  slot (the word after `-i ''`). All are fail-closed; the GNU slot, `-e`
  scripts and the `.bak` slot are not affected. Follow-up recommended:
  make the backslash rule aware of the platform and shell.
  - The `\` split for `..` components applies on every platform, so a
    BSD-slot `s` / `y` script with unescaped dots before an escaped slash
    is reported as a path: `sed -i '' 's/..\/..\/utils/@utils/g' src/a.ts`,
    `'s/..\/lib/x/'`, `'s/from "..\/..\//from "@\//g'`, `'s/a/..\\b/'` and
    `'y/..\//abc/'`. The architect is blocked on win32 and a scoped coder
    on every platform, where the code before this change allowed them.
  - A `:`-delimited script whose pattern starts with `/`
    (`sed -i '' 's:/usr/local:/opt:g' f`) matches the drive-absolute rule
    and is reported.
  - A label script such as `:a;N;ba` is reported (it holds a `:`).
- Predating this change, at the base and here (high severity, follow-up
  recommended first): on win32 the parser decodes C escapes in quoted
  redirect and file words, so a word such as `'..\x41'` or
  `'src\..\..\x41'` is resolved as the decoded in-root name while Git
  Bash writes a file with a literal backslash path. The architect is
  allowed at the base and here; a scoped coder is blocked. Fix direction:
  resolve redirect and file paths from the raw source slice, as the sink
  device check now does.
- Predating this change: `tee` and `dd of=` still exempt an escaped sink
  device word (`tee '/dev/nul\154'`), because they match the decoded
  word; only redirects use the source-text check.
