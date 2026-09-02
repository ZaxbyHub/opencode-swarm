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

	test('the resolved repo_graph.storage mode reaches the injection options (#1534)', () => {
		// repo-graph-injection.ts must never read config synchronously on the
		// system-prompt path (issue #704/#1900), so `storage` can only reach the
		// block builders by riding in the options object system-enhancer.ts
		// parses ONCE at hook creation. Without this line the indexed path is
		// unreachable in production no matter what the user configures.
		const systemEnhancer = readFileSync(
			path.join(SRC_ROOT, 'hooks/system-enhancer.ts'),
			'utf8',
		);
		const optionsLiteral = systemEnhancer.match(
			/const repoGraphInjectionOptions = \{([\s\S]*?)\n\t\};/,
		);
		expect(optionsLiteral).not.toBeNull();
		expect(optionsLiteral?.[1]).toContain('storage: repoGraphConfig.storage');

		// And the block builders must consume it rather than resolving it
		// themselves.
		const injection = readFileSync(
			path.join(SRC_ROOT, 'hooks/repo-graph-injection.ts'),
			'utf8',
		);
		expect(injection).toContain("options?.storage === 'indexed'");
		expect(injection).not.toContain('resolveGraphStorageMode');
	});
});
