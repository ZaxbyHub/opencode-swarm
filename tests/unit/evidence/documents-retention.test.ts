import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	atomicRenameWithRetry,
	pruneEvidenceDocuments,
	type DocumentsRetentionResult,
} from '../../../src/evidence/documents-retention';

/**
 * Retention tests for the documents cache (issue #1184).
 *
 * Conventions (AGENTS.md invariant #7):
 *   - bun:test only
 *   - real fs under os.tmpdir() + realpath (no hardcoded /tmp or C:\)
 *   - _internals DI seam restored in afterEach (no mock.module leaks)
 *   - under 500 lines, focused on this one module
 */

function makeTmpDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-docs-ret-')));
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence-cache'), { recursive: true });
	return dir;
}

function cachePath(dir: string): string {
	return path.join(dir, '.swarm', 'evidence-cache', 'documents.jsonl');
}

interface Row {
	id: string;
	ref: string;
	text: string;
	capturedAt: string;
	sourceType?: string;
}

function rowToJson(row: Row): string {
	return JSON.stringify({
		id: row.id,
		ref: row.ref,
		sourceType: row.sourceType ?? 'web_search',
		text: row.text,
		capturedAt: row.capturedAt,
	});
}

async function writeRows(dir: string, rows: Row[]): Promise<void> {
	const content = rows.map(rowToJson).join('\n') + '\n';
	await fsp.writeFile(cachePath(dir), content, 'utf8');
}

