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

const originalNow = _internals.now;
const originalYield = _internals.yieldToEventLoop;
const originalReadFileChunk = _internals.readFileChunk;
const originalCloseDirectory = _internals.closeDirectory;
let tempDir: string;
let outsideDir: string | undefined;

function successful(
	result: SecretscanResult | SecretscanErrorResult,
): SecretscanResult {
	if ('error' in result) throw new Error(result.error);
	return result;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('secretscan-bounds-');
});

afterEach(() => {
	_internals.now = originalNow;
	_internals.yieldToEventLoop = originalYield;
	_internals.readFileChunk = originalReadFileChunk;
	_internals.closeDirectory = originalCloseDirectory;
	fs.rmSync(tempDir, { recursive: true, force: true });
	if (outsideDir) fs.rmSync(outsideDir, { recursive: true, force: true });
	outsideDir = undefined;
});

function expireBeforeSecondFile(): void {
	let yields = 0;
	_internals.now = () => (yields >= 2 ? 60_000 : 0);
	_internals.yieldToEventLoop = async () => {
		yields++;
	};
}

describe('bounded scan completion', () => {
	test('explicit-file deadline preserves completed work and reports the remainder', async () => {
		fs.writeFileSync(path.join(tempDir, 'a.txt'), 'clean\n');
		fs.writeFileSync(path.join(tempDir, 'b.txt'), 'clean\n');
		expireBeforeSecondFile();

		const result = successful(
			await runSecretscanOnFiles(['a.txt', 'b.txt'], tempDir),
		);

		expect(result.files_scanned).toBe(1);
		expect(result.incomplete_files).toBe(1);
	});

	test('standalone deadline preserves completed work and reports the remainder', async () => {
		fs.writeFileSync(path.join(tempDir, 'a.txt'), 'clean\n');
		fs.writeFileSync(path.join(tempDir, 'b.txt'), 'clean\n');
		expireBeforeSecondFile();

		const result = successful(await runSecretscan(tempDir));

		expect(result.files_scanned).toBe(1);
		expect(result.incomplete_files).toBe(1);
	});

	test('explicit-file cap reports every unexamined candidate', async () => {
		const files: string[] = [];
		for (let index = 0; index < 101; index++) {
			const file = `${String(index).padStart(3, '0')}.txt`;
			fs.writeFileSync(path.join(tempDir, file), 'clean\n');
			files.push(file);
		}

		const result = successful(await runSecretscanOnFiles(files, tempDir));
		expect(result.files_scanned).toBe(100);
		expect(result.incomplete_files).toBe(1);
	});

	test('standalone 1,000-file cap reports every unexamined candidate', async () => {
		for (let index = 0; index < 999; index++) {
			fs.writeFileSync(
				path.join(tempDir, `a${String(index).padStart(4, '0')}.txt`),
				'clean\n',
			);
		}
		const stripeKey = ['sk', 'test', 'd'.repeat(24)].join('_');
		fs.writeFileSync(path.join(tempDir, 'z-secret.txt'), `${stripeKey}\n`);
		fs.writeFileSync(path.join(tempDir, 'ä-clean.txt'), 'clean\n');

		const result = successful(await runSecretscan(tempDir));
		expect(result.files_scanned).toBe(1000);
		expect(result.incomplete_files).toBe(1);
		expect(
			result.findings.some((finding) => finding.path.endsWith('z-secret.txt')),
		).toBe(true);
	});

	test('a maximum-size secret line stays within the serialized output bound', async () => {
		const stripeKey = ['sk', 'test', 'm'.repeat(24)].join('_');
		fs.writeFileSync(
			path.join(tempDir, 'maximum-line.txt'),
			`${'a'.repeat(512 * 1024 - stripeKey.length - 1)} ${stripeKey}`,
		);
		const started = performance.now();

		const result = successful(await runSecretscan(tempDir));
		const serialized = JSON.stringify(result, null, 2);

		expect(result.files_scanned).toBe(1);
		expect(result.findings).toHaveLength(1);
		expect(serialized).not.toContain(stripeKey);
		expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(512_000);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	test('directory discovery yields and reports deadline-truncated coverage', async () => {
		for (let index = 0; index < 200; index++) {
			fs.writeFileSync(path.join(tempDir, `${index}.txt`), 'clean\n');
		}
		let yields = 0;
		_internals.now = () => (yields >= 2 ? 60_000 : 0);
		_internals.yieldToEventLoop = async () => {
			yields++;
		};

		const result = successful(await runSecretscan(tempDir));

		expect(yields).toBeGreaterThanOrEqual(2);
		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBeGreaterThan(0);
		expect(result.message).toContain('Discovery stopped');
	});

	test('bounds a file that grows after its opened handle is inspected', async () => {
		const file = path.join(tempDir, 'growing.txt');
		fs.writeFileSync(file, 'clean\n');
		let grew = false;
		let maximumRequestedRead = 0;
		_internals.readFileChunk = ((...args: Parameters<typeof fs.readSync>) => {
			const length = args[3] as number;
			maximumRequestedRead = Math.max(maximumRequestedRead, length);
			if (!grew) {
				grew = true;
				fs.appendFileSync(file, Buffer.alloc(513 * 1024, 0x61));
			}
			return originalReadFileChunk(...args);
		}) as typeof _internals.readFileChunk;

		const result = successful(
			await runSecretscanOnFiles(['growing.txt'], tempDir),
		);

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(maximumRequestedRead).toBeLessThanOrEqual(512 * 1024 + 1);
	});

	test('records unexpected directory-close failures as incomplete', async () => {
		fs.writeFileSync(path.join(tempDir, 'clean.txt'), 'clean\n');
		_internals.closeDirectory = (directory) => {
			originalCloseDirectory(directory);
			const error = new Error('close failed') as NodeJS.ErrnoException;
			error.code = 'EPERM';
			throw error;
		};

		const result = successful(await runSecretscan(tempDir));

		expect(result.files_scanned).toBe(1);
		expect(result.incomplete_files).toBe(1);
		expect(result.message).toContain('cleanup failed');
	});
});

describe('canonical containment', () => {
	test('does not scan through a parent symlink or Windows junction outside the root', async () => {
		outsideDir = canonicalMkdtemp('secretscan-outside-');
		const stripeKey = ['sk', 'test', 'w'.repeat(24)].join('_');
		fs.writeFileSync(path.join(outsideDir, 'outside.txt'), stripeKey);
		fs.symlinkSync(
			outsideDir,
			path.join(tempDir, 'escape'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		const result = successful(
			await runSecretscanOnFiles(['escape/outside.txt'], tempDir),
		);

		expect(result.findings).toHaveLength(0);
		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
	});

	test.skipIf(process.platform === 'win32')(
		'reports an unreadable requested file as incomplete on POSIX',
		async () => {
			const file = path.join(tempDir, 'unreadable.txt');
			fs.writeFileSync(file, 'clean\n');
			fs.chmodSync(file, 0);
			try {
				const result = successful(
					await runSecretscanOnFiles(['unreadable.txt'], tempDir),
				);
				expect(result.files_scanned).toBe(0);
				expect(result.incomplete_files).toBe(1);
			} finally {
				fs.chmodSync(file, 0o600);
			}
		},
	);
});
