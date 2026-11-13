import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import {
	classifyWorkspaceGitHealth,
	_internals as receiptScopeInternals,
} from '../../../src/hooks/review-receipt-scope';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Split from reviewer-scope-availability-3680.test.ts (FR-006 500-line cap):
// the classifier's per-child deadline clamp and its spawn-failure cause
// typing. Both legs drive fully faked children and need neither the real-git
// fixtures nor the lifecycle scaffolding the parent file owns.

let directory: string;
const originalSpawn = receiptScopeInternals.spawn;

beforeEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	directory = canonicalMkdtemp('reviewer-scope-availability-3680-spawn-');
});

afterEach(() => {
	receiptScopeInternals.spawn = originalSpawn;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('classifyWorkspaceGitHealth deadline budget (#3680)', () => {
	test('each probe child is clamped to the caller deadline and never hangs', async () => {
		const observedTimeouts: unknown[] = [];
		// Fake children by role: the availability probe answers (exit 0,
		// stdout '.git'), the HEAD^{commit} verify fails fast (exit 128 — so
		// the failure-arm follow-ups actually run), and every later child
		// hangs so the classifier's own per-child timer is the only terminator.
		// (Final-critic round 1: the previous never-answering fake let the
		// unclamped 2000ms probe satisfy the old <=2000 bound while the three
		// resolveHeadSha children — the ones the clamp exists for — never ran;
		// removing the clamps left the suite 14/14 green.)
		const fakeSpawn = ((_command: string, args: string[]) => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			if (args.includes('--git-dir')) {
				queueMicrotask(() => {
					stdout.write('.git\n');
					stdout.end();
					stderr.end();
					child.emit('close', 0);
				});
			} else if (args.includes('--verify')) {
				queueMicrotask(() => {
					stdout.end();
					stderr.end();
					child.emit('close', 128);
				});
			}
			// symbolic-ref / show-ref children never emit: the clamped timer
			// must terminate them.
			return child;
		}) as typeof originalSpawn;
		const recordingSpawn = ((
			command: string,
			args: string[],
			options: Parameters<typeof originalSpawn>[2],
		) => {
			observedTimeouts.push(options?.timeout);
			return fakeSpawn(command, args, options);
		}) as typeof originalSpawn;
		receiptScopeInternals.spawn = recordingSpawn;
		// performance.timeOrigin + performance.now() IS the epoch-ms clock
		// classifyWorkspaceGitHealth uses (same OS clock, ~0ms skew) and stays
		// outside the check:test-clock raw-clock pattern. A ~400ms remaining
		// budget must clamp EVERY child (probe included) well under the
		// unclamped caps (2000/5000) and still terminate.
		const startedAt = performance.now();
		const deadlineAt = performance.timeOrigin + performance.now() + 400;
		const health = await classifyWorkspaceGitHealth(directory, deadlineAt);
		const elapsedMs = performance.now() - startedAt;
		expect(health).toEqual({
			kind: 'denial',
			code: 'head_timeout',
			retryable: true,
		});
		// probe + HEAD verify + at least one failure-arm follow-up
		expect(observedTimeouts.length).toBeGreaterThanOrEqual(3);
		for (const timeout of observedTimeouts) {
			expect(typeof timeout).toBe('number');
			expect(timeout as number).toBeGreaterThanOrEqual(1);
			expect(timeout as number).toBeLessThanOrEqual(500);
			// spawn()'s timeout option rejects a fractional value with a
			// synchronous ERR_OUT_OF_RANGE (final-critic round-3 probe), so
			// the remaining budget must be ceiled to an integer before it
			// reaches argv — the deadline above is performance.now()-derived
			// and therefore fractional.
			expect(Number.isInteger(timeout)).toBe(true);
		}
		expect(elapsedMs).toBeLessThan(1_900);
	}, 60_000);
});

describe('spawn-failure cause typing (#3680 — final-critic round-2 blockers 1-2)', () => {
	// Node's spawn() reports only EACCES/EAGAIN/EMFILE/ENFILE/ENOENT through
	// the async 'error' event and THROWS other errnos (ENOMEM included)
	// synchronously, so the transient set is pinned on BOTH arms.
	for (const errno of ['EMFILE', 'ENFILE', 'EAGAIN'] as const) {
		test(`${errno} via the error event stays transient head_timeout`, async () => {
			receiptScopeInternals.spawn = (() => {
				const child = Object.assign(new EventEmitter(), {
					stdin: null,
					stdout: new PassThrough(),
					stderr: new PassThrough(),
					kill: () => true,
				});
				queueMicrotask(() => {
					child.emit(
						'error',
						Object.assign(new Error('resource temporarily unavailable'), {
							code: errno,
						}),
					);
				});
				return child;
			}) as typeof originalSpawn;
			const health = await classifyWorkspaceGitHealth(directory);
			expect(health).toEqual({
				kind: 'denial',
				code: 'head_timeout',
				retryable: true,
			});
		}, 60_000);
	}

	test('ENOMEM thrown synchronously from spawn stays transient head_timeout', async () => {
		receiptScopeInternals.spawn = (() => {
			throw Object.assign(new Error('Cannot allocate memory'), {
				code: 'ENOMEM',
			});
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'head_timeout',
			retryable: true,
		});
	}, 60_000);

	test('ENOENT stays permanent git_unavailable', async () => {
		receiptScopeInternals.spawn = (() => {
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			});
			queueMicrotask(() => {
				child.emit(
					'error',
					Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
				);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unavailable',
			retryable: false,
		});
	}, 60_000);

	test('every git child env pins a C locale for cause matching', async () => {
		const observedEnvs: Record<string, string | undefined>[] = [];
		receiptScopeInternals.spawn = ((
			_command: string,
			args: string[],
			options: Parameters<typeof originalSpawn>[2],
		) => {
			observedEnvs.push(
				(options?.env ?? {}) as Record<string, string | undefined>,
			);
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			queueMicrotask(() => {
				if (args.includes('--git-dir')) {
					stdout.write('.git\n');
				} else if (args.includes('--verify')) {
					stdout.write(`${'a'.repeat(40)}\n`);
				}
				stdout.end();
				stderr.end();
				child.emit('close', 0);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health.kind).toBe('head');
		expect(observedEnvs.length).toBeGreaterThanOrEqual(2);
		for (const env of observedEnvs) {
			expect(env.LC_ALL).toBe('C');
			expect(env.LC_MESSAGES).toBe('C');
			expect(env.LANGUAGE).toBe('');
		}
	}, 60_000);

	test('a spawn failure AFTER a successful availability probe stays terminal git_unavailable', async () => {
		// The availability child spawns fine (exit 0, '.git'), so a later
		// child's spawn failure is a permanent missing/unwritable executable,
		// not a transient one: the resource-exhaustion errnos were already
		// converted to `timeout` inside runBoundedGit. Grouping this residual
		// spawn-error with timeout made a vanished git binary retryable
		// (plan-critic shipped-scope finding 5; #3680 AC12).
		receiptScopeInternals.spawn = ((_command: string, args: string[]) => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			queueMicrotask(() => {
				if (args.includes('--git-dir')) {
					stdout.write('.git\n');
					stdout.end();
					stderr.end();
					child.emit('close', 0);
					return;
				}
				// The HEAD^{commit} verify child cannot be spawned at all.
				child.emit(
					'error',
					Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
				);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_unavailable',
			retryable: false,
		});
	}, 60_000);

	test('a single over-512-byte dubious-ownership stderr keeps the cause', async () => {
		// git writes the message in ONE write and it exceeds the 512-byte
		// excerpt cap for realistic Windows paths; the cap must keep the
		// prefix (the cause string lives at the front) instead of dropping
		// the whole crossing chunk into a generic git_unhealthy.
		const longPath = `E:/projects/${'x'.repeat(120)}/opencode-swarm-dev`;
		const message = [
			`fatal: detected dubious ownership in repository at '${longPath}'`,
			'',
			'To add an exception for this directory, call:',
			'',
			`\tgit config --global --add safe.directory '${longPath}'`,
			'',
			'Filler text pushing this single git write past the 512-byte stderr excerpt cap.'.repeat(
				2,
			),
		].join('\n');
		expect(Buffer.byteLength(message)).toBeGreaterThan(512);
		receiptScopeInternals.spawn = (() => {
			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const child = Object.assign(new EventEmitter(), {
				stdin: null,
				stdout,
				stderr,
				kill: () => true,
			}) as unknown as ReturnType<typeof originalSpawn>;
			queueMicrotask(() => {
				stderr.write(message);
				stderr.end();
				stdout.end();
				child.emit('close', 128);
			});
			return child;
		}) as typeof originalSpawn;
		const health = await classifyWorkspaceGitHealth(directory);
		expect(health).toEqual({
			kind: 'denial',
			code: 'git_dubious_ownership',
			retryable: false,
		});
	}, 60_000);
});
