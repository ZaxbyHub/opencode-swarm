# PR review collection no longer kills healthy lanes

`collect_lane_results` is now a pure observer of background PR-review lanes. A caller's wait budget
expiring — including `timeout_ms: 0` — or the OpenCode host messages client being unavailable no
longer writes a terminal failure for work that is still running. Previously either condition
synthesized a durable `error` transition against lanes that were, by the guard's own definition,
still pending or running, so a slow review could be killed by the act of looking at it. The
30-minute presumed-stale sweep is once again the only terminal backstop for an active PR-review
lane, and explicit `cancel_pending` remains the only caller-initiated way to stop one.

Collections that return before every lane settles now report `pending_lanes` — batch id, lane id,
stored status, and an output reference when one exists — regardless of `include_pending`, so
outstanding work can no longer be silently omitted from a result. Host liveness diagnostics are
evaluated on every path that can return pending work, including the missing-client path, and remain
strictly advisory: they never mutate a lane and never stand as evidence of provider failure. The
tool description and PR-review skill guidance now state plainly that a wait budget bounds the
observer call only, and that an expired collection is a reason to poll again, cancel explicitly, or
wait for the stale backstop — never a reason to abort the review.

Within a single collection, the revision context is resolved once per project root and PR head and
shared across every lane settling in that pass, instead of once per lane. The snapshot is local to
the invocation, so a later collection always observes the working tree afresh, and publication-time
validation still re-verifies the active revision independently. When the snapshot cannot be
resolved within budget the affected lanes stay pending with an explicit diagnostic instead of
failing silently, and a slow resolution for one lane can no longer starve the others. A transcript
fetch that fails outright — a transport error rather than a budget timeout — is likewise reported
rather than leaving a silently pending lane.

Collection diagnostics are redacted and bounded. The cause attached to a pending lane is routed
through the same failure-evidence redactor the guardrail circuit already uses, so a provider or host
error carrying a credentialed URL, an API key, or a command line no longer reaches the collection
result verbatim, and each diagnostic channel is bounded independently so a flood of host-call
timeouts cannot crowd out the per-lane cause an operator needs. Diagnostics are also
tracked per lane rather than per message, so one lane's error text can no longer retire another
lane's diagnostic.

Staged canary/fanout PR-review resilience (`pr_review_resilience`) now defaults to disabled while
the wider PR-review repair program is in progress; projects that set `enabled: true` keep the staged
behavior unchanged.

One behavior is intentionally left for a follow-up: a lane that wedges without ever producing output
now reaches a terminal state without a typed failure class, so the five-of-six partial-coverage
disclosure is unavailable for that specific case until terminal N-of-6 completion lands. Normal
six-of-six completion is unaffected, as is partial coverage driven by a contract or resource failure
classified from a lane's own output. Collection no longer classifies a lane from observer transport
failure at all, which is the intended consequence of treating collection as a pure observer.
