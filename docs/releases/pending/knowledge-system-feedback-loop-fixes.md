Fixes several knowledge feedback-loop correctness issues: injected critical
directive gate state now reflects only rendered directive records, phase-start
knowledge cache keys include the latest user prompt, stale critical gate state is
cleared on preamble-only injection, hive `knowledge_query` results honor
`knowledge.scope_filter`, verdict feedback markers advance to processed event
timestamps, and same-session knowledge acknowledgments survive UTC day changes.
