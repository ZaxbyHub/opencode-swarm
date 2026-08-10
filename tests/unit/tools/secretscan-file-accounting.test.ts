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

let tempDir: string;
const originalLstatFile = _internals.lstatFile;

function successful(
	result: SecretscanResult | SecretscanErrorResult,
): SecretscanResult {
	if ('error' in result) throw new Error(result.error);
	return result;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('secretscan-accounting-');
});

afterEach(() => {
	_internals.lstatFile = originalLstatFile;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('truthful per-file accounting', () => {
	test('does not count binary text-extension files as scanned', async () => {
		fs.writeFileSync(path.join(tempDir, 'binary.txt'), Buffer.alloc(64, 0));
		const explicit = successful(
			await runSecretscanOnFiles(['binary.txt'], tempDir),
		);
		const standalone = successful(await runSecretscan(tempDir));

		for (const result of [explicit, standalone]) {
			expect(result.files_scanned).toBe(0);
			expect(result.skipped_files).toBe(1);
			expect(result.incomplete_files).toBe(0);
			expect(result.incomplete_paths).toEqual([]);
		}
	});

	test('skips oversized binary prefixes without marking them incomplete', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'oversized-binary.txt'),
			Buffer.alloc(513 * 1024, 0),
		);
		const result = successful(
			await runSecretscanOnFiles(['oversized-binary.txt'], tempDir),
		);

		expect(result.files_scanned).toBe(0);
		expect(result.skipped_files).toBe(1);
		expect(result.incomplete_files).toBe(0);
		expect(result.incomplete_paths).toEqual([]);
	});

	test('reports oversized files as incomplete in both entry points', async () => {
		fs.writeFileSync(
			path.join(tempDir, 'oversized.txt'),
			Buffer.alloc(513 * 1024, 0x61),
		);
		const explicit = successful(
			await runSecretscanOnFiles(['oversized.txt'], tempDir),
		);
		const standalone = successful(await runSecretscan(tempDir));

		for (const result of [explicit, standalone]) {
			expect(result.files_scanned).toBe(0);
			expect(result.skipped_files).toBe(1);
			expect(result.incomplete_files).toBe(1);
			expect(result.incomplete_paths).toHaveLength(1);
			expect(result.incomplete_paths[0].reason).toBe('oversized');
		}
	});

	test('reports a directory passed as a file as incomplete', async () => {
		fs.mkdirSync(path.join(tempDir, 'nested'));
		const result = successful(await runSecretscanOnFiles(['nested'], tempDir));

		expect(result.files_scanned).toBe(0);
		expect(result.skipped_files).toBe(1);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toHaveLength(1);
		expect(result.incomplete_paths[0].path).toBe('nested');
		expect(result.incomplete_paths[0].reason).toBe('non_file');
	});

	test('treats non-ENOENT inspection failures as incomplete', async () => {
		fs.writeFileSync(path.join(tempDir, 'blocked.txt'), 'clean\n');
		_internals.lstatFile = ((filePath: fs.PathLike) => {
			if (String(filePath).endsWith('blocked.txt')) {
				const error = new Error('access denied') as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			return originalLstatFile(filePath);
		}) as typeof _internals.lstatFile;

		const result = successful(
			await runSecretscanOnFiles(['blocked.txt'], tempDir),
		);

		expect(result.files_scanned).toBe(0);
		expect(result.incomplete_files).toBe(1);
		expect(result.incomplete_paths).toEqual([
			{ path: 'blocked.txt', reason: 'read_error' },
		]);
	});

	test('skips an explicitly requested file that disappeared', async () => {
		const result = successful(
			await runSecretscanOnFiles(['missing.txt'], tempDir),
		);

		expect(result.files_scanned).toBe(0);
		expect(result.skipped_files).toBe(1);
		expect(result.incomplete_files).toBe(0);
		expect(result.incomplete_paths).toEqual([]);
	});

	test('bounds incomplete path diagnostics and marks truncation', async () => {
		const directories = Array.from(
			{ length: 30 },
			(_, index) => `dir-${index}`,
		);
		for (const directory of directories) {
			fs.mkdirSync(path.join(tempDir, directory));
		}

		const result = successful(await runSecretscanOnFiles(directories, tempDir));

		expect(result.incomplete_files).toBe(30);
		expect(result.incomplete_paths).toHaveLength(25);
		expect(result.incomplete_paths.at(-1)).toEqual({
			path: '.',
			reason: 'truncated',
		});
	});
});

