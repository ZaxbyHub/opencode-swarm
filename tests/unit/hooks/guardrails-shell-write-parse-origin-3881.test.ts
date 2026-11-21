/**
 * Origin-aware write-detection denial wording at every gate and every explain
 * mirror (#3881 review F-001), plus the neutralizer review follow-ups:
 * F-002 (tab inside a neutralized body), F-003 (oversized-word budget on the
 * pre-neutralization text), scope_validate parity, and the Windows-grammar
 * shapes the neutralizer must leave alone (F-006).
 *
 * Only a genuine bash-parser exception may say "parse failure, not a policy
 * refusal"; a policy sentinel (ambient shell state, unsafe command text,
 * oversized word) and the wrapper-preprocessing bound (`failClosed`) must not.
 *
 * @jest-environment node
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	classifyWriteParseFailure,
	describeWriteParseFailure,
	detectPosixWrites,
	neutralizeQuotedHeredocBodies,
	WRITE_ANALYSIS_WORD_BUDGET,
	type WriteAnalysis,
} from '../../../src/hooks/shell-write-detect';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import {
	evaluateScopeValidate,
	ScopeValidationError,
} from '../../../src/tools/scope-validate';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-parse-origin-3881-');
mkdirSync(`${TEST_DIR}/notes`, { recursive: true });

const PARSE_FAILURE_PHRASE = 'parse failure, not a policy refusal';
const OVERSIZED_WORD = 'a'.repeat(WRITE_ANALYSIS_WORD_BUDGET + 1);

function defaultConfig(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function scopedCoder(sessionId: string): void {
	startAgentSession(sessionId, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionId,
		taskId: '1.1',
		files: ['notes/'],
		dispatchCallId: 'call-1',
	});
}

/** Run the real gate; return the thrown message, or null when it resolved. */
async function gateMessage(
	sessionId: string,
	command: string,
): Promise<string | null> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
	scopedCoder(sessionId);
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: sessionId, callID: 'c1' },
			{ args: { command } },
		);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** The firing-rule cell of an explain table (single-line cell). */
async function explainFiringRule(args: string[]): Promise<string> {
	const out = await handleGuardrailExplain(TEST_DIR, args);
	const line = out.split('\n').find((l) => l.startsWith('| Firing Rule'));
	// The shell-mode report renders "| Firing Rule | <rule> |".
	expect(line).toBeDefined();
	return line ?? '';
}

// Wrapper shapes whose ambient-state payload is only visible after the
// wrapper is unwrapped (gate 3 / explain's second parse branch).
const WRAPPED_AMBIENT = [
	"env -C notes bash -c 'BASH_ENV=startup.sh cat a.md'",
	"sudo -D notes sh -c 'BASH_ENV=startup.sh cat a.md'",
];

// Every denial the write gate itself can raise for these shapes. A resolved
// call, or a failure outside this set (e.g. the downstream sandbox wrapper on
// hosts that cannot wrap a multiline command, which runs AFTER the write
// gate), means the write gate admitted the command.
const WRITE_GATE_DENIAL =
	/failed to parse command|could not safely model|policy refusal|analysis budget|SCOPE_VIOLATION|AUTHORITY_ROOT_ESCAPE|WRITE BLOCKED/;

