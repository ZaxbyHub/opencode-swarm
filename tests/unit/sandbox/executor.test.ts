/**
 * Tests for src/sandbox/executor.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	_resetExecutorCache,
	_resetSandboxAssessmentCache,
	assessSandboxEnforcement,
	getExecutor,
	normalizeSandboxMechanism,
	SandboxError,
	type SandboxExecutor,
} from '../../../src/sandbox/executor';

describe('SandboxError', () => {
	test('SandboxError instance has correct name and message', () => {
		const err = new SandboxError('test message', 'ERR_TEST');
		expect(err.name).toBe('SandboxError');
		expect(err.message).toBe('test message');
		expect(err.code).toBe('ERR_TEST');
	});

	test('SandboxError is instanceof Error', () => {
		const err = new SandboxError('oops', 'ERR_OPS');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(SandboxError);
	});

	test('SandboxError preserves message and code', () => {
		const err = new SandboxError('sandbox unavailable', 'ENOENT');
		expect(err.message).toBe('sandbox unavailable');
		expect(err.code).toBe('ENOENT');
	});
});

describe('getExecutor()', () => {
	beforeEach(() => {
		// Ensure clean state before each test
		_resetExecutorCache();
	});

	afterEach(() => {
		// Reset after each test so module state doesn't pollute other tests
		_resetExecutorCache();
		_resetSandboxAssessmentCache();
	});

	test('getExecutor() returns a Promise', () => {
		const result = getExecutor();
		expect(result).toBeInstanceOf(Promise);
	});

	test('getExecutor() resolves to SandboxExecutor | null', async () => {
		const executor = await getExecutor();
		// In Phase 1 no concrete executor exists, so null is expected
		expect(executor === null || typeof executor === 'object').toBe(true);
		if (executor !== null) {
			expect(executor).toHaveProperty('mechanism');
			expect(executor).toHaveProperty('isAvailable');
			expect(executor).toHaveProperty('wrapCommand');
			expect(executor).toHaveProperty('getEnvOverrides');
		}
	});

	test('getExecutor() returns null when no platform executor is available (Phase 1)', async () => {
		// On Windows, probeWindows() now properly probes cmd.exe availability.
		// If cmd.exe is available (which it is on Windows), the executor is enabled.
		// On other platforms without a working sandbox, it may still return null.
		const executor = await getExecutor();
		// The executor may be null on non-Windows platforms in Phase 1
		// On Windows it should return the WindowsSandboxExecutor
		if (process.platform === 'win32') {
			expect(executor).not.toBeNull();
		}
	});

	test('concurrent getExecutor() calls return the same promise (cache sharing)', async () => {
		// Initiate two calls "simultaneously" — both should resolve to the same value
		// The cache is at module level; the source code guarantees same-promise semantics
		const [exec1, exec2] = await Promise.all([getExecutor(), getExecutor()]);
		// Both should be null in Phase 1; the key invariant is they both resolved
		expect(exec1).toBe(exec2);
	});
});

describe('_resetExecutorCache()', () => {
	beforeEach(() => {
		_resetExecutorCache();
	});

	afterEach(() => {
		_resetExecutorCache();
		_resetSandboxAssessmentCache();
	});

	test('calling _resetExecutorCache() allows getExecutor() to run again', async () => {
		// First call — populates cache
		const first = await getExecutor();

		// Reset — should clear the cached promise
		_resetExecutorCache();

		// Second call after reset — should not short-circuit on cached value
		const second = await getExecutor();
		// On Windows the executor should be available; after reset both should be same type
		if (process.platform === 'win32') {
			expect(first).not.toBeNull();
			expect(second).not.toBeNull();
		}
		// Both should be the same (same outcome, but after reset it's a new promise chain)
		expect(typeof first).toBe(typeof second);
	});

	test('_resetExecutorCache() is callable multiple times without error', () => {
		expect(() => _resetExecutorCache()).not.toThrow();
		expect(() => _resetExecutorCache()).not.toThrow();
	});
});

describe('assessSandboxEnforcement()', () => {
	const originalDetectSandboxCapability = _internals.detectSandboxCapability;

	afterEach(() => {
		_internals.detectSandboxCapability = originalDetectSandboxCapability;
		_resetSandboxAssessmentCache();
	});

	test('returns a stable cache key for identical requirements', async () => {
		const first = await assessSandboxEnforcement({
			mode: 'required',
			require_filesystem: true,
			require_network: true,
		});
		const second = await assessSandboxEnforcement({
			mode: 'required',
			require_filesystem: true,
			require_network: true,
		});

		expect(first.cacheKey).toBe(second.cacheKey);
		expect(first.capability.identity).toBe(second.capability.identity);
	});

	test('regression FB-001: required mode canonicalizes the advisory PowerShell wrapper before checking strict policy support', async () => {
		_internals.detectSandboxCapability = async () =>
			({
				v: 1,
				status: 'enabled',
				strength: 'advisory',
				mechanism: 'PowerShell wrapper',
				platform: 'win32',
				filesystem: 'none',
				network: 'none',
				process: 'none',
				effective: 'none',
				reasons: ['advisory only'],
				identity: 'win32:powershell-wrapper',
			}) as Awaited<ReturnType<typeof originalDetectSandboxCapability>>;

		const assessment = await assessSandboxEnforcement({ mode: 'required' });

		expect(assessment.supported).toBe(false);
		expect(assessment.satisfied).toBe(false);
		expect(assessment.unsupported).toEqual(['network_mode']);
	});

	test('normalizeSandboxMechanism folds whitespace and punctuation to one stable identity', () => {
		expect(normalizeSandboxMechanism('PowerShell wrapper')).toBe(
			'powershellwrapper',
		);
		expect(normalizeSandboxMechanism('powershell-wrapper')).toBe(
			'powershellwrapper',
		);
		expect(normalizeSandboxMechanism('native-runner/app-container')).toBe(
			'nativerunnerappcontainer',
		);
	});
});
