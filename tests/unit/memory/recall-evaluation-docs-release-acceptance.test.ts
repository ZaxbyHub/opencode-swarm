/** Acceptance coverage for issue #2490 / AC13. */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dir, '../../..');
const documentation = ['docs/memory.md', 'docs/commands.md']
	.map((relativePath) =>
		readFileSync(path.join(repositoryRoot, relativePath), 'utf8'),
	)
	.join('\n')
	.toLowerCase();

describe('issue #2490 AC13 — evaluator documentation and release evidence', () => {
	test('documents the profiles and auditable measurement contract', () => {
		for (const profile of ['lexical', 'hybrid', 'hybrid+rerank']) {
			expect(
				documentation,
				`missing profile documentation: ${profile}`,
			).toContain(profile);
		}
		for (const term of [
			'manifest',
			'corpus',
			'version',
			'limitation',
			'degrad',
			'fallback',
			'precision',
			'recall',
			'latency',
			'cost',
			'resource',
		]) {
			expect(
				documentation,
				`missing evaluator documentation term: ${term}`,
			).toContain(term);
		}
	});

	test('has one unique pending release fragment naming both issues', () => {
		const pendingDirectory = path.join(repositoryRoot, 'docs/releases/pending');
		const matches = readdirSync(pendingDirectory)
			.filter((file) => file.endsWith('.md'))
			.filter((file) => {
				const content = readFileSync(path.join(pendingDirectory, file), 'utf8');
				return content.includes('#2489') && content.includes('#2490');
			});
		expect(
			matches,
			'expected one pending fragment mentioning #2489 and #2490',
		).toHaveLength(1);
	});
});
