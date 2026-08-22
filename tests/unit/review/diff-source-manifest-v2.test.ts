import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectReviewDiff,
	_internals as diffSourceInternals,
} from '../../../src/review/diff-source';

const fixtures: string[] = [];
const originalNow = diffSourceInternals.now;

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15_000,
		maxBuffer: 1024 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr}`,
		);
	}
	return result.stdout.trim();
}

function repoFixture(prefix: string): string {
	const directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
	);
	fixtures.push(directory);
	git(directory, ['init', '-b', 'main']);
	git(directory, ['config', 'user.email', 'review@example.invalid']);
	git(directory, ['config', 'user.name', 'Review Fixture']);
	fs.appendFileSync(
		path.join(directory, '.git', 'info', 'exclude'),
		'\n.swarm/\n',
		'utf8',
	);
	return directory;
}

function write(directory: string, relativePath: string, content: string): void {
	const target = path.join(directory, ...relativePath.split('/'));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, 'utf8');
}

function blobId(
	directory: string,
	treeish: string,
	relativePath: string,
): string {
	return git(directory, ['rev-parse', `${treeish}:${relativePath}`]);
}

afterEach(() => {
	diffSourceInternals.now = originalNow;
	for (const directory of fixtures.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe('review diff manifest v2', () => {
	test('default/base selectors bind deleted old-side identities to the collector merge-base on diverged history', async () => {
		const directory = repoFixture('review-manifest-merge-base-');
		write(directory, 'src/shared.ts', 'export const shared = "base";\n');
		write(directory, 'src/only-on-main.ts', 'export const keep = "main";\n');
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'base']);
		const baseCommit = git(directory, ['rev-parse', 'HEAD']);

		git(directory, ['checkout', '-b', 'feature']);
		fs.unlinkSync(path.join(directory, 'src', 'only-on-main.ts'));
		write(directory, 'src/shared.ts', 'export const shared = "feature";\n');
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'feature commit']);

		git(directory, ['checkout', 'main']);
		write(
			directory,
			'src/only-on-main.ts',
			'export const keep = "main-tip-only";\n',
		);
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'main tip']);
		const mainTip = git(directory, ['rev-parse', 'HEAD']);

		git(directory, ['checkout', 'feature']);
		const defaultScope = await collectReviewDiff({ directory });
		expect(defaultScope.status).toBe('ok');
		if (defaultScope.status !== 'ok') throw new Error(defaultScope.reason);

		const baseScope = await collectReviewDiff({
			directory,
			selector: { kind: 'base', ref: 'main' },
		});
		expect(baseScope.status).toBe('ok');
		if (baseScope.status !== 'ok') throw new Error(baseScope.reason);

		const mergeBaseBlob = blobId(directory, baseCommit, 'src/only-on-main.ts');
		const mainTipBlob = blobId(directory, mainTip, 'src/only-on-main.ts');
		expect(mergeBaseBlob).not.toBe(mainTipBlob);

		const defaultDeleted = defaultScope.manifest.path_records.find(
			(record) => record.old_path === 'src/only-on-main.ts',
		);
		const baseDeleted = baseScope.manifest.path_records.find(
			(record) => record.old_path === 'src/only-on-main.ts',
		);
		expect(defaultDeleted?.kind).toBe('deleted');
		expect(baseDeleted?.kind).toBe('deleted');
		expect(defaultDeleted?.old_identity?.git_blob_oid).toBe(mergeBaseBlob);
		expect(baseDeleted?.old_identity?.git_blob_oid).toBe(mergeBaseBlob);
		expect(defaultDeleted?.old_identity?.git_blob_oid).not.toBe(mainTipBlob);
		expect(baseDeleted?.old_identity?.git_blob_oid).not.toBe(mainTipBlob);
	});

	test('working-tree manifests stay stable across unrelated commits but change when reviewed bytes change', async () => {
		const directory = repoFixture('review-manifest-working-tree-');
		write(directory, 'src/reviewed.ts', 'export const reviewed = "base";\n');
		write(directory, 'src/unrelated.ts', 'export const unrelated = "base";\n');
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'base']);

		write(directory, 'src/reviewed.ts', 'export const reviewed = "dirty";\n');
		const first = await collectReviewDiff({ directory });
		expect(first.status).toBe('ok');
		if (first.status !== 'ok') throw new Error(first.reason);

		git(directory, ['commit', '--allow-empty', '-m', 'unrelated commit']);
		const second = await collectReviewDiff({ directory });
		expect(second.status).toBe('ok');
		if (second.status !== 'ok') throw new Error(second.reason);
		expect(second.manifest.hash).toBe(first.manifest.hash);

		write(directory, 'src/new-untracked.ts', 'export const added = true;\n');
		const fileSetChanged = await collectReviewDiff({ directory });
		expect(fileSetChanged.status).toBe('ok');
		if (fileSetChanged.status !== 'ok') throw new Error(fileSetChanged.reason);
		expect(fileSetChanged.manifest.hash).not.toBe(first.manifest.hash);
		fs.unlinkSync(path.join(directory, 'src', 'new-untracked.ts'));

		const workingTreeOnly = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});
		expect(workingTreeOnly.status).toBe('ok');
		if (workingTreeOnly.status !== 'ok')
			throw new Error(workingTreeOnly.reason);
		expect(workingTreeOnly.manifest.hash).not.toBe(first.manifest.hash);

		write(
			directory,
			'src/reviewed.ts',
			'export const reviewed = "dirty-again";\n',
		);
		const third = await collectReviewDiff({ directory });
		expect(third.status).toBe('ok');
		if (third.status !== 'ok') throw new Error(third.reason);
		expect(third.manifest.hash).not.toBe(first.manifest.hash);
	});

	test('working-tree manifests fail completeness closed when content identity exceeds the per-file cap', async () => {
		const directory = repoFixture('review-manifest-file-cap-');
		write(directory, 'src/huge.ts', 'export const huge = "base";\n');
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'base']);

		write(
			directory,
			'src/huge.ts',
			`export const huge = "${'x'.repeat(2 * 1024 * 1024 + 128)}";\n`,
		);

		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		expect(result.status).toBe('ok');
		if (result.status !== 'ok') throw new Error(result.reason);
		expect(result.completeness.complete).toBe(false);
		expect(result.completeness.skipReasons).toContainEqual(
			expect.objectContaining({
				code: 'UNREADABLE_FILE',
				path: 'src/huge.ts',
			}),
		);
		expect(
			result.manifest.path_records.find(
				(record) => record.new_path === 'src/huge.ts',
			)?.new_identity,
		).toBeUndefined();
	});

	test('working-tree manifests fail completeness closed when content identity hashing exceeds the deadline', async () => {
		const directory = repoFixture('review-manifest-deadline-');
		write(directory, 'src/reviewed.ts', 'export const reviewed = "base";\n');
		git(directory, ['add', '--', 'src']);
		git(directory, ['commit', '-m', 'base']);

		write(
			directory,
			'src/reviewed.ts',
			'export const reviewed = "dirty-after-deadline";\n',
		);
		let nowCalls = 0;
		diffSourceInternals.now = () => (nowCalls++ === 0 ? 0 : 2_500);

		const result = await collectReviewDiff({
			directory,
			selector: { kind: 'working-tree' },
		});

		expect(result.status).toBe('ok');
		if (result.status !== 'ok') throw new Error(result.reason);
		expect(result.completeness.complete).toBe(false);
		expect(
			result.completeness.skipReasons.some(
				(item) =>
					item.code === 'UNREADABLE_FILE' &&
					item.path === 'src/reviewed.ts' &&
					item.detail.includes('deadline'),
			),
		).toBe(true);
		expect(
			result.manifest.path_records.find(
				(record) => record.new_path === 'src/reviewed.ts',
			)?.new_identity,
		).toBeUndefined();
	});
});
