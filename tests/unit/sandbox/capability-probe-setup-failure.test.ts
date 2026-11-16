/**
 * #3332 regression: a probe temp-SETUP failure (mkdtemp ENOSPC/EACCES, mkdir
 * EACCES, profile build error) returns a bounded BehavioralEvidence result
 * and cleans up whatever it created — it never escapes detectBehavioralEvidence
 * as an unhandled throw, and never leaks the probe temp root.
 *
 * Drives _internals.detectBehavioralEvidence directly with node:fs mocked
 * (originals captured first — Bun hot-swaps the captured namespace);
 * spawnSync is stubbed so no probe binary runs. The residue check scans the
 * REAL canonicalTempRoot() around each call (mkdtempSync stays real except in the
 * mkdtemp-failure legs).
 *
 * RED at base (R1/R2 reproduced the unhandled EACCES + leaked root), GREEN
 * after the fix.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import {
	canonicalMkdtemp,
	canonicalTmpDir as canonicalTempRoot,
} from '../../helpers/tmpdir';

const realMkdtempSync = realFs.mkdtempSync;
const realMkdirSync = realFs.mkdirSync;
const realReaddirSync = realFs.readdirSync;
const realRmSync = realFs.rmSync;
void realMkdirSync;
void realReaddirSync;
void realRmSync;

function errnoError(code: string, message: string): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

function probeResidue(prefix: string): string[] {
	return realFs
		.readdirSync(canonicalTempRoot())
		.filter((name) => name.startsWith(prefix));
}

afterEach(() => {
	mock.restore();
});

describe('probe temp-setup failures are bounded (linux)', () => {
	const capability = {
		status: 'enabled',
		strength: 'advisory',
		mechanism: 'Bubblewrap',
		platform: 'linux',
	} as const;

	test('mkdirSync failure: no throw, weak dimensions, reason recorded, temp root cleaned', async () => {
		const before = new Set(probeResidue('swarm-bwrap-probe-'));
		mock.module('node:fs', () => ({
			...realFs,
			mkdtempSync: realMkdtempSync,
			mkdirSync: (p: unknown) => {
				if (typeof p === 'string' && p.endsWith('allowed')) {
					throw errnoError('EACCES', `EACCES: permission denied, mkdir '${p}'`);
				}
				return undefined;
			},
		}));
		const { _internals } = await import(
			'../../../src/sandbox/capability-probe.js'
		);
		const originalSpawn = _internals.spawnSync;
		_internals.spawnSync = (() => ({
			status: 0,
			stdout: '',
			stderr: '',
		})) as unknown as typeof _internals.spawnSync;
		try {
			let thrown: unknown;
			const result = (() => {
				try {
					return _internals.detectBehavioralEvidence(capability);
				} catch (error) {
					thrown = error;
					return undefined;
				}
			})();
			expect(thrown).toBeUndefined();
			expect(result?.filesystem).toBe('weak');
			expect(result?.reasons ?? []).not.toEqual([]);
			const after = probeResidue('swarm-bwrap-probe-');
			const leaked = after.filter((name) => !before.has(name));
			expect(leaked).toEqual([]);
		} finally {
			_internals.spawnSync = originalSpawn;
			for (const name of probeResidue('swarm-bwrap-probe-')) {
				if (!before.has(name)) {
					realFs.rmSync(path.join(canonicalTempRoot(), name), {
						recursive: true,
						force: true,
					});
				}
			}
		}
	}, 60_000);

	test('mkdtempSync failure: no throw, bounded result, no cleanup attempt needed', async () => {
		mock.module('node:fs', () => ({
			...realFs,
			mkdtempSync: () => {
				throw errnoError('ENOSPC', 'ENOSPC: no space left on device, mkdtemp');
			},
		}));
		const { _internals } = await import(
			'../../../src/sandbox/capability-probe.js'
		);
		const originalSpawn = _internals.spawnSync;
		_internals.spawnSync = (() => ({
			status: 0,
			stdout: '',
			stderr: '',
		})) as unknown as typeof _internals.spawnSync;
		try {
			let thrown: unknown;
			const result = (() => {
				try {
					return _internals.detectBehavioralEvidence(capability);
				} catch (error) {
					thrown = error;
					return undefined;
				}
			})();
			expect(thrown).toBeUndefined();
			expect(result?.filesystem).toBe('weak');
			expect(result?.reasons ?? []).not.toEqual([]);
		} finally {
			_internals.spawnSync = originalSpawn;
		}
	}, 60_000);
});

describe('probe temp-setup failures are bounded (darwin)', () => {
	const capability = {
		status: 'enabled',
		strength: 'advisory',
		mechanism: 'sandbox-exec',
		platform: 'darwin',
	} as const;

	test('mkdirSync failure: no throw, weak dimensions, reason recorded, temp root cleaned', async () => {
		const before = new Set(probeResidue('swarm-seatbelt-probe-'));
		mock.module('node:fs', () => ({
			...realFs,
			mkdtempSync: realMkdtempSync,
			mkdirSync: (p: unknown) => {
				if (typeof p === 'string' && p.endsWith('sandbox-tmp')) {
					throw errnoError('EACCES', `EACCES: permission denied, mkdir '${p}'`);
				}
				return undefined;
			},
		}));
		const { _internals } = await import(
			'../../../src/sandbox/capability-probe.js'
		);
		const originalSpawn = _internals.spawnSync;
		_internals.spawnSync = (() => ({
			status: 0,
			stdout: '',
			stderr: '',
		})) as unknown as typeof _internals.spawnSync;
		try {
			let thrown: unknown;
			const result = (() => {
				try {
					return _internals.detectBehavioralEvidence(capability);
				} catch (error) {
					thrown = error;
					return undefined;
				}
			})();
			expect(thrown).toBeUndefined();
			expect(result?.filesystem).toBe('weak');
			expect(result?.reasons ?? []).not.toEqual([]);
			const after = probeResidue('swarm-seatbelt-probe-');
			const leaked = after.filter((name) => !before.has(name));
			expect(leaked).toEqual([]);
		} finally {
			_internals.spawnSync = originalSpawn;
			for (const name of probeResidue('swarm-seatbelt-probe-')) {
				if (!before.has(name)) {
					realFs.rmSync(path.join(canonicalTempRoot(), name), {
						recursive: true,
						force: true,
					});
				}
			}
		}
	}, 60_000);

	test('buildSandboxProfile failure: no throw, bounded result, temp root cleaned', async () => {
		const before = new Set(probeResidue('swarm-seatbelt-probe-'));
		mock.module('node:fs', () => ({
			...realFs,
			mkdtempSync: realMkdtempSync,
		}));
		const { _internals, default: _unusedNamespace } = await import(
			'../../../src/sandbox/capability-probe.js'
		);
		void _unusedNamespace;
		// The macOS probe builds its SBPL profile through the executor's
		// seam; make THAT throw to cover the profile-build setup leg.
		const macosModule = await import(
			'../../../src/sandbox/macos/sandbox-exec-executor.js'
		);
		const originalBuild = macosModule._internals.buildSandboxProfile;
		macosModule._internals.buildSandboxProfile = () => {
			throw errnoError('EINVAL', 'EINVAL: invalid profile');
		};
		const originalSpawn = _internals.spawnSync;
		_internals.spawnSync = (() => ({
			status: 0,
			stdout: '',
			stderr: '',
		})) as unknown as typeof _internals.spawnSync;
		try {
			let thrown: unknown;
			const result = (() => {
				try {
					return _internals.detectBehavioralEvidence(capability);
				} catch (error) {
					thrown = error;
					return undefined;
				}
			})();
			expect(thrown).toBeUndefined();
			expect(result?.filesystem).toBe('weak');
			expect(result?.reasons ?? []).not.toEqual([]);
			const after = probeResidue('swarm-seatbelt-probe-');
			const leaked = after.filter((name) => !before.has(name));
			expect(leaked).toEqual([]);
		} finally {
			macosModule._internals.buildSandboxProfile = originalBuild;
			_internals.spawnSync = originalSpawn;
			for (const name of probeResidue('swarm-seatbelt-probe-')) {
				if (!before.has(name)) {
					realFs.rmSync(path.join(canonicalTempRoot(), name), {
						recursive: true,
						force: true,
					});
				}
			}
		}
	}, 60_000);
});

// Guard against vacuous imports: canonicalMkdtemp is part of this file's
// tmpdir-hygiene convention even when a leg stubs mkdtempSync itself.
void canonicalMkdtemp;
