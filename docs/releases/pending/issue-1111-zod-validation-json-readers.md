Sibling JSON readers across council evidence, criteria store, dependency graph, PR evidence, and delegation gate now validate parsed JSON through Zod schemas instead of accepting raw objects. Malformed/corrupt plan and evidence payloads are consistently rejected rather than silently consumed.

Council criteria schema also removed `.passthrough()` to prevent prototype pollution via `__proto__`/`constructor`/`prototype` keys in persisted criteria files.

No migration required.
