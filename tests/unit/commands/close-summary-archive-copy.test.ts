/** Regression tests for copying the current close summary into an archive. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { _internals as closeInternals } from '../../../src/commands/close.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let testDir: string;

beforeEach(() => {
	testDir = canonicalMkdtemp('close-summary-archive-');
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function makeContext(archiveDir: string, archiveStageFailed = false) {
	return {
		archiveStageFailed,
		archiveDir,
		warnings: [] as string[],
	};
}

describe('archiveCloseSummary', () => {
	it('copies the freshly written summary into a healthy archive bundle', async () => {
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		const archiveDir = path.join(testDir, '.swarm', 'archive', 'current');
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(summaryPath, '# current summary');
		const ctx = makeContext(archiveDir);

		await closeInternals.archiveCloseSummary(ctx, summaryPath, true);

		const archivedPath = path.join(archiveDir, 'close-summary.md');
		expect(existsSync(archivedPath)).toBe(true);
		expect(readFileSync(archivedPath, 'utf-8')).toBe('# current summary');
		expect(ctx.warnings).toEqual([]);
	});

	it('skips the archive copy when archive creation failed', async () => {
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		const archiveDir = path.join(testDir, '.swarm', 'archive', 'missing');
		writeFileSync(summaryPath, '# current summary');
		const ctx = makeContext(archiveDir, true);

		await closeInternals.archiveCloseSummary(ctx, summaryPath, true);

		expect(existsSync(path.join(archiveDir, 'close-summary.md'))).toBe(false);
		expect(ctx.warnings).toEqual([]);
	});

	it('reports archive-copy failures separately from the primary write', async () => {
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		const archiveDir = path.join(testDir, '.swarm', 'archive', 'missing');
		writeFileSync(summaryPath, '# current summary');
		const ctx = makeContext(archiveDir);

		await closeInternals.archiveCloseSummary(ctx, summaryPath, true);

		expect(ctx.warnings[0]).toContain('Failed to archive close-summary.md:');
		expect(ctx.warnings[0]).not.toContain('Failed to write close-summary.md');
	});

	it('does not archive a stale summary when the current write failed', async () => {
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		const archiveDir = path.join(testDir, '.swarm', 'archive', 'stale');
		mkdirSync(archiveDir, { recursive: true });
		writeFileSync(summaryPath, '# stale previous-session summary');
		const ctx = makeContext(archiveDir);

		await closeInternals.archiveCloseSummary(ctx, summaryPath, false);

		expect(existsSync(path.join(archiveDir, 'close-summary.md'))).toBe(false);
		expect(ctx.warnings).toEqual([]);
	});
});
