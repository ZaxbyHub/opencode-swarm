- Bounded PR-monitor persistence now uses an atomic checkpoint plus a bounded audit tail, so long-lived subscription history can no longer grow without limit.
- Legacy migration and recovery now converge within explicit byte and work budgets, preserve native baselines, quarantine copied foreign state, and handle archive rollback/retry cases safely.
- The `/swarm pr status` storage diagnostics and related configuration docs were updated to describe the bounded store behavior, and the PR-monitor regression suite was expanded to cover adversarial I/O, migration, health, checkpoint, multiprocess, and hardening cases.

No migration is required for users. The change is internal to PR-monitor storage behavior and diagnostics.

Known caveat: large pre-existing legacy stores are now folded incrementally under bounded work budgets, so the first read after upgrade may perform a short catch-up step before the bounded checkpoint becomes the primary source of truth.
