## Follow-through for issue #2104: status help + init-bound acceptance tests

Documentation- and test-only follow-through on the background-work visibility shipped for
issue #2104. No runtime behavior changes — the opt-in status section itself landed earlier in
this release cycle.

### `/swarm status` help now mentions the opt-in section

The `status` command (and its deprecated `info` alias) description now reads "Show current
swarm state (plus background-work health when hooks.background_subagents is enabled)", and
`docs/commands.md` documents what the opt-in Background Work section shows: delegation counts
by status, active coder reservations with generation/lease state, the durable maintenance
summary, and the `Source: validated recovery (bounded scan)` provenance label — with typed
`⚠ State uncertain: …` output when a store is corrupt or over its recovery bound. Disabled
(default) configurations still see no section and schedule no maintenance.

### Init-bound acceptance tests for the #2104 maintenance wiring

New tests pin the post-init maintenance contract from the issue's acceptance list: the
deferred post-init pass is registered only when `hooks.background_subagents` is enabled, runs
strictly after plugin-server resolution on the wrapper-owned post-resolution queue, and fails
open when maintenance storage is corrupt (the failure is recorded durably in the health
artifact's maintenance ring instead of surfacing at init). A third test drives a terminal
session event through the real plugin event hook and proves the session-close maintenance
point fires. The deferred task is now named (`backgroundMaintenancePostInitTask`) so the
wiring stays addressable by tests, matching the existing deferred-task pattern.
