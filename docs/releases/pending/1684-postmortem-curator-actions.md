# Issue 1684: Execute curator post-mortem actions

- `CURATOR_POSTMORTEM` output now has an explicit `postmortem_actions` JSON fence contract. Parsed summaries are returned to the architect instead of being replaced by mechanical counts.
- Post-mortem curation recommendations now execute through the existing knowledge update and hive promotion paths, while proposal triage is limited to the proposal IDs named by the post-mortem output.
- `/swarm post-mortem` supports `--scope session|project`, and `/swarm curate` runs an on-demand curator pass when session context is available.
- Finalize now archives and cleans generated post-mortem reports and advisory drift reports after they are safely copied into the close bundle.
