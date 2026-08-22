/**
 * Adversarial tests for temp file cleanup in handoff.ts
 * Tests error handling paths for renameSync/unlinkSync cleanup patterns
 * that are NOT covered by the main error-handling test suite.
 *
 * Issue #2035 migrated handoff's writes to the canonical atomic-write helper,
 * so failure injection targets `src/utils/atomic-write.ts:_internals`
 * (renameSync / unlinkSync / writeSync) — the seam the writer consults.
 * Mocking `Bun.write` / `mock.module('node:fs', ...)` no longer intercepts.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _internals as atomicWriteInternals } from '../utils/atomic-write.js';

mock.module('../session/snapshot-writer', () => ({
	writeSnapshot: mock(async () => {}),
	flushPendingSnapshot: mock(async () => {}),
}));

import { handleHandoffCommand } from './handoff';

const realWriteSync = atomicWriteInternals.writeSync;
const realRenameSync = atomicWriteInternals.renameSync;
const realUnlinkSync = atomicWriteInternals.unlinkSync;

describe('handoff.ts temp file cleanup adversarial tests', () => {
	let testDir: string;
	let unlinkTargets: string[];
	let renameDests: string[];
	let renameCount: number;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), 'handoff-adv-'));
		unlinkTargets = [];
		renameDests = [];
		renameCount = 0;
		atomicWriteInternals.writeSync = realWriteSync;
		atomicWriteInternals.renameSync = realRenameSync;
		atomicWriteInternals.unlinkSync = (p: string) => {
			unlinkTargets.push(p);
			return realUnlinkSync(p);
		};
	});

	afterEach(() => {
		atomicWriteInternals.writeSync = realWriteSync;
		atomicWriteInternals.renameSync = realRenameSync;
		atomicWriteInternals.unlinkSync = realUnlinkSync;
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
		mock.restore();
	});

	function residueTemps(): string[] {
		const swarm = join(testDir, '.swarm');
		if (!existsSync(swarm)) return [];
		return readdirSync(swarm).filter((f) => f.endsWith('.tmp'));
	}

	/** Renames that delegate to the real fs while recording destinations. */
	function recordRenames(): void {
		atomicWriteInternals.renameSync = (from: string, to: string) => {
			renameCount++;
			renameDests.push(to);
			return realRenameSync(from, to);
		};
	}

	// ---------------------------------------------------------------------------
	// AV1: rename fails but unlink cleanup also fails
	// Verify: no crash, original rename error still propagated
	// ---------------------------------------------------------------------------

	test('AV1: rename fails, unlink also fails — original error propagated, no crash', async () => {
		atomicWriteInternals.renameSync = () => {
			throw Object.assign(new Error('EPERM: operation not permitted'), {
				code: 'EPERM',
			});
		};
		atomicWriteInternals.unlinkSync = () => {
			throw Object.assign(new Error('EBUSY: resource busy'), {
				code: 'EBUSY',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		// Should get error response, not crash
		expect(result).toContain('Handoff Generated (file write failed)');
		expect(result).toContain('EPERM');
	});

	// ---------------------------------------------------------------------------
	// AV2: rename throws EPERM (permission) — cleanup attempted
	// ---------------------------------------------------------------------------

	test('AV2: rename throws EPERM — own-temp cleanup attempted under the canonical grammar', async () => {
		atomicWriteInternals.renameSync = () => {
			throw Object.assign(new Error('EPERM: operation not permitted'), {
				code: 'EPERM',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		// unlink was attempted for the temp
		expect(unlinkTargets.length).toBeGreaterThan(0);
		expect(unlinkTargets[0]).toMatch(/handoff\.md\.[0-9a-f]{32}\.tmp$/);
		expect(result).toContain('EPERM');
	});

	// ---------------------------------------------------------------------------
	// AV3: first file succeeds, second rename fails, writeSnapshot throws
	// Verify: the rename error is surfaced, not the writeSnapshot error
	// ---------------------------------------------------------------------------

	test('AV3: second file rename fails, writeSnapshot then throws — first error surfaced', async () => {
		mock.module('../session/snapshot-writer', () => ({
			writeSnapshot: mock(async () => {
				throw new Error('writeSnapshot failed');
			}),
			flushPendingSnapshot: mock(async () => {}),
		}));

		let localRenameCount = 0;
		atomicWriteInternals.renameSync = (from: string, to: string) => {
			localRenameCount++;
			if (localRenameCount === 1) return realRenameSync(from, to);
			throw Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('ENOSPC');
		expect(result).not.toContain('writeSnapshot failed');
	});

	// ---------------------------------------------------------------------------
	// AV4: temp paths unique per write — random-suffix collision resistance
	// ---------------------------------------------------------------------------

	test('AV4: temp paths are unique per write — random-suffix collision resistance', async () => {
		recordRenames();

		await handleHandoffCommand(testDir, []);

		// Both artifacts written (handoff.md + handoff-prompt.md)
		expect(renameCount).toBe(2);

		const tempPaths = unlinkTargets;
		// The finally-unlink observed one unique canonical temp per write
		expect(tempPaths.length).toBe(2);
		const suffixes = tempPaths.map(
			(p) => p.match(/\.([0-9a-f]{32})\.tmp$/)?.[1],
		);
		expect(suffixes.every(Boolean)).toBe(true);
		expect(new Set(suffixes).size).toBe(2);
	});

	// ---------------------------------------------------------------------------
	// AV5: validateSwarmPath with directory traversal
	// Verify: path is rejected before any temp file creation
	// ---------------------------------------------------------------------------

	test('AV5: path traversal in filename — validateSwarmPath rejects before temp creation', async () => {
		const maliciousFilename = '../../../etc/passwd';

		const { validateSwarmPath } = await import('../hooks/utils');
		expect(() => validateSwarmPath(testDir, maliciousFilename)).toThrow(
			/path traversal detected/,
		);

		expect(/\.\.[/\\]/.test(maliciousFilename)).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// AV6: successful writes — both artifacts committed, zero residue
	// ---------------------------------------------------------------------------

	test('AV6: successful writes — both artifacts committed with zero temp residue', async () => {
		recordRenames();

		await handleHandoffCommand(testDir, []);

		expect(renameCount).toBe(2);
		expect(existsSync(join(testDir, '.swarm', 'handoff.md'))).toBe(true);
		expect(existsSync(join(testDir, '.swarm', 'handoff-prompt.md'))).toBe(true);
		// The own-temp finally-unlink is a no-op ENOENT after each successful
		// rename — nothing is left behind.
		expect(residueTemps()).toEqual([]);
	});

	// ---------------------------------------------------------------------------
	// AV7: payload write fails — no rename, own temp still cleaned
	// ---------------------------------------------------------------------------

	test('AV7: payload write fails — rename never attempted, own temp cleaned, error propagated', async () => {
		recordRenames();
		atomicWriteInternals.writeSync = () => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('Handoff Generated (file write failed)');
		expect(result).toContain('ENOSPC');
		// No rename attempted since the payload write failed
		expect(renameCount).toBe(0);
		// The temp that existed before the write failure was removed
		expect(residueTemps()).toEqual([]);
	});

	// ---------------------------------------------------------------------------
	// AV8: rapid successive calls — verify state isolation
	// ---------------------------------------------------------------------------

	test('AV8: consecutive calls — temp paths isolated per invocation', async () => {
		recordRenames();

		await handleHandoffCommand(testDir, []);
		await handleHandoffCommand(testDir, []);

		// 2 files x 2 calls: all temp paths unique across invocations
		expect(unlinkTargets.length).toBe(4);
		const suffixes = unlinkTargets.map(
			(p) => p.match(/\.([0-9a-f]{32})\.tmp$/)?.[1],
		);
		expect(new Set(suffixes).size).toBe(4);
	});

	// ---------------------------------------------------------------------------
	// AV9: unlink on non-existent path (ENOENT)
	// Verify: unlink failure doesn't prevent error propagation
	// ---------------------------------------------------------------------------

	test('AV9: unlink on non-existent path — ENOENT ignored, original error surfaced', async () => {
		atomicWriteInternals.renameSync = () => {
			throw Object.assign(new Error('EBADF: bad file descriptor'), {
				code: 'EBADF',
			});
		};
		atomicWriteInternals.unlinkSync = () => {
			// Cleanup fails with ENOENT (file doesn't exist) — must be ignored
			throw Object.assign(new Error('ENOENT: no such file'), {
				code: 'ENOENT',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('EBADF');
	});

	// ---------------------------------------------------------------------------
	// AV10: both rename and unlink fail for the second file
	// Verify: first file is committed, second file's error surfaced
	// ---------------------------------------------------------------------------

	test('AV10: first file committed, second file rename fails — second error surfaced', async () => {
		let localRenameCount = 0;
		atomicWriteInternals.renameSync = (from: string, to: string) => {
			localRenameCount++;
			if (localRenameCount === 1) return realRenameSync(from, to);
			throw Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
		};

		const result = await handleHandoffCommand(testDir, []);

		// Second file's error is surfaced
		expect(result).toContain('EIO');
		// First file's rename was committed
		expect(localRenameCount).toBe(2);
		expect(existsSync(join(testDir, '.swarm', 'handoff.md'))).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// AV11: unlink race condition — file deleted before unlink is called
	// ---------------------------------------------------------------------------

	test('AV11: file deleted between rename failure and unlink — ENOENT best-effort ignored', async () => {
		const callOrder: string[] = [];
		atomicWriteInternals.renameSync = () => {
			callOrder.push('rename');
			throw Object.assign(new Error('EBUSY: resource busy'), {
				code: 'EBUSY',
			});
		};
		atomicWriteInternals.unlinkSync = (p: string) => {
			callOrder.push('unlink');
			// File was already cleaned up by another process
			throw Object.assign(new Error('ENOENT: no such file'), {
				code: 'ENOENT',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(callOrder).toContain('rename');
		expect(callOrder).toContain('unlink');
		expect(result).toContain('EBUSY');
	});

	// ---------------------------------------------------------------------------
	// AV12: only the final path is validated by validateSwarmPath
	// ---------------------------------------------------------------------------

	test('AV12: final paths stay within .swarm — only the final path is security-relevant', async () => {
		recordRenames();

		await handleHandoffCommand(testDir, []);

		expect(renameDests.length).toBe(2);
		expect(renameDests.every((p) => p.includes('.swarm'))).toBe(true);
	});
});
