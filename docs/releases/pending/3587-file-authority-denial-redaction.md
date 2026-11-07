# File-authority denial messages now bounded and home-redacted

## What changed

Every `WRITE BLOCKED: Agent "…" is not authorised to write "…"` denial thrown by the shell
write gate and the file-write path now renders the target through one shared
bounded-and-redacted helper (`sanitizeDiagnosticText(redactPath(target), 320)` with the
escaping-relative home fold below), replacing raw interpolation at all four throw sites
(universal deny prefix, lenient verifier-config, enforced authority, and the non-shell
file_write door — agent names are bounded there too).

The file-authority denial **reason** keeps its workspace-relative display and folds
home/profile segments under two rules: an absolute path (`/home/<name>/...`,
`/Users/<name>/...`, `C:\Users\<name>\...`, UNC shares) folds via the shared `redactPath`, and
an ESCAPING relative path (one starting `../`, provably outside the workspace) folds its
`home/<name>` / `Users/<name>` segment to `~` — so a `/home/<name>/...` target no longer
discloses the profile name in either the absolute or the `../../home/<name>` relative form.
The denial message's target slot applies the same escaping-relative fold (deciding "escaping"
on the normalized form, so `./../home/<name>/…`, `src/../../home/<name>/…`, and win32
`..\Users\<name>\…` spellings fold too), so the message and reason channels of one denial
agree. Ordinary in-workspace relative paths and non-home
absolutes render unchanged (over-redaction is pinned against). Known bounds: when the
workspace sits under one profile and the target under a SIBLING profile, the relative
display's common-ancestor prefix already dropped the `Users` segment, so the sibling account
name remains in the reason (the message's target slot is still folded); the escaping fold is
case-sensitive (`Users` but not `users`); a drive-relative win32 spelling
(`C:..\Users\<name>\…`, no separator after the drive) is not recognized as
escaping and renders raw in the message channel; the lstat-failed / symlink-junction ancestor denial
arms still render the raw ancestor path; and a `/home//<name>/...` double-slash shape dodges
the POSIX home regex (all pre-existing in the shared redaction helpers and tracked for a
follow-up).

Diagnostic-only change: the structured data channels keep their pre-change behavior
(`ShellWriteBlockedError.writeTarget` stays exact; audit rows keep persisting their existing
redacted-and-truncated form); message shape is unchanged, so downstream message-parsing and
the pinned denial suites are unaffected.

## Why

Follow-up from PR #3568's final critic (#3587): a long attacker-influenced target (400+ chars)
flowed unbounded and un-redacted into denial messages — including absolute user-profile paths
(`C:\Users\<name>\…`) rendered verbatim. The PR #3567 round had fixed exactly one of the five
denial-throw sites; this closes the remaining four plus the reason channel.

Issue: #3587
