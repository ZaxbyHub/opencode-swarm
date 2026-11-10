# Fix: on OpenCode 2, a reply cut off by the output limit or the content filter fails closed

## What

On OpenCode 2 the v2 adapter rebuilt each reply's v1 `info` from the model ids
only and dropped the assistant entry's `finish`. The shared provider-error
reader (`readProviderMessageError`) reports a reply the host ended early
(`finish: "length"` as `MessageOutputLengthError`, `finish: "content-filter"`
as `MessageContentFilterError`) only when it can see `finish`, so on OpenCode 2
such a reply read as a clean success. A reply truncated right after
`VERDICT: APPROVED` could therefore pass the full-auto oversight critic and the
other consumers of the shared reader there, while the same reply failed closed
on OpenCode 1 (since v7.192.4).

The adapter now copies the `finish` of the last assistant entry of the final
turn onto `info`, matching v1, where the reply's `info.finish` is the last
step's. Every consumer of the shared reader now treats a cut-off or filtered
reply as a failed dispatch on both hosts. The Lean lane runner keeps its
existing exemption for a reply whose `finish` is `length` or `content-filter`.

Not changed: when OpenCode 2 reports the cut-off as a failed step
(`session.execution.failed`, a recorded error), the adapter still takes its
recorded-error path, which fails closed under the recorded error's own name,
so the Lean runner's exemption does not apply there.

Unchanged: a reply that ends with `finish: "stop"`, `"tool-calls"`, `"error"`
or `"unknown"` (the reader ignores those values), so an empty completed reply
is still the provider-refusal signal the Epic phase-review bash retry reads.
A truncated step earlier in the turn does not fail a turn whose last step
finished normally.

## Why

Tracked in #3165 G.8: #3175 closed this on OpenCode 1, but the v2 adapter never
carried the field. `finish` is part of the OpenCode 2 assistant entry
(`SessionMessageAssistant` in `@opencode/client` 2.0.26 through 2.2.7).

## Migration

None.
