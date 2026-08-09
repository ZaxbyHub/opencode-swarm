/**
 * Stable JSON serialization helpers.
 *
 * # Why this exists
 *
 * Several subsystems hash tool-call arguments for repetition / spiral
 * detection. Two requirements make naive `JSON.stringify(value)` incorrect:
 *
 * 1. **Key-order independence.** Two semantically identical objects whose
 *    keys were inserted in different order (`{a:1,b:2}` vs `{b:2,a:1}`) must
 *    hash equally, otherwise a genuine repetition loop whose args happen to
 *    be built with reordered keys is missed.
 *
 * 2. **No nested-key loss.** A `JSON.stringify(value, sortedKeysArray)`
 *    property-list replacer looks like it sorts keys — and it does, but only
 *    for the top level. At every deeper object it acts as a *filter*,
 *    dropping any key not present in the (top-level-derived) list. For nested
 *    args like `{todos:[{content,status}]}` every todo collapses to `{}`,
 *    re-introducing the exact false-collision class this is meant to prevent.
 *
 * `stableCanonicalStringify` rebuilds each object with sorted keys at every
 * depth (no filtering) and serializes arrays element-wise, producing a stable
 * canonical string suitable for hashing.
 *
 * Originally introduced for the adversarial-detector spiral hash
 * (issue #2060) and shared with `file-authority.hashArgs` so both code paths
 * use one correct implementation.
 *
 * This is a canonicalizer for HASH INPUT, not a drop-in `JSON.stringify`
 * replacement — see the "Serialization limits" section on
 * `stableCanonicalStringify` before using it anywhere the output is parsed or
 * shown to a user.
 */

/**
 * Recursively produces a canonical JSON string with object keys sorted at
 * EVERY depth (not just the top level). Arrays are serialized element-wise in
 * index order.
 *
 * Why not `JSON.stringify(value, sortedKeysArray)`: a property-list replacer
 * array acts as a KEY FILTER at every object depth, not just the top level, so
 * any key not in the (top-level-derived) list is silently dropped from nested
 * objects. For tool args like `{todos:[{content,status}]}`, that collapses
 * every todo to `{}`, re-introducing the exact false-collision class this
 * function exists to eliminate. Sorting must be done by rebuilding each object
 * with sorted keys before serialization.
 *
 * ## Serialization limits (#2062 F-008 — deliberate, verified, do not "fix"
 * without re-reading this)
 *
 * - **No `toJSON` support.** `toJSON` is never consulted. A `Date` therefore
 *   collapses to `{}` (it has no own enumerable keys) — a genuine divergence
 *   from `JSON.stringify`, which emits the ISO string.
 * - **`Map`/`Set` collapse to `{}`.** This MATCHES `JSON.stringify` (neither
 *   exposes own enumerable string keys), so it is lossy for both rather than a
 *   divergence between them.
 * - **`undefined` serializes as `null`** in object-property AND array-element
 *   position, so no bare `undefined` token or sparse-array hole is emitted for
 *   it. `JSON.stringify` instead omits an `undefined`-valued property; keeping
 *   the key here is deliberate — two objects differing only by a
 *   present-but-undefined key must not hash equal. True sparse array *holes*
 *   (`[1,,3]`) are NOT covered: `Array.prototype.map` skips holes, so they
 *   still render as `[1,,3]`.
 * - **Function and symbol values still emit a bare `undefined` token**, which
 *   is not valid JSON. It is deterministic, so it is safe as hash input, but
 *   the result is not always `JSON.parse`-able.
 *
 * These limits are safe at every current call site: the cohort fingerprint
 * input is a flat all-primitive struct, and the hook call sites hash tool-call
 * arguments that have already round-tripped through JSON transport, so
 * `Date`/`Map`/`Set`/function values cannot reach them.
 *
 * ## Throwing, and how callers must (and must not) handle it
 *
 * Throws on cyclic structures (infinite recursion) and on values that
 * `JSON.stringify` cannot represent (BigInt). Correct caller handling depends
 * on what the hash is FOR:
 *
 * - **Repetition / spiral-detection callers** (`hashArgsForSpiral` in
 *   `hooks/adversarial-detector.ts`, `hashArgs` in
 *   `hooks/guardrails/file-authority.ts`) SHOULD wrap in try/catch and fall
 *   back to a stable coarse hash. There, a fallback only degrades detection
 *   sensitivity for the one call that failed.
 * - **Identity / fail-closed comparison callers** (e.g.
 *   `computeMemoryCohortFingerprint` in `memory/redaction.ts`) MUST NOT do
 *   that. A constant fallback would collapse every failing input to the same
 *   fingerprint, so two genuinely incompatible cohort members would compare
 *   equal and the fail-closed coherence check would be silently defeated. Let
 *   the throw propagate, or rethrow with added context — never return a
 *   constant.
 */
export function stableCanonicalStringify(value: unknown): string {
	// `undefined` has no JSON token; emit `null` in every position so the
	// output never contains a bare `undefined` or a sparse-array hole.
	if (value === undefined) return 'null';
	if (value === null) return 'null';
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((el) => stableCanonicalStringify(el)).join(',')}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	const entries = keys
		.map((k) => `${JSON.stringify(k)}:${stableCanonicalStringify(obj[k])}`)
		.join(',');
	return `{${entries}}`;
}
