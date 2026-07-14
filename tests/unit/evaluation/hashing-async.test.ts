import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
	computeTaskLineageInputHash,
} from '../../../src/evaluation/hashing.js';

const originalReadFile = _internals.readFile;
const originalOpendir = _internals.opendir;
const roots: string[] = [];

afterEach(() => {
	_internals.readFile = originalReadFile;
	_internals.opendir = originalOpendir;
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function makeRoot(): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'evaluation-hashing-')),
	);
	roots.push(root);
	return root;
}

describe('asynchronous evaluation input hashing', () => {
	test('yields while reading candidate payload bytes', async () => {
		const root = makeRoot();
		fs.writeFileSync(path.join(root, 'candidate.md'), 'candidate\n');
		let asynchronousReadCompleted = false;
		_internals.readFile = (async (filePath: string) => {
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					asynchronousReadCompleted = true;
					resolve();
				}, 0);
			});
			return originalReadFile(filePath);
		}) as typeof originalReadFile;

		const hashPromise = computeCandidateInputContentHash(root, {
			v: 1,
			id: 'candidate',
			kind: 'skill',
			payloadPath: 'candidate.md',
			model: 'configured',
		});
		expect(hashPromise).toBeInstanceOf(Promise);
		const hash = await hashPromise;
		expect(asynchronousReadCompleted).toBe(true);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	test('applies one entry budget across every task input tree', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'fixture'));
		fs.writeFileSync(path.join(root, 'instruction.md'), 'instruction\n');
		fs.writeFileSync(path.join(root, 'fixture', 'subject.ts'), 'export {};\n');
		fs.writeFileSync(path.join(root, 'fixture', 'scorer.mjs'), 'export {};\n');

		await expect(
			computeTaskInputContentHash(
				root,
				{
					v: 1,
					id: 'budgeted-task',
					source: 'curated',
					split: 'validation',
					category: 'correctness',
					protected: false,
					instructionPath: 'instruction.md',
					environment: { kind: 'fixture', path: 'fixture' },
					scorer: {
						kind: 'project',
						argv: ['fixture/scorer.mjs'],
						timeoutMs: 1_000,
						scoreRange: [0, 1],
					},
					provenance: { origin: 'unit-test', license: 'MIT' },
				},
				{ maxFiles: 4, maxBytes: 1_024 },
			),
		).rejects.toThrow('canonical hashing budget');
	});

	test('charges empty directories to the traversal budget', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'fixture', 'empty-a'), { recursive: true });
		fs.mkdirSync(path.join(root, 'fixture', 'empty-b'));
		fs.mkdirSync(path.join(root, 'fixture', 'empty-c'));
		fs.writeFileSync(path.join(root, 'instruction.md'), 'instruction\n');

		await expect(
			computeTaskInputContentHash(
				root,
				{
					v: 1,
					id: 'directory-budget-task',
					source: 'curated',
					split: 'validation',
					category: 'correctness',
					protected: false,
					instructionPath: 'instruction.md',
					environment: { kind: 'fixture', path: 'fixture' },
					scorer: {
						kind: 'builtin',
						argv: ['tier1-defect'],
						timeoutMs: 1_000,
						scoreRange: [0, 1],
					},
					provenance: { origin: 'unit-test', license: 'MIT' },
				},
				{ maxFiles: 4, maxBytes: 1_024 },
			),
		).rejects.toThrow('canonical hashing budget');
	});

	test('rejects non-finite, fractional, and unsafe task limits', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'fixture'));
		fs.writeFileSync(path.join(root, 'instruction.md'), 'instruction\n');
		const task = {
			v: 1 as const,
			id: 'invalid-limit-task',
			source: 'curated' as const,
			split: 'validation' as const,
			category: 'correctness',
			protected: false,
			instructionPath: 'instruction.md',
			environment: { kind: 'fixture' as const, path: 'fixture' },
			scorer: {
				kind: 'builtin' as const,
				argv: ['tier1-defect'],
				timeoutMs: 1_000,
				scoreRange: [0, 1] as [number, number],
			},
			provenance: { origin: 'unit-test', license: 'MIT' },
		};
		const invalidLimits = [
			{ maxFiles: Number.NaN, maxBytes: 1 },
			{ maxFiles: Number.POSITIVE_INFINITY, maxBytes: 1 },
			{ maxFiles: 1.5, maxBytes: 1 },
			{ maxFiles: 2, maxBytes: Number.NaN },
			{ maxFiles: 2, maxBytes: Number.POSITIVE_INFINITY },
			{ maxFiles: 2, maxBytes: Number.MAX_SAFE_INTEGER + 1 },
		];
		for (const compute of [
			computeTaskInputContentHash,
			computeTaskLineageInputHash,
		]) {
			for (const limits of invalidLimits) {
				await expect(compute(root, task, limits)).rejects.toThrow(
					'positive safe integers',
				);
			}
		}
	});

	test('stops directory enumeration at remaining capacity plus one', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'fixture'));
		fs.writeFileSync(path.join(root, 'instruction.md'), 'instruction\n');
		let yielded = 0;
		let closed = 0;
		_internals.opendir = (async () => ({
			read: async () => {
				const index = yielded++;
				return { name: `empty-${index}` };
			},
			close: async () => {
				closed++;
			},
		})) as unknown as typeof originalOpendir;

		await expect(
			computeTaskInputContentHash(
				root,
				{
					v: 1,
					id: 'enumeration-budget-task',
					source: 'curated',
					split: 'validation',
					category: 'correctness',
					protected: false,
					instructionPath: 'instruction.md',
					environment: { kind: 'fixture', path: 'fixture' },
					scorer: {
						kind: 'builtin',
						argv: ['tier1-defect'],
						timeoutMs: 1_000,
						scoreRange: [0, 1],
					},
					provenance: { origin: 'unit-test', license: 'MIT' },
				},
				{ maxFiles: 3, maxBytes: 1_024 },
			),
		).rejects.toThrow('canonical hashing budget');
		expect(yielded).toBe(2);
		expect(closed).toBe(1);
	});

	test('closes directory handles after successful enumeration', async () => {
		const root = makeRoot();
		fs.mkdirSync(path.join(root, 'fixture'));
		fs.writeFileSync(path.join(root, 'instruction.md'), 'instruction\n');
		let closed = 0;
		_internals.opendir = (async () => ({
			read: async () => null,
			close: async () => {
				closed++;
			},
		})) as unknown as typeof originalOpendir;

		await computeTaskInputContentHash(
			root,
			{
				v: 1,
				id: 'directory-close-task',
				source: 'curated',
				split: 'validation',
				category: 'correctness',
				protected: false,
				instructionPath: 'instruction.md',
				environment: { kind: 'fixture', path: 'fixture' },
				scorer: {
					kind: 'builtin',
					argv: ['tier1-defect'],
					timeoutMs: 1_000,
					scoreRange: [0, 1],
				},
				provenance: { origin: 'unit-test', license: 'MIT' },
			},
			{ maxFiles: 2, maxBytes: 1_024 },
		);
		expect(closed).toBe(1);
	});
});
