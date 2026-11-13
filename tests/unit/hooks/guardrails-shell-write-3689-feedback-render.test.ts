/**
 * #3689 swarm-pr-review feedback round — message/rendering sibling of
 * guardrails-shell-write-3689-feedback-hardening.test.ts (FR-006 500-line
 * cap split; the FB-016 refusal-reason and FB-017 redaction describes were
 * moved here unchanged).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { dcEvaluateRecursiveDeleteTargets } from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;

afterEach(() => {
	resetSwarmState();
});

describe('FB-016: refusal reasons name the actual unknowable composition', () => {
	test(
		'xargs-fed non-recursive delete denies with the xargs reason, not the brace text',
		async () => {
			const r = await gate('xargs rm file.txt', { blockDestructive: true });
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('stdin-supplied operands under xargs');
			expect(r.message).not.toContain('brace expansion');
		},
		T,
	);
	test(
		'time-masked delete denies with the time-wrapper reason, not the brace text',
		async () => {
			const r = await gate('time -Z rm -rf ../y', {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toContain('masked behind a time wrapper');
			expect(r.message).not.toContain('brace expansion');
		},
		T,
	);
	test(
		'the genuine brace refusal keeps the byte-identical brace wording at the evaluator (consumer pins)',
		() => {
			// Evaluator-level control: the only brace-family marker producer
			// (dynamic brace content at the extractor) feeds targets whose
			// $-bearing token is intercepted by the gate's unexpanded-variable
			// check BEFORE reaching dcEvaluateRecursiveDeleteTargets, so the
			// brace wording is asserted where it is produced. Existing
			// consumers (3569/3591/3616 brace pins) rely on this text staying
			// byte-identical for non-xargs/non-time markers.
			const decision = dcEvaluateRecursiveDeleteTargets({
				targets: ['__swarm_brace_refusal__/{a..c}/node_modules'],
				cwd: process.cwd(),
			});
			expect(decision.allowed).toBe(false);
			expect(decision.code).toBe('DESTRUCTIVE_TARGET_INVALID');
			expect(decision.reason).toContain('unresolvable brace expansion');
		},
		T,
	);
});

describe('FB-017: dynamic-source denial text redacts the home profile', () => {
	test(
		'a path-qualified xargs verb never renders the raw profile path in the denial',
		async () => {
			// Closeout critic (finding #3): built from os.homedir() this leg
			// was NOT hermetic — a root-run self-hosted merge-queue runner has
			// home /root, which redactPath does not fold (only lexical
			// /home/<u>, /Users/<u> and Windows-profile shapes are profile
			// forms; deny-render-3616.test.ts:245-248 states the same). A
			// SYNTHETIC profile-shape path makes the fold (and its absence)
			// deterministic on every runner.
			const syntheticUser = 'sw3689user';
			// FORWARD-slash profile spellings: redactPath recognizes the
			// Windows-profile, macOS /Users and Linux /home LEXICAL shapes,
			// and a backslash verb token breaks the shell tokenizer
			// (basenameAnySep could not extract `cp`, admitting the command).
			// The absolute-shape regex in tool-before.ts accepts
			// `[A-Za-z]:[\\/]`, so `C:/...` still routes through redactPath.
			const profileHome =
				process.platform === 'win32'
					? `C:/Users/${syntheticUser}`
					: process.platform === 'darwin'
						? `/Users/${syntheticUser}`
						: `/home/${syntheticUser}`;
			const verbPath = `${profileHome}/bin/cp`;
			const r = await gate(`echo x | xargs ${verbPath}`, {
				blockDestructive: true,
			});
			expect(r.verdict).toBe('BLOCKED');
			// Pre-fix this rendered the literal profile path; the sibling
			// SCOPE_VIOLATION sink folds via redactPath — this sink now uses
			// the same idiom (absolute-shape conditional).
			expect(r.message).not.toContain(syntheticUser);
			expect(r.message).toContain('~');
		},
		T,
	);
});
