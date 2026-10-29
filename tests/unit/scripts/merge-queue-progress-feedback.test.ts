import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
	classify,
	entryMatchesModuleUrl,
	invokedAsMain,
	main,
	runCli,
} from '../../../scripts/check-merge-queue-progress.mjs';

/*
 * Feedback-round regressions for the merge-queue entry progress detector
 * (pr3490-fb1: FB-01/02/03/04/05/07/08/15/17 of the swarm-pr-review and
 * parallel-automation-review findings). Split from
 * merge-queue-progress.test.ts to stay under the FR-006 500-line cap; the
 * frozen C1/C2 acceptance filters (`-t "orphan-verdict"` /
 * `-t "building-verdict"`) select describes that remain in the original
 * file. All fixtures are pure in-memory payloads; the clock is injected.
 */

const NOW = Date.parse('2026-10-27T20:00:00.000Z');

function ev(
	event: string,
	minutesAgo: number,
): { event: string; created_at: string } {
	return {
		event,
		created_at: new Date(NOW - minutesAgo * 60_000).toISOString(),
	};
}

function completedRuns(
	count: number,
): Array<{ headBranch: string; status: string }> {
	return Array.from({ length: count }, (_, i) => ({
		headBranch: `feature/ci-something-${i}`,
		status: 'completed',
	}));
}

/** Records every ghJson call so tests can assert exact argv. */
function fakeIo(responses: {
	timeline?: unknown;
	runs?: unknown;
	state?: string;
	timelineError?: Error;
}) {
	const calls: string[][] = [];
	const out: string[] = [];
	const errors: string[] = [];
	return {
		io: {
			ghJson(args: string[]) {
				calls.push(args);
				if (args[0] === 'repo' && args[1] === 'view') {
					return { nameWithOwner: 'ZaxbyHub/opencode-swarm' };
				}
				if (args[0] === 'api') {
					if (responses.timelineError) throw responses.timelineError;
					return responses.timeline ?? [];
				}
				if (args[0] === 'run' && args[1] === 'list') {
					return responses.runs ?? completedRuns(100);
				}
				if (args[0] === 'pr' && args[1] === 'view') {
					return { state: responses.state ?? 'OPEN' };
				}
				throw new Error(`unexpected gh args: ${args.join(' ')}`);
			},
			log(line: string) {
				out.push(line);
			},
			err(line: string) {
				errors.push(line);
			},
			now() {
				return NOW;
			},
		},
		calls,
		out,
		errors,
	};
}

