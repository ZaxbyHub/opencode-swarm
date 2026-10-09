# Fix: Lean Turbo lanes fail on a provider refusal instead of completing as if answered

## What

OpenCode answers `session.prompt` with HTTP 200 even when the model provider
refused or failed the request (an HTTP 403 refusal, a 429 rate limit, an
exhausted quota). The failure is recorded on the assistant message as
`info.error`, and the message has no text.

The Lean Turbo lane runner only checked that the prompt returned data, so it
treated such a lane as a successful coder answer and never tried the lane's
model-fallback chain. It now reads `info.error` through the shared provider
error reader and, on a provider error, takes its existing failure path: the
lane's session is aborted and torn down and the lane reports a failure whose
message names the provider error (for example `APIError (HTTP 403): …`).

What happens next depends on the error, through the lane's existing
transient-vs-permanent classification: a rate limit (429), quota (402) or
server error (5xx) is transient and fails over to the lane's next fallback
model, while an authentication or configuration refusal (403,
`ProviderAuthError`) is permanent and fails the lane without failing over.

A truncated reply (`MessageOutputLengthError`) is not treated as a refusal by
the runner; it keeps the behavior it had before.

## Why

Follow-up from the #3146 review (finding F-05): the other `session.prompt`
consumers were moved onto the shared reader there, and the lane runner was the
one left out.