describe('origin-aware write-detection denial wording (#3881 F-001)', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
	});

	describe('shared classifier (one source of truth)', () => {
		const sentinel = (operator: string): Pick<WriteAnalysis, 'writes'> => ({
			writes: [{ category: 'interpreter_eval', operator, path: null }],
		});

		it('maps every policy sentinel to its own origin and everything else to parser', () => {
			expect(classifyWriteParseFailure(sentinel('oversized word'))).toBe(
				'oversized_word',
			);
			expect(
				classifyWriteParseFailure(
					sentinel('ambient shell-state key assignment'),
				),
			).toBe('ambient_state');
			expect(classifyWriteParseFailure(sentinel('unsafe command text'))).toBe(
				'unsafe_text',
			);
			expect(classifyWriteParseFailure({ writes: [] })).toBe('parser');
			expect(classifyWriteParseFailure(sentinel('>'))).toBe('parser');
		});

		it('classifies the real detector output for each sentinel command', () => {
			expect(
				classifyWriteParseFailure(
					detectPosixWrites('BASH_ENV=startup.sh cat notes/a.md'),
				),
			).toBe('ambient_state');
			expect(
				classifyWriteParseFailure(detectPosixWrites('cat\tnotes/a.md')),
			).toBe('unsafe_text');
			expect(
				classifyWriteParseFailure(detectPosixWrites(`cat ${OVERSIZED_WORD}`)),
			).toBe('oversized_word');
			const unclosed = detectPosixWrites("echo 'unclosed quote");
			expect(unclosed.parseError).toBe(true);
			expect(classifyWriteParseFailure(unclosed)).toBe('parser');
		});

		it('only the parser origin claims a parse failure', () => {
			expect(describeWriteParseFailure('parser').message).toContain(
				PARSE_FAILURE_PHRASE,
			);
			for (const origin of [
				'oversized_word',
				'ambient_state',
				'unsafe_text',
				'analysis_bound',
			] as const) {
				expect(describeWriteParseFailure(origin).message).not.toContain(
					'parse failure',
				);
			}
			expect(describeWriteParseFailure('analysis_bound').message).toContain(
				'could not safely model',
			);
		});
	});

	describe('gate wording (tool-before.ts)', () => {
		it('ambient shell-state key is a policy refusal', async () => {
			const msg = await gateMessage(
				'o3881-g1',
				'BASH_ENV=startup.sh cat notes/a.md',
			);
			expect(msg).toContain('ambient shell-state key');
			expect(msg).toContain('policy refusal');
			expect(msg).not.toContain('parse failure');
		}, 60_000);

		it('unsafe command text (tab after cat) is a policy refusal', async () => {
			const msg = await gateMessage('o3881-g2', 'cat\tnotes/a.md');
			expect(msg).toContain('command text is unsafe for shell analysis');
			expect(msg).toContain('policy refusal');
			expect(msg).not.toContain('parse failure');
		}, 60_000);

		it('oversized word keeps its dedicated budget message', async () => {
			const msg = await gateMessage('o3881-g3', `cat notes/${OVERSIZED_WORD}`);
			expect(msg).toContain(
				`over the ${WRITE_ANALYSIS_WORD_BUDGET}-character analysis budget`,
			);
			expect(msg).not.toContain('parse failure');
		}, 60_000);

		it('failClosed wrapper bounds read "could not safely model", not parse failure', async () => {
			for (const [i, command] of [
				"sudo -D '' cat notes/a.md",
				"env -C '' cat notes/a.md",
			].entries()) {
				const msg = await gateMessage(`o3881-g4-${i}`, command);
				expect(msg).toContain('could not safely model this command');
				expect(msg).not.toContain('parse failure');
			}
		}, 60_000);

		it('a policy sentinel exposed only by the wrapper unwrap (gate 3) is still a policy refusal', async () => {
			// The sentinel sits inside a quoted wrapper payload, so gate 1 does not
			// see it; it surfaces on the unwrapped analysis (gate 3).
			for (const [i, command] of WRAPPED_AMBIENT.entries()) {
				const msg = await gateMessage(`o3881-g3w-${i}`, command);
				expect(msg).toContain('policy refusal');
				expect(msg).not.toContain('parse failure');
			}
		}, 60_000);

		it('a genuine parser exception still says parse failure', async () => {
			const msg = await gateMessage('o3881-g5', "echo 'unclosed quote");
			expect(msg).toContain(
				`failed to parse command (${PARSE_FAILURE_PHRASE})`,
			);
		}, 60_000);
	});

	describe('explain mirrors (guardrail-explain-service.ts)', () => {
		it('ambient shell-state key: policy_refusal, never parse_error', async () => {
			const rule = await explainFiringRule([
				'BASH_ENV=startup.sh',
				'cat',
				'notes/a.md',
			]);
			expect(rule).toContain('policy_refusal:');
			expect(rule).toContain('ambient shell-state key');
			expect(rule).not.toContain('parse_error');
			expect(rule).not.toContain(PARSE_FAILURE_PHRASE);
		}, 60_000);

		it('unsafe command text: policy_refusal, never parse_error', async () => {
			const rule = await explainFiringRule(['cat\tnotes/a.md']);
			expect(rule).toContain('policy_refusal:');
			expect(rule).toContain('command text is unsafe for shell analysis');
			expect(rule).not.toContain('parse_error');
		}, 60_000);

		it('oversized word: dedicated budget label and message', async () => {
			const rule = await explainFiringRule(['cat', OVERSIZED_WORD]);
			expect(rule).toContain('analysis_budget:');
			expect(rule).toContain(
				`over the ${WRITE_ANALYSIS_WORD_BUDGET}-character analysis budget`,
			);
			expect(rule).not.toContain('parse_error');
		}, 60_000);

		it('failClosed wrapper bounds: analysis_bound, never parse_error', async () => {
			for (const args of [
				['sudo', '-D', "''", 'cat', 'notes/a.md'],
				['env', '-C', "''", 'cat', 'notes/a.md'],
			]) {
				const rule = await explainFiringRule(args);
				expect(rule).toContain('analysis_bound:');
				expect(rule).toContain('could not safely model this command');
				expect(rule).not.toContain('parse_error');
				expect(rule).not.toContain(PARSE_FAILURE_PHRASE);
			}
		}, 60_000);

		it('a policy sentinel exposed only by the wrapper unwrap: policy_refusal, never parse_error', async () => {
			for (const command of WRAPPED_AMBIENT) {
				const rule = await explainFiringRule([command]);
				expect(rule).toContain('policy_refusal:');
				expect(rule).not.toContain('parse_error');
				expect(rule).not.toContain('parse failure');
			}
		}, 60_000);

		it('a genuine parser exception is still parse_error', async () => {
			const rule = await explainFiringRule(['echo', "'unclosed"]);
			expect(rule).toContain('parse_error:');
			expect(rule).toContain(PARSE_FAILURE_PHRASE);
		}, 60_000);

		it('explain and the gate use the same sentence for every origin', async () => {
			const cases: Array<[string[], string, string]> = [
				[
					['BASH_ENV=startup.sh', 'cat', 'notes/a.md'],
					'BASH_ENV=startup.sh cat notes/a.md',
					describeWriteParseFailure('ambient_state').message,
				],
				[
					['cat', OVERSIZED_WORD],
					`cat ${OVERSIZED_WORD}`,
					describeWriteParseFailure('oversized_word').message,
				],
				[
					['sudo', '-D', "''", 'cat', 'notes/a.md'],
					"sudo -D '' cat notes/a.md",
					describeWriteParseFailure('analysis_bound').message,
				],
			];
			for (const [i, [args, command, message]] of cases.entries()) {
				expect(await explainFiringRule(args)).toContain(message);
				expect(await gateMessage(`o3881-parity-${i}`, command)).toContain(
					message,
				);
			}
		}, 60_000);
	});
});

