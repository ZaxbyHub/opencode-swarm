/**
 * #3689 swarm-pr-review feedback round (PR #3689 breadth review: 5 CONFIRMED
 * HIGH fail-opens inside the claimed-closed families + 1 introduced perf
 * regression + message/redaction accuracy). One row per reviewer/critic-
 * verified finding (FB ids from .zcode/session/tasks/pr3689-feedback/
 * fb-ledger.md). Gate-level probes through the real
 * createGuardrailsHooks().toolBefore harness (the sanctioned #3495/#3551
 * pattern) plus direct extractor assertions where the arm under test is
 * otherwise masked by a redundant sibling (FB-007).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { dcExtractRecursiveRmTargets } from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;

afterEach(() => {
	resetSwarmState();
});

describe('FB-001: glued/standalone opener strip reaches the launcher-uncertainty channel', () => {
	// The strip mutated the caller's own array, so the caller's "did
	// anything change?" comparison always saw the un-stripped head and
	// `(sudo -i)`/`((sudo -i))` were ADMITTED while `( sudo -i )` denied.
	test(
		'(sudo -i) is denied (glued paren opener, argument-free login shell)',
		async () => {
			expect((await gate('(sudo -i)')).verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'((sudo -i)) is denied (doubled glued opener)',
		async () => {
			expect((await gate('((sudo -i))')).verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		"echo 'rm -rf ../x' | (sudo -i) is denied (stdin-fed root shell)",
		async () => {
			expect((await gate("echo 'rm -rf ../x' | (sudo -i)")).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		'{sudo -i;} is denied (glued brace opener)',
		async () => {
			expect((await gate('{sudo -i;}')).verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'( (sudo -i) ) is denied (standalone wrapping glued — closeout critic finding #1: the first closer-trim iteration regressed this intake-BLOCKED shape)',
		async () => {
			expect((await gate('( (sudo -i) )')).verdict).toBe('BLOCKED');
			expect((await gate('( (sudo -s) )')).verdict).toBe('BLOCKED');
			expect((await gate('{ (sudo -i); }')).verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'(echo hi) stays admitted (opener strip must not over-deny innocuous groups)',
		async () => {
			expect((await gate('(echo hi)')).verdict).toBe('ADMITTED');
			expect((await gate('(( echo hi ))')).verdict).toBe('ADMITTED');
		},
		T,
	);
});

describe('FB-002/008/009: time peel is iterative, bounded, and consumes nice/env heads', () => {
	test(
		'nice -n 5 time -o src/t.txt sh -c "rm -rf ../outside" is denied (nice value advance)',
		async () => {
			expect(
				(
					await gate('nice -n 5 time -o src/t.txt sh -c "rm -rf ../outside"', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'nice -n5 time -o src/t.txt sh -c "rm -rf ../outside" is denied (glued -nN)',
		async () => {
			expect(
				(
					await gate('nice -n5 time -o src/t.txt sh -c "rm -rf ../outside"', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	// Stage-B reviewer round 2 executed probes: both were ADMITTED until the
	// nice branch handled the glued long form and the negative detached
	// adjustment.
	test(
		'nice --adjustment=5 time -o src/t.txt sh -c "rm -rf ../outside" is denied (glued long form)',
		async () => {
			expect(
				(
					await gate(
						'nice --adjustment=5 time -o src/t.txt sh -c "rm -rf ../outside"',
						{ blockDestructive: true },
					)
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'nice -n -5 time -o src/t.txt sh -c "rm -rf ../outside" is denied (negative detached adjustment)',
		async () => {
			expect(
				(
					await gate('nice -n -5 time -o src/t.txt sh -c "rm -rf ../outside"', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'env time -o src/t.txt rm -rf ../outside is denied (env head peeled)',
		async () => {
			expect(
				(
					await gate('env time -o src/t.txt rm -rf ../outside', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'env FOO=1 time -o src/t.txt sh -c "rm -rf ../outside" is denied (assignments peeled too)',
		async () => {
			expect(
				(
					await gate('env FOO=1 time -o src/t.txt sh -c "rm -rf ../outside"', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'8-deep command chain + time -o + sh -c recursive rm is denied (shared bound 64, not 8)',
		async () => {
			const cmd = `${'command '.repeat(8)}time -o src/t.txt sh -c "rm -rf ../outside"`;
			expect((await gate(cmd, { blockDestructive: true })).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		'a 400-deep time chain extracts fail-closed in bounded time (iterative peel, no O(n^2) recursion)',
		() => {
			const chain: string[] = [];
			for (let i = 0; i < 400; i += 1) chain.push(`time -o o${i}`);
			chain.push('rm -rf x');
			const start = performance.now();
			const out = dcExtractRecursiveRmTargets(chain.join(' '));
			const ms = performance.now() - start;
			// Pre-fix this input class measured 4x cost per doubling (~40 ms at
			// 400, 13.9 s at 111 KB). The iterative peel keeps any bound-hitting
			// chain at a single pass + one fail-closed refusal.
			expect(ms).toBeLessThan(1000);
			expect(out).toEqual(['__swarm_brace_refusal__/time-masked rm']);
		},
		T,
	);
});

describe('FB-003/004/010: xargs verb position is classified, not literal-membership only', () => {
	test(
		'(sudo xargs cp /dev/null ../esc) is denied (wrapper-consumed anchoring)',
		async () => {
			expect((await gate('(sudo xargs cp /dev/null ../esc)')).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		'{ sudo xargs cp /dev/null ../esc; } is denied (brace-wrapped)',
		async () => {
			expect((await gate('{ sudo xargs cp /dev/null ../esc; }')).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		'(nice xargs cp /dev/null ../esc) is denied (launcher-wrapped)',
		async () => {
			expect((await gate('(nice xargs cp /dev/null ../esc)')).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		`xargs sh -c 'rm -rf ../secret' is denied (shell verb withdraws)`,
		async () => {
			expect(
				(
					await gate("xargs sh -c 'rm -rf ../secret'", {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'xargs python3 -c open(../secret,w) is denied (interpreter verb withdraws)',
		async () => {
			expect(
				(await gate(`xargs python3 -c 'open("../secret","w")'`)).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		`echo x | xargs awk 'BEGIN{print > "../secret"}' is denied (awk verb reaches eval classification)`,
		async () => {
			expect(
				(await gate(`echo x | xargs awk 'BEGIN{print > "../secret"}'`)).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'xargs env rm -rf ../secret is denied (launcher verb withdraws)',
		async () => {
			expect(
				(
					await gate('xargs env rm -rf ../secret', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'xargs xargs rm -rf ../secret is denied (nested xargs withdraws)',
		async () => {
			expect(
				(
					await gate('xargs xargs rm -rf ../secret', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'xargs "$CMD" rm -rf ../secret is denied (expansion-bearing verb withdraws)',
		async () => {
			expect(
				(
					await gate('xargs "$CMD" rm -rf ../secret', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'xargs ${CMD} rm -rf ../secret is denied (braced expansion verb)',
		async () => {
			expect(
				(
					await gate('xargs ${CMD} rm -rf ../secret', {
						blockDestructive: true,
					})
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'echo x | xargs grep pattern file stays admitted (benign verb control)',
		async () => {
			expect((await gate('echo x | xargs grep pattern file')).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
});

describe('FB-005/018/019: awk family uniformity with the external-effect gate on -i inplace', () => {
	test(
		`awk -i inplace '{print > "../secret"}' src/x.txt is denied (in-place does not disable print >)`,
		async () => {
			expect(
				(await gate(`awk -i inplace '{print > "../secret"}' src/x.txt`))
					.verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		`awk -i inplace 'BEGIN{system("rm -rf ../secret")}' src/x.txt is denied`,
		async () => {
			expect(
				(
					await gate(
						`awk -i inplace 'BEGIN{system("rm -rf ../secret")}' src/x.txt`,
						{ blockDestructive: true },
					)
				).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		`awk -i inplace '{print $1 < "src/in.txt"}' src/x.txt is denied (getline input)`,
		async () => {
			expect(
				(await gate(`awk -i inplace '{print $1 < "src/in.txt"}' src/x.txt`))
					.verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		"awk -i inplace '{print}' src/x.txt stays admitted (clean program — carve-out intact)",
		async () => {
			expect((await gate("awk -i inplace '{print}' src/x.txt")).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	test(
		"gawk -i inplace '{print}' src/x.txt stays admitted (FB-018: family shares the awk in-place model)",
		async () => {
			expect((await gate("gawk -i inplace '{print}' src/x.txt")).verdict).toBe(
				'ADMITTED',
			);
		},
		T,
	);
	test(
		`gawk -i inplace '{print > "../secret"}' src/x.txt is denied (FB-018 must not re-open FB-005)`,
		async () => {
			expect(
				(await gate(`gawk -i inplace '{print > "../secret"}' src/x.txt`))
					.verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		`nawk 'BEGIN{print > "../secret"}' is denied (FB-019: BSD/macOS awk joins the eval family)`,
		async () => {
			expect((await gate(`nawk 'BEGIN{print > "../secret"}'`)).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
	test(
		`original-awk 'BEGIN{print > "../secret"}' is denied (FB-019: BWK awk)`,
		async () => {
			expect(
				(await gate(`original-awk 'BEGIN{print > "../secret"}'`)).verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'gtime rm -rf ../secret is denied under blockDestructive (FB-019: Homebrew GNU time peels)',
		async () => {
			expect(
				(await gate('gtime rm -rf ../secret', { blockDestructive: true }))
					.verdict,
			).toBe('BLOCKED');
		},
		T,
	);
	test(
		'gtime sh -c "echo x > ../y.txt" is denied (FB-019: write payload under gtime analyzed)',
		async () => {
			expect((await gate('gtime sh -c "echo x > ../y.txt"')).verdict).toBe(
				'BLOCKED',
			);
		},
		T,
	);
});

describe('FB-007: the destructive-side xargs arm is independently pinned (not just verdict-masked)', () => {
	test(
		'dcExtractRecursiveRmTargets attributes xargs-fed rm to the destructive arm directly',
		() => {
			// Verdict-only gate legs cannot see this arm die (the write-side arm
			// denies the same command with its own message — verified by the
			// reviewer's mutant: disabling THIS arm left every gate suite
			// green). Direct extractor assertion kills that mutant.
			expect(dcExtractRecursiveRmTargets('xargs rm -rf ../x')).toEqual([
				'__swarm_brace_refusal__/xargs-fed rm',
			]);
			expect(dcExtractRecursiveRmTargets('xargs -n 2 rm -rf ../x')).toEqual([
				'__swarm_brace_refusal__/xargs-fed rm',
			]);
		},
		T,
	);
});
