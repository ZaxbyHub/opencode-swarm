/**
 * #2062 F-007: coverage for `stableCanonicalStringify`, which had none.
 *
 * The function is a canonical-JSON hash-input builder shared by the
 * adversarial-detector spiral hash, `file-authority.hashArgs`, and the memory
 * cohort fingerprint. Two things must be pinned: the guarantees callers rely
 * on (key-order independence at every depth, no nested-key loss), and the
 * documented LIMITS (Date/Map/Set collapse, sparse holes, function values) so
 * that changing any of them is a deliberate, visible decision.
 */

import { describe, expect, test } from 'bun:test';
import { stableCanonicalStringify } from '../../../src/utils/stable-stringify';

describe('stableCanonicalStringify — key-order independence', () => {
	test('top-level key order does not change the output', () => {
		expect(stableCanonicalStringify({ a: 1, b: 2 })).toBe(
			stableCanonicalStringify({ b: 2, a: 1 }),
		);
	});

	test('keys are emitted in sorted order', () => {
		expect(stableCanonicalStringify({ b: 2, a: 1, c: 3 })).toBe(
			'{"a":1,"b":2,"c":3}',
		);
	});

	test('nested object key order does not change the output at depth 3', () => {
		const first = { z: { y: { x: 1, w: 2 }, v: 3 }, u: 4 };
		const second = { u: 4, z: { v: 3, y: { w: 2, x: 1 } } };
		expect(stableCanonicalStringify(first)).toBe(
			stableCanonicalStringify(second),
		);
		expect(stableCanonicalStringify(first)).toBe(
			'{"u":4,"z":{"v":3,"y":{"w":2,"x":1}}}',
		);
	});

	test('objects differing in value, not order, still differ', () => {
		expect(stableCanonicalStringify({ a: 1, b: 2 })).not.toBe(
			stableCanonicalStringify({ a: 1, b: 3 }),
		);
	});
});

describe('stableCanonicalStringify — regression: nested keys inside arrays (#2060)', () => {
	test('objects inside arrays keep every key', () => {
		// Previous code used `JSON.stringify(value, Object.keys(value).sort())`.
		// A property-list replacer acts as a KEY FILTER at every depth, so each
		// todo collapsed to `{}` and unrelated todo lists hashed identically.
		const args = {
			todos: [
				{ content: 'write the fix', status: 'pending' },
				{ content: 'run the tests', status: 'in_progress' },
			],
		};
		const out = stableCanonicalStringify(args);
		expect(out).toBe(
			'{"todos":[{"content":"write the fix","status":"pending"},' +
				'{"content":"run the tests","status":"in_progress"}]}',
		);
		expect(out).not.toContain('{}');
	});

	test('two different todo lists do not collide', () => {
		const a = { todos: [{ content: 'alpha', status: 'pending' }] };
		const b = { todos: [{ content: 'beta', status: 'pending' }] };
		expect(stableCanonicalStringify(a)).not.toBe(stableCanonicalStringify(b));
	});

	test('nested-in-array objects are key-sorted too', () => {
		expect(stableCanonicalStringify([{ b: 1, a: 2 }])).toBe(
			stableCanonicalStringify([{ a: 2, b: 1 }]),
		);
	});

	test('array order is preserved (arrays are not sorted)', () => {
		expect(stableCanonicalStringify([1, 2])).not.toBe(
			stableCanonicalStringify([2, 1]),
		);
	});
});

describe('stableCanonicalStringify — undefined and null (#2062 F-008)', () => {
	test('regression: undefined object property serializes as null', () => {
		// Previous code emitted the bare token `undefined` here, producing
		// `{"a":undefined}` — not parseable JSON.
		expect(stableCanonicalStringify({ a: undefined })).toBe('{"a":null}');
	});

	test('regression: undefined array element serializes as null', () => {
		// Previous code produced `[1,,3]`: the element stringified to the JS
		// value `undefined`, which `Array.prototype.join` renders as empty.
		expect(stableCanonicalStringify([1, undefined, 3])).toBe('[1,null,3]');
	});

	test('a present-but-undefined key is distinguishable from an absent key', () => {
		// Deliberately stricter than JSON.stringify (which drops the property):
		// two objects that differ by key presence must not hash equal.
		expect(stableCanonicalStringify({ a: undefined })).not.toBe(
			stableCanonicalStringify({}),
		);
	});

	test('top-level undefined serializes as null', () => {
		expect(stableCanonicalStringify(undefined)).toBe('null');
	});

	test('null is preserved in every position', () => {
		expect(stableCanonicalStringify(null)).toBe('null');
		expect(stableCanonicalStringify({ a: null })).toBe('{"a":null}');
		expect(stableCanonicalStringify([null])).toBe('[null]');
	});

	test('documented limit: true sparse holes are NOT converted to null', () => {
		// `Array.prototype.map` skips holes, so a genuine hole survives as an
		// empty slot. JSON.stringify would emit `[1,null,3]`. Unreachable at
		// every current call site; pinned so a change here is deliberate.
		const sparse: unknown[] = new Array(3);
		sparse[0] = 1;
		sparse[2] = 3;
		expect(1 in sparse).toBe(false); // index 1 is a genuine hole
		expect(stableCanonicalStringify(sparse)).toBe('[1,,3]');
		expect(JSON.stringify(sparse)).toBe('[1,null,3]');
	});
});