async function readRows(dir: string): Promise<Record<string, unknown>[]> {
	const content = await fsp.readFile(cachePath(dir), 'utf8');
	return content
		.trim()
		.split('\n')
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

function makeRow(id: string, daysAgo: number, text = 'x'.repeat(100)): Row {
	// Fixed "now" reference = 2026-06-01. `daysAgo` days BEFORE that date.
	// Larger daysAgo → older row → pruned first.
	const now = Date.UTC(2026, 5, 1);
	const ts = new Date(now - daysAgo * 86_400_000).toISOString();
	return { id, ref: `evidence-cache:${id}`, text, capturedAt: ts };
}

describe('pruneEvidenceDocuments', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTmpDir();
	});

	afterEach(async () => {
		// Restore the DI seam so a later file's overrides don't leak.
		_internals.stat = (p) => fsp.stat(p);
		_internals.createReadStream = (p, options) =>
			fs.createReadStream(p, options);
		_internals.openSync = (p, flags) => fs.openSync(p, flags);
		_internals.writeSync = (fd, data, position) =>
			fs.writeSync(fd, data, position);
		_internals.fsyncSync = (fd) => fs.fsyncSync(fd);
		_internals.closeSync = (fd) => fs.closeSync(fd);
		_internals.renameWithRetry = atomicRenameWithRetry;
		_internals.unlink = (p) => fsp.unlink(p);
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	test('missing file → idempotent zeroed result, no throw', async () => {
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxBytes: 1024,
			maxRecords: 100,
		});
		expect(result).toMatchObject({
			inventory: 0,
			selected: 0,
			archived: 0,
			corrupt: 0,
			bytesBefore: 0,
			bytesAfter: 0,
			aborted: false,
		});
	});

	test('no caps configured → no-op, preserves append-only behavior', async () => {
		await writeRows(tempDir, [makeRow('evd_1', 1), makeRow('evd_2', 2)]);
		const before = await fsp.readFile(cachePath(tempDir), 'utf8');

		const result = await pruneEvidenceDocuments({ directory: tempDir });

		expect(result.selected).toBe(0);
		expect(result.archived).toBe(0);
		const after = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(after).toBe(before);
	});

	test('dry_run: true writes nothing (content + mtime unchanged)', async () => {
		await writeRows(tempDir, [
			makeRow('evd_1', 10),
			makeRow('evd_2', 1),
			makeRow('evd_3', 2),
		]);
		const beforeStat = await fsp.stat(cachePath(tempDir));
		const beforeContent = await fsp.readFile(cachePath(tempDir), 'utf8');

		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 1,
			dryRun: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.archived).toBe(0);
		expect(result.selected).toBe(2); // would drop the 2 oldest
		expect(result.inventory).toBe(3);

		const afterStat = await fsp.stat(cachePath(tempDir));
		const afterContent = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(afterContent).toBe(beforeContent);
		// mtime must be unchanged when nothing was written.
		expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
	});

	test('maxRecords drops oldest by capturedAt, keeps newest', async () => {
		await writeRows(tempDir, [
			makeRow('evd_old', 30),
			makeRow('evd_mid', 10),
			makeRow('evd_new', 1),
		]);

		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 1,
		});

		expect(result.archived).toBe(2);
		expect(result.inventory).toBe(3);

		const survivors = await readRows(tempDir);
		expect(survivors).toHaveLength(1);
		expect(survivors[0].id).toBe('evd_new');
	});

	test('maxBytes drops oldest until under cap', async () => {
		// Each row: 100 bytes of text + ~80 bytes overhead ≈ 180 bytes.
		const rows = [
			makeRow('evd_a', 30, 'a'.repeat(100)),
			makeRow('evd_b', 20, 'b'.repeat(100)),
			makeRow('evd_c', 10, 'c'.repeat(100)),
			makeRow('evd_d', 1, 'd'.repeat(100)),
		];
		await writeRows(tempDir, rows);

		// Cap at ~250 bytes: should keep only the newest 1-2 rows.
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxBytes: 250,
		});

		expect(result.archived).toBeGreaterThan(0);
		expect(result.bytesAfter).toBeLessThanOrEqual(250);

		const survivors = await readRows(tempDir);
		// The newest row (evd_d) must always survive.
		expect(survivors.some((r) => r.id === 'evd_d')).toBe(true);
		// The oldest row (evd_a) must be dropped when trimming under a tight cap.
		expect(survivors.some((r) => r.id === 'evd_a')).toBe(false);
	});

	test('both caps: whichever is tighter wins', async () => {
		await writeRows(tempDir, [
			makeRow('evd_a', 30),
			makeRow('evd_b', 20),
			makeRow('evd_c', 10),
			makeRow('evd_d', 1),
		]);

		// maxRecords=2 is the binding constraint (4 rows → drop 2 oldest).
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 2,
			maxBytes: 100_000, // loose, does not bind
		});

		expect(result.archived).toBe(2);
		const survivors = await readRows(tempDir);
		expect(survivors.map((r) => r.id).sort()).toEqual(['evd_c', 'evd_d']);
	});

	test('corrupt row dropped + counted, not preserved in rewrite', async () => {
		// Mix valid and corrupt lines.
		const valid1 = rowToJson(makeRow('evd_1', 30));
		const corrupt = 'this is not valid json {{{';
		const valid2 = rowToJson(makeRow('evd_2', 1));
		await fsp.writeFile(
			cachePath(tempDir),
			`${valid1}\n${corrupt}\n${valid2}\n`,
			'utf8',
		);

		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 10, // loose cap; corrupt row still triggers a rewrite
		});

		expect(result.corrupt).toBe(1);
		expect(result.inventory).toBe(2); // corrupt row excluded from inventory
		// Corrupt row is gone from the file.
		const content = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(content).not.toContain('this is not valid json');
		expect(content).toContain('evd_1');
		expect(content).toContain('evd_2');
	});

	test('no selection and no corrupt rows → skips rewrite entirely', async () => {
		await writeRows(tempDir, [makeRow('evd_1', 1), makeRow('evd_2', 2)]);
		const beforeStat = await fsp.stat(cachePath(tempDir));

		// Cap is loose; nothing to drop.
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 100,
		});

		expect(result.selected).toBe(0);
		expect(result.archived).toBe(0);
		const afterStat = await fsp.stat(cachePath(tempDir));
		expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
	});

	test('100 MiB read cap → aborted, file byte-identical, nothing written', async () => {
		await writeRows(tempDir, [makeRow('evd_1', 1)]);

		// Force the read loop to think it crossed the cap by making the first
		// line's byte length report as over the limit.
		const realCreateReadStream = _internals.createReadStream;
		let readCount = 0;
		// Replace stat so bytesBefore looks non-trivial.
		const realStat = _internals.stat;
		_internals.stat = async (p) => {
			const s = await realStat(p);
			// Report a size above the cap so the abort path is reachable.
			return { ...s, size: 200 * 1024 * 1024 } as fs.Stats;
		};
		// Hijack the stream: emit a single oversized line.
		_internals.createReadStream = (_p, _options) => {
			const { Readable } = require('node:stream');
			const stub = new Readable({ encoding: 'utf8' });
			stub.push('x'.repeat(200 * 1024 * 1024));
			stub.push(null);
			// Attach destroy so the production code's stream.destroy() works.
			(stub as unknown as fs.ReadStream).destroy = () => undefined;
			readCount++;
			return stub as unknown as fs.ReadStream;
		};

		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 1,
		});

		expect(result.aborted).toBe(true);
		expect(result.selected).toBe(0);
		expect(result.archived).toBe(0);
		expect(readCount).toBe(1);
		// Original file content unchanged.
		const content = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(content).toContain('evd_1');
	});

	test('Windows rename retry: EPERM twice then success (integration via _internals)', async () => {
		await writeRows(tempDir, [
			makeRow('evd_old', 30),
			makeRow('evd_new', 1),
		]);

		// Override the DI seam so the production code's retry path runs
		// against a rename that throws EPERM twice then succeeds. This
		// proves the integration: rewriteAtomic → _internals.renameWithRetry
		// → retry loop honors EPERM and eventually lands the file.
		const realRename = fsp.rename;
		let attempts = 0;
		const flakyRename = async (src: string, dst: string) => {
			attempts++;
			if (attempts < 3) {
				const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			}
			await realRename(src, dst);
		};
		_internals.renameWithRetry = (src, dst) =>
			atomicRenameWithRetry(src, dst, flakyRename);

		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 1,
		});

		expect(result.archived).toBe(1);
		expect(attempts).toBe(3); // 2 EPERM retries + 1 success
		const survivors = await readRows(tempDir);
		expect(survivors).toHaveLength(1);
		expect(survivors[0].id).toBe('evd_new');
	});

	test('atomic-rewrite failure: tmp cleaned up, original untouched', async () => {
		await writeRows(tempDir, [
			makeRow('evd_old', 30),
			makeRow('evd_new', 1),
		]);
		const beforeContent = await fsp.readFile(cachePath(tempDir), 'utf8');

		// rename always fails (non-retryable error).
		_internals.renameWithRetry = async () => {
			const err = new Error('ENOSPC: no space') as NodeJS.ErrnoException;
			err.code = 'ENOSPC';
			throw err;
		};

		await expect(
			pruneEvidenceDocuments({ directory: tempDir, maxRecords: 1 }),
		).rejects.toThrow(/rewrite failed/);

		// Original file untouched.
		const afterContent = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(afterContent).toBe(beforeContent);
		// No temp file leaked.
		const dirEntries = await fsp.readdir(path.dirname(cachePath(tempDir)));
		const tmpLeaks = dirEntries.filter((name) => name.includes('.tmp.'));
		expect(tmpLeaks).toEqual([]);
	});

	test('writeSync failure: tmp cleaned up, original untouched (reviewer finding)', async () => {
		await writeRows(tempDir, [
			makeRow('evd_old', 30),
			makeRow('evd_new', 1),
		]);
		const beforeContent = await fsp.readFile(cachePath(tempDir), 'utf8');

		// writeSync fails after openSync succeeds — temp file must still be
		// cleaned up (the outer finally runs on every non-success path).
		const realOpenSync = _internals.openSync;
		const realCloseSync = _internals.closeSync;
		let openedTmpPath: string | null = null;
		_internals.openSync = (p, flags) => {
			const fd = realOpenSync(p, flags);
			if (typeof p === 'string' && p.includes('.tmp.')) {
				openedTmpPath = p;
			}
			return fd;
		};
		_internals.writeSync = () => {
			throw new Error('EIO: write error');
		};
		// closeSync must still work so the fd is released.
		_internals.closeSync = (fd) => realCloseSync(fd);

		await expect(
			pruneEvidenceDocuments({ directory: tempDir, maxRecords: 1 }),
		).rejects.toThrow(/rewrite failed/);

		// Original file untouched.
		const afterContent = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(afterContent).toBe(beforeContent);
		// The temp file opened during the failed write must be cleaned up.
		expect(openedTmpPath).not.toBeNull();
		await expect(fsp.stat(openedTmpPath as string)).rejects.toThrow();
	});

	test('empty file → zeroed result, no crash', async () => {
		await fsp.writeFile(cachePath(tempDir), '', 'utf8');
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 10,
		});
		expect(result.inventory).toBe(0);
		expect(result.corrupt).toBe(0);
	});

	test('JSON array / non-object rows counted as corrupt', async () => {
		// JSON.parse succeeds but the result is not an object.
		await fsp.writeFile(
			cachePath(tempDir),
			'[1,2,3]\n"string"\n42\n',
			'utf8',
		);
		const result = await pruneEvidenceDocuments({
			directory: tempDir,
			maxRecords: 10,
		});
		expect(result.corrupt).toBe(3);
		expect(result.inventory).toBe(0);
		// File is rewritten empty (all rows dropped).
		const content = await fsp.readFile(cachePath(tempDir), 'utf8');
		expect(content).toBe('');
	});
});

