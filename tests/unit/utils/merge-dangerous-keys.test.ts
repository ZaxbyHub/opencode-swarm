import { describe, expect, test } from 'bun:test';
import type { ScoringConfig } from '../../../src/config/constants';
import { resolveScoringConfig } from '../../../src/config/constants';
import {
	DANGEROUS_MERGE_KEYS,
	DangerousMergeKeyError,
	deepMerge,
} from '../../../src/utils/merge';

/**
 * Issue #2476 AC2 (source issue #2264): deepMerge must reject
 * __proto__/constructor/prototype at every depth. Payloads are built via
 * JSON.parse from raw text — an object literal `{ __proto__: ... }` sets the
 * prototype instead of creating the own enumerable key and does NOT
 * reproduce the defect (measured in the #2261 security review).
 */
describe('deepMerge dangerous-key rejection (#2476 AC2)', () => {
	test('rejects top-level __proto__ with the typed error', () => {
		const hostile = JSON.parse(
			'{"git":{"__proto__":{"binary":"/evil"}}}',
		) as Record<string, unknown>;
		expect(() =>
			deepMerge({ git: {} } as Record<string, unknown>, hostile),
		).toThrow(DangerousMergeKeyError);
	});

	test('the pre-fix reparenting payload is closed: hostile value unreadable', () => {
		const hostile = JSON.parse(
			'{"git":{"__proto__":{"binary":"/evil"}}}',
		) as Record<string, unknown>;
		let merged: Record<string, unknown> | undefined;
		let threw = false;
		try {
			merged = deepMerge(
				{ git: {} } as Record<string, unknown>,
				hostile,
			) as Record<string, unknown>;
		} catch (err) {
			threw = err instanceof DangerousMergeKeyError;
		}
		// Either the typed throw fired, or the hostile value must NOT be
		// readable on the result (fail-closed on both arms).
		expect(threw || merged?.git?.binary === undefined).toBe(true);
	});

	test('rejects __proto__ at depth 3', () => {
		const hostile = JSON.parse('{"a":{"b":{"__proto__":{"x":1}}}}') as Record<
			string,
			unknown
		>;
		expect(() =>
			deepMerge({ a: { b: {} } } as Record<string, unknown>, hostile),
		).toThrow(/dangerous key "__proto__" at "\$.a.b"/);
	});

	test('rejects constructor and prototype keys', () => {
		const ctor = JSON.parse('{"constructor":{"prototype":{"y":2}}}') as Record<
			string,
			unknown
		>;
		expect(() => deepMerge({}, ctor)).toThrow(DangerousMergeKeyError);
		const proto = JSON.parse('{"o":{"prototype":{"z":3}}}') as Record<
			string,
			unknown
		>;
		expect(() =>
			deepMerge({ o: {} } as Record<string, unknown>, proto),
		).toThrow(DangerousMergeKeyError);
	});

	test('Object.prototype is not polluted by any payload', () => {
		const before = Object.keys(Object.prototype).length;
		const payloads = [
			'{"__proto__":{"polluted":true}}',
			'{"a":{"__proto__":{"polluted":true}}}',
			'{"constructor":{"prototype":{"polluted":true}}}',
		];
		for (const raw of payloads) {
			try {
				deepMerge({}, JSON.parse(raw) as Record<string, unknown>);
			} catch {
				// typed rejection is the expected arm
			}
		}
		expect(Object.keys(Object.prototype).length).toBe(before);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test('benign nested override semantics are unchanged', () => {
		const base = { a: { x: 1, keep: true }, b: 2 } as Record<string, unknown>;
		const override = { a: { x: 2 }, c: 3 } as Record<string, unknown>;
		const merged = deepMerge(base, override) as Record<string, unknown>;
		expect(merged).toEqual({ a: { x: 2, keep: true }, b: 2, c: 3 });
		// base immutability
		expect(base.a).toEqual({ x: 1, keep: true });
	});

	test('array replacement and undefined-operand passthrough unchanged', () => {
		expect(deepMerge({ l: [1, 2] }, { l: [3] })).toEqual({ l: [3] });
		expect(deepMerge(undefined, { k: 1 })).toEqual({ k: 1 });
		expect(deepMerge({ k: 1 }, undefined)).toEqual({ k: 1 });
	});

	test('DANGEROUS_MERGE_KEYS exports exactly the three carriers', () => {
		expect([...DANGEROUS_MERGE_KEYS].sort()).toEqual([
			'__proto__',
			'constructor',
			'prototype',
		]);
	});

	test('resolveScoringConfig: the throw is reachable when Zod is bypassed (plan B6)', () => {
		// A hand-built object bypassing the surrounding schema parse is the
		// only route to resolveScoringConfig's deepMerge with a dangerous
		// key — proving the typed throw there is live fail-closed surface,
		// not dead code, which is why no downstream catch exists.
		const bypass = JSON.parse(
			'{"__proto__":{"weight":9}}',
		) as unknown as ScoringConfig;
		expect(() => resolveScoringConfig(bypass)).toThrow(DangerousMergeKeyError);
	});
});
