import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type RepoMapTool = {
	execute: (
		args: Record<string, unknown>,
		ctx: { directory: string; sessionID: string },
	) => Promise<string>;
};

const repoMap = TOOL_MANIFEST.repo_map() as unknown as RepoMapTool;
const roots: string[] = [];

function createProject(prefix: string): string {
	const root = canonicalMkdtemp(prefix);
	roots.push(root);
	return root;
}

function parse(output: string): Record<string, unknown> {
	return JSON.parse(output) as Record<string, unknown>;
}

function call(root: string, args: Record<string, unknown>): Promise<string> {
	return repoMap.execute(args, {
		directory: root,
		sessionID: 'repo-map-2540-bounds',
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('repo_map bounded fallback acceptance (issue #2540)', () => {
	test('rejects an oversized preflight scope before graph loading', async () => {
		const root = createProject('repo-map-2540-scope-');
		const files = Array.from(
			{ length: 101 },
			(_, index) => `src/requested-${index}.ts`,
		);

		const result = parse(
			await call(root, { action: 'preflight_packet', files }),
		);

		expect(result).toMatchObject({
			success: false,
			action: 'preflight_packet',
		});
		expect(String(result.error)).toMatch(/at most|cap|maximum|scope/i);
	});

	test('reports an unsupported symbol-search language explicitly', async () => {
		const root = createProject('repo-map-2540-language-');
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'entry.ts'),
			'export function entry() { return 1; }\n',
		);

		const built = parse(await call(root, { action: 'build' }));
		expect(built.success).toBe(true);

		const result = parse(
			await call(root, {
				action: 'symbol_search',
				symbol: 'entry',
				language: 'brainfuck',
			}),
		);
		const warnings = Array.isArray(result.warnings)
			? (result.warnings as unknown[]).map(String)
			: [];
		const explicitFallback =
			result.languageSupported === false ||
			warnings.some((warning) =>
				/unsupported|unavailable|not indexed|no .*language/i.test(warning),
			);

		expect(result.success).toBe(true);
		expect(result.hits).toEqual([]);
		expect(explicitFallback).toBe(true);
	});
});
