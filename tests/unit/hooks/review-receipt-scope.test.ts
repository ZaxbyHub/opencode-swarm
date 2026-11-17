import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { resolveAutoReviewConfig } from '../../../src/config/schema';
import {
	isScopeStale,
	type ReviewReceipt,
} from '../../../src/hooks/review-receipt';
import { collectReviewerReceiptAfter } from '../../../src/hooks/review-receipt-collector';
import {
	buildReviewerTaskScope,
	classifyWorkspaceGitHealth,
	_internals as receiptScopeInternals,
	resolveReviewerTaskScope,
} from '../../../src/hooks/review-receipt-scope';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

let directory: string;
const originalSpawn = receiptScopeInternals.spawn;

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
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'review-receipt-scope-')),
	);
	git(['init']);
	fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'src', 'actual.ts'),
		'export const n = 1;\n',
	);
	git(['add', 'src/actual.ts']);
	git([
		'-c',
		'user.name=Scope Test',
		'-c',
		'user.email=scope@example.invalid',
		'commit',
		'-m',
		'baseline',
	]);
});

afterEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	resetSwarmState();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer task receipt scope', () => {
	test('regression F2: HEAD subprocess actually ignores stdin', async () => {
		const observed: Array<{
			args: string[];
			stdio: unknown;
			timeout: unknown;
			stdinWasNull: boolean;
		}> = [];
		receiptScopeInternals.spawn = ((
			command: string,
			args: string[],
			options: Parameters<typeof originalSpawn>[2],
		) => {
			const child = originalSpawn(command, args, options);
			observed.push({
				args,
				stdio: options?.stdio,
				timeout: options?.timeout,
				stdinWasNull: child.stdin === null,
			});
			return child;
		}) as typeof originalSpawn;

		// Previous execFile code cast an unsupported `stdio` option, so Node
		// silently created a writable stdin pipe even though the source claimed
		// stdin was ignored.
		const result = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(result.ok).toBe(true);
		// Select the HEAD invocation by argv rather than by call position: the
		// availability probe (`rev-parse --git-dir`) runs FIRST and reads
		// stderr, so "the first spawn" is no longer the call under test
		// (FB-004 moved it behind a path-sized output cap).
		const headCall = observed.find((call) => call.args.includes('--verify'));
		expect(headCall).toBeDefined();
		expect(headCall?.stdio).toEqual(['ignore', 'pipe', 'ignore']);
		expect(headCall?.timeout).toBe(5_000);
		expect(headCall?.stdinWasNull).toBe(true);
	});

	test('regression F2: oversized HEAD output is killed and rejected', async () => {
		let killCalls = 0;
		const invocations: Array<{ args: string[]; child: EventEmitter }> = [];
		receiptScopeInternals.spawn = ((_command: string, args: string[]) => {
			const stdout = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr: null,
				kill: () => {
					killCalls += 1;
					return true;
				},
			});
			invocations.push({ args, child });
			queueMicrotask(() => {
				stdout.write(Buffer.alloc(257, 0x61));
				stdout.end();
				child.emit('close', 0);
			});
			return child;
		}) as typeof originalSpawn;

		// This fake covers only output overflow. The real-process test above
		// covers normal completion; existing scope tests cover valid SHA output.
		const result = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(result).toMatchObject({ ok: false, code: 'head_timeout' });
		expect(killCalls).toBeGreaterThan(0);
		// The kill must come from the HEAD invocation, not from the
		// availability probe that now runs first: the probe's stdout is never
		// read, so it is bounded by a path-sized cap instead (FB-004).
		expect(invocations.some((call) => call.args.includes('--verify'))).toBe(
			true,
		);
	});

	test('FB-004: a path-sized availability answer is not an overflow denial', async () => {
		// A `rev-parse --git-dir` answer is a filesystem PATH, not a SHA: a
		// linked-worktree lane root or a deep subdirectory root routinely
		// exceeds 256 bytes. Reusing the SHA-sized cap there overflowed a
		// HEALTHY workspace into a retryable `head_timeout` denial that
		// re-dispatch can never clear. Executed: a deep linked worktree whose
		// absolute git-dir path is ~250 bytes crosses the old cap at ~250
		// bytes of main-repo path.
		//
		// DISCRIMINATING: dropping PATH_OUTPUT_BYTES (or lowering it below a
		// real git-dir path) makes this same answer overflow the availability
		// probe, which classifies `overflow` as the RETRYABLE `head_timeout`
		// — the exact assertion below then fails.
		const PATH_ANSWER = `.git/${'lane/'.repeat(400)}`;
		expect(PATH_ANSWER.length).toBeGreaterThan(256);
		const gitDirCalls: string[] = [];
		receiptScopeInternals.spawn = ((_command: string, args: string[]) => {
			if (args.includes('--git-dir')) gitDirCalls.push(args.join(' '));
			const stdout = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr: null,
				kill: () => true,
			});
			queueMicrotask(() => {
				stdout.write(PATH_ANSWER);
				stdout.end();
				// Exit 1 with no git cause on stderr: a probe the classifier
				// reads as `git_unhealthy`, NOT as the transient overflow.
				child.emit('close', 1);
			});
			return child;
		}) as typeof originalSpawn;

		const health = await classifyWorkspaceGitHealth(directory);
		expect(gitDirCalls.length).toBe(1);
		expect(health).toMatchObject({
			kind: 'denial',
			code: 'git_unhealthy',
			retryable: false,
		});
		// The discriminating direction, stated explicitly.
		expect((health as { code: string }).code).not.toBe('head_timeout');
		expect((health as { retryable: boolean }).retryable).toBe(false);
	});

	test('fails without authoritative parent-session modified-file state', async () => {
		expect(
			await resolveReviewerTaskScope(directory, 'missing-session'),
		).toBeNull();
	});

	test('binds a receipt to actual modified code despite under-scoped prompt prose', async () => {
		const session = ensureAgentSession('architect-session');
		session.modifiedFilesThisCoderTask = ['src/actual.ts'];
		fs.writeFileSync(
			path.join(directory, 'src', 'actual.ts'),
			'export const n = 3;\n',
		);
		const reviewedScope = await resolveReviewerTaskScope(
			directory,
			'architect-session',
		);
		expect(reviewedScope?.files).toEqual(['src/actual.ts']);

		const receiptPath = await collectReviewerReceiptAfter(
			directory,
			{
				tool: 'Task',
				args: {
					subagent_type: 'reviewer',
					prompt: 'TASK: Review README.md only',
				},
				sessionID: 'architect-session',
			},
			{
				output: 'VERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none',
			},
			{ config: resolveAutoReviewConfig({ enabled: true }) },
		);
		expect(receiptPath).not.toBeNull();
		const receipt = JSON.parse(
			fs.readFileSync(receiptPath as string, 'utf-8'),
		) as ReviewReceipt;
		expect(receipt.scope_fingerprint.scope_description).toBe(
			'reviewer-task-files-v2',
		);
		expect(isScopeStale(receipt, reviewedScope?.content)).toBe(false);

		fs.writeFileSync(
			path.join(directory, 'src', 'actual.ts'),
			'export const n = 2;\n',
		);
		const changedScope = await resolveReviewerTaskScope(
			directory,
			'architect-session',
		);
		expect(changedScope?.content).not.toBe(reviewedScope?.content);
		expect(isScopeStale(receipt, changedScope?.content)).toBe(true);
	});

	test('changes scope when HEAD changes while current modified bytes stay identical', async () => {
		fs.writeFileSync(
			path.join(directory, 'src', 'actual.ts'),
			'export const n = 2;\n',
		);
		const before = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(before.ok).toBe(true);

		fs.writeFileSync(
			path.join(directory, 'unrelated.txt'),
			'new baseline commit\n',
		);
		git(['add', 'unrelated.txt']);
		git([
			'-c',
			'user.name=Scope Test',
			'-c',
			'user.email=scope@example.invalid',
			'commit',
			'-m',
			'advance head',
		]);
		const after = await buildReviewerTaskScope(directory, ['src/actual.ts']);
		expect(after.ok).toBe(true);

		expect(after.scope.content).not.toBe(before.scope.content);
	});

	test('rejects path escapes instead of forging a partial scope', async () => {
		const escaped = await buildReviewerTaskScope(directory, ['../outside.ts']);
		expect(escaped).toMatchObject({ ok: false, code: 'outside_workspace' });
	});
});
