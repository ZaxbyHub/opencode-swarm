import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

function productionTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...productionTypeScriptFiles(absolute));
		} else if (
			entry.isFile() &&
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts')
		) {
			files.push(absolute);
		}
	}
	return files;
}

describe('repo graph freshness production wiring', () => {
	test('the deprecated TTL helper has no production caller', () => {
		const matches: string[] = [];
		for (const file of productionTypeScriptFiles(SRC_ROOT)) {
			const source = readFileSync(file, 'utf8');
			const count = source.match(/\bisGraphFresh\s*\(/g)?.length ?? 0;
			for (let index = 0; index < count; index++) {
				matches.push(path.relative(SRC_ROOT, file).replace(/\\/g, '/'));
			}
		}

		expect(matches).toEqual(['tools/repo-graph/query.ts']);
	});

	test('all prompt graph consumers await and receive freshness options', () => {
		const systemEnhancer = readFileSync(
			path.join(SRC_ROOT, 'hooks/system-enhancer.ts'),
			'utf8',
		);
		const semanticDiff = readFileSync(
			path.join(SRC_ROOT, 'hooks/semantic-diff-injection.ts'),
			'utf8',
		);

		expect(systemEnhancer).toContain('await buildCoderLocalizationBlock(');
		expect(systemEnhancer).toContain('await buildReviewerBlastRadiusBlock(');
		const semanticDiffCalls = [
			...systemEnhancer.matchAll(
				/await buildSemanticDiffBlock\(([\s\S]*?)\);/g,
			),
		];
		expect(semanticDiffCalls).toHaveLength(2);
		for (const call of semanticDiffCalls) {
			expect(call[1]).toContain('repoGraphInjectionOptions');
		}
		expect(semanticDiff).toContain('await _internals.getCachedGraph(');
		expect(semanticDiff).toContain('repoGraphOptions');
	});
});