describe('stableCanonicalStringify — primitives, empties, and key escaping', () => {
	test('empty object and empty array', () => {
		expect(stableCanonicalStringify({})).toBe('{}');
		expect(stableCanonicalStringify([])).toBe('[]');
	});

	test('primitive scalars match JSON.stringify', () => {
		expect(stableCanonicalStringify(0)).toBe('0');
		expect(stableCanonicalStringify(-1.5)).toBe('-1.5');
		expect(stableCanonicalStringify(true)).toBe('true');
		expect(stableCanonicalStringify(false)).toBe('false');
		expect(stableCanonicalStringify('')).toBe('""');
		expect(stableCanonicalStringify('hi')).toBe('"hi"');
	});

	test('unicode keys and values round-trip through JSON.parse', () => {
		const out = stableCanonicalStringify({
			日本語: 'café ☕',
			ключ: 'значение',
		});
		expect(JSON.parse(out)).toEqual({ 日本語: 'café ☕', ключ: 'значение' });
	});

	test('keys needing escapes are escaped, and sorting is by raw key', () => {
		const out = stableCanonicalStringify({
			'quote"key': 1,
			'back\\slash': 2,
			'new\nline': 3,
		});
		expect(out).toBe('{"back\\\\slash":2,"new\\nline":3,"quote\\"key":1}');
		expect(JSON.parse(out)).toEqual({
			'quote"key': 1,
			'back\\slash': 2,
			'new\nline': 3,
		});
	});

	test('a literal __proto__ key is serialized as an ordinary key', () => {
		// Object.keys sees an own `__proto__` data property created via a literal
		// only when defined with defineProperty / JSON.parse — assignment would
		// hit the setter. Use JSON.parse to build a real own key.
		const obj = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
		const out = stableCanonicalStringify(obj);
		expect(out).toBe('{"__proto__":{"polluted":true},"safe":1}');
		// The serializer must not have mutated Object.prototype.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test('a __proto__-shaped key does not collide with a normal key', () => {
		const a = JSON.parse('{"__proto__": 1}');
		const b = { proto: 1 };
		expect(stableCanonicalStringify(a)).not.toBe(stableCanonicalStringify(b));
	});
});

describe('stableCanonicalStringify — documented throwing behavior', () => {
	test('throws on a self-referential object', () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		expect(() => stableCanonicalStringify(cyclic)).toThrow();
	});

	test('throws on a cycle through an array', () => {
		const arr: unknown[] = [1];
		arr.push(arr);
		expect(() => stableCanonicalStringify(arr)).toThrow();
	});

	test('throws on BigInt', () => {
		expect(() => stableCanonicalStringify({ n: 1n })).toThrow(TypeError);
	});
});

describe('stableCanonicalStringify — documented lossy limits (#2062 F-008)', () => {
	test('Date collapses to {} — a genuine divergence from JSON.stringify', () => {
		// toJSON is never consulted, and a Date has no own enumerable keys.
		const d = new Date('2020-01-02T03:04:05.000Z');
		expect(stableCanonicalStringify({ d })).toBe('{"d":{}}');
		expect(JSON.stringify({ d })).toBe('{"d":"2020-01-02T03:04:05.000Z"}');
	});

	test('a custom toJSON is ignored', () => {
		const withToJson = { toJSON: () => 'ignored', real: 1 };
		// The toJSON function itself is serialized as a value, not invoked.
		expect(stableCanonicalStringify({ v: withToJson })).toBe(
			'{"v":{"real":1,"toJSON":undefined}}',
		);
	});

	test('Map and Set collapse to {} — this MATCHES JSON.stringify', () => {
		const m = new Map([['k', 'v']]);
		const s = new Set(['a']);
		expect(stableCanonicalStringify({ m })).toBe('{"m":{}}');
		expect(stableCanonicalStringify({ s })).toBe('{"s":{}}');
		expect(JSON.stringify({ m })).toBe('{"m":{}}');
		expect(JSON.stringify({ s })).toBe('{"s":{}}');
	});

	test('function values still emit a bare undefined token (not valid JSON)', () => {
		// Deterministic, so safe as hash input, but the output is not parseable.
		// Unreachable at every current call site; pinned so a change is visible.
		expect(stableCanonicalStringify({ f: () => 1 })).toBe('{"f":undefined}');
	});

	test('two different Dates collide (consequence of the limit above)', () => {
		expect(stableCanonicalStringify({ d: new Date(0) })).toBe(
			stableCanonicalStringify({ d: new Date(1) }),
		);
	});
});
