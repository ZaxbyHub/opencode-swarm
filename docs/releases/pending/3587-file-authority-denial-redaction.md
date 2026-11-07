# File-authority denial messages now bounded and home-redacted

## What changed

Every `WRITE BLOCKED: Agent "…" is not authorised to write "…"` denial thrown by the shell
write gate and the file-write path now renders the target through one shared
bounded-and-redacted helper (`sanitizeDiagnosticText(redactPath(target), 320)` with the
escaping-relative home fold below), replacing raw interpolation at all four throw sites
(universal deny prefix, lenient verifier-config, enforced authority, and the non-shell
file_write door — agent names are bounded there too).

The shared `redactPath` now classifies profile shapes **lexically** on a normalized
slash form, on every host: normalization-created home paths (`/tmp/../home/<name>/…`,
`/home//<name>/…`) fold, exact profile roots (`/home/<name>`, `/Users/<name>`,
`C:\Users\<name>`) fold, and Windows-drive and UNC profile forms fold in either separator
flavor even on POSIX hosts (`C:/Users/<name>/…`, `//server/Users/<name>/…`). A folded
Windows path renders `~\rest` (the old `~\\rest` double separator is gone); non-profile paths
render exactly as before.

The file-authority denial **reason** keeps its workspace-relative display: an ESCAPING
relative path (normalized form starting `../`, provably outside the workspace) folds its
`home/<name>` / `Users/<name>` segment to `~`, and every other display routes through
`redactPath`. The denial message's target slot makes the same escaping decision on the
normalized form (`./../home/<name>/…`, `src/../../home/<name>/…`, and win32
`..\Users\<name>\…` all fold), so for operand-shaped targets — the non-shell file_write door —
the message and reason agree. The three SHELL doors render the RESOLVED absolute target: its
leading runtime profile folds, but an interior caller-supplied `home/<name>` segment beyond it
stays visible in the message while the reason folds it (folding interior segments of resolved
paths would over-redact legitimate in-workspace denial targets). Ordinary in-workspace relative
paths and non-home absolutes render structurally unchanged — through `redactPath`'s
host-normalized form, as before (over-redaction is pinned against).

Known bounds: when the workspace sits under one profile and the target under a SIBLING profile,
the relative display's common-ancestor prefix already dropped the `Users` segment, so the
sibling account name remains in the reason (the message's target slot is still folded); the
escaping fold is case-sensitive (`Users` but not `users`); a drive-relative win32 spelling
(`C:..\Users\<name>\…`, no separator after the drive) is not recognized as escaping, so the
message renders it raw while the reason folds it; and the lstat-failed / symlink-junction
ancestor denial arms still render the raw ancestor path (pre-existing, tracked for a
follow-up).

Diagnostic-only change: `ShellWriteBlockedError.writeTarget` stays exact; audit rows keep
their redacted-and-truncated contract and pick up the same profile folds (ordinary paths
persist unchanged); message shape is unchanged, so downstream message-parsing and the pinned
denial suites are unaffected.

## Why

Follow-up from PR #3568's final critic (#3587): a long attacker-influenced target (400+ chars)
flowed unbounded and un-redacted into denial messages — including absolute user-profile paths
(`C:\Users\<name>\…`) rendered verbatim. The PR #3567 round had fixed exactly one of the five
denial-throw sites; this closes the remaining four plus the reason channel.

Issue: #3587
