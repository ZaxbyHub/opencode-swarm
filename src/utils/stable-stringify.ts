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
 * Throws on cyclic structures (infinite recursion) and on values that
 * `JSON.stringify` cannot represent (BigInt); callers should wrap in try/catch
 * and fall back to a stable coarse hash.
 */
export function stableCanonicalStringify(value: unknown): string {
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
