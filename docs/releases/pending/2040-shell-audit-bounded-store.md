# Bounded and hardened shell-audit retention and queries (issue #2040)

The guardrail decision audit log `.swarm/session/shell-audit.jsonl` is now a
bounded single-file security-audit store in the issue-#2039 house pattern,
with its own retention contract defined separately from the general event
bus. Line 1 is a `swarm-shell-audit-manifest` header carrying the folded
aggregate (lifetime decision total, per-type counts ≤16 keys + `__other__`,
corrupt/dropped counters); line 2+ is the retained window of raw decision
lines, preserved byte-for-byte — legacy five-field shell entries stay legacy,
and `/swarm guardrail-log` re-redacts them at render time through the current
policy so a legacy record can never bypass it.

Retention is enforced by `SHELL_AUDIT_LIMITS` (documented constants, not
config keys): a sovereign 1 MiB hard byte ceiling over manifest + window,
`securityMaxEntries` 4,000 for typed decisions (blocks, violations, sandbox
transitions — never age-folded), `allowedMaxEntries` 2,000 plus a 72 h age
ceiling for allowed shell decisions, 256 KiB bounded compaction passes every
25 appends, 64 KiB per-line bound with commands truncated to 4,096 chars at
line-shaping time, and a 256 KiB tail-bounded public read. When the byte
ceiling binds, the oldest lines fold regardless of class and the folded
per-type counts disclose it — security decisions are exempt from aging only,
not from the hard bound. Lifetime totals are always folded + retained, and
guardrail authorization was already computed independently of every audit
write (fail-open fire-and-forget), so retention can never alter a block/allow
decision.

`/swarm guardrail-log` no longer reads the whole file: it renders the newest
256 KiB window, caps output at the 200 most-recent entries, and appends an
explicit footer disclosing render caps, read-window truncation, and the
folded lifetime total. All existing contracts are preserved (missing/empty
friendly messages, malformed-line skipping, `--blocks-only` exact semantics,
most-recent-first ordering) and every rendered field is sanitized against
ANSI/control/bidi injection with a per-line 512-char cap.

Write-time redaction is strengthened and caller-independent:
`redactShellCommand` now also redacts URL credentials
(`scheme://user:pass@host`), PowerShell `$env:` and cmd `set` assignments for
sensitive names, well-known token value shapes (OpenAI `sk-`, GitHub
`ghp_`/`github_pat_`, AWS `AKIA`, Slack `xox*`, Google `AIza`), and long
base64-like payload runs (≥80 chars with mixed case + digit — hex SHAs and
short payloads deliberately stay visible). Typed command entries additionally
persist a 16-hex sha256 `commandHash` of the final redacted command so
correlation survives without reversible content; legacy shell entries stay
exactly five fields (SC-119). Windows drive-letter home redaction is now
case-insensitive.

Crash and concurrency safety mirrors the #2039 store: every write (append,
compaction, finalize) holds an exclusive `.swarm/session/shell-audit.lock`
(`wx` create, 5-minute mtime stale-break, bounded retry); rewrites are
PID-scoped tmp + byte-verified renames with the Windows EPERM/EBUSY retry
loop; a crash-torn tail is re-framed on the next append and corrupt lines are
folded counted, never silently resurrected. Legacy header-less files are read
as-is and migrate to the manifest layout in bounded maintenance passes; close
finalizes them into a validated cut before the `session/` directory archive
copy (fail-open), releasing the lock so a stale lock is never archived.

Observability and anti-regression: a counts-only `shell_audit_health` event
(accepted/compacted/retained/dropped/corrupt + timestamps + byte figures —
never commands, paths, agents, or session IDs) is emitted on compaction and
close and catalogued as the 49th event kind; the retention registry's
`shell-audit` row now records the shipped bounds and lifecycle; and the new
`bun run check:shell-audit` literal-mention ratchet (wired into CI and
drift-check) rejects any new direct `shell-audit.jsonl` reader or writer
outside the canonical seam, exactly like `check:core-events` does for the
event bus. A field content-class ratchet
(`tests/unit/hooks/shell-audit-field-classes.test.ts`) fails CI when a
decision field is added without declaring its redaction/content class.

## Caveats

- The 1 MiB byte ceiling is sovereign over both decision classes: a
  pathological burst of security decisions can still push older security
  lines out of the window via the byte budget (disclosed via the folded
  counts and health event) — security exemption is from the 72 h age ceiling
  only, matching the hard-bound requirement.
- An 80+ character base64-shaped run in a command is minimized to
  `[REDACTED:base64]` by design; hex commit SHAs, URLs, and shorter payloads
  remain visible (pinned by no-over-redaction tests).
- `/swarm reset` continues to leave `.swarm/session` untouched (state.json
  parity); `/swarm reset-session` and `/swarm close` remain the lifecycle
  boundaries that delete/archive the audit store, as before.
- Legacy pre-#2040 files migrate lazily: the first throttled maintenance pass
  (every 25 appends) or a close finalizes the manifest layout; until then
  they are read bounded, newest-window first.
