/**
 * Error-handling tests for /swarm handoff command.
 * Verifies graceful degradation when atomic writes fail.
 *
 * Issue #2035 migrated handoff's file writes to the canonical
 * `atomicWriteSwarmFile` helper, so failure injection targets
 * `src/utils/atomic-write.ts:_internals` (writeSync / renameSync / unlinkSync)
 * — the seam the writer actually consults. Mocking `Bun.write` or
 * `mock.module('node:fs', ...)` no longer intercepts anything.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';

import { _internals as atomicWriteInternals } from '../utils/atomic-write.js';

// Mock snapshot-writer to be no-ops (handoff flushes the snapshot on success)
mock.module('../session/snapshot-writer', () => ({
	writeSnapshot: mock(() => Promise.resolve()),
	flushPendingSnapshot: mock(() => Promise.resolve()),
}));

import { handleHandoffCommand } from './handoff';

const realWriteSync = atomicWriteInternals.writeSync;
const realRenameSync = atomicWriteInternals.renameSync;
const realUnlinkSync = atomicWriteInternals.unlinkSync;

describe('handleHandoffCommand', () => {
	let testDir: string;
	let unlinkTargets: string[];
	let renameCount: number;

	beforeEach(() => {
		testDir = canonicalMkdtemp('handoff-err-');
		unlinkTargets = [];
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

	/** Leftover atomic-write temps in .swarm (canonical or legacy grammar). */
	function residueTemps(): string[] {
		const swarm = join(testDir, '.swarm');
		if (!existsSync(swarm)) return [];
		return readdirSync(swarm).filter((f) => f.endsWith('.tmp'));
	}

	// ---------------------------------------------------------------------------
	// Payload-write failure (previously "bunWrite throws")
	// ---------------------------------------------------------------------------

	test('returns error message with inline content when the payload write fails', async () => {
		atomicWriteInternals.writeSync = () => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('file write failed');
		expect(result).toContain('## Swarm Handoff');
		expect(result).toContain('ENOSPC');
		expect(result).toContain('no space left on device');
		expect(result).toContain(
			'The handoff content is included below for manual copy',
		);

		// The failed write's own temp is cleaned up — no new residue.
		expect(residueTemps()).toEqual([]);
	});

	test('includes handoff markdown content in the fallback response', async () => {
		atomicWriteInternals.writeSync = () => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			});
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('**Generated**:');
		expect(result).toContain('## Handoff Generated (file write failed)');
	});

	test('the payload write is attempted (write path reached)', async () => {
		let writeCalls = 0;
		const real = realWriteSync;
		atomicWriteInternals.writeSync = (
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
		) => {
			writeCalls++;
			return real(fd, buffer, offset, length);
		};

		await handleHandoffCommand(testDir, []);

		expect(writeCalls).toBeGreaterThan(0);
	});

	// ---------------------------------------------------------------------------
	// rename failure — own-temp cleanup still runs
	// ---------------------------------------------------------------------------

	describe('when the atomic rename throws', () => {
		test('returns fallback content when the rename fails on handoff.md', async () => {
			// EIO is not in RETRYABLE_RENAME_CODES, so it fails fast.
			atomicWriteInternals.renameSync = (_from: string, _to: string) => {
				throw Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
			};

			const result = await handleHandoffCommand(testDir, []);

			expect(result).toContain('## Handoff Generated (file write failed)');
			expect(result).toContain('EIO');
			expect(residueTemps()).toEqual([]);
		});

		test('cleans up the handoff.md temp (canonical grammar) when the rename fails', async () => {
			atomicWriteInternals.renameSync = (_from: string, _to: string) => {
				throw Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
			};

			await handleHandoffCommand(testDir, []);

			// The failed rename's temp was unlinked exactly once, under the
			// canonical <target>.<hex32>.tmp grammar.
			const handoffTemps = unlinkTargets.filter((p) =>
				p.includes('handoff.md'),
			);
			expect(handoffTemps.length).toBe(1);
			expect(handoffTemps[0]).toMatch(/handoff\.md\.[0-9a-f]{32}\.tmp$/);
			expect(residueTemps()).toEqual([]);
		});

		test('cleans up the handoff-prompt.md temp when its rename fails', async () => {
			// First rename (handoff.md) succeeds, second (prompt) throws EIO.
			atomicWriteInternals.renameSync = (from: string, to: string) => {
				renameCount++;
				if (renameCount === 1) return realRenameSync(from, to);
				throw Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
			};

			const result = await handleHandoffCommand(testDir, []);

			expect(result).toContain('## Handoff Generated (file write failed)');
			const promptTemps = unlinkTargets.filter((p) =>
				p.includes('handoff-prompt.md'),
			);
			expect(promptTemps.length).toBe(1);
			expect(promptTemps[0]).toMatch(/handoff-prompt\.md\.[0-9a-f]{32}\.tmp$/);
			expect(residueTemps()).toEqual([]);
		});
	});

	// ---------------------------------------------------------------------------
	// Payload-write failure — own temp is still cleaned (it exists by then)
	// ---------------------------------------------------------------------------

	test('a failed payload write still cleans its own temp file', async () => {
		atomicWriteInternals.writeSync = () => {
			throw Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			});
		};

		await handleHandoffCommand(testDir, []);

		// The temp exists from openSync('wx') before writeSync throws; the
		// finally-unlink must remove it (issue #2035: failed writes clean only
		// their own temp and preserve the previous target).
		expect(residueTemps()).toEqual([]);
		expect(unlinkTargets.some((p) => /\.tmp$/.test(p))).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// Happy path
	// ---------------------------------------------------------------------------

	test('happy path: both artifacts written, no temp residue, both renames run', async () => {
		atomicWriteInternals.renameSync = (from: string, to: string) => {
			renameCount++;
			return realRenameSync(from, to);
		};

		const result = await handleHandoffCommand(testDir, []);

		expect(result).toContain('## Handoff Brief Written');
		expect(result).not.toContain('file write failed');
		expect(renameCount).toBe(2); // handoff.md and handoff-prompt.md
		expect(residueTemps()).toEqual([]);
	});
});
