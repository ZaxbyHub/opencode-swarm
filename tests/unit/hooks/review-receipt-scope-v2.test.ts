import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeScopeFingerprint } from '../../../src/hooks/review-receipt';
import {
	buildReviewerTaskScope,
	REVIEWER_TASK_SCOPE_DESCRIPTION,
	REVIEWER_TASK_SCOPE_HEADER,
} from '../../../src/hooks/review-receipt-scope';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';

function git(args: string[]): string {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf-8',
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true,
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || `git ${args.join(' ')} failed`);
	}
	return result.stdout;
}

beforeEach(() => {
	directory = canonicalMkdtemp('review-scope-manifest-v2-');
	git(['init']);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src/small.ts'),
		'export const s = 1;\n',
	);
	fs.writeFileSync(
		path.join(directory, 'src/large.ts'),
		`export const l = '${'x'.repeat(300 * 1024)}';\n`,
	);
	git(['add', '.']);
	git([
		'-c',
		'user.name=Manifest Test',
		'-c',
		'user.email=manifest@example.invalid',
		'commit',
		'-m',
		'baseline',
	]);
});

afterEach(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer-task manifest v2 (issue #2100 contract C)', () => {
	test('manifest is versioned and carries head + workspace identity', async () => {
		const result = await buildReviewerTaskScope(directory, ['src/small.ts']);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const lines = result.scope.content.split('\n');
		expect(lines[0]).toBe(REVIEWER_TASK_SCOPE_HEADER);
		expect(result.scope.description).toBe('reviewer-task-files-v2');
		const header = JSON.parse(lines[1]) as Record<string, unknown>;
		expect(header.head).toMatch(/^[0-9a-f]{40,64}$/i);
		expect(typeof header.workspace).toBe('string');
		expect(header.workspace.length).toBeGreaterThan(0);
		expect(result.scope.workspaceIdentity).toBe(header.workspace);
	});

	test('the payload budget changes delivery modes but never the manifest digest', async () => {
		const tight = await buildReviewerTaskScope(
			directory,
			['src/large.ts'],
			1024,
		);
		const generous = await buildReviewerTaskScope(
			directory,
			['src/large.ts'],
			1024 * 1024,
		);
		expect(tight.ok).toBe(true);
		expect(generous.ok).toBe(true);
		if (!tight.ok || !generous.ok) return;
		// The 300 KiB file is exact in BOTH manifests regardless of the budget.
		expect(tight.scope.content).toBe(generous.scope.content);
		expect(
			computeScopeFingerprint(tight.scope.content, tight.scope.description)
				.hash,
		).toBe(
			computeScopeFingerprint(
				generous.scope.content,
				generous.scope.description,
			).hash,
		);
		expect(tight.scope.delivery).toEqual([
			{ path: 'src/large.ts', mode: 'manual' },
		]);
		expect(generous.scope.delivery).toEqual([
			{ path: 'src/large.ts', mode: 'inline' },
		]);
	});

	test('a 300 KiB file exceeds the old v1 default budget yet enters the manifest exactly', async () => {
		const result = await buildReviewerTaskScope(directory, ['src/large.ts']);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const record = result.scope.content
			.split('\n')
			.map((line) => {
				try {
					return JSON.parse(line) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.find((parsed) => parsed?.path === 'src/large.ts');
		expect(record).toBeDefined();
		expect(record?.bytes).toBeGreaterThan(256 * 1024);
		expect(typeof record?.sha256).toBe('string');
	});

	test('provenance is embedded in the hashed content', async () => {
		const result = await buildReviewerTaskScope(
			directory,
			['src/small.ts'],
			undefined,
			{
				taskId: '1.1',
				coderCallID: 'coder-call',
				generation: 7,
				sessionIncarnation: 'inc-1',
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.scope.content).toContain('"task_id":"1.1"');
		expect(result.scope.content).toContain('"coder_call_id":"coder-call"');
		expect(result.scope.content).toContain('"generation":7');
		expect(result.scope.content).toContain('"session_incarnation":"inc-1"');
	});

	test('deleted files appear as deleted records', async () => {
		fs.rmSync(path.join(directory, 'src/small.ts'));
		const result = await buildReviewerTaskScope(directory, ['src/small.ts']);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.scope.content).toContain('"state":"deleted"');
		expect(result.scope.delivery).toEqual([
			{ path: 'src/small.ts', mode: 'manual' },
		]);
	});

	test('invalid budgets and file counts are typed non-retryable', async () => {
		expect(await buildReviewerTaskScope(directory, [])).toMatchObject({
			ok: false,
			code: 'no_files',
			retryable: false,
		});
		expect(
			await buildReviewerTaskScope(directory, ['src/small.ts'], 0),
		).toMatchObject({ ok: false, code: 'invalid_budget', retryable: false });
		expect(
			await buildReviewerTaskScope(
				directory,
				Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`),
			),
		).toMatchObject({ ok: false, code: 'too_many_files', retryable: false });
	});
});
