---
issue: 2964
---

## A slow or unreachable host no longer converts an unverified ephemeral-session teardown into a false success

The verified ephemeral-session teardown (`teardownEphemeralSessionVerified`)
no longer counts a verify-timeout or a transient transport failure as
confirmed session death. Previously, a `session.get` that hung past the verify
deadline (2 s default) or died with a transport error (connection reset, fetch
failure) was caught and reported as "session gone", so the wrapper returned
`{ok: true}` — a death claim that was never proven — and the #2599
leaked-session advisory (`WORKTREE_RECOVERY_CHILD_SESSION_LEAKED`) and the
stranded-lane reclaim were silently suppressed.

The existence check now returns a three-state verdict: only a confirmed-gone
signal (empty body, or a rejection that is neither the constructed verify
deadline error nor transport-class) verifies teardown; timeouts (distinguished
by error identity) and transport-class rejections produce the existing typed
`ephemeral-session-teardown-unverified` failure with reason
`verify-unreadable`. Under the OpenCode 2 host, where the session shim
normalizes host rejections to `{data: null, error}` envelopes, a transport
error in that envelope is classified the same way instead of falling through
the empty-body path as "gone". Confirmed-gone behavior is unchanged: empty
body still verifies, and hosts that throw on 404 still verify via the
rejection path.
