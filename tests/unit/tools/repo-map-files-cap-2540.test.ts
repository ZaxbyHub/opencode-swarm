import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { repo_map } from '../../../src/tools/repo-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const MAX_FILES = 50;
const ACTIONS = [
	'blast_radius',
	'preflight_packet',
	'diff_context',
	'test_pack',
	'retrieve',
] as const;

type Action = (typeof ACTIONS)[number];
type RepoMapTool = {
	execute: (
		args: Record<string, unknown>,
		ctx: { directory: string; sessionID: string },
	) => Promise<string>;
	args: {
		files?: {
			safeParse: (value: unknown) => { success: boolean };
		};
	};
};
type ErrorEnvelope = {
	success: false;
	action: string;
	error: string;
};

const tool = repo_map as unknown as RepoMapTool;
const roots: string[] = [];

function fileList(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);
}

function parseError(output: string): ErrorEnvelope {
	const result = JSON.parse(output) as Partial<ErrorEnvelope>;
	expect(result.success).toBe(false);
	expect(typeof result.action).toBe('string');
	expect(typeof result.error).toBe('string');
	return result as ErrorEnvelope;
}

function call(action: Action, files: string[], root: string): Promise<string> {
	return tool.execute(
		{
			action,
			files,
			...(action === 'retrieve' ? { question: 'locate the entry point' } : {}),
		},
		{ directory: root, sessionID: 'repo-map-files-cap-2540' },
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('repo_map multi-file cap (issue #2540)', () => {
	test('rejects 51 files before loading the repository graph for every file action', async () => {
		const root = canonicalMkdtemp('repo-map-files-cap-2540-');
		roots.push(root);

		for (const action of ACTIONS) {
			const result = parseError(
				await call(action, fileList(MAX_FILES + 1), root),
			);
			expect(result).toMatchObject({ success: false, action });
			expect(result.error).toMatch(/at most 50/);
			expect(result.error.length).toBeLessThan(200);
			// No graph exists in this fixture; reaching graph loading would produce
			// the missing-graph error instead of the bounded scope error.
			expect(result.error).not.toContain('No repo graph found');
		}
	});

	test('keeps the schema and execute boundary aligned at exactly 50 files', async () => {
		const files = fileList(MAX_FILES);
		const schema = tool.args.files;
		expect(schema?.safeParse(files).success).toBe(true);
		expect(schema?.safeParse(fileList(MAX_FILES + 1)).success).toBe(false);

		const root = canonicalMkdtemp('repo-map-files-boundary-2540-');
		roots.push(root);
		const result = parseError(await call('preflight_packet', files, root));
		expect(result.error).toContain('No repo graph found');
		expect(result.error).not.toMatch(/at most 50/);
	});
});
