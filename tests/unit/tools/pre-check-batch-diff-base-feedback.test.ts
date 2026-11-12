/**
 * PR #3677 feedback-round pins (FB-001/002/003): the shared diff-base
 * resolver's diagnostic is deduped per directory with a conditional remedy,
 * a non-repository directory skips the doomed candidate walk, a timeout
 * teardown with uncollectable streams classifies systemic (stops the walk),
 * and the batch memo lets the second diff-base consumer reuse the first
 * consumer's walk instead of re-running it.
 *
 * GREEN at the fixed tree (authored against the feedback fixes; the
 * pre-fix tree fails the non-repo skip, cooldown, remedy, symbolic-ref,
 * teardown-corner, and memo legs).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	getChangedLineAmbiguousFiles,
	getChangedLineRanges,
	_internals as preCheckInternals,
} from '../../../src/tools/pre-check-batch';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let repo: string;

function git(...args: string[]): void {
	execFileSync('git', args, {
		cwd: repo,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function revParseHead(): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], {
		cwd: repo,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		windowsHide: true,
	}).trim();
}

function updateRef(ref: string, sha: string): void {
	execFileSync('git', ['update-ref', ref, sha], {
		cwd: repo,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function commitAll(message: string): void {
	git('add', '-A');
	git('commit', '-q', '-m', message);
}

function initTrunkRepo(): void {
	mkdirSync(repo, { recursive: true });
	git('init', '-q', '-b', 'trunk');
	git('config', 'user.email', 'tests@example.com');
	git('config', 'user.name', 'tests');
	git('config', 'core.autocrlf', 'false');
	writeFileSync(path.join(repo, 'base.txt'), 'line1\n');
	commitAll('seed');
}

function initTrunkRepoWithRemote(): void {
	initTrunkRepo();
	updateRef('refs/remotes/origin/main', revParseHead());
}

beforeEach(() => {
	repo = canonicalMkdtemp('pcb-diff-base-feedback-');
});

afterEach(() => {
	safeRmRecursive(repo);
});

describe('diff-base resolver — feedback-round pins (FB-001/002/003)', () => {
	test('a non-repository directory skips the doomed candidate walk and names the cause (GREEN after the FB-001 fix)', async () => {
		const notARepo = canonicalMkdtemp('pcb-feedback-notrepo-');
		try {
			const savedRun = preCheckInternals.runExternalTool;
			let candidateSpawns = 0;
			preCheckInternals.runExternalTool = (async (options: {
				args?: string[];
			}) => {
				if (options?.args?.includes('merge-base')) candidateSpawns++;
				return {
					status: 'completed',
					exitCode: 128,
					stdout: '',
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				} as never;
			}) as never;
			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
			let captured = '';
			try {
				const map = await getChangedLineRanges(notARepo, undefined, []);
				captured = warnSpy.mock.calls
					.map((call) => String(call[0] ?? ''))
					.join('\n');
				expect(map).toBeNull();
				expect(candidateSpawns).toBe(0);
			} finally {
				preCheckInternals.runExternalTool = savedRun;
				warnSpy.mockRestore();
			}
			expect(captured).toContain('non-repository directory');
			expect(captured).not.toContain('zaxbyhub/main=');
		} finally {
			safeRmRecursive(notARepo);
		}
	});

	test('the failure diagnostic is cooled down per directory: two consumers, one emission (GREEN after the FB-001 fix)', async () => {
		initTrunkRepo();
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const a = await getChangedLineRanges(repo, undefined, []);
			const b = await getChangedLineAmbiguousFiles(repo, undefined, []);
			expect(a).toBeNull();
			expect(b).toBeNull();
			const criticalLines = warnSpy.mock.calls
				.map((call) => String(call[0] ?? ''))
				.filter((line) => line.includes('changed-line base resolution failed'));
			expect(criticalLines.length).toBe(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test('an all-unresolvable walk gets the refs-do-not-exist remedy, not the fetch advice (GREEN after the FB-001 fix)', async () => {
		initTrunkRepo();
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
		let captured = '';
		try {
			await getChangedLineRanges(repo, undefined, []);
			captured = warnSpy.mock.calls
				.map((call) => String(call[0] ?? ''))
				.join('\n');
		} finally {
			warnSpy.mockRestore();
		}
		expect(captured).toContain('none of the candidate refs exists');
		expect(captured).not.toContain('fetch the remote tracking refs');
	});

	test('the remote symbolic HEAD is derived as an extra candidate on total failure (GREEN after the FB-001 fix)', async () => {
		// origin/develop at the branch point; origin/main does not exist, so
		// the fixed list fails and only the derived candidate can resolve.
		initTrunkRepo();
		const base = revParseHead();
		writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
		commitAll('branch commit');
		updateRef('refs/remotes/origin/develop', base);
		git(
			'symbolic-ref',
			'refs/remotes/origin/HEAD',
			'refs/remotes/origin/develop',
		);

		const map = await getChangedLineRanges(repo, undefined, []);

		expect(map).not.toBeNull();
		expect(map?.has('tracked.txt')).toBe(true);
	});

	test('a timeout teardown with uncollectable streams stops the walk as systemic (GREEN after the FB-002 fix)', async () => {
		initTrunkRepo();
		const savedRun = preCheckInternals.runExternalTool;
		let mergeBaseSpawns = 0;
		preCheckInternals.runExternalTool = (async (options: {
			args?: string[];
		}) => {
			if (options?.args?.includes('merge-base')) {
				mergeBaseSpawns++;
				// Timeout teardown corner: spawn-error with BOTH truncation
				// flags and EMPTY streams (external-tool-runner teardown path).
				return {
					status: 'spawn-error',
					stdoutTruncated: true,
					stderrTruncated: true,
					stdout: '',
					stderr: '',
				} as never;
			}
			return {
				status: 'completed',
				exitCode: 0,
				stdout: `${'a'.repeat(40)}\n`,
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			} as never;
		}) as never;
		try {
			const map = await getChangedLineRanges(repo, undefined, []);
			expect(map).toBeNull();
			expect(mergeBaseSpawns).toBe(1);
		} finally {
			preCheckInternals.runExternalTool = savedRun;
		}
	});

	test('the batch memo lets the second diff-base consumer reuse the first walk (GREEN after the FB-003 fix)', async () => {
		initTrunkRepoWithRemote();
		// A branch commit past the base keeps the ambiguity consumer's
		// PRR-002 HEAD-equal refusal out of the picture (origin/main != HEAD).
		writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\n');
		commitAll('branch commit');
		// First consumer resolves and populates the batch memo.
		const first = await getChangedLineRanges(repo, undefined, []);
		expect(first).not.toBeNull();
		const savedRun = preCheckInternals.runExternalTool;
		let mergeBaseSpawns = 0;
		preCheckInternals.runExternalTool = (async (options: {
			args?: string[];
		}) => {
			if (options?.args?.includes('merge-base')) {
				mergeBaseSpawns++;
				// Fail every probe: only a memo hit can serve the envelope.
				return {
					status: 'completed',
					exitCode: 1,
					stdout: '',
					stderr: '',
					stdoutTruncated: false,
					stderrTruncated: false,
				} as never;
			}
			// Everything else (rev-parse, the consumer's own scoped legs)
			// passes through to the real runner.
			return savedRun(options as never);
		}) as never;
		try {
			// Second consumer: memo hit means zero merge-base probes even with
			// a stub that would fail every real probe.
			const ambiguous = await getChangedLineAmbiguousFiles(repo, undefined, []);
			expect(ambiguous).not.toBeNull();
			expect(mergeBaseSpawns).toBe(0);
		} finally {
			preCheckInternals.runExternalTool = savedRun;
		}
	});

	test('a HEAD move self-invalidates the memo (GREEN after the FB-003 fix)', async () => {
		initTrunkRepoWithRemote();
		const first = await getChangedLineRanges(repo, undefined, []);
		expect(first).not.toBeNull();
		writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo edited\nthree\n');
		commitAll('second commit');
		const second = await getChangedLineRanges(repo, undefined, []);
		expect(second).not.toBeNull();
		expect(second?.has('tracked.txt')).toBe(true);
	});
});
