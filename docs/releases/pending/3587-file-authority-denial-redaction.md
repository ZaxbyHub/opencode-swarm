# File-authority denial messages now bounded and home-redacted

## What changed

Every `WRITE BLOCKED: Agent "…" is not authorised to write "…"` denial thrown by the shell
write gate and the file-write path now renders the target through one shared
bounded-and-redacted helper (`sanitizeDiagnosticText(redactPath(target), 320)`), replacing raw
interpolation at all four throw sites (universal deny prefix, lenient verifier-config, enforced
authority, and the non-shell file_write door — agent names are bounded there too).

The file-authority denial **reason** now folds home/profile prefixes (`/home/<name>`,
`/Users/<name>`, `C:\Users\<name>`, UNC shares) to `~` before the path reaches operator- and
provider-bound transcripts. The fold is derived from the original input before workspace
relativization, so a `/home/<name>/...` target no longer discloses the profile name in either
the absolute or the `../../home/<name>` relative form. Ordinary non-home paths are preserved by
design (over-redaction is pinned against).

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
