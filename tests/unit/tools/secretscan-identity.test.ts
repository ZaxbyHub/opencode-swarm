import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runSecretscan,
	runSecretscanOnFiles,
	type SecretscanErrorResult,
	type SecretscanResult,
} from '../../../src/tools/secretscan';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const originalOpenFile = _internals.openFile;
const originalFstatFile = _internals.fstatFile;
const originalReadFileChunk = _internals.readFileChunk;
const originalCloseFile = _internals.closeFile;
const originalLstatFile = _internals.lstatFile;

let tempDir: string;

function successful(
	result: SecretscanResult | SecretscanErrorResult,
): SecretscanResult {
	if ('error' in result) throw new Error(result.error);
	return result;
}

function cloneStats(
	source: fs.BigIntStats,
	overrides: Partial<Pick<fs.BigIntStats, 'dev' | 'ino'>> = {},
): fs.BigIntStats {
	return Object.assign(
		Object.create(Object.getPrototypeOf(source)),
		source,
		overrides,
	) as fs.BigIntStats;
}

async function scan(
	mode: 'explicit' | 'standalone',
	file = 'target.txt',
): Promise<SecretscanResult> {
	return mode === 'explicit'
		? successful(await runSecretscanOnFiles([file], tempDir))
		: successful(await runSecretscan(tempDir));
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('secretscan-identity-');
});

afterEach(() => {
	_internals.openFile = originalOpenFile;
	_internals.fstatFile = originalFstatFile;
	_internals.readFileChunk = originalReadFileChunk;
	_internals.closeFile = originalCloseFile;
	_internals.lstatFile = originalLstatFile;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('descriptor identity hardening', () => {
	test.each([
		['standalone', 2],
		['explicit', 3],
	] as const)('%s scanning routes immediate file checks through _internals.lstatFile and preserves numeric open flags', async (mode, minimumTargetLstatCalls) => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'password=secret123\n');

		let targetLstatCalls = 0;
		let capturedFlags: number | null = null;
		_internals.lstatFile = ((candidate: fs.PathLike) => {
			if (path.resolve(String(candidate)) === targetPath) {
				targetLstatCalls++;
			}
			return originalLstatFile(candidate);
		}) as typeof _internals.lstatFile;
		_internals.openFile = ((candidate: fs.PathLike, flags: number) => {
			capturedFlags = flags;
			return originalOpenFile(candidate, flags);
		}) as typeof _internals.openFile;

		const result = await scan(mode);

		expect(result.files_scanned).toBe(1);
		expect(targetLstatCalls).toBeGreaterThanOrEqual(minimumTargetLstatCalls);
		expect(capturedFlags).not.toBeNull();
		expect((capturedFlags as number) & fs.constants.O_RDONLY).toBe(
			fs.constants.O_RDONLY,
		);
		if (process.platform !== 'win32') {
			const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
			expect(noFollow).toBeDefined();
			expect((capturedFlags as number) & (noFollow as number)).toBe(
				noFollow as number,
			);
		}
	});

	test('rejects a before-open descriptor swap and closes the opened descriptor once', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		const alternatePath = path.join(tempDir, 'alternate.txt');
		fs.writeFileSync(targetPath, 'clean\n');
		fs.writeFileSync(alternatePath, 'password=swappedSecret\n');

		let closeCount = 0;
		_internals.openFile = ((candidate: fs.PathLike, flags: number) => {
			expect(path.resolve(String(candidate))).toBe(targetPath);
			return originalOpenFile(alternatePath, flags);
		}) as typeof _internals.openFile;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('explicit');

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'target.txt', reason: 'read_error' },
		]);
		expect(result.findings).toEqual([]);
		expect(closeCount).toBe(1);
	});

	test('rejects an after-open path swap and closes the descriptor once', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'clean\n');

		const targetStat = originalLstatFile(targetPath);
		const mismatchedPostOpenStat = cloneStats(targetStat, {
			ino: targetStat.ino === 1n ? 2n : 1n,
		});
		let targetLstatCalls = 0;
		let closeCount = 0;
		_internals.lstatFile = ((candidate: fs.PathLike) => {
			if (path.resolve(String(candidate)) === targetPath) {
				targetLstatCalls++;
				return targetLstatCalls >= 2 ? mismatchedPostOpenStat : targetStat;
			}
			return originalLstatFile(candidate);
		}) as typeof _internals.lstatFile;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('standalone');

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'target.txt', reason: 'read_error' },
		]);
		expect(closeCount).toBe(1);
	});

	test('rejects unavailable descriptor identity conservatively and still closes once', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'clean\n');

		let closeCount = 0;
		_internals.fstatFile = ((fd: number) => {
			const stat = originalFstatFile(fd);
			return cloneStats(stat, { dev: 0n, ino: 0n });
		}) as typeof _internals.fstatFile;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('explicit');

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'target.txt', reason: 'read_error' },
		]);
		expect(closeCount).toBe(1);
	});

	test('preserves descriptor identity numbers above the safe-integer range', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'clean\n');

		const largeIno = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
		let closeCount = 0;
		_internals.lstatFile = ((candidate: fs.PathLike) => {
			const stat = originalLstatFile(candidate);
			return path.resolve(String(candidate)) === targetPath
				? cloneStats(stat, { ino: largeIno })
				: stat;
		}) as typeof _internals.lstatFile;
		_internals.fstatFile = ((fd: number) => {
			const stat = originalFstatFile(fd);
			return cloneStats(stat, { ino: largeIno });
		}) as typeof _internals.fstatFile;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('explicit');

		expect(result.files_scanned).toBe(1);
		expect(result.incomplete_files).toBe(0);
		expect(result.incomplete_paths).toEqual([]);
		expect(closeCount).toBe(1);
	});

	test('rejects non-file descriptors and closes once', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'clean\n');

		const directoryStat = originalLstatFile(tempDir);
		let closeCount = 0;
		_internals.fstatFile = (() => directoryStat) as typeof _internals.fstatFile;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('standalone');

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'target.txt', reason: 'non_file' },
		]);
		expect(closeCount).toBe(1);
	});

	test('treats descriptor growth as incomplete and closes once', async () => {
		const targetPath = path.join(tempDir, 'target.txt');
		fs.writeFileSync(targetPath, 'clean\n');

		let grew = false;
		let closeCount = 0;
		_internals.readFileChunk = ((...args: Parameters<typeof fs.readSync>) => {
			if (!grew) {
				grew = true;
				fs.appendFileSync(targetPath, Buffer.alloc(513 * 1024, 0x61));
			}
			return originalReadFileChunk(...args);
		}) as typeof _internals.readFileChunk;
		_internals.closeFile = ((fd: number) => {
			closeCount++;
			return originalCloseFile(fd);
		}) as typeof _internals.closeFile;

		const result = await scan('explicit');

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'target.txt', reason: 'oversized' },
		]);
		expect(closeCount).toBe(1);
	});
});
