# Fix: inherited-key lookups in lean-turbo scopes and /swarm concurrency, and numeric-entity decoding in web-fetch

## What changed

Same-class follow-ups to the `web_fetch` entity-decode fix, surfaced during review of that fix and closed in the same change set:

- `runPartitionPreflight` (`src/turbo/lean/partition-common.ts`) checked a caller-supplied `scopes` map with `task.id in scopes`. A plan task whose id was an inherited `Object.prototype` name (for example `constructor`) resolved to the `Object` function instead of a file list, and the planner threw `TypeError: ... is not iterable`. The lookup now uses `Object.hasOwn(scopes, task.id)`; a task id that is an own key of `scopes` still uses its declared scope, and any other id falls through to the normal undeclared-scope path (`.swarm/scopes/` file, then `files_touched` when `require_declared_scope` is false, otherwise the serialized no-scope path).
- `/swarm concurrency set <value>` (`src/commands/concurrency.ts`) checked presets with `normalizedValue in PRESETS`. `constructor` or `__proto__` matched, and the `Object` function was stored as the session concurrency override. The check now uses `Object.hasOwn(PRESETS, normalizedValue)`, so those inputs are rejected as invalid values.
- `decodeEntities` (`src/tools/web-fetch.ts`) now matches decimal references with `#[0-9]+` and hex references with `#x[0-9a-f]+`. Previously a decimal reference containing hex letters, such as `&#1e5;` or `&#12ab;`, was truncated by `parseInt` and silently dropped characters; it is now left as literal text. Numeric references that are NUL, a surrogate, or beyond U+10FFFF decode to U+FFFD (as the HTML spec specifies) instead of emitting a control character or lone surrogate, or vanishing. A digit run so long that it overflows to Infinity (hundreds of digits) is still left as literal text rather than decoded.

## Why

All three are the same class of bug as the main fix: a lookup or parse that accepts input it should reject, on values that originate from untrusted HTML or operator input. They sit next to the code the main fix touches, so they are closed here rather than left open.

## Impact

- `/swarm concurrency set constructor` (and similar) now returns the invalid-value message instead of storing a function.
- A pending lean-turbo task with a non-standard id such as `constructor` no longer fails planning when an explicit `scopes` map is supplied.
- `web_fetch` text no longer loses characters after a malformed decimal reference, and no longer carries NUL or lone-surrogate characters from numeric references.
- Declared scopes keyed by real task ids, real concurrency presets, and well-formed numeric references behave exactly as before.

## Migration

No migration required.
