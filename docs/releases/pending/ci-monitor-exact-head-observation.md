# Exact-head CI and merge-queue observations

Swarm CI Monitor records all available check-run pages for the selected PR head
and marks the observation incomplete when pagination or revision identity cannot
be verified. A known merge-queue run can be recorded separately with its own SHA
and status. Terminal merge reporting requires the PR's merge commit and
independent Git evidence on the target base.

The monitor still uses the repository's required-check and merge authorization
rules. MCP-only hosts need a paginated check-run read and independent Git proof
for the corresponding observations.
