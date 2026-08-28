# Background coder settlement ownership transfer

Coder Tasks that a host reclassifies as background work now transfer any matching foreground settlement record to the durable background completion owner. This prevents a completed, failed, or cancelled background coder from leaving a legacy `DISPATCHED` record that permanently blocks task status updates, Stage A attribution, recovery, and later task dispatches.

The transfer is exact-call and exact-task scoped, survives process restarts, and leaves ambiguous attribution fail-closed. Transient Windows lock/permission errors use bounded retry and a durable reconciliation marker; maintenance replays the trusted terminal after the WAL becomes writable again. For worktree-backed coders, the background completion record remains the sole merge and cleanup owner, preventing duplicate cleanup or lane loss. No configuration or migration step is required.