describe('complete bounded content coverage', () => {
	test('detects a secret after the former 50 KiB cutoff', async () => {
		const stripeKey = ['sk', 'test', 'y'.repeat(24)].join('_');
		fs.writeFileSync(
			path.join(tempDir, 'late-secret.txt'),
			`${'a'.repeat(60 * 1024)}\nSTRIPE_KEY=${stripeKey}\n`,
		);
		const explicit = successful(
			await runSecretscanOnFiles(['late-secret.txt'], tempDir),
		);
		const standalone = successful(await runSecretscan(tempDir));

		for (const result of [explicit, standalone]) {
			expect(
				result.findings.some((finding) => finding.type === 'stripe_key'),
			).toBe(true);
		}
	});

	test('detects a secret on a line longer than 10,000 characters', async () => {
		const stripeKey = ['sk', 'test', 'z'.repeat(24)].join('_');
		fs.writeFileSync(
			path.join(tempDir, 'long-line.txt'),
			`${'a'.repeat(12_000)} STRIPE_KEY=${stripeKey}\n`,
		);
		const result = successful(
			await runSecretscanOnFiles(['long-line.txt'], tempDir),
		);
		expect(
			result.findings.some((finding) => finding.type === 'stripe_key'),
		).toBe(true);
	});

	test('redacts every secret from shared same-line context', async () => {
		const stripeKey = ['sk', 'test', 'r'.repeat(24)].join('_');
		const githubToken = ['ghp', 's'.repeat(36)].join('_');
		fs.writeFileSync(
			path.join(tempDir, 'two-secrets.txt'),
			`STRIPE_KEY=${stripeKey} GITHUB_TOKEN=${githubToken}\n`,
		);

		const result = successful(
			await runSecretscanOnFiles(['two-secrets.txt'], tempDir),
		);
		const serialized = JSON.stringify(result);

		expect(result.findings.length).toBeGreaterThanOrEqual(2);
		expect(serialized).not.toContain(stripeKey);
		expect(serialized).not.toContain(githubToken);
	});

	test('does not leak a colon-assigned high-entropy value', async () => {
		const highEntropyValue = [
			'5J8mP2nK',
			'4qL9rT6w',
			'X0zA3bC7',
			'dE1fG5hJ',
		].join('');
		fs.writeFileSync(
			path.join(tempDir, 'entropy.txt'),
			`credential: ${highEntropyValue}\n`,
		);

		const result = successful(
			await runSecretscanOnFiles(['entropy.txt'], tempDir),
		);
		const serialized = JSON.stringify(result);

		expect(
			result.findings.some((finding) => finding.type === 'high_entropy'),
		).toBe(true);
		expect(serialized).not.toContain(highEntropyValue);
		expect(
			result.findings.find((finding) => finding.type === 'high_entropy')
				?.redacted,
		).toBe('credential=[HIGH_ENTROPY]');
	});

	test('preserves findings when another requested file is incomplete', async () => {
		const stripeKey = ['sk', 'test', 'q'.repeat(24)].join('_');
		fs.writeFileSync(path.join(tempDir, 'secret.txt'), `KEY=${stripeKey}\n`);
		fs.writeFileSync(
			path.join(tempDir, 'oversized.txt'),
			Buffer.alloc(513 * 1024, 0x61),
		);
		const result = successful(
			await runSecretscanOnFiles(['secret.txt', 'oversized.txt'], tempDir),
		);

		expect(
			result.findings.some((finding) => finding.type === 'stripe_key'),
		).toBe(true);
		expect(result.incomplete_files).toBe(1);
	});
});
