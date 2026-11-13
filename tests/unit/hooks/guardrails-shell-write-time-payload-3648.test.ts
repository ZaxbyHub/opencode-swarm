/**
 * #3648 item 7 (D7 / frozen check C09): GNU `time -o FILE` must not mask the
 * timed payload — the `-o` target write is emitted AND the plain timed
 * command is analyzed as its own leaf (an in-scope `-o` decoy no longer
 * hides the payload's escaping write). The bare bash-keyword `time` never
 * applies the binary `-o` grammar (the nest-3588 and brace-sites pins stay
 * admitted), `time -o FILE` with no payload usage-errors before opening
 * (A5e), and the cd-carrying `time -o` write keeps its tracked-landing
 * resolution through the preprocessing rewrite (detector + resolver proofs).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { dcPreprocessWrappers } from '../../../src/hooks/guardrails/destructive-command';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState } from '../../../src/state';
import { gate, makeWorkspace, teardown } from './_shell-write-3616-fixtures';

const T = 60_000;

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D7: time -o does not mask the timed payload', () => {
	test(
		'time -o src/t.txt sh -c "echo x > ../y.txt" is denied (C09 RED leg)',
		async () => {
			const r = await gate('time -o src/t.txt sh -c "echo x > ../y.txt"');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/y\.txt/);
		},
		T,
	);

	test(
		'time -osrc/t.txt glued spelling is denied too',
		async () => {
			const r = await gate('time -osrc/t.txt sh -c "echo x > ../y.txt"');
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/y\.txt/);
		},
		T,
	);

	test(
		'time -o ../secret stays admitted (A5e: GNU time usage-errors before opening)',
		async () => {
			const r = await gate('time -o ../secret');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'time -o x true stays admitted (nest-3588 pin: bare keyword never emits -o)',
		async () => {
			const r = await gate('time -o x true');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'time -osrc/{a,../esc} true stays admitted (brace-sites pin: bare keyword never emits -o)',
		async () => {
			const r = await gate('time -osrc/{a,../esc} true');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'time make build stays admitted',
		async () => {
			const r = await gate('time make build');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'time sh -c echo hi stays admitted (no-write payload)',
		async () => {
			const r = await gate("time sh -c 'echo hi'");
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'time sh -c with an escaping write is denied (no -o masking sibling)',
		async () => {
			const r = await gate("time sh -c 'echo x > ../y.txt'");
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});

describe('#3648 D7 launcher spellings of time -o', () => {
	test(
		'cd src && /usr/bin/time -o ok.txt true stays admitted (N-02 absolute)',
		async () => {
			const r = await gate('cd src && /usr/bin/time -o ok.txt true');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		"cd src && 'time' -o ok.txt true stays admitted (N-02 quoted)",
		async () => {
			const r = await gate("cd src && 'time' -o ok.txt true");
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'cd src && /usr/bin/time -o ok.txt sh -c escaping write is denied',
		async () => {
			const r = await gate(
				"cd src && /usr/bin/time -o ok.txt sh -c 'echo x > ../esc'",
			);
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'/usr/bin/time -o ../secret echo hi is denied (A5d preserving leg)',
		async () => {
			const r = await gate('/usr/bin/time -o ../secret echo hi');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});

describe('#3648 D7 detector/resolver proofs: the first-leaf emission survives the rewrite', () => {
	test(
		'detector: dcPreprocessWrappers keeps a time -o write on the rewritten command',
		() => {
			const pre = dcPreprocessWrappers(
				'cd src && /usr/bin/time -o ok.txt true',
			) as { changed: boolean; command: string };
			expect(pre.changed).toBe(true);
			const analysis = detectPosixWrites(pre.command);
			const timeWrite = analysis.writes.find((w) => w.operator === 'time -o');
			expect(timeWrite).toBeDefined();
			expect(timeWrite?.path).toBe('ok.txt');
		},
		T,
	);

	test(
		'resolver: the time -o write resolves under the tracked cd landing',
		() => {
			const ws = makeWorkspace();
			try {
				const pre = dcPreprocessWrappers(
					'cd src && /usr/bin/time -o ok.txt true',
				) as { command: string };
				const analysis = detectPosixWrites(pre.command);
				const resolved = resolveWriteTargets(pre.command, analysis.writes, ws);
				const timeResolved = resolved.filter(
					(r) => r.original.operator === 'time -o' && r.resolvedPath !== null,
				);
				expect(timeResolved.length).toBeGreaterThan(0);
				// The cd-ambiguous pessimistic map emits BOTH landings; the
				// tracked one ends with the path separator + src/ok.txt.
				expect(
					timeResolved.some((r) =>
						/[\\/]src[\\/]ok\.txt$/.test(r.resolvedPath as string),
					),
				).toBe(true);
			} finally {
				teardown(ws);
			}
		},
		T,
	);
});
