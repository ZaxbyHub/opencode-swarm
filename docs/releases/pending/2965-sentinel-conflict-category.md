# Fix: sentinel receipt conflicts report their real reason, not `store_unavailable`

## What

Filing a second `knowledge_receipt` with `trace_id: "none"` (the no-retrieval
sentinel) in the same session used to be rejected as `store_unavailable` —
the retry-inviting infrastructure category — even though the rejection is a
permanent, deterministic identity conflict: within one session the first
`"none"` receipt fixes the recorded `task_id`/`phase` (and grace window), and
every later filing that disagrees conflicts with the immutable record.

The conflict is now reported with the precise, actionable reason from the
existing receipt taxonomy:

- `wrong_task` — the filed `task_id` differs from (or is omitted against, in
  either direction) the recorded one;
- `wrong_phase` — the filed `phase` differs from or is omitted against the
  recorded one;
- `duplicate_conflicting_terminal` — the recorded grace window no longer
  matches. Task and phase agree in this case; the trigger is a change to the
  `knowledge.receipt_close_grace_days` setting between the two filings, so
  re-filing cannot resolve it — an operator restores the original setting.

The rejection detail keeps the `conflicting immutable empty retrieval for …`
prefix and names the conflicting axis with the recorded and filed values.
Every interpolated value is sanitized through the same single-line diagnostic
sanitizer used elsewhere in the plugin (control and bidirectional characters
become `?`), truncated on code-point boundaries with a visible `…` marker
when over the per-field budget, and the axis sentence is budgeted to survive
in full. The `knowledge_receipt` tool surfaces the same code as `reason`, and
its description now distinguishes the two cases: `wrong_task`/`wrong_phase`
are fixed by re-filing with the originally recorded `task_id`/`phase`
(idempotent), while `duplicate_conflicting_terminal` is not fixable by
re-filing at all.

Genuine store failures keep their existing codes unchanged — lock exhaustion
still returns `lock_timeout`, journal corruption `store_corrupt`, and
unclassified I/O failures `store_unavailable` — so the permanent-conflict
class and the store class stay distinguishable by code, and only the store
class invites retry. The phase-complete gate's receipt-failure classifier
recognizes the three conflict codes as a permanent `RECEIPT_CONFLICT` bucket
— checked ahead of the detail-string heuristics for both the ledger result
shape and the validator's rejection shape. Its recovery points at the
`knowledge_receipt` tool for the `wrong_task`/`wrong_phase` arms (re-file
with the recorded identity); the `duplicate_conflicting_terminal` grace arm
is named as operator-actionable, since re-filing cannot resolve it.

## Why

The misfiled category violated the plugin's failure-channel separation
(AGENTS.md invariant 9): agents reading `store_unavailable` legitimately treat
the failure as a transient store condition and retry, but the task/phase
conflicts are permanent for the session horizon. The precise codes already
existed in the receipt taxonomy but were never produced for this class, and no
test covered the conflict at all.

## Migration

No breaking changes:

- The immutability rule itself is unchanged — same-arguments retries remain
  idempotent with identical event ids as long as the resolved grace window is
  unchanged.
- The rejection JSON's `reason` value on this path changes from
  `store_unavailable` to one of the three precise codes (the output shape is
  unchanged; the codes already existed in the receipt taxonomy).
- No schema, journal-format, keying, or grace-policy change.
