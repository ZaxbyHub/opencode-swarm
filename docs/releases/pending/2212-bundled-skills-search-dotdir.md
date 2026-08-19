# Search tool now discovers files in dot-directories when explicitly included

## What changed

Fixed the `search` tool so agents can load bundled skill files from
`.swarm/bundled-skills/` (issue #2212). Three independent layers previously
excluded dot-directories from search results even when a caller explicitly
named them via `include`:

- **Ripgrep hidden-dir default.** `src/tools/search.ts`'s `ripgrepSearch()`
  now promotes exact dot-directory paths (e.g.
  `.swarm/bundled-skills/brainstorm/SKILL.md`) to ripgrep path operands,
  which bypasses hidden-dir and `.gitignore` filtering for that one file.
- **Ripgrep gitignore filter.** Glob `include` patterns that target a
  dot-directory (e.g. `.swarm/**/*.md`) now add `--hidden --no-ignore` to
  the ripgrep invocation.
- **Fallback engine's `DEFAULT_SKIP_DIRS`.** The Node.js fallback search
  (`collectFiles`) now un-skips a directory when the caller's `include`
  first path segment names it explicitly.

`src/agents/architect.ts` gained a "SKILL LOADING" prompt section
instructing the architect to self-load `file:`-referenced skills via the
`search` tool with the correct `include` pattern, closing the loop between
`bundledProjectSkillFileReference()` (which already wrote the correct
`.swarm/bundled-skills/<slug>/SKILL.md` reference) and the search tool that
previously couldn't read it back.

`.git` content protection was hardened across six vectors so the new
dot-directory traversal never exposes `.git/config` or other repository
internals: direct promotion, flag injection, mixed-include ride-along
(`--glob !.git` appended whenever `--hidden --no-ignore` is added),
fallback-engine leak, a Windows case-insensitive `.Git` bypass, and — added
after PR review — a **resolved-path guard**: a path is only promoted to a
ripgrep operand when its *resolved* workspace-relative path (symlinks
followed, traversals collapsed) contains no `.git` segment, which blocks
nested `.git` directories (e.g. `.swarm/sub/.git/config`) and symlink aliases
(e.g. `.foo -> .git`). The fallback engine's `.git` hard block is
case-insensitive to match.

## Why

Bundled skill files were synced correctly to disk by
`syncBundledProjectSkillsIfMissingAsync`, but agents could never read them
back because the search tool silently filtered dot-directories — the bug
was in reading, not writing. Any agent instructed to load a bundled skill
via its `file:.swarm/bundled-skills/...` reference got zero search results.

## Impact

- Agents can now load bundled project skills as intended. The self-load
  protocol uses `max_results: 10000` and `max_lines: 10000` (both tool hard
  caps), which covers the largest bundled skill (`swarm-pr-review`, ~1,990
  lines with lines up to ~1,130 characters); if a skill ever exceeds even
  that, the protocol fails loudly with `SKILL_LOAD_FAILED` and asks the user
  instead of proceeding with partial content.
- Explicitly targeting any dot-directory (`.claude/`, `.cache/`, etc.) via
  `include` now works through both the ripgrep and fallback search engines.
- `.git/` remains fully blocked from search results regardless of how it is
  included — including nested `.git` directories and symlink aliases — on
  both engines and on case-insensitive filesystems.
- Search now surfaces hard ripgrep errors (exit code 2, e.g. a malformed
  glob) instead of silently returning zero matches, and rejects more than
  100 comma-separated include/exclude patterns up front.

## Migration

No migration required. This is a pure bug fix — no schema, config, or API
changes.

## Breaking changes

None. Existing non-dot-directory searches are unaffected: the partition
logic in `ripgrepSearch()` only activates when at least one `include`
pattern targets a dot-directory.
