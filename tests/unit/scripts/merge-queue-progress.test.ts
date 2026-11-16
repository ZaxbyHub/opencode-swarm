import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
	classify,
	entryMatchesModuleUrl,
	exitCodeFor,
	invokedAsMain,
	main,
	runCli,
} from '../../../scripts/check-merge-queue-progress.mjs';

/*
 * Merge-queue entry progress detector contract (issue #3265). The frozen
 * acceptance filters (C1/C2) select the `orphan-verdict` and
 * `building-verdict` describe blocks, so their test names must keep those
 * substrings. All fixtures are pure in-memory payloads derived from the
 * field evidence recorded on the issue; no network, no filesystem.
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

describe('orphan-verdict (C1, issue #3265 AC1)', () => {
	test('entry accepted 200 minutes ago, no queue build in the 100-run window → ORPHANED', () => {
		const result = classify(
			[ev('auto_merge_enabled', 200), ev('added_to_merge_queue', 201)],
			completedRuns(100),
			{ now: NOW, pr: 42 },
		);
		expect(result.verdict).toBe('ORPHANED');
		expect(result.ageMinutes).toBe(200);
		expect(result.lastEvent).toBe('auto_merge_enabled');
		expect(exitCodeFor(result.verdict)).toBe(2);
	});

	test('boundary: age exactly at the 150-minute threshold stays IDLE (strictly-greater rule)', () => {
		const result = classify(
			[ev('auto_merge_enabled', 150)],
			completedRuns(100),
			{ now: NOW, pr: 42 },
		);
		expect(result.verdict).toBe('IDLE');
		expect(exitCodeFor(result.verdict)).toBe(0);
	});

	test('age below the threshold stays IDLE', () => {
		const result = classify(
			[ev('added_to_merge_queue', 149)],
			completedRuns(100),
			{ now: NOW, pr: 42 },
		);
		expect(result.verdict).toBe('IDLE');
	});

	test('CLI prints the exact ORPHANED verdict line, recovery line, and exits 2', () => {
		const { io, out, errors } = fakeIo({
			timeline: [
				[
					{
						event: 'cross_referenced',
						created_at: new Date(NOW - 300 * 60_000).toISOString(),
					},
				],
				[ev('auto_merge_enabled', 200)],
			],
			state: 'OPEN',
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(2);
		expect(errors).toEqual([]);
		expect(out[0]).toBe('ORPHANED pr=42 age=200 state=OPEN');
		expect(
			out.some((line) =>
				line.includes(
					'gh pr close 42 --comment "orphaned queue entry" && gh pr reopen 42 && gh pr merge 42',
				),
			),
		).toBe(true);
		expect(out.some((line) => line.includes('PREDATE the current entry'))).toBe(
			true,
		);
	});

	test('CLI timeline fetch uses --paginate --slurp and flattens pages (newest event on page 2 wins)', () => {
		const { io, calls, out } = fakeIo({
			timeline: [
				[ev('added_to_merge_queue', 400)],
				[ev('auto_merge_enabled', 200)],
			],
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(2);
		const timelineCall = calls.find((args) => args[0] === 'api');
		expect(timelineCall).toBeDefined();
		expect(timelineCall?.includes('--paginate')).toBe(true);
		expect(timelineCall?.includes('--slurp')).toBe(true);
		expect(timelineCall?.join(' ')).toContain(
			'repos/ZaxbyHub/opencode-swarm/issues/42/timeline',
		);
		// age=200 (the page-2 event), not 400 — a page-blind parse would mis-age it.
		expect(out[0]).toBe('ORPHANED pr=42 age=200 state=OPEN');
	});

	test('CLI refuses to classify on a malformed (non-slurped-array) timeline payload', () => {
		const { io, out, errors } = fakeIo({ timeline: { not: 'an array' } });
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(1);
		expect(errors.some((line) => line.includes('refusing to classify'))).toBe(
			true,
		);
		expect(out.filter((line) => line.includes('pr=42'))).toEqual([]);
	});

	test('CLI without --pr is a usage error (exit 1)', () => {
		const { io, errors } = fakeIo({});
		const code = runCli([], io);
		expect(code).toBe(1);
		expect(errors[0]).toContain('usage:');
	});

	test('main(io, argv) propagates the ORPHANED exit code through process.exitCode', () => {
		const previous = process.exitCode ?? 0;
		try {
			const { io } = fakeIo({ timeline: [[ev('auto_merge_enabled', 200)]] });
			main(io, ['--pr', '42']);
			expect(process.exitCode).toBe(2);
		} finally {
			process.exitCode = previous;
		}
	});
});

describe('building-verdict (C2, issue #3265 AC2)', () => {
	test('stale entry age but one in_progress queue build → BUILDING, exit 0', () => {
		const runs = [
			...completedRuns(99),
			{
				headBranch: 'gh-readonly-queue/main/pr-42-abc123',
				status: 'in_progress',
			},
		];
		const result = classify([ev('auto_merge_enabled', 200)], runs, {
			now: NOW,
			pr: 42,
		});
		expect(result.verdict).toBe('BUILDING');
		expect(result.ageMinutes).toBe(200);
		expect(exitCodeFor(result.verdict)).toBe(0);
	});

	test('an in_progress queue build for a DIFFERENT pr does not count (pr-scoped prefix)', () => {
		const runs = [
			...completedRuns(99),
			{
				headBranch: 'gh-readonly-queue/main/pr-43-abc123',
				status: 'in_progress',
			},
		];
		const result = classify([ev('auto_merge_enabled', 200)], runs, {
			now: NOW,
			pr: 42,
		});
		expect(result.verdict).toBe('ORPHANED');
	});

	test('CLI prints the exact BUILDING verdict line and never the recovery line', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('auto_merge_enabled', 200)]],
			runs: [
				...completedRuns(99),
				{
					headBranch: 'gh-readonly-queue/main/pr-42-abc123',
					status: 'in_progress',
				},
			],
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(0);
		expect(out[0]).toBe('BUILDING pr=42 age=200 state=OPEN');
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
	});

	test('main(io, argv) propagates the BUILDING exit code 0 through process.exitCode', () => {
		const previous = process.exitCode ?? 0;
		process.exitCode = 2;
		try {
			const { io } = fakeIo({
				timeline: [[ev('auto_merge_enabled', 200)]],
				runs: [
					...completedRuns(99),
					{
						headBranch: 'gh-readonly-queue/main/pr-42-abc123',
						status: 'in_progress',
					},
				],
			});
			main(io, ['--pr', '42']);
			expect(process.exitCode).toBe(0);
		} finally {
			process.exitCode = previous;
		}
	});
});

describe('verdict-coverage guardrails (issue #3265 design constraints)', () => {
	test('removed_from_merge_queue is UNKNOWN — never a power-cycle recommendation', () => {
		const result = classify(
			[ev('removed_from_merge_queue', 200)],
			completedRuns(100),
			{
				now: NOW,
				pr: 42,
			},
		);
		expect(result.verdict).toBe('UNKNOWN');
		expect(exitCodeFor(result.verdict)).toBe(0);
	});

	test('no queue events at all → UNKNOWN with null age', () => {
		const result = classify(
			[{ event: 'cross_referenced', created_at: new Date(NOW).toISOString() }],
			[],
			{
				now: NOW,
				pr: 42,
			},
		);
		expect(result.verdict).toBe('UNKNOWN');
		expect(result.ageMinutes).toBeNull();
	});

	test('CLI: removed entry + MERGED pr → consumed-by-merge note, no recovery line', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('removed_from_merge_queue', 200)]],
			state: 'MERGED',
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(0);
		expect(out.some((line) => line.includes('consumed by merge'))).toBe(true);
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
	});

	test('CLI: removed entry + OPEN pr → eviction guidance, never the power-cycle', () => {
		const { io, out } = fakeIo({
			timeline: [[ev('removed_from_merge_queue', 200)]],
			state: 'OPEN',
		});
		const code = runCli(['--pr', '42'], io);
		expect(code).toBe(0);
		expect(out.some((line) => line.includes('plain re-enqueue'))).toBe(true);
		expect(out.some((line) => line.includes('gh pr close'))).toBe(false);
	});

	test('entry guard: Node fallback compares the resolved entry URL against the module URL (win32 case-insensitive)', () => {
		const scriptUrl = new URL(
			'../../../scripts/check-merge-queue-progress.mjs',
			import.meta.url,
		).href;
		const scriptPath = fileURLToPath(scriptUrl);
		// Absolute Windows paths and POSIX forms alike resolve to the module URL.
		expect(entryMatchesModuleUrl(scriptPath, scriptUrl)).toBe(true);
		expect(
			entryMatchesModuleUrl('definitely-not-this-file.ts', scriptUrl),
		).toBe(false);
		// Under Bun the boolean import.meta.main branch decides; imported (not
		// run as main) in this process, the guard itself reads false.
		expect(invokedAsMain()).toBe(false);
	});
});
