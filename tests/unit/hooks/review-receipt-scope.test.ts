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
		let observedStdio: unknown;
		let observedTimeout: unknown;
		let childStdinWasNull = false;
		receiptScopeInternals.spawn = ((
			command: string,
			args: string[],
			options: Parameters<typeof originalSpawn>[2],
		) => {
			const child = originalSpawn(command, args, options);
			observedStdio = options?.stdio;
			observedTimeout = options?.timeout;
			childStdinWasNull = child.stdin === null;
			return child;
		}) as typeof originalSpawn;

		// Previous execFile code cast an unsupported `stdio` option, so Node
		// silently created a writable stdin pipe even though the source claimed
		// stdin was ignored.
		expect(
			await buildReviewerTaskScope(directory, ['src/actual.ts']),
		).not.toBeNull();
		expect(observedStdio).toEqual(['ignore', 'pipe', 'ignore']);
		expect(observedTimeout).toBe(5_000);
		expect(childStdinWasNull).toBe(true);
	});

	test('regression F2: oversized HEAD output is killed and rejected', async () => {
		const stdout = new PassThrough();
		let killCalls = 0;
		const fakeChild = Object.assign(new EventEmitter(), {
			stdin: null,
			stdout,
			stderr: null,
			kill: () => {
				killCalls += 1;
				return true;
			},
		}) as unknown as ReturnType<typeof originalSpawn>;
		receiptScopeInternals.spawn = (() => {
			queueMicrotask(() => {
				stdout.write(Buffer.alloc(257, 0x61));
				stdout.end();
				fakeChild.emit('close', 0);
			});
			return fakeChild;
		}) as typeof originalSpawn;

		// This fake covers only output overflow. The real-process test above
		// covers normal completion; existing scope tests cover valid SHA output.
		expect(
			await buildReviewerTaskScope(directory, ['src/actual.ts']),
		).toBeNull();
		expect(killCalls).toBeGreaterThan(0);
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
			'reviewer-task-files-v1',
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
		expect(before).not.toBeNull();

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

		expect(after?.content).not.toBe(before?.content);
	});

	test('rejects path escapes instead of forging a partial scope', async () => {
		expect(
			await buildReviewerTaskScope(directory, ['../outside.ts']),
		).toBeNull();
	});
});
