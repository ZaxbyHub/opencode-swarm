# Fix: sentinel receipt conflicts report their real reason, not `store_unavailable`

## What

Filing a second `knowledge_receipt` with `trace_id: "none"` (the no-retrieval
sentinel) in the same session used to be rejected as `store_unavailable` —
the retry-inviting infrastructure category — even though the rejection is a
permanent, deterministic identity conflict: within one session the first
`"none"` receipt fixes the recorded `task_id`/`phase`, and every later filing
with a differing or omitted value conflicts with the immutable record.

The conflict is now reported with the precise, actionable reason from the
existing receipt taxonomy:

- `wrong_task` — the filed `task_id` differs from (or is omitted against, in
  either direction) the recorded one;
- `wrong_phase` — the filed `phase` differs from or is omitted against the
  recorded one;
- `duplicate_conflicting_terminal` — a `grace_days` drift or an
  otherwise-indistinguishable mismatch.

The rejection detail keeps the `conflicting immutable empty retrieval for …`
prefix and names the conflicting axis with the recorded and filed values
(bounded and sanitized). The `knowledge_receipt` tool surfaces the same code
as `reason`, and its description now states that these reasons are permanent:
re-filing the same conflicting identity keeps failing, while re-filing with
the originally recorded `task_id`/`phase` (or the exact same arguments)
succeeds idempotently.

Genuine store failures (an unreadable project root, lock exhaustion, journal
corruption) keep returning `store_unavailable` unchanged — the two classes
are distinguishable by code, and only the store class remains retry-inviting.
The shared receipt-failure classifier used by the phase-complete gate also
learns the three conflict codes as a permanent `RECEIPT_CONFLICT` bucket
whose remedy is re-filing the receipt, never a retry — checked ahead of the
detail-string heuristics so a transient-sounding conflict detail can never be
misrouted to the retry path.

## Why

The misfiled category violated the plugin's failure-channel separation
(AGENTS.md invariant 9): agents reading `store_unavailable` legitimately treat
the failure as a transient store condition and retry, but this conflict is
permanent for the session horizon (default 7-day grace, then compaction
archival) — the only accepted re-file is an exact identity match, i.e.
misattribution. The precise codes already existed in the receipt taxonomy but
were never produced for this class, and no test covered the conflict at all.

## Migration

No breaking changes:

- The immutability rule itself is unchanged — same-arguments retries remain
  idempotent with identical event ids.
- The rejection JSON gains three possible `reason` values (additive; the
  output shape is unchanged).
- No schema, journal-format, keying, or grace-policy change.
