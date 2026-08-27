/**
 * Tests for src/sandbox/capability-probe.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	_resetCapabilityCache,
	assessSandboxRequirements,
	isBubblewrapAvailable,
	isSandboxExecAvailable,
	isWindowsSandboxAvailable,
	SandboxCapabilityProbe,
} from '../../../src/sandbox/capability-probe';
import { _internals as linuxExecutorInternals } from '../../../src/sandbox/linux/bubblewrap-executor';

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
			expect(result).toHaveProperty('filesystem');
			expect(result).toHaveProperty('network');
			expect(result).toHaveProperty('process');
			expect(result).toHaveProperty('effective');
			expect(result).toHaveProperty('identity');
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

		test('cache invalidates when the resolved probe binary identity changes', async () => {
			const originalPlatform = process.platform;
			const originalWithProbeTimeout = _internals.withProbeTimeout;
			const originalResolveBwrapBinary =
				linuxExecutorInternals.resolveBwrapBinary;
			let callCount = 0;
			Object.defineProperty(process, 'platform', {
				value: 'linux',
				configurable: true,
			});
			linuxExecutorInternals.resolveBwrapBinary = () =>
				callCount === 0 ? '/usr/bin/bwrap-a' : '/usr/bin/bwrap-b';
			_internals.withProbeTimeout = mock(async () => {
				callCount += 1;
				return 'bubblewrap 1.0';
			});

			try {
				const first = await new SandboxCapabilityProbe().detect();
				const second = await new SandboxCapabilityProbe().detect();
				expect(callCount).toBe(2);
				expect(first).not.toBe(second);
				expect(first.identity).not.toBe(second.identity);
			} finally {
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
				linuxExecutorInternals.resolveBwrapBinary = originalResolveBwrapBinary;
				_internals.withProbeTimeout = originalWithProbeTimeout;
				_resetCapabilityCache();
			}
		});
	});

	describe('regressions FB-023 and FB-024', () => {
		const originalSpawnSync = _internals.spawnSync;
		const originalRemoveProbeTempRoot = _internals.removeProbeTempRoot;
		const originalComSpec = process.env.ComSpec;
		const originalPathEnv = process.env.Path;
		const originalResolveBwrapBinary =
			linuxExecutorInternals.resolveBwrapBinary;

		afterEach(() => {
			_internals.spawnSync = originalSpawnSync;
			_internals.removeProbeTempRoot = originalRemoveProbeTempRoot;
			linuxExecutorInternals.resolveBwrapBinary = originalResolveBwrapBinary;
			if (originalComSpec === undefined) {
				delete process.env.ComSpec;
			} else {
				process.env.ComSpec = originalComSpec;
			}
			if (originalPathEnv === undefined) {
				delete process.env.Path;
			} else {
				process.env.Path = originalPathEnv;
			}
			_resetCapabilityCache();
		});

		test('regression FB-023: windows probe source identity follows the resolved command processor instead of a hardcoded system path literal', () => {
			const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cmd-'));
			const cmdA = path.join(tempRoot, 'cmd-a.exe');
			const cmdB = path.join(tempRoot, 'cmd-b.exe');
			fs.writeFileSync(cmdA, '');
			fs.writeFileSync(cmdB, '');
			process.env.Path = '';
			process.env.ComSpec = cmdA;
			const first = _internals.currentProbeSourceIdentity('win32');
			process.env.ComSpec = cmdB;
			const second = _internals.currentProbeSourceIdentity('win32');

			try {
				expect(first).toContain(path.normalize(cmdA));
				expect(second).toContain(path.normalize(cmdB));
				expect(first).not.toContain('C:\\Windows\\System32\\cmd.exe');
				expect(second).not.toContain('C:\\Windows\\System32\\cmd.exe');
				expect(first).not.toBe(second);
			} finally {
				fs.rmSync(tempRoot, { recursive: true, force: true });
			}
		});

		test('regression FB-024: behavioral probes surface cleanup failures without discarding a bounded success result', () => {
			linuxExecutorInternals.resolveBwrapBinary = () => 'bwrap';
			_internals.spawnSync = mock(
				(_cmd: string, args: string[], options?: { input?: string }) => {
					const target = args.at(-1) ?? '';
					if (target.endsWith('inside.txt')) {
						fs.writeFileSync(target, String(options?.input ?? ''));
						return { status: 0, stdout: '', stderr: '' };
					}
					if (target.endsWith('outside.txt')) {
						return { status: 1, stdout: '', stderr: 'denied' };
					}
					if (target === '/proc/self/ns/net') {
						return { status: 0, stdout: '', stderr: '' };
					}
					return { status: 0, stdout: '', stderr: '' };
				},
			) as unknown as typeof originalSpawnSync;
			_internals.removeProbeTempRoot = (() => {
				const error = new Error('busy') as NodeJS.ErrnoException;
				error.code = 'EPERM';
				throw error;
			}) as typeof originalRemoveProbeTempRoot;

			const result = _internals.detectBehavioralEvidence({
				status: 'enabled',
				strength: 'strong',
				mechanism: 'Bubblewrap',
				platform: 'linux',
			});

			expect(result.filesystem).toBe('real');
			expect(result.reasons).toContain(
				'bubblewrap allowed in-scope writes and blocked out-of-scope writes in a bounded probe',
			);
			expect(result.reasons).toContain(
				'bubblewrap probe temp cleanup failed (EPERM)',
			);
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
			expect(result.filesystem).toBe('weak');
			expect(result.network).toBe('none');
			expect(result.process).toBe('none');
			expect(result.effective).toBe('none');
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

	describe('requirement assessment', () => {
		test('required filesystem+network fails when capability is partial', () => {
			const result = assessSandboxRequirements(
				{
					v: 1,
					status: 'enabled',
					strength: 'strong',
					mechanism: 'sandbox-exec',
					platform: 'darwin',
					filesystem: 'real',
					network: 'none',
					process: 'none',
					effective: 'none',
					reasons: ['network outside boundary'],
					identity: 'darwin:sandbox-exec',
				},
				{
					mode: 'required',
					require_filesystem: true,
					require_network: true,
				},
			);

			expect(result.satisfied).toBe(false);
			expect(result.missing).toEqual(['network']);
		});

		test('advisory mode never blocks', () => {
			const result = assessSandboxRequirements(
				{
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
				},
				{
					mode: 'advisory',
					require_filesystem: true,
					require_network: true,
				},
			);

			expect(result.satisfied).toBe(true);
			expect(result.missing).toEqual([]);
		});
	});
});
