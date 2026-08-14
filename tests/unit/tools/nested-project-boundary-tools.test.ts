import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	pre_check_batch,
	_internals as preCheckInternals,
	_test_exports as preCheckTestExports,
} from '../../../src/tools/pre-check-batch';
import { resolveWorkingDirectory } from '../../../src/tools/resolve-working-directory';
import {
	createNestedBoundaryFixture,
	type NestedBoundaryFixture,
	removeNestedBoundaryFixture,
} from '../../helpers/nested-project-boundary';

const fixtures: NestedBoundaryFixture[] = [];
const originalRunLintWrapped = preCheckInternals.runLintWrapped;

afterEach(() => {
	preCheckInternals.runLintWrapped = originalRunLintWrapped;
	for (const fixture of fixtures.splice(0)) {
		removeNestedBoundaryFixture(fixture);
	}
});

function fixture(
	marker: 'git-directory' | 'git-file' | 'opencode' = 'git-directory',
): NestedBoundaryFixture {
	const created = createNestedBoundaryFixture(marker);
	fixtures.push(created);
	return created;
}

function context(directory: string): ToolContext {
	return {
		sessionID: 'issue-2127-session',
		messageID: 'issue-2127-message',
		agent: 'architect',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		askID: '1.1',
		ask_id: '1.1',
		askId: '1.1',
	} as ToolContext;
}

describe('nested project boundary tools — regression: parent .swarm poison (#2127)', () => {
	it('resolveWorkingDirectory accepts each explicit nested boundary type', () => {
		for (const marker of ['git-directory', 'git-file', 'opencode'] as const) {
			const { outer, nested } = fixture(marker);
			expect(resolveWorkingDirectory(nested, outer)).toEqual({
				success: true,
				directory: nested,
			});
		}
	});

	it('resolveWorkingDirectory still rejects an ordinary descendant', () => {
		const { outer, ordinary } = fixture();
		const result = resolveWorkingDirectory(ordinary, outer);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.message).toContain('project root');
	});

	it('rejects an ordinary descendant when fallback is absent or unrelated', () => {
		const { ordinary } = fixture();
		const { nested: unrelatedRoot } = fixture('opencode');

		expect(resolveWorkingDirectory(ordinary, undefined).success).toBe(false);
		expect(resolveWorkingDirectory(ordinary, unrelatedRoot).success).toBe(
			false,
		);
		expect(resolveWorkingDirectory(undefined, ordinary).success).toBe(false);
	});

	it('classifies target-directory links by the direct markers at their canonical target', () => {
		const { outer, nested, ordinary } = fixture();
		const markedLink = path.join(outer, 'marked-link');
		const ordinaryLink = path.join(outer, 'ordinary-link');
		const linkType = process.platform === 'win32' ? 'junction' : 'dir';
		fs.symlinkSync(nested, markedLink, linkType);
		fs.symlinkSync(ordinary, ordinaryLink, linkType);

		expect(resolveWorkingDirectory(markedLink, outer)).toEqual({
			success: true,
			directory: markedLink,
		});
		expect(resolveWorkingDirectory(ordinaryLink, outer).success).toBe(false);
	});

	it('registered pre_check_batch scans files in an explicitly nested root', async () => {
		const { outer, nested } = fixture('git-directory');
		let lintDirectory: string | undefined;
		preCheckInternals.runLintWrapped = async (_files, directory) => {
			lintDirectory = directory;
			return {
				ran: true,
				result: { success: true, output: '', errors: [], warnings: [] },
				duration_ms: 0,
			};
		};
		fs.writeFileSync(
			path.join(nested, 'nested.ts'),
			'export const nested = 1;\n',
		);

		const raw = await pre_check_batch.execute(
			{ directory: nested, files: ['nested.ts'] },
			context(outer),
		);
		const result = JSON.parse(raw);

		expect(result.lint.ran).toBe(true);
		expect(lintDirectory).toBe(nested);
		expect(result.secretscan.ran).toBe(true);
		expect(result.sast_scan.ran).toBe(true);
		expect(result.quality_budget.ran).toBe(true);
	});

	it('registered pre_check_batch still rejects an ordinary descendant', async () => {
		const { outer, ordinary } = fixture();
		fs.writeFileSync(
			path.join(ordinary, 'ordinary.ts'),
			'export const value = 1;\n',
		);

		const raw = await pre_check_batch.execute(
			{ directory: ordinary, files: ['ordinary.ts'] },
			context(outer),
		);
		const result = JSON.parse(raw);

		expect(result.gates_passed).toBe(false);
		expect(result.lint.error).toContain('subdirectory');
	});

	it('rejects an explicitly marked root on an unrelated Windows drive', () => {
		// The conflicted implementation accepted any marked root after path.win32.relative
		// returned an absolute path for a cross-drive target.
		expect(
			preCheckTestExports.isAcceptedProjectRootForPlatform(
				'D:\\external-project',
				'C:\\workspace',
				'win32',
				true,
			),
		).toBe(false);
		expect(
			preCheckTestExports.isAcceptedProjectRootForPlatform(
				'C:\\workspace\\nested-project',
				'C:\\workspace',
				'win32',
				true,
			),
		).toBe(true);
	});
});
