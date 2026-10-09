# Fix: review dispatches report the provider's refusal instead of an empty answer

## What

OpenCode answers `session.prompt` with HTTP 200 even when the model provider
refused the request. The refusal is recorded on the assistant message as
`info.error`, and the message has no text. `dispatchEphemeralAgent` only read
the text parts, so it reported such a dispatch as `completed` with empty text.
This affected every review, validation and evaluation dispatch built on it.

It now returns `status: 'error'` in that case:
- the error message gives the provider error's name, HTTP status and message
  (e.g. `APIError (HTTP 403): …`);
- a structured `providerError` field lets callers recognise the refusal. It
  carries the failure category from the shared provider classifier (e.g.
  `provider.rate_limit`), and its message is the classifier's bounded,
  redacted display text, never the provider's raw text.

Because the message now says what happened, the evaluation dispatcher's
transient-vs-permanent classifier can retry rate limits and similar errors.

The other callers of `session.prompt` that read only the text parts now read
`info.error` through the same shared reader and treat it as a failed dispatch,
so their existing retry and model-fallback paths handle a 429 or quota error:
- the full-auto oversight critic and the reactive full-auto critic, which
  used to turn the empty response into a synthetic `NEEDS_REVISION` verdict;
- the Lean Turbo phase critic, the curator and skill-improver delegates, and
  the mutation-test generator, which used to treat it as an empty answer.

The Epic phase review now retries with `bash` re-enabled only for an
authentication/configuration refusal (the HTTP 403 class that re-enabling
`bash` can cure). A rate limit, quota or outage error goes straight to the
model-fallback chain.

## Why

Found in a live run on the OpenCode Zen free tier: every `bash:false` review
dispatch was refused with HTTP 403. The callers saw "the reviewer said nothing"
and failed with no indication of the cause.
