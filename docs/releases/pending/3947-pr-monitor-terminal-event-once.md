# PR monitor: emit terminal PR events once

## What

`pr.merged` and `pr.closed` were re-emitted on every poll cycle while a PR
stayed in a terminal state and its subscription lingered (for example when the
subscription store refused writes because it was over capacity). One merged PR
produced 7+ duplicate `pr.merged` deliveries.

The PR monitor worker now dedupes the terminal event with an in-memory latch,
so each terminal event is emitted at most once per worker lifetime. The latch
only gates the event: sweep tracking and the auto-unsubscribe retry still run
every cycle while the PR is terminal, so a refused or timed-out cleanup is
retried without re-emitting. The latch is cleared when the PR is seen open
again (reopen), after a successful auto-unsubscribe, and on worker stop. A
single re-emit after a worker restart is expected.

## Compatibility

No configuration, schema, or event payload changes. The `auto_unsubscribe_on_merge`
and `auto_unsubscribe_on_close` flags are unchanged.

## Credit

Fix originally proposed by @thehaven in #3947.
