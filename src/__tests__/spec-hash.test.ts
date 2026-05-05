import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../config/plan-schema';
import { computeSpecHash, isSpecStale } from '../utils/spec-hash';

describe('computeSpecHash', () => {
	let tempDir: string;

	beforeEach(async () => {
		// Create temp directory with spec.md using os.tmpdir()
		tempDir = join(
			tmpdir(),
			'spec-hash-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await mock.restore();
		// Clean up temp directory
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('returns a 64-char hex string (SHA-256) for an existing spec.md', async () => {
		await writeFile(join(tempDir, '.swarm', 'spec.md'), 'test content');

		const hash = await computeSpecHash(tempDir);

		expect(hash).toBeDefined();
		expect(typeof hash).toBe('string');
		expect(hash!.length).toBe(64);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test('returns null when spec.md does not exist', async () => {
		// Don't create spec.md
		const hash = await computeSpecHash(tempDir);

		expect(hash).toBeNull();
	});
});

describe('isSpecStale', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'spec-stale-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('Pre-feature plan (no specHash): returns {stale: false}', async () => {
		const plan = { id: 'test-plan', specHash: undefined } as unknown as Plan;

		const result = await isSpecStale(tempDir, plan);

		expect(result).toEqual({ stale: false });
	});

	test('Spec deleted (currentHash null, plan has specHash): returns {stale: true, reason contains deleted}', async () => {
		// Create a plan with a specHash but don't create spec.md
		const plan = {
			id: 'test-plan',
			specHash: 'someoldhash12345678901234567890123456789012345678901234',
		} as unknown as Plan;

		const result = await isSpecStale(tempDir, plan);

		expect(result.stale).toBe(true);
		expect(result.reason).toContain('deleted');
	});

	test('Spec modified (hash mismatch): returns {stale: true, reason contains modified}', async () => {
		// Create spec.md with content
		await writeFile(join(tempDir, '.swarm', 'spec.md'), 'original content');

		// Create a plan with a different hash
		const plan = {
			id: 'test-plan',
			specHash: 'different-hash-that-is-64-chars-0000000000000000000000',
		} as unknown as Plan;

		const result = await isSpecStale(tempDir, plan);

		expect(result.stale).toBe(true);
		expect(result.reason).toContain('modified');
	});

	test('Spec unchanged (hash match): returns {stale: false}', async () => {
		// Create spec.md with content
		const content = 'unchanged content';
		await writeFile(join(tempDir, '.swarm', 'spec.md'), content);

		// Compute the correct hash
		const correctHash = await computeSpecHash(tempDir);

		// Create a plan with the matching hash
		const plan = { id: 'test-plan', specHash: correctHash } as unknown as Plan;

		const result = await isSpecStale(tempDir, plan);

		expect(result).toEqual({ stale: false });
	});
});

describe('computeSpecHash error handling', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'spec-error-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('re-throws on unexpected errors (non-ENOENT)', async () => {
		// We need to mock fs/promises.readFile to throw a non-ENOENT error
		// Since the source uses named import, we use mock.module
		const _originalReadFile = (await import('node:fs/promises')).readFile;
		const mockReadFile = mock(() => {
			const error = new Error('Random error') as NodeJS.ErrnoException;
			error.code = 'EACCES'; // Not ENOENT
			throw error;
		});

		mock.module('fs/promises', () => ({
			...{ readFile: mockReadFile, mkdir, writeFile, rm },
			mkdir,
			writeFile,
			rm,
		}));

		// Re-import to get mocked version
		const { computeSpecHash: mockedFn } = await import('../utils/spec-hash');

		await expect(mockedFn(tempDir)).rejects.toThrow('Random error');
	});
});
