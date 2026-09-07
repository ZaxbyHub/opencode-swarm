import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	loadHeldoutRecallEvaluationCorpus,
	loadHeldoutRecallEvaluationScenarios,
	validateHeldoutRecallCorpusManifest,
} from '../../../src/memory/heldout-evaluation-corpus';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const valid = {
	corpus_id: 'memory-recall-heldout',
	split: 'heldout',
	cases: [
		{
			language: 'typescript',
			expected_symbols: ['resolveMemory'],
			expected_edges: ['resolveMemory -> recall'],
			known_misses: ['comments'],
			spurious_edges: ['comment -> symbol'],
			paraphrase: 'find the memory resolution path',
			source_path: 'sources/example.ts',
			content_hash: 'a'.repeat(64),
		},
	],
};

describe('held-out recall corpus contract', () => {
	test('accepts bounded, content-addressed held-out corpus metadata', () => {
		expect(() => validateHeldoutRecallCorpusManifest(valid)).not.toThrow();
	});

	test('rejects missing contract fields and malformed content hashes', () => {
		expect(() =>
			validateHeldoutRecallCorpusManifest({ ...valid, split: 'training' }),
		).toThrow();
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				cases: [{ ...valid.cases[0], content_hash: 'bad' }],
			}),
		).toThrow();
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				version: 1,
			}),
		).toThrow('invalid version');
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				thresholds: { precision_at_k: Number.POSITIVE_INFINITY },
			}),
		).toThrow('invalid thresholds');
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				cases: [
					{
						...valid.cases[0],
						id: '',
						expected_symbols: [42],
						expected_edges: [{ from: 'resolveMemory', to: 1 }],
					},
				],
			}),
		).toThrow();
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				cases: [
					{
						...valid.cases[0],
						expected_edges: [{ from: 'resolveMemory', to: 1 }],
					},
				],
			}),
		).toThrow('invalid expected_edges');
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				cases: [{ ...valid.cases[0], spurious_edges: [false] }],
			}),
		).toThrow('invalid spurious_edges');
	});

	test('rejects explicit ids that collide with generated fallback ids', () => {
		expect(() =>
			validateHeldoutRecallCorpusManifest({
				...valid,
				cases: [
					{ ...valid.cases[0], id: 'typescript-2' },
					{ ...valid.cases[0], source_path: 'sources/second.ts' },
				],
			}),
		).toThrow('duplicates id');
	});

	test('loader rejects lexical escapes and source hash mismatches', async () => {
		const root = canonicalMkdtemp('swarm-heldout-corpus-');
		try {
			const source = 'export const x = 1;';
			await fs.mkdir(path.join(root, 'sources'));
			await fs.writeFile(path.join(root, 'sources', 'example.ts'), source);
			const manifest = {
				...valid,
				cases: [
					{
						...valid.cases[0],
						source_path: '../outside.ts',
						content_hash: createHash('sha256').update(source).digest('hex'),
					},
				],
			};
			await fs.writeFile(
				path.join(root, 'manifest.json'),
				JSON.stringify(manifest),
			);
			await expect(loadHeldoutRecallEvaluationCorpus(root)).rejects.toThrow(
				'escapes corpus root',
			);

			manifest.cases[0].source_path = 'sources/example.ts';
			manifest.cases[0].content_hash = 'b'.repeat(64);
			await fs.writeFile(
				path.join(root, 'manifest.json'),
				JSON.stringify(manifest),
			);
			await expect(loadHeldoutRecallEvaluationCorpus(root)).rejects.toThrow(
				'hash mismatch',
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('loader validates CRLF source against its canonical LF hash', async () => {
		const root = canonicalMkdtemp('swarm-heldout-corpus-crlf-');
		try {
			const lfSource = 'export const x = 1;\nexport const y = 2;\n';
			const lfHash = createHash('sha256').update(lfSource).digest('hex');
			await fs.mkdir(path.join(root, 'sources'));
			await fs.writeFile(
				path.join(root, 'sources', 'example.ts'),
				lfSource.replace(/\n/g, '\r\n'),
			);
			await fs.writeFile(
				path.join(root, 'manifest.json'),
				JSON.stringify({
					...valid,
					cases: [{ ...valid.cases[0], content_hash: lfHash }],
				}),
			);

			const { scenarios } = await loadHeldoutRecallEvaluationScenarios(root);
			expect(scenarios[0]?.source_hash).toBe(lfHash);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('loader rejects a manifest symlink that resolves outside the corpus root', async () => {
		const root = canonicalMkdtemp('swarm-heldout-manifest-link-');
		const outside = canonicalMkdtemp('swarm-heldout-manifest-outside-');
		try {
			const source = 'export const x = 1;';
			await fs.writeFile(
				path.join(outside, 'manifest.json'),
				JSON.stringify(valid),
			);
			try {
				await fs.symlink(
					path.join(outside, 'manifest.json'),
					path.join(root, 'manifest.json'),
				);
			} catch {
				// File symlinks need platform-specific privileges on some Windows hosts.
				return;
			}
			await fs.writeFile(path.join(outside, 'outside.ts'), source);
			await expect(loadHeldoutRecallEvaluationCorpus(root)).rejects.toThrow(
				'manifest path escapes corpus root',
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(outside, { recursive: true, force: true });
		}
	});
});
