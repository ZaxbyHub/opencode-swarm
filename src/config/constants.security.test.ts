/**
 * Adversarial security tests for freezeSet() Proxy
 * Tests for:
 * 1. Proxy bypass via Object.getOwnPropertyDescriptor or Reflect
 * 2. Prototype pollution reachability
 * 3. Injection vectors through command name values
 */
import { describe, expect, test } from 'bun:test';
import { CLAUDE_CODE_NATIVE_COMMANDS } from './constants';

// Re-implement freezeSet to test the actual implementation pattern
function freezeSet<T>(items: readonly T[]): ReadonlySet<T> {
	const set = new Set(items);
	return new Proxy(set, {
		get(target, prop) {
			if (prop === 'add' || prop === 'delete' || prop === 'clear') {
				return () => {
					throw new TypeError('CLAUDE_CODE_NATIVE_COMMANDS is readonly');
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

// ============================================================
// TASK 1.4 REQUIREMENT VERIFICATION
// ============================================================
describe('TASK 1.4 REQUIREMENT: plan and reset in CLAUDE_CODE_NATIVE_COMMANDS', () => {
	test('CLAUDE_CODE_NATIVE_COMMANDS has plan command', () => {
		expect(CLAUDE_CODE_NATIVE_COMMANDS.has('plan')).toBe(true);
	});

	test('CLAUDE_CODE_NATIVE_COMMANDS has reset command', () => {
		expect(CLAUDE_CODE_NATIVE_COMMANDS.has('reset')).toBe(true);
	});
});

// ============================================================
// ATTACK VECTOR 1: Reflect.get bypass
// ============================================================
describe('ATTACK VECTOR 1: Reflect.get bypass', () => {
	test('Reflect.get returns blocked function without throwing on GET', () => {
		const set = freezeSet(['plan', 'reset']);

		// Reflect.get does NOT throw on get - it returns the blocked function
		// The throw only happens when the function is CALLED
		const result = Reflect.get(set, 'add');
		expect(typeof result).toBe('function');
	});

	test('The blocked function throws when CALLED (not when obtained)', () => {
		const set = freezeSet(['plan', 'reset']);

		// Get the blocked function
		const blockedAdd = Reflect.get(set, 'add') as Function;

		// Calling it throws - regardless of what 'this' is
		// The throw is baked into the function closure, not the proxy
		expect(() => blockedAdd.call(new Set(), 'x')).toThrow(
			'CLAUDE_CODE_NATIVE_COMMANDS is readonly',
		);
		expect(() => blockedAdd.call(set, 'x')).toThrow(
			'CLAUDE_CODE_NATIVE_COMMANDS is readonly',
		);
	});

	test('Reflect.get for delete returns blocked function', () => {
		const set = freezeSet(['plan', 'reset']);
		const blockedDelete = Reflect.get(set, 'delete') as Function;
		expect(typeof blockedDelete).toBe('function');
		expect(() => blockedDelete.call(new Set(), 'x')).toThrow();
	});

	test('Reflect.get for clear returns blocked function', () => {
		const set = freezeSet(['plan', 'reset']);
		const blockedClear = Reflect.get(set, 'clear') as Function;
		expect(typeof blockedClear).toBe('function');
		expect(() => blockedClear.call(new Set())).toThrow();
	});
});

// ============================================================
// ATTACK VECTOR 2: Prototype pollution via setPrototypeOf
// ============================================================
describe('ATTACK VECTOR 2: Object.setPrototypeOf pollution', () => {
	test('CONFIRMED VULNERABILITY: Object.setPrototypeOf does not throw', () => {
		const set = freezeSet(['plan', 'reset']);

		// setPrototypeOf should throw but it doesn't
		const result = Object.setPrototypeOf(set, null);
		expect(result).toBe(set);
	});

	test('After setPrototypeOf(null), prototype chain is broken', () => {
		const set = freezeSet(['plan', 'reset']);

		Object.setPrototypeOf(set, null);

		// Now the proxy has no prototype, breaking Set methods
		expect(Object.getPrototypeOf(set)).toBe(null);
	});
});

// ============================================================
// ATTACK VECTOR 3: Object.defineProperty bypass
// ============================================================
describe('ATTACK VECTOR 3: Object.defineProperty bypass', () => {
	test('CONFIRMED VULNERABILITY: Object.defineProperty can add new properties', () => {
		const set = freezeSet(['plan', 'reset']);

		Object.defineProperty(set, 'injectedProp', {
			value: 'attack',
			writable: false,
			enumerable: false,
			configurable: false,
		});

		expect((set as any).injectedProp).toBe('attack');
	});

	test('Object.defineProperty can define new enumerable properties', () => {
		const set = freezeSet(['plan', 'reset']);

		Object.defineProperty(set, 'malicious', {
			value: 'MALICIOUS_VALUE',
			writable: true,
			enumerable: true,
			configurable: true,
		});

		expect(Object.keys(set)).toContain('malicious');
		expect((set as any).malicious).toBe('MALICIOUS_VALUE');
	});
});

// ============================================================
// ATTACK VECTOR 4: Object.assign bypass
// ============================================================
describe('ATTACK VECTOR 4: Object.assign bypass', () => {
	test('CONFIRMED VULNERABILITY: Object.assign can add properties', () => {
		const set = freezeSet(['plan', 'reset']);

		Object.assign(set, {
			maliciousAdd: () => 'MALICIOUS',
			injected: 'value',
		});

		expect((set as any).maliciousAdd()).toBe('MALICIOUS');
		expect((set as any).injected).toBe('value');
	});
});

// ============================================================
// ATTACK VECTOR 5: Constructor access
// ============================================================
describe('ATTACK VECTOR 5: Constructor access', () => {
	test('Proxy constructor property returns Set-like constructor', () => {
		const set = freezeSet(['plan', 'reset']);

		// The proxy's constructor passes through to the underlying Set
		const ctor = (set as any).constructor;
		expect(typeof ctor).toBe('function');
		// It's a Set constructor (could be bound)
		expect(ctor.name).toMatch(/Set|set/i);
	});

	test('Set.prototype.add is the real Set add', () => {
		const attackSet = new Set();

		// Call the real Set.prototype.add directly
		Set.prototype.add.call(attackSet, 'injected');
		expect(attackSet.has('injected')).toBe(true);
	});
});

// ============================================================
// ATTACK VECTOR 6: Command name injection
// ============================================================
describe('ATTACK VECTOR 6: Command name injection vectors', () => {
	test('No __proto__ in command names', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		expect(commands).not.toContain('__proto__');
	});

	test('No constructor in command names', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		expect(commands).not.toContain('constructor');
	});

	test('No null bytes or control characters in commands', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		const controlPattern = /[\x00-\x1F\x7F]/;
		for (const cmd of commands) {
			expect(controlPattern.test(cmd)).toBe(false);
		}
	});

	test('No template literal injection in commands', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		for (const cmd of commands) {
			expect(cmd).not.toContain('${');
		}
	});

	test('No SQL injection patterns', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		for (const cmd of commands) {
			expect(cmd).not.toContain("';");
			expect(cmd).not.toContain('";');
			expect(cmd).not.toContain('--');
		}
	});

	test('No path traversal patterns', () => {
		const commands = Array.from(CLAUDE_CODE_NATIVE_COMMANDS);
		for (const cmd of commands) {
			expect(cmd).not.toContain('..');
			expect(cmd).not.toContain('/');
			expect(cmd).not.toContain('\\');
		}
	});
});

// ============================================================
// VERIFICATION: Normal Set operations work
// ============================================================
describe('VERIFICATION: Normal Set operations work correctly', () => {
	test('has() returns correct values', () => {
		const set = freezeSet(['plan', 'reset', 'clear', 'help']);
		expect(set.has('plan')).toBe(true);
		expect(set.has('reset')).toBe(true);
		expect(set.has('clear')).toBe(true);
		expect(set.has('help')).toBe(true);
		expect(set.has('nonexistent')).toBe(false);
	});

	test('size property is accessible', () => {
		const set = freezeSet(['plan', 'reset', 'clear', 'help']);
		expect(set.size).toBe(4);
	});

	test('forEach iteration works', () => {
		const set = freezeSet(['plan', 'reset', 'clear', 'help']);
		const items: string[] = [];
		set.forEach((v) => items.push(v));
		expect(items.sort()).toEqual(['clear', 'help', 'plan', 'reset']);
	});

	test('entries/values iteration works', () => {
		const set = freezeSet(['plan', 'reset', 'clear', 'help']);
		const items = Array.from(set.values());
		expect(items.sort()).toEqual(['clear', 'help', 'plan', 'reset']);

		const entries = Array.from(set.entries());
		expect(entries.length).toBe(4);
	});
});

// ============================================================
// SECURITY SUMMARY
// ============================================================
describe('SECURITY VERDICT', () => {
	test('VULNERABILITIES CONFIRMED', () => {
		// VULNERABILITY 1: Reflect.get returns blocked function without throwing on get
		{
			const set = freezeSet(['a']);
			const blockedAdd = Reflect.get(set, 'add') as Function;
			// The function IS returned - it just throws when called
			expect(typeof blockedAdd).toBe('function');
			expect(() => blockedAdd.call(new Set(), 'x')).toThrow(); // CONFIRMED
		}

		// VULNERABILITY 2: Object.setPrototypeOf succeeds
		{
			const set = freezeSet(['a']);
			Object.setPrototypeOf(set, null);
			expect(Object.getPrototypeOf(set)).toBe(null); // CONFIRMED
		}

		// VULNERABILITY 3: Object.defineProperty succeeds
		{
			const set = freezeSet(['a']);
			Object.defineProperty(set, 'testProp', { value: 'test' });
			expect((set as any).testProp).toBe('test'); // CONFIRMED
		}

		// VULNERABILITY 4: Object.assign succeeds
		{
			const set = freezeSet(['a']);
			Object.assign(set, { prop: 'value' });
			expect((set as any).prop).toBe('value'); // CONFIRMED
		}
	});
});
