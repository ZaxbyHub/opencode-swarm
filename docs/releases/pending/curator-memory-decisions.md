### Curator-approved memory decisions

Pending Swarm memory proposals can now be applied through a schema-validated curator decision path. Normal agents still only create pending proposals; curator decisions are applied by the gateway/provider, update proposal status durably, log each decision event, and atomically mutate SQLite memory rows for add, update, supersede, reject, and noop decisions.
