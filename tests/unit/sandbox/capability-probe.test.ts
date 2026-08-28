/**
 * Tests for src/sandbox/capability-probe.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	_resetCapabilityCache,
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
			const start = performance.now();
			await probe.detect();
			const elapsed = performance.now() - start;
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

	// -------------------------------------------------------------------------
	// darwin block (issue #2236 F6/F9) — seam-driven so it runs on any host.
	//
	// Prior to F6, capability-probe.test.ts had NO darwin coverage at all: the
	// only way to exercise probeMacOS() was to actually run on a macOS host.
	// process.platform is overridden via the established Object.defineProperty
	// pattern (see tests/unit/config/cache-paths.test.ts) and
	// _internals.withProbeTimeout is mocked, so these assertions exercise the
	// real probeMacOS() logic — including the F6 exit-code-only fix — from
	// this Windows host.
	// -------------------------------------------------------------------------
	describe('darwin — probeMacOS() (#2236 F6, seam-driven)', () => {
		const originalPlatform = process.platform;
		const originalWithProbeTimeout = _internals.withProbeTimeout;

		function setPlatform(value: NodeJS.Platform): void {
			Object.defineProperty(process, 'platform', {
				value,
				configurable: true,
			});
		}

		beforeEach(() => {
			setPlatform('darwin');
			_resetCapabilityCache();
		});

		afterEach(() => {
			Object.defineProperty(process, 'platform', {
				value: originalPlatform,
				configurable: true,
			});
			_internals.withProbeTimeout = originalWithProbeTimeout;
			_resetCapabilityCache();
		});

		test('resolved withProbeTimeout (exit 0) with EMPTY stdout reports enabled/strong — the case the old stdout-length check got wrong', async () => {
			_internals.withProbeTimeout = mock(async () => '');

			const result = await new SandboxCapabilityProbe().detect();

			expect(result.status).toBe('enabled');
			expect(result.strength).toBe('strong');
			expect(result.mechanism).toBe('sandbox-exec');
			expect(result.platform).toBe('darwin');
		});

		test('resolved withProbeTimeout with non-empty stdout ALSO reports enabled (content is irrelevant to the criterion)', async () => {
			_internals.withProbeTimeout = mock(async () => 'some incidental output');

			const result = await new SandboxCapabilityProbe().detect();

			expect(result.status).toBe('enabled');
		});

		test('rejected withProbeTimeout with a non-ENOENT error reports disabled, not unsupported', async () => {
			_internals.withProbeTimeout = mock(async () => {
				throw new Error('permission denied');
			});

			const result = await new SandboxCapabilityProbe().detect();

			expect(result.status).toBe('disabled');
			expect(result.error).toBe('permission denied');
		});

		test('rejected withProbeTimeout with "binary not found" reports unsupported', async () => {
			_internals.withProbeTimeout = mock(async () => {
				throw new Error('binary not found');
			});

			const result = await new SandboxCapabilityProbe().detect();

			expect(result.status).toBe('unsupported');
		});

		test('invokes withProbeTimeout with -p <profile> <target>, never --version', async () => {
			let capturedArgs: [string, string[], number] | undefined;
			_internals.withProbeTimeout = mock(
				async (cmd: string, args: string[], ms: number) => {
					capturedArgs = [cmd, args, ms];
					return '';
				},
			);

			await new SandboxCapabilityProbe().detect();

			expect(capturedArgs).toBeDefined();
			const [, args] = capturedArgs!;
			expect(args).not.toContain('--version');
			expect(args[0]).toBe('-p');
			expect(typeof args[1]).toBe('string');
			expect(args[1]).toContain('(version 1)');
		});

		test('isSandboxExecAvailable() reflects the mocked enabled result', async () => {
			_internals.withProbeTimeout = mock(async () => '');
			await new SandboxCapabilityProbe().detect();
			expect(isSandboxExecAvailable()).toBe(true);
		});
	});
});
