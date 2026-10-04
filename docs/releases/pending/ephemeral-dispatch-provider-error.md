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
- a structured `providerError` field lets callers recognise the refusal.

Because the message now says what happened, the evaluation dispatcher's
transient-vs-permanent classifier can retry rate limits and similar errors.

## Why

Found in a live run on the OpenCode Zen free tier: every `bash:false` review
dispatch was refused with HTTP 403. The callers saw "the reviewer said nothing"
and failed with no indication of the cause.