describe('feedback-round regressions (pr3490-fb1: FB-01/02/03/04/08/15/17)', () => {
	test('FB-01: a QUEUED queue run counts as active (runner contention keeps run-level status queued while jobs execute)', () => {
		const runs = [
			...completedRuns(99),
			{ headBranch: 'gh-readonly-queue/main/pr-42-abc123', status: 'queued' },
		];
		const result = classify([ev('auto_merge_enabled', 200)], runs, {
			now: NOW,
			pr: 42,
		});
		expect(result.verdict).toBe('BUILDING');
	});

	test('FB-01: waiting/pending/requested statuses also count as active; completed does not', () => {
		for (const status of ['waiting', 'pending', 'requested']) {
			const result = classify(
				[ev('auto_merge_enabled', 200)],
				[
					...completedRuns(99),
					{ headBranch: 'gh-readonly-queue/main/pr-42-abc', status },
				],
				{ now: NOW, pr: 42 },
			);
			expect(result.verdict).toBe('BUILDING');
		}
		const done = classify(
			[ev('auto_merge_enabled', 200)],
			[
				...completedRuns(99),
				{ headBranch: 'gh-readonly-queue/main/pr-42-abc', status: 'completed' },
			],
			{ now: NOW, pr: 42 },
		);
		expect(done.verdict).toBe('ORPHANED');
	});

	test('FB-08: a queued run for pr-420 does NOT satisfy pr 42 (trailing-dash prefix scoping)', () => {
		const result = classify(
			[ev('auto_merge_enabled', 200)],
			[
				...completedRuns(99),
				{ headBranch: 'gh-readonly-queue/main/pr-420-abc', status: 'queued' },
			],
			{ now: NOW, pr: 42 },
		);
		expect(result.verdict).toBe('ORPHANED');
	});

	test('FB-03: ORPHANED with a MERGED pr prints no recovery and explains the stale state', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			state: 'MERGED',
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(2);
		expect(out[0]).toBe('ORPHANED pr=42 age=200 state=MERGED');
		expect(out.some((line) => line.includes('no recovery printed'))).toBe(true);
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
	});

	test('FB-03: ORPHANED with a CLOSED pr also suppresses the recovery line', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			state: 'CLOSED',
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(2);
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
		expect(out.some((line) => line.includes('no recovery printed'))).toBe(true);
	});

	test('FB-04: a non-array run-list payload fails closed (exit 1, no verdict)', () => {
		const { io, out, errors } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			runs: { not: 'an array' },
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(1);
		expect(
			errors.some((line) => line.includes('run-list payload was not an array')),
		).toBe(true);
		expect(out.filter((line) => line.includes('pr=42'))).toEqual([]);
	});

	test('FB-02: an ORPHANED verdict whose 100-run window does not reach the entry event downgrades to UNKNOWN', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			// Newest-100 window starts 10 minutes ago — far newer than the
			// 200-minute-old entry, so zero-active-builds is unproven.
			runs: [
				{
					headBranch: 'feature/a',
					status: 'completed',
					createdAt: new Date(NOW - 10 * 60_000).toISOString(),
				},
			],
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(0);
		// The window note prints before the verdict line.
		expect(out[0]).toContain('does not reach back');
		expect(out[1]).toBe('UNKNOWN pr=42 age=200 state=OPEN');
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
	});

	test('FB-15: BUILDING over a removed entry still prints the state cross-check guidance', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('removed_from_merge_queue', 200)]],
			runs: [
				...completedRuns(99),
				{
					headBranch: 'gh-readonly-queue/main/pr-42-abc',
					status: 'in_progress',
				},
			],
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(0);
		expect(out[0]).toBe('BUILDING pr=42 age=200 state=OPEN');
		expect(out.some((line) => line.includes('plain re-enqueue'))).toBe(true);
	});

	test('FB-17: --threshold is honored (age inside a raised threshold reads IDLE)', () => {
		const { io, out } = fakeIo({ timeline: [[ev('auto_merge_enabled', 200)]] });
		const code = runCli(['--pr', '42', '--threshold', '300'], io);
		expect(code).toBe(0);
		expect(out[0]).toBe('IDLE pr=42 age=200 state=OPEN');
	});

	test('FB-17: strict argv — unit-suffixed threshold and garbage pr are usage errors', () => {
		const { io: io1, errors: e1 } = fakeIo({});
		expect(runCli(['--pr', '42', '--threshold', '150m'], io1)).toBe(1);
		expect(e1[0]).toContain('usage:');
		const { io: io2, errors: e2 } = fakeIo({});
		expect(runCli(['--pr', '42abc'], io2)).toBe(1);
		expect(e2[0]).toContain('usage:');
		const { io: io3, errors: e3 } = fakeIo({});
		expect(runCli(['--pr', '42', '--threshold', '0'], io3)).toBe(1);
		expect(e3[0]).toContain('usage:');
		const { io: io4, errors: e4 } = fakeIo({});
		expect(runCli(['--pr', '42', '--bogus'], io4)).toBe(1);
		expect(e4[0]).toContain('usage:');
	});

	test('FB-07: a thrown gh call fails closed (exit 1, gh call failed, no verdict)', () => {
		const { io, out, errors } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			timelineError: new Error('boom'),
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(1);
		expect(errors.some((line) => line.includes('gh call failed'))).toBe(true);
		expect(out.filter((line) => line.includes('pr=42'))).toEqual([]);
	});

	test('FB-07: main() propagates the usage-error exit code 1 through process.exitCode', () => {
		const previous = process.exitCode ?? 0;
		try {
			const { io } = fakeIo({});
			main(io, []);
			expect(process.exitCode).toBe(1);
		} finally {
			process.exitCode = previous;
		}
	});

	test('FB-05: main(io, argv) honors the injected clock (deterministic ORPHANED regardless of wall clock)', () => {
		const previous = process.exitCode ?? 0;
		try {
			// The fixture event is 200 minutes before the INJECTED now; a wall
			// clock far in the past would read IDLE if the injection leaked.
			const { io } = fakeIo({ timeline: [[ev('auto_merge_enabled', 200)]] });
			main(io, ['--pr', '42']);
			expect(process.exitCode).toBe(2);
		} finally {
			process.exitCode = previous;
		}
	});

	test('FB-20: control characters in the PR state cannot forge the verdict line', () => {
		const ESC = String.fromCharCode(27);
		const NL = String.fromCharCode(10);
		const { io, out } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			state: `OPEN${NL}forged: recovery${ESC}[31m`,
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(2);
		expect(out[0]).toBe(
			'ORPHANED pr=42 age=200 state=OPEN forged: recovery [31m',
		);
		for (const line of out) {
			for (let i = 0; i < line.length; i++) {
				const codeUnit = line.charCodeAt(i);
				expect(codeUnit).toBeGreaterThanOrEqual(32);
				expect(codeUnit).not.toBe(127);
			}
		}
	});
});
