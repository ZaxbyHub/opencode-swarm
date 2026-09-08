# PR-review transition authority settlement (#2512)

The PR-review transition contract now distinguishes the six reducer events
that are actually produced by registered workflow adapters from ten historical
event names that had no production creator. An exhaustive authority registry
keeps both sets classified and names the stronger replacement authority for
retired lifecycle names.

Registered rollback, collection observation, structured result receipts,
resilience circuit advance/probe handling, and resilience configuration paths
now have focused state/effect, stale, and replay coverage. Structured results
remain child-bound and exactly-once: an accepted receipt is durable before a
later terminal delegation settlement, while conflicting or stale submissions
fail closed. Collection timeouts and host-client absence remain diagnostics,
not invented lane failures.

The lifecycle documentation records the lock/CAS and ledger authorities for
PR_REVIEW completion, PR_FEEDBACK publication, reviewer authorization, critic
composition, coverage, and armed recovery. No second durable projection or
new persistence migration is introduced.
