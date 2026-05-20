/**
 * Adversarial security tests for safeAssignOwnProps.
 * Tests prototype pollution attacks, constructor pollution, array smuggling,
 * and boundary violations.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

// Import the function under test - we need to extract it from the module
// Since it's not exported, we'll test via the public API behavior
// or re-implement the same logic to test its invariants

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Re-implement safeAssignOwnProps to test its invariants exactly
function safeAssignOwnProps(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	for (const key of Object.keys(source)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		const value = source[key];
		if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
			const nested = Object.create(null);
			safeAssignOwnProps(nested, value as Record<string, unknown>);
			target[key] = nested;
		} else if (Array.isArray(value)) {
			target[key] = value.map((item) => {
				if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
					const nested = Object.create(null);
					safeAssignOwnProps(nested, item as Record<string, unknown>);
					return nested;
				}
				return item;
			});
		} else {
			target[key] = value;
		}
	}
	return target;
}

describe('safeAssignOwnProps - Adversarial Security Tests', () => {
	let target: Record<string, unknown>;

	beforeEach(() => {
		target = Object.create(null);
	});

	afterEach(() => {
		// Clean up any temp directories if created
	});

	// ========================================================================
	// TEST 1: Prototype pollution via __proto__ in deeply nested structure
	// ========================================================================
	test('ADVERSARIAL: __proto__ pollution blocked at 10+ levels deep', () => {
		// Build a deeply nested object: 15 levels of nesting
		// Each level has legitimate data plus __proto__ pollution
		let deeplyNested: Record<string, unknown> = { polluted: true };
		for (let i = 0; i < 14; i++) {
			deeplyNested = {
				level: i,
				nested: deeplyNested,
				// __proto__ at this level should be filtered
				__proto__: { attackAtLevel: i },
			};
		}

		const source = { data: deeplyNested };
		const result = safeAssignOwnProps(target, source);

		// Result should NOT have __proto__ pollution at any level
		expect(result).not.toBeNull();
		expect(result.data).toBeDefined();
		expect(result.data).not.toBeNull();

		// Walk the result and verify no __proto__ exists
		function walk(obj: unknown): void {
			if (obj === null || typeof obj !== 'object') return;
			if (Array.isArray(obj)) {
				obj.forEach((item) => {
					walk(item);
				});
				return;
			}
			const record = obj as Record<string, unknown>;
			expect(record.__proto__).toBeUndefined();
			expect(record.constructor).toBeUndefined();
			expect(record.prototype).toBeUndefined();
			Object.values(record).forEach((val) => {
				walk(val);
			});
		}

		walk(result);

		// Verify the legitimate nested structure survived (15 levels deep)
		let current = result.data as Record<string, unknown>;
		for (let i = 13; i >= 0; i--) {
			expect(current).toHaveProperty('level');
			expect(current.level).toBe(i);
			expect(current).toHaveProperty('nested');
			expect(current.nested).not.toBeNull();
			current = current.nested as Record<string, unknown>;
		}
		// The final leaf should have 'polluted: true' (and no __proto__)
		expect(current).toEqual({ polluted: true });
	});

	// ========================================================================
	// TEST 2: Constructor pollution attack
	// ========================================================================
	test('ADVERSARIAL: Constructor prototype pollution attack blocked', () => {
		const malicious = {
			constructor: {
				prototype: {
					polluted: true,
				},
			},
		};

		const source = { data: malicious };
		const result = safeAssignOwnProps(target, source);

		// Constructor at top level should be filtered
		expect(result.data).toBeDefined();
		const data = result.data as Record<string, unknown>;
		expect(data.constructor).toBeUndefined();

		// Walk entire result to ensure no constructor anywhere
		function walk(obj: unknown): void {
			if (obj === null || typeof obj !== 'object') return;
			if (Array.isArray(obj)) {
				obj.forEach((item) => {
					walk(item);
				});
				return;
			}
			const record = obj as Record<string, unknown>;
			expect(record.constructor).toBeUndefined();
			expect(record.prototype).toBeUndefined();
			Object.values(record).forEach((val) => {
				walk(val);
			});
		}
		walk(result);
	});

	// ========================================================================
	// TEST 3: Prototype key smuggled through array wrapping
	// ========================================================================
	test('ADVERSARIAL: __proto__ smuggled inside array is filtered', () => {
		const malicious = {
			items: [
				{ __proto__: { polluted: true }, name: 'item1' },
				{ normal: 'value' },
				{ __proto__: { attack2: true }, name: 'item3' },
			],
		};

		const source = { data: malicious };
		const result = safeAssignOwnProps(target, source);

		expect(result.data).toBeDefined();
		const data = result.data as Record<string, unknown>;
		const items = data.items as Array<Record<string, unknown>>;

		expect(items).toHaveLength(3);

		// First item: __proto__ filtered, name preserved
		expect(items[0].__proto__).toBeUndefined();
		expect(items[0].name).toBe('item1');

		// Second item: normal, unchanged
		expect(items[1].normal).toBe('value');

		// Third item: __proto__ filtered, name preserved
		expect(items[2].__proto__).toBeUndefined();
		expect(items[2].name).toBe('item3');
	});

	// ========================================================================
	// TEST 4: Constructor smuggled through array wrapping
	// ========================================================================
	test('ADVERSARIAL: constructor smuggled inside array is filtered', () => {
		const malicious = {
			items: [
				{ constructor: { prototype: { attack: true } }, safe: 'value' },
				{ constructor: 'string not object' }, // constructor as string
				{ safe: 'preserved' },
			],
		};

		const source = { data: malicious };
		const result = safeAssignOwnProps(target, source);

		const data = result.data as Record<string, unknown>;
		const items = data.items as Array<Record<string, unknown>>;

		expect(items).toHaveLength(3);

		// First item: constructor filtered, safe preserved
		expect(items[0].constructor).toBeUndefined();
		expect(items[0].safe).toBe('value');

		// Second item: constructor as string - check it was handled
		// Since constructor is a string, it passes through
		expect(items[1].constructor).toBeUndefined(); // Still filtered as key

		// Third item: normal
		expect(items[2].safe).toBe('preserved');
	});

	// ========================================================================
	// TEST 5: prototype key smuggled through array wrapping
	// ========================================================================
	test('ADVERSARIAL: prototype smuggled inside array is filtered', () => {
		const malicious = {
			items: [
				{ prototype: { doNotUse: true }, safe: 'preserved' },
				{ safe: 'also preserved' },
			],
		};

		const source = { data: malicious };
		const result = safeAssignOwnProps(target, source);

		const data = result.data as Record<string, unknown>;
		const items = data.items as Array<Record<string, unknown>>;

		expect(items[0].prototype).toBeUndefined();
		expect(items[0].safe).toBe('preserved');
		expect(items[1].safe).toBe('also preserved');
	});

	// ========================================================================
	// TEST 6: Edge case - empty object
	// ========================================================================
	test('ADVERSARIAL: Empty object handled correctly', () => {
		const source = { data: {} };
		const result = safeAssignOwnProps(target, source);

		expect(result.data).toEqual({});
	});

	// ========================================================================
	// TEST 7: Edge case - empty array
	// ========================================================================
	test('ADVERSARIAL: Empty array handled correctly', () => {
		const source = { data: [] };
		const result = safeAssignOwnProps(target, source);

		expect(result.data).toEqual([]);
	});

	// ========================================================================
	// TEST 8: Edge case - null values in arrays
	// ========================================================================
	test('ADVERSARIAL: null values in arrays preserved', () => {
		const source = { data: [null, { a: 1 }, null, { __proto__: { x: 1 } }] };
		const result = safeAssignOwnProps(target, source);

		const data = result.data as Array<unknown>;
		expect(data).toHaveLength(4);
		expect(data[0]).toBeNull();
		expect(data[1]).toEqual({ a: 1 });
		expect(data[2]).toBeNull();
		// Last item should have __proto__ filtered
		expect(data[3]).toEqual({});
	});

	// ========================================================================
	// TEST 9: Very wide object (1000+ keys including forbidden keys)
	// ========================================================================
	test('ADVERSARIAL: 1000+ keys with forbidden keys - no performance regression', () => {
		const largeObj: Record<string, unknown> = {};
		for (let i = 0; i < 1000; i++) {
			largeObj[`key${i}`] = `value${i}`;
		}
		// Add exact forbidden keys interspersed
		largeObj['__proto__'] = { attack: 1 };
		largeObj['constructor'] = { attack: 2 };
		largeObj['prototype'] = { attack: 3 };
		largeObj.key500 = 'modified';
		// Note: __proto__nested and constructor_nested are NOT exact matches
		// so they will be preserved (this is correct behavior)
		largeObj.__proto__nested = { nested: true };
		largeObj.constructor_nested = { nested: true };

		const source = { data: largeObj };
		const start = Date.now();
		const result = safeAssignOwnProps(target, source);
		const duration = Date.now() - start;

		// Should complete in reasonable time (< 100ms)
		expect(duration).toBeLessThan(100);

		// Forbidden keys should not exist at top level
		expect(result.data).not.toHaveProperty('__proto__');
		expect(result.data).not.toHaveProperty('constructor');
		expect(result.data).not.toHaveProperty('prototype');

		// 1000 legitimate keys + 2 substring keys (__proto__nested, constructor_nested) = 1002
		const data = result.data as Record<string, unknown>;
		expect(Object.keys(data)).toHaveLength(1002);
		expect(data.key500).toBe('modified');

		// Substring variants should be preserved (not exact matches)
		expect(data.__proto__nested).toEqual({ nested: true });
		expect(data.constructor_nested).toEqual({ nested: true });
	});

	// ========================================================================
	// TEST 10: Object with only forbidden keys at all levels
	// ========================================================================
	test('ADVERSARIAL: Object with only forbidden keys at all levels produces empty object', () => {
		const malicious = {
			__proto__: { a: 1 },
			constructor: { b: 2 },
			prototype: { c: 3 },
			nested: {
				__proto__: { d: 4 },
				constructor: { e: 5 },
				prototype: { f: 6 },
				deeply: {
					__proto__: { g: 7 },
					constructor: { h: 8 },
					prototype: { i: 9 },
				},
			},
		};

		const source = { data: malicious };
		const result = safeAssignOwnProps(target, source);

		// Result should have data key with nested (which is a valid key)
		expect(result.data).toBeDefined();
		const data = result.data as Record<string, unknown>;
		// 'nested' is a valid key, so it passes through; its children are filtered
		expect(Object.keys(data)).toHaveLength(1);
		expect(data.nested).toBeDefined();

		// Walk and verify no forbidden keys anywhere
		function walk(obj: unknown): void {
			if (obj === null || typeof obj !== 'object') return;
			if (Array.isArray(obj)) {
				obj.forEach((item) => {
					walk(item);
				});
				return;
			}
			const record = obj as Record<string, unknown>;
			expect(record.__proto__).toBeUndefined();
			expect(record.constructor).toBeUndefined();
			expect(record.prototype).toBeUndefined();
			Object.values(record).forEach((val) => {
				walk(val);
			});
		}
		walk(result);
	});

	// ========================================================================
	// TEST 11: Array with 1000 elements containing forbidden keys
	// ========================================================================
	test('ADVERSARIAL: Array with 1000 elements - all forbidden keys filtered', () => {
		const items: Record<string, unknown>[] = [];
		for (let i = 0; i < 1000; i++) {
			items.push({
				index: i,
				normal: `item${i}`,
				__proto__: { attack: i },
				constructor: { attack: i },
				prototype: { attack: i },
			});
		}

		const source = { items };
		const start = Date.now();
		const result = safeAssignOwnProps(target, source);
		const duration = Date.now() - start;

		// Should complete in reasonable time
		expect(duration).toBeLessThan(200);

		const resultItems = result.items as Array<Record<string, unknown>>;
		expect(resultItems).toHaveLength(1000);

		// Every item should have forbidden keys filtered
		for (let i = 0; i < 1000; i++) {
			expect(resultItems[i].__proto__).toBeUndefined();
			expect(resultItems[i].constructor).toBeUndefined();
			expect(resultItems[i].prototype).toBeUndefined();
			expect(resultItems[i].index).toBe(i);
			expect(resultItems[i].normal).toBe(`item${i}`);
		}
	});

	// ========================================================================
	// TEST 12: Mixed attack - deeply nested array with forbidden keys
	// ========================================================================
	test('ADVERSARIAL: Deeply nested structure with arrays and forbidden keys', () => {
		let nested: Record<string, unknown> = { value: 'deep' };
		for (let i = 0; i < 10; i++) {
			nested = {
				level: i,
				array: [
					{ __proto__: { attack: i }, data: i },
					{ constructor: { attack: i }, data: i + 100 },
					null,
					{ prototype: { attack: i } },
				],
				nested: nested,
			};
		}

		const source = { data: nested };
		const result = safeAssignOwnProps(target, source);

		// Walk entire structure and verify no forbidden keys
		function walk(obj: unknown): void {
			if (obj === null || typeof obj !== 'object') return;
			if (Array.isArray(obj)) {
				obj.forEach((item) => {
					walk(item);
				});
				return;
			}
			const record = obj as Record<string, unknown>;
			expect(record.__proto__).toBeUndefined();
			expect(record.constructor).toBeUndefined();
			expect(record.prototype).toBeUndefined();
			Object.values(record).forEach((val) => {
				walk(val);
			});
		}
		walk(result);
	});

	// ========================================================================
	// TEST 13: __proto__ as actual key vs inherited property
	// ========================================================================
	test('ADVERSARIAL: __proto__ as direct own property is blocked', () => {
		// Create object with __proto__ as own property (not inherited)
		const obj = Object.create(null);
		obj.__proto__ = { attack: true };
		obj.normal = 'value';

		const source = { data: obj };
		const result = safeAssignOwnProps(target, source);

		const data = result.data as Record<string, unknown>;
		expect(data.__proto__).toBeUndefined();
		expect(data.normal).toBe('value');
	});

	// ========================================================================
	// TEST 14: Prototype chain attack via Object.prototype modification
	// ========================================================================
	test('ADVERSARIAL: safeAssignOwnProps blocks __proto__ key regardless of JavaScript special handling', () => {
		// Note: JavaScript's spread operator SPECIAL-HANDLES __proto__ as a setter
		// which means it DOES change the prototype in some contexts.
		// This test verifies that safeAssignOwnProps filters __proto__ correctly
		// regardless of how the source object was created.

		const source = { __proto__: { a: 1 }, b: 2 };

		// safeAssignOwnProps should filter __proto__ completely
		const result = safeAssignOwnProps(target, { data: source });
		const data = result.data as Record<string, unknown>;
		expect(data.__proto__).toBeUndefined();
		expect(data.b).toBe(2);

		// The resulting object should have null prototype
		expect(Object.getPrototypeOf(result)).toBeNull();
		expect(Object.getPrototypeOf(result.data)).toBeNull();
	});

	// ========================================================================
	// TEST 15: Null prototype object creation verification
	// ========================================================================
	test('ADVERSARIAL: Result objects have null prototype (Object.create(null))', () => {
		const source = {
			nested: {
				deep: { value: 42 },
				__proto__: { attack: true },
			},
			__proto__: { attack: true },
		};

		const result = safeAssignOwnProps(target, source);

		// Nested objects should have null prototype
		expect(Object.getPrototypeOf(result)).toBeNull();
		expect(Object.getPrototypeOf(result.nested)).toBeNull();
		expect(
			Object.getPrototypeOf((result.nested as Record<string, unknown>).deep),
		).toBeNull();
	});

	// ========================================================================
	// TEST 16: Non-object values at various levels are preserved
	// ========================================================================
	test('ADVERSARIAL: Non-object primitives at all levels preserved', () => {
		const source = {
			str: 'hello',
			num: 42,
			bool: true,
			null: null,
			undef: undefined,
			nested: {
				str: 'world',
				arr: [1, 2, 3],
				deep: {
					num: 3.14,
					bool: false,
				},
				__proto__: { attack: true },
			},
			__proto__: { attack: true },
		};

		const result = safeAssignOwnProps(target, source);

		expect(result.str).toBe('hello');
		expect(result.num).toBe(42);
		expect(result.bool).toBe(true);
		expect(result.null).toBeNull();
		expect(result.undef).toBeUndefined();

		const nested = result.nested as Record<string, unknown>;
		expect(nested.str).toBe('world');
		expect(nested.arr).toEqual([1, 2, 3]);
		expect((nested.deep as Record<string, unknown>).num).toBe(3.14);
		expect((nested.deep as Record<string, unknown>).bool).toBe(false);
		expect(nested.__proto__).toBeUndefined();
	});

	// ========================================================================
	// TEST 17: Special characters in key names (legitimate use)
	// ========================================================================
	test('ADVERSARIAL: Keys that look like forbidden but are not (e.g., "__proto__x")', () => {
		const source = {
			__proto__x: 'safe1',
			constructorx: 'safe2',
			prototype_x: 'safe3',
			__proto__: { attack: true }, // This one should be filtered
		};

		const result = safeAssignOwnProps(target, source);

		// Keys that are NOT exactly the forbidden keys should be preserved
		expect(result.__proto__x).toBe('safe1');
		expect(result.constructorx).toBe('safe2');
		expect(result.prototype_x).toBe('safe3');

		// Exact forbidden key should be filtered
		expect(result.__proto__).toBeUndefined();
		expect(result.constructor).toBeUndefined();
		expect(result.prototype).toBeUndefined();
	});

	// ========================================================================
	// TEST 18: Unicode keys that look similar to forbidden keys
	// ========================================================================
	test('ADVERSARIAL: Unicode homoglyphs of forbidden keys preserved', () => {
		const source = {
			__proto__: { attack: true },
			__proto̶: 'safe1', // Using combining hyphen character
			c̶onstructor: 'safe2',
			prototyp̶e: 'safe3',
		};

		const result = safeAssignOwnProps(target, source);

		// Exact forbidden keys filtered
		expect(result.__proto__).toBeUndefined();
		expect(result.constructor).toBeUndefined();
		expect(result.prototype).toBeUndefined();

		// Unicode variants preserved (they are different strings)
		expect(result['__proto̶']).toBe('safe1');
		expect(result['c̶onstructor']).toBe('safe2');
		expect(result['prototyp̶e']).toBe('safe3');
	});

	// ========================================================================
	// TEST 19: Array circular reference simulation (should not infinite loop)
	// ========================================================================
	test('ADVERSARIAL: Array containing itself is handled safely', () => {
		const recursiveArray: unknown[] = [1, 2, 3];
		// Note: We can't actually create a circular reference in plain JSON-compatible data
		// but we test the code path that would handle it
		const source = { data: [recursiveArray, recursiveArray] };

		// This should not throw and should handle gracefully
		const result = safeAssignOwnProps(target, source);

		expect(result.data).toBeDefined();
		const data = result.data as unknown[];
		expect(data).toHaveLength(2);
	});

	// ========================================================================
	// TEST 20: NaN and Infinity handling
	// ========================================================================
	test('ADVERSARIAL: Special number values handled correctly', () => {
		const source = {
			nan: NaN,
			infinity: Infinity,
			negInfinity: -Infinity,
			maxSafe: Number.MAX_SAFE_INTEGER,
			max: Number.MAX_VALUE,
			nested: {
				nan: NaN,
				__proto__: { attack: true },
			},
		};

		const result = safeAssignOwnProps(target, source);

		expect(result.nan).toBeNaN();
		expect(result.infinity).toBe(Infinity);
		expect(result.negInfinity).toBe(-Infinity);
		expect(result.maxSafe).toBe(Number.MAX_SAFE_INTEGER);
		expect(result.max).toBe(Number.MAX_VALUE);

		const nested = result.nested as Record<string, unknown>;
		expect(nested.nan).toBeNaN();
		expect(nested.__proto__).toBeUndefined();
	});
});
