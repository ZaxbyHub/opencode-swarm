export const MAX_MERGE_DEPTH = 10;

/**
 * Keys that must never be merged, at any depth (issue #2476 AC2 / source
 * issue #2264). `JSON.parse` creates `__proto__` as an OWN ENUMERABLE data
 * property (CreateDataProperty, not [[Set]]), so `Object.keys(override)`
 * yields it and the plain assignment below would invoke the
 * `Object.prototype.__proto__` setter and reparent the merged object.
 * `constructor`/`prototype` are the sibling prototype-pollution carriers.
 * Only the OVERRIDE side is checked: that is the untrusted side at every
 * production call site (repo-supplied project config over user config at
 * `src/config/loader.ts`; user scoring config over defaults at
 * `src/config/constants.ts`) — `base` is either caller-built defaults or an
 * already-vetted earlier merge.
 */
export const DANGEROUS_MERGE_KEYS: ReadonlySet<string> = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

/** Typed, fail-closed rejection of a dangerous merge key (issue #2476 AC2). */
export class DangerousMergeKeyError extends Error {
	constructor(
		readonly key: string,
		readonly path: string,
	) {
		super(
			`deepMerge refused dangerous key "${key}" at "${path}": ` +
				'prototype-pollution carriers (__proto__/constructor/prototype) are never merged',
		);
		this.name = 'DangerousMergeKeyError';
	}
}

/**
 * Reject a dangerous key wherever it appears in the override tree. This is a
 * FULL recursive scan, not a merge-path walk: `deepMergeInternal` copies a
 * subtree BY REFERENCE whenever the base side has no matching plain object
 * (the common case for a project config introducing a new section), so a
 * walk that only inspects keys it merges would miss `{"git":{"__proto__":
 * ...}}` against a base of `{}` — measured live while landing #2476 AC2.
 * Arrays are entered too: a hostile JSON payload can nest objects inside
 * array elements. Bounded by MAX_MERGE_DEPTH.
 */
function scanOverrideForDangerousKeys(
	value: unknown,
	path: string,
	depth: number,
): void {
	if (depth >= MAX_MERGE_DEPTH) return;
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			scanOverrideForDangerousKeys(value[i], `${path}[${i}]`, depth + 1);
		}
		return;
	}
	if (typeof value !== 'object' || value === null) return;
	for (const key of Object.keys(value as Record<string, unknown>)) {
		if (DANGEROUS_MERGE_KEYS.has(key)) {
			throw new DangerousMergeKeyError(key, path);
		}
		scanOverrideForDangerousKeys(
			(value as Record<string, unknown>)[key],
			`${path}.${key}`,
			depth + 1,
		);
	}
}

/**
 * Deep merge two objects, with override values taking precedence.
 * Internal implementation with depth tracking to prevent infinite recursion.
 */
function deepMergeInternal<T extends Record<string, unknown>>(
	base: T,
	override: T,
	depth: number,
	path: string,
): T {
	if (depth >= MAX_MERGE_DEPTH) {
		throw new Error(`deepMerge exceeded maximum depth of ${MAX_MERGE_DEPTH}`);
	}

	const result = { ...base } as T;
	for (const key of Object.keys(override) as (keyof T)[]) {
		const baseVal = base[key];
		const overrideVal = override[key];

		if (
			typeof baseVal === 'object' &&
			baseVal !== null &&
			typeof overrideVal === 'object' &&
			overrideVal !== null &&
			!Array.isArray(baseVal) &&
			!Array.isArray(overrideVal)
		) {
			result[key] = deepMergeInternal(
				baseVal as Record<string, unknown>,
				overrideVal as Record<string, unknown>,
				depth + 1,
				`${path}.${key as string}`,
			) as T[keyof T];
		} else {
			result[key] = overrideVal;
		}
	}
	return result;
}

/**
 * Deep merge two objects, with override values taking precedence.
 *
 * Throws `DangerousMergeKeyError` when the override object carries
 * `__proto__`, `constructor`, or `prototype` at ANY depth (issue #2476 AC2).
 * The config loader catches this at the repo-supplied project-config merge
 * and continues with user-level config only; other callers get the typed
 * throw as fail-closed semantics.
 */
export function deepMerge<T extends Record<string, unknown>>(
	base?: T,
	override?: T,
): T | undefined {
	if (!base) return override;
	if (!override) return base;

	scanOverrideForDangerousKeys(override, '$', 0);
	return deepMergeInternal(base, override, 0, '$');
}
