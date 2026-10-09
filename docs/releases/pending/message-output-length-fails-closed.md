# Fix: a truncated model reply fails closed again in the provider-error consumers

## What

When a model reply is cut off by the output limit, OpenCode answers HTTP 200
with `info.error` set to `MessageOutputLengthError` and whatever text was
produced so far. The shared provider-error reader (`readProviderMessageError`)
reports that error, and every consumer that reads a reply through it treats it
as a failed dispatch: the full-auto oversight critic and the reactive critic,
the curator and skill-improver delegates, the ephemeral agent dispatcher, the
mutation-test generator and the Lean integration critic.

An earlier change (the Lean runner provider-error fix) made the shared reader
treat this error as "no error". That let an empty or cut-off reply through those
consumers, including a reply truncated right after `VERDICT: APPROVED`, which
the oversight and review parsers read as an approval. The shared reader is back
to reporting the error, and a regression test pins it for the reader and for
the oversight gate.

Only the Lean lane runner exempts `MessageOutputLengthError`, so a lane keeps
the behavior it had before it started reading `info.error`. A text-aware rule
(fail only when the reply has no usable text) is tracked in #3165.

The Lean runner's provider-error fragment is also corrected: an authentication
or configuration refusal (403, `ProviderAuthError`) fails the lane without
failing over to the next model; only rate-limit, quota and server errors
(429, 402, 5xx) fail over.

## Why

Found by the swarm review of the Lean runner change. The one-line reader change
was outside that fix's scope and made truncated replies pass gates that failed
closed before it.
