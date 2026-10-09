# Fix: a reply the host cut off by finish reason now fails closed in the provider-error consumers

## What

When the model's reply is cut off by the output limit, the host can record
that as `finish: "length"` on the assistant message, with the partial text and
no `info.error`. The same holds for a reply withheld by the content filter
(`finish: "content-filter"`). The shared provider-error reader
(`readProviderMessageError`) only read `info.error`, so a reply truncated right
after `VERDICT: APPROVED` reached the full-auto oversight critic, the reactive
critic, the curator and skill-improver delegates, the ephemeral agent
dispatcher, the mutation-test generator and the Lean integration critic as an
approval.

The reader now reports an early `finish` of `length` (as
`MessageOutputLengthError`) or `content-filter` (as `MessageContentFilterError`)
when `info.error` is absent, and those consumers treat it as a failed dispatch.
`info.error` still takes precedence when both are present.

The Lean lane runner exempts both, so a lane keeps the behavior it had before
it started reading `info.error`.

## Why

Found by the independent review of the truncated-reply fix, which checked the
host binary and found no code that sets `MessageOutputLengthError` on a
truncated reply.