describe('neutralizer review follow-ups (#3881 F-002, F-003, F-006)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('F-002: control characters inside a neutralized body', () => {
		it('a tab inside the inert body of a quoted heredoc is admitted by the write gate', async () => {
			for (const [i, command] of [
				"cat > notes/x.md <<-'EOF'\n\techo x\nEOF",
				"cat > notes/x.md <<'EOF'\nbody\twith a tab\nEOF",
			].entries()) {
				const msg = await gateMessage(`o3881-f2-body-${i}`, command);
				expect(msg === null || !WRITE_GATE_DENIAL.test(msg)).toBe(true);
			}
		}, 60_000);

		it('a tab-indented terminator line is still refused (unsafe command text)', async () => {
			const msg = await gateMessage(
				'o3881-f2-term',
				"cat > notes/x.md <<-'EOF'\nbody\n\tEOF",
			);
			expect(msg).toContain('command text is unsafe for shell analysis');
		}, 60_000);

		it('a tab-indented opener line is still refused (unsafe command text)', async () => {
			const msg = await gateMessage(
				'o3881-f2-open',
				"cat\t> notes/x.md <<'EOF'\nbody\nEOF",
			);
			expect(msg).toContain('command text is unsafe for shell analysis');
		}, 60_000);

		it('a tab in the body does not widen scope: an out-of-scope target is still denied', async () => {
			const msg = await gateMessage(
				'o3881-f2-escape',
				"cat > ../outside/esc.md <<-'EOF'\n\techo x\nEOF",
			);
			expect(msg).toMatch(/SCOPE_VIOLATION|AUTHORITY_ROOT_ESCAPE/);
		}, 60_000);
	});

	describe('F-003: oversized-word budget sees the pre-neutralization text', () => {
		const oversizedBody = `cat > notes/x.md <<'EOF'\n${OVERSIZED_WORD}\nEOF`;

		it('an oversized single-word body is not neutralized', () => {
			expect(neutralizeQuotedHeredocBodies(oversizedBody)).toBe(oversizedBody);
		});

		it('an at-budget word body is still neutralized (control)', () => {
			const atBudget = `cat > notes/x.md <<'EOF'\n${'a'.repeat(WRITE_ANALYSIS_WORD_BUDGET)}\nEOF`;
			expect(neutralizeQuotedHeredocBodies(atBudget)).not.toBe(atBudget);
		});

		it('the detector reports the oversized-word sentinel exactly as before neutralization existed', () => {
			const analysis = detectPosixWrites(
				neutralizeQuotedHeredocBodies(oversizedBody),
			);
			expect(analysis.parseError).toBe(true);
			expect(classifyWriteParseFailure(analysis)).toBe('oversized_word');
		});

		it('the write gate denies it with the dedicated budget message', async () => {
			const msg = await gateMessage('o3881-f3', oversizedBody);
			expect(msg).toContain(
				`over the ${WRITE_ANALYSIS_WORD_BUDGET}-character analysis budget`,
			);
		}, 60_000);
	});

	describe('scope_validate parity (neutralization is threaded)', () => {
		const parensBody = "cat > notes/x.md <<'EOF'\nbody (with parens)\nEOF";

		it('the raw command would be a parse failure (control: neutralization is what changes it)', () => {
			expect(detectPosixWrites(parensBody).parseError).toBe(true);
		});

		it('a dense quoted heredoc is analysed, not rejected as UNPARSEABLE_COMMAND', () => {
			let code: string | null = null;
			try {
				evaluateScopeValidate(
					{
						command: parensBody,
						shell: 'posix',
						scope_files: ['notes/x.md'],
					},
					TEST_DIR,
				);
			} catch (err) {
				expect(err).toBeInstanceOf(ScopeValidationError);
				code = (err as ScopeValidationError).code;
			}
			// Pre-existing, documented bound: scope_validate cannot resolve the
			// heredoc marker target (UNRESOLVED_TARGET). The point here is that
			// the body no longer surfaces as a parse failure.
			expect(code).toBe('UNRESOLVED_TARGET');
		});
	});

	describe('F-006: Windows-grammar shapes are not neutralized', () => {
		// The neutralizer is shell-agnostic and unconditional, so the Windows
		// detectors must never be handed a blanked body for a Windows-shaped
		// command. These shapes carry no POSIX `cat <<'EOF'` opener and must
		// come back byte-identical. (No real cmd.exe / PowerShell run is
		// performed here; the claim is limited to the neutralizer's grammar.)
		it('PowerShell here-strings, cmd redirects, and wrapped cat heredocs are returned unchanged', () => {
			const shapes = [
				"Set-Content -Path notes\\x.md -Value @'\nbody (parens) 'quotes' ..\\..\\escape.md\n'@",
				'cmd /c "type nul > notes\\x.md"\nrem body (parens)\nrem ..\\..\\escape.md',
				'powershell -Command "cat <<\'EOF\' > notes\\x.md\nbody ..\\..\\escape.md\nEOF"',
			];
			for (const command of shapes) {
				expect(neutralizeQuotedHeredocBodies(command)).toBe(command);
			}
		});
	});
});
