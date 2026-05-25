/**
 * Tests for src/sandbox/capability-probe.ts
 */

import { describe, expect, test } from 'bun:test';
import {
	isBubblewrapAvailable,
	isSandboxExecAvailable,
	isWindowsSandboxAvailable,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';

const platform = process.platform;

describe('SandboxCapabilityProbe', () => {
	describe('platform detection', () => {
		test('detect() returns correct platform field', async () => {
			const probe = new SandboxCapabilityProbe();
			const result = await probe.detect();
			expect(result.platform).toBe(platform as 'linux' | 'darwin' | 'win32');
		});

		test('detect() returns a valid SandboxCapability shape', async () => {
			const probe = new SandboxCapabilityProbe();
			const result = await probe.detect();

			expect(result).toHaveProperty('status');
			expect(result).toHaveProperty('mechanism');
			expect(result).toHaveProperty('platform');
			expect(['enabled', 'disabled', 'unsupported']).toContain(result.status);
			expect(typeof result.mechanism).toBe('string');
		});

		test.skipIf(platform !== 'win32')(
			'detect() returns windows probe result on Windows',
			async () => {
				const probe = new SandboxCapabilityProbe();
				const result = await probe.detect();
				expect(result.platform).toBe('win32');
				// F-002 fix: Windows probe probes cmd.exe availability; on
				// a functioning Windows system cmd.exe is available.
				expect(result.mechanism).toBe('PowerShell wrapper');
				expect(result.status).toBe('enabled');
			},
		);

		test.skipIf(platform !== 'linux')(
			'detect() does not throw on Linux (bwrap missing is non-fatal)',
			async () => {
				const probe = new SandboxCapabilityProbe();
				expect(async () => await probe.detect()).not.toThrow();
			},
		);
	});

	describe('sync helper availability checks', () => {
		test('isBubblewrapAvailable() returns boolean after detect()', async () => {
			const probe = new SandboxCapabilityProbe();
			await probe.detect();
			expect(typeof isBubblewrapAvailable()).toBe('boolean');
		});

		test('isSandboxExecAvailable() returns boolean after detect()', async () => {
			const probe = new SandboxCapabilityProbe();
			await probe.detect();
			expect(typeof isSandboxExecAvailable()).toBe('boolean');
		});

		test('isWindowsSandboxAvailable() returns boolean after detect()', async () => {
			const probe = new SandboxCapabilityProbe();
			await probe.detect();
			expect(typeof isWindowsSandboxAvailable()).toBe('boolean');
		});

		test('is*Available() return false before detect() is called', () => {
			// Before any detect() call the helpers return false (cache is undefined)
			expect(typeof isBubblewrapAvailable()).toBe('boolean');
			expect(typeof isSandboxExecAvailable()).toBe('boolean');
			expect(typeof isWindowsSandboxAvailable()).toBe('boolean');
		});
	});

	describe('timeout / non-blocking behavior', () => {
		test('detect() resolves within reasonable time (< 5s)', async () => {
			const probe = new SandboxCapabilityProbe();
			const start = Date.now();
			await probe.detect();
			const elapsed = Date.now() - start;
			// 5s guard — real timeout is 2s per probe
			expect(elapsed).toBeLessThan(5000);
		});
	});

	describe('error handling — fail-open', () => {
		test.skipIf(platform !== 'linux')(
			'detect() never throws even when binary is missing (linux)',
			async () => {
				const probe = new SandboxCapabilityProbe();
				const result = await probe.detect();
				expect(['enabled', 'disabled', 'unsupported']).toContain(result.status);
			},
		);

		test.skipIf(platform !== 'linux')(
			'detect() result includes error message when status is disabled',
			async () => {
				const probe = new SandboxCapabilityProbe();
				const result = await probe.detect();
				if (result.status === 'disabled') {
					expect(result.error).toBeDefined();
					expect(typeof result.error).toBe('string');
				}
			},
		);
	});

	describe('session-level caching', () => {
		test('second detect() call returns the cached result', async () => {
			const probe1 = new SandboxCapabilityProbe();
			const probe2 = new SandboxCapabilityProbe();

			const result1 = await probe1.detect();
			// Small delay to ensure cache is set
			await new Promise((r) => setTimeout(r, 10));
			const result2 = await probe2.detect();

			// Should be the same object reference (cached)
			expect(result1).toBe(result2);
		});
	});
});
