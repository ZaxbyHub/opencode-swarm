# Docs: exact Stage B wording for Turbo and Lean Turbo, and release notes that were never published

## Stage B under Turbo and Lean Turbo

The Turbo and Lean Turbo docs said Stage B (reviewer + test_engineer) runs for
"every task", and the Lean Turbo banner told the architect that every task must
go through full Stage B. The runtime rule is narrower and the same in every
mode: `update_task_status(completed)` applies one Stage B rule whether or not
Turbo or Lean Turbo is active. A task that does not need Stage B without Turbo
(for example, a task in a phase whose `required_agents` leave out the reviewer)
does not need it with Turbo either. Neither mode ever skips Stage B for a task
that needs it.

`docs/modes.md`, `docs/getting-started.md` and the Turbo and Lean Turbo
banners now say that, including for Lean Turbo's degraded and serialized
tasks. The banners are architect prompt text; their instruction is unchanged
in substance (do not skip Stage B for a task that needs it); they no longer
claim more than the gate enforces. The `turbo_mode` config description, the
`/swarm turbo` README row and the README mode table get the same correction.
The config description and the mode table also state that Turbo's early coder
re-dispatch applies only to a non-Tier-3 task whose planned `files_touched`
are known and non-empty.

The phase-wrap skill said "Turbo mode skips all gates automatically". Turbo
makes `phase_complete` bypass the completion-verify, drift-verifier,
hallucination-guard, mutation-gate, phase-council and todo-gate checks, not
every gate: it does not skip the final-review, final-council, full-auto or
architecture-supervisor gates (each still fires only under its own enable and
trigger conditions). The skill now says so, both in its gate-evidence note and
in the drift, hallucination and phase-council steps, which now skip under Turbo
as the mutation step already did.

## Truncated replies fail closed (notes from #3172, not published until now)

These notes describe a fix that shipped in v7.192.3 but were left out of every
release since.

When a reply is cut off by the output limit, the host records it on the
assistant message, either as `info.error` set to `MessageOutputLengthError` or
as `finish: "length"` with the partial text and no `info.error` (the shape a
static check of the OpenCode 1.18.35 binary points to; not yet confirmed
against a live truncated reply). The shared provider-error reader
(`readProviderMessageError`) reports both, the `finish` shape since v7.192.4.
Every consumer that reads a reply through it treats a cut-off reply as a failed
dispatch: the full-auto oversight critic and intercept, the curator and
skill-improver delegates, the ephemeral agent dispatcher, the mutation-test
generator and the Lean integration critic. A reply truncated right after
`VERDICT: APPROVED` therefore no longer reads as an approval. A
`content-filter` finish is handled the same way.

Only the Lean lane runner exempts a cut-off or content-filtered reply, so a
lane keeps the behavior it had before it started reading `info.error`.

The v7.192.4 notes already describe the `finish` half; this section is the
original #3172 change those notes build on.

On OpenCode 2 the `finish` shape fails closed too, now that the v2 adapter
passes `finish` through; the separate OpenCode 2 note (#3634) gives the exact
conditions.

## Correction to the v7.192.3 Lean runner notes

The v7.192.3 notes say that a rate limit (429), quota (402) or server error
(5xx) fails over to the lane's next fallback model, and that an authentication
or configuration refusal (403, `ProviderAuthError`) fails the lane without
failing over. The exact rule: a lane fails over when the formatted provider
error reads as transient. That covers, for example, 429 and 402, quota and
rate-limit messages, timeouts, network errors, an unavailable model, and the
statuses 408, 500, 502, 503, 504 and 529. A lane dispatch timeout and a refused
lane scope handshake never fail over. Other 5xx statuses (501, 505) fail over
only when their message reads as transient, for example "server error" or
"overloaded". An authentication or configuration refusal (403,
`ProviderAuthError`) fails the lane without failing over, unless its message
text itself reads as transient (tracked in #3165 G.6).

## Tests

#3171 added a complement regression suite for the Lean runner's provider-error
handling (`tests/unit/turbo/lean/runner-provider-message-error-3162.test.ts`).
It is test-only; its own fragment is folded into this one.

## Migration

None.
