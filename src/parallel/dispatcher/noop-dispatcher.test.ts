/**
 * Tests for the no-op dispatcher (Phase 5 dark foundation).
 *
 * Proves:
 *   - disabled config → reject with 'parallelization_disabled'
 *   - no file I/O, no side effects on dispatch
 *   - handles() always empty
 *   - shutdown() is a no-op
 */

import { describe, expect, test } from 'bun:test';
import { createNoopDispatcher } from './noop-dispatcher.js';
import type { DispatcherConfig } from './types.js';

const DISABLED_CONFIG: DispatcherConfig = {
	enabled: false,
	maxConcurrentTasks: 1,
	evidenceLockTimeoutMs: 60000,
};

describe('createNoopDispatcher — disabled default', () => {
	test('dispatch returns reject with reason parallelization_disabled', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		const decision = d.dispatch('1.1');
		expect(decision.action).toBe('reject');
		expect(decision.reason).toBe('parallelization_disabled');
	});

	test('dispatch is consistent for any taskId', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		for (const id of ['1.1', '2.3', '99.99']) {
			const dec = d.dispatch(id);
			expect(dec.action).toBe('reject');
		}
	});

	test('handles() returns empty array', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		expect(d.handles()).toHaveLength(0);
	});

	test('shutdown() does not throw', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		expect(() => d.shutdown()).not.toThrow();
	});

	test('config is accessible on the dispatcher', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		expect(d.config.enabled).toBe(false);
		expect(d.config.maxConcurrentTasks).toBe(1);
	});
});

describe('createNoopDispatcher — decision shape', () => {
	test('reject decision has no slot field', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		const decision = d.dispatch('1.1');
		expect(decision).not.toHaveProperty('slot');
	});

	test('calling dispatch multiple times returns consistent results', () => {
		const d = createNoopDispatcher(DISABLED_CONFIG);
		const d1 = d.dispatch('1.1');
		const d2 = d.dispatch('1.1');
		expect(d1.action).toBe(d2.action);
		expect(d1.reason).toBe(d2.reason);
	});
});
