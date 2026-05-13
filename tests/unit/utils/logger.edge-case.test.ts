/**
 * Adversarial security tests for src/utils/logger.ts debug-gating change
 *
 * Attack vectors tested:
 * 1. DEBUG gate bypass via runtime env manipulation
 * 2. undefined/null/empty string as message
 * 3. Very large data objects
 * 4. Circular reference objects
 * 5. Prototype pollution via message/data parameters
 * 6. Non-string message types at runtime
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

// Store original console methods
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let originalError: typeof console.error;

beforeEach(() => {
	originalLog = console.log;
	originalWarn = console.warn;
	originalError = console.error;
});

afterEach(() => {
	console.log = originalLog;
	console.warn = originalWarn;
	console.error = originalError;
});

describe('ADVERSARIAL: warn() debug gate security', () => {
	// ============================================================================
	// ATTACK VECTOR 1: DEBUG gate bypass via runtime env manipulation
	// ============================================================================
	describe('ATTACK VECTOR 1: DEBUG gate bypass', () => {
		it('should NOT be bypassable by modifying process.env.OPENCODE_SWARM_DEBUG after module load', () => {
			// Set env to 0 initially
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '0';

			// Clear require cache to re-import with fresh env
			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			// Import with DEBUG=0 (module captures this at load time)
			const { warn } = require('../../../src/utils/logger');

			// Attacker tries to enable debug at runtime
			process.env.OPENCODE_SWARM_DEBUG = '1';

			// Spy on console.warn
			let warnCalled = false;
			console.warn = (...args: unknown[]) => {
				warnCalled = true;
			};

			// Call warn - should NOT output because DEBUG was captured at module load
			warn('test message', { sensitive: 'data' });

			// Verify console.warn was NOT called
			expect(warnCalled).toBe(false);

			// Restore env
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should be secure when DEBUG=0 even if env changed to 1 before call', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '0';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');

			// Attempt to manipulate env
			process.env.OPENCODE_SWARM_DEBUG = '1';
			process.env.OPENCODE_SWARM_DEBUG = 'true';
			process.env.OPENCODE_SWARM_DEBUG = 'yes';

			let warnCalled = false;
			console.warn = () => {
				warnCalled = true;
			};

			warn('bypass attempt', {});
			expect(warnCalled).toBe(false);

			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should work correctly when DEBUG=1 at module load', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');

			let warnCalled = false;
			let warnArgs: unknown[] = [];
			console.warn = (...args: unknown[]) => {
				warnCalled = true;
				warnArgs = args;
			};

			warn('debug enabled', { test: true });

			expect(warnCalled).toBe(true);
			expect(warnArgs[0]).toContain('debug enabled');
			expect(warnArgs[1]).toEqual({ test: true });

			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ATTACK VECTOR 2: undefined/null/empty string as message
	// ============================================================================
	describe('ATTACK VECTOR 2: undefined/null/empty message handling', () => {
		it('should NOT crash when message is undefined', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn(undefined as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should NOT crash when message is null', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn(null as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should NOT crash when message is empty string', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('')).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle message with only whitespace', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('   ')).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle special Unicode characters in message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('🎯\x00\x1f\r\n')).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ATTACK VECTOR 3: Very large data objects
	// ============================================================================
	describe('ATTACK VECTOR 3: Large data object handling', () => {
		it('should NOT crash with very large data object (100KB)', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			// Create 100KB of data
			const largeData = { data: 'x'.repeat(100000) };

			expect(() => warn('large data test', largeData)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should NOT crash with deeply nested object (depth 100)', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			// Create deeply nested object
			let obj: Record<string, unknown> = {};
			for (let i = 0; i < 100; i++) {
				obj = { nested: obj };
			}

			expect(() => warn('deep nesting', obj)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle array with 10000 elements', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const largeArray = Array(10000).fill('item');

			expect(() => warn('large array', largeArray)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ATTACK VECTOR 4: Circular reference objects
	// ============================================================================
	describe('ATTACK VECTOR 4: Circular reference handling', () => {
		it('should NOT crash with circular reference in data object', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const circular: Record<string, unknown> = { name: 'test' };
			circular.self = circular;

			// Should not throw, though console.warn may have issues with circular refs
			expect(() => warn('circular test', circular)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle mutual circular references', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const objA: Record<string, unknown> = { name: 'A' };
			const objB: Record<string, unknown> = { name: 'B' };
			objA.ref = objB;
			objB.ref = objA;

			expect(() => warn('mutual circular', { a: objA, b: objB })).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle circular reference in nested array', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const arr: unknown[] = [1, 2, 3];
			arr.push(arr);

			expect(() => warn('array circular', arr)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ATTACK VECTOR 5: Prototype pollution via message/data parameters
	// ============================================================================
	describe('ATTACK VECTOR 5: Prototype pollution attempts', () => {
		it('should NOT allow __proto__ pollution via data', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			warn('proto test', { __proto__: { polluted: true } } as Record<
				string,
				unknown
			>);

			// Verify prototype wasn't polluted
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should NOT allow constructor pollution via data', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			warn('constructor test', { constructor: { malicious: true } } as Record<
				string,
				unknown
			>);

			// Verify constructor wasn't polluted
			expect(({} as Record<string, unknown>).malicious).toBeUndefined();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should NOT allow prototype injection via message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			// These are just logged as strings, no object manipulation
			expect(() => warn('__proto__:malicious')).not.toThrow();
			expect(() => warn('constructor.prototype.injection')).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle data with getters that throw', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const maliciousGetter = {
				get value() {
					throw new Error('Getter attack');
				},
			};

			// Should not crash when accessing properties
			expect(() => warn('getter test', maliciousGetter)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ATTACK VECTOR 6: Non-string message types at runtime
	// ============================================================================
	describe('ATTACK VECTOR 6: Non-string message type handling', () => {
		it('should handle number as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn(12345 as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle boolean as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn(true as unknown as string)).not.toThrow();
			expect(() => warn(false as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle object as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn({ key: 'value' } as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle array as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn(['arr', 'ay'] as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle function as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn((() => {}) as unknown as string)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle Symbol as message - SECURITY FINDING: throws TypeError', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			// SECURITY FINDING: Symbol causes TypeError at runtime - template literal cannot coerce Symbol
			// This is a vulnerability - passing Symbol as message crashes the application
			expect(() => warn(Symbol('test') as unknown as string)).toThrow(
				TypeError,
			);
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle BigInt as message', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() =>
				warn(BigInt(12345678901234567890) as unknown as string),
			).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});

	// ============================================================================
	// ADDITIONAL EDGE CASES
	// ============================================================================
	describe('ADDITIONAL EDGE CASES', () => {
		it('should handle data that throws when stringified', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const obj = {
				toString() {
					throw new Error('toString attack');
				},
			};

			expect(() => warn('toString throw', obj)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle data with circular reference in toJSON', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const obj: Record<string, unknown> = {
				toJSON() {
					return { circular: {} };
				},
			};
			obj.circular = obj;

			expect(() => warn('toJSON circular', obj)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle undefined as data parameter', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('test', undefined)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle null as data parameter', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('test', null)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle NaN as data', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('test', NaN)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle Infinity as data', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			expect(() => warn('test', Infinity)).not.toThrow();
			expect(() => warn('test', -Infinity)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});

		it('should handle Proxy object as data', () => {
			const originalEnv = process.env.OPENCODE_SWARM_DEBUG;
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const loggerPath = require.resolve('../../../src/utils/logger');
			delete require.cache[loggerPath];

			const { warn } = require('../../../src/utils/logger');
			console.warn = () => {};

			const proxy = new Proxy(
				{},
				{
					get() {
						throw new Error('Proxy trap attack');
					},
				},
			);

			expect(() => warn('proxy test', proxy)).not.toThrow();
			process.env.OPENCODE_SWARM_DEBUG = originalEnv;
		});
	});
});
