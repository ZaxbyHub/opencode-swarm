/**
 * #3343 wrapper-chain and env-flag-argument spellings — the final-critic
 * round-1 Critical legs. The frozen spelling suite (3343) pins the plain
 * prefix shapes; this post-freeze sibling pins the two real evasion defects
 * the critic executed against the pre-fix normalizer:
 * - arg-taking env flags (`env -u FOO python -c …`): the flag's ARGUMENT
 *   must never be mistaken for the interpreter;
 * - wrapper chains (`command env python -c …`, `exec env python3.11 -c …`):
 *   the scan cursor must advance through every hop.
 * RED at the pre-fix-critic head, GREEN after the cursor rewrite.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

const EVAL_PAYLOAD = "-c \"open('f','w').write('x')\"";

function expectEvalDetected(command: string): void {
	const analysis = detectPosixWrites(command);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`${command} must classify as interpreter_eval`,
	).toBe(true);
}

describe('interpreter env-flag arguments and wrapper chains (#3343)', () => {
	it('detects env flags that take a separate argument', () => {
		expectEvalDetected(`env -u FOO python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -i -u HOME python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -C /tmp python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -S "-i" python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --split-string "-i" python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --unset FOO python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --chdir /tmp python ${EVAL_PAYLOAD}`);
		// final-critic r3: the argv[0]-override family and --env0-from
		// (GNU coreutils 9.1+; the host's own env may predate them, the
		// remote executors' will not).
		expectEvalDetected(`env -a prog python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --argv0 prog python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --env0-from FILE python ${EVAL_PAYLOAD}`);
	});

	it('canonicalizes GNU getopt spellings: unambiguous long abbreviations and short clusters (final-critic r4/r5)', () => {
		expectEvalDetected(`env --un FOO python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --ch /tmp python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env --arg prog python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -iu FOO python ${EVAL_PAYLOAD}`);
		// r5: single-char long abbreviations are valid getopt spellings.
		expectEvalDetected(`env --u FOO python ${EVAL_PAYLOAD}`);
		// r5: a mid-cluster arg-taking member swallows the REST of the token
		// as its attached argument (`-uu` = `-u u`) — the token consumes NO
		// next word, so `python` must remain the interpreter word.
		expectEvalDetected(`env -uu python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -iuu python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -uU python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -Cu python ${EVAL_PAYLOAD}`);
		// r6: BSD/macOS env's required-arg -P altpath (inventory gap, not a
		// getopt-spelling gap — GNU env rejects -P, macOS/BSD execute it).
		expectEvalDetected(`env -P /usr/bin python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env -iP /bin python ${EVAL_PAYLOAD}`);
	});

	it('detects wrapper chains (the cursor advances past every hop)', () => {
		expectEvalDetected(`command env python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`env env python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`exec env python3.11 ${EVAL_PAYLOAD}`);
		expectEvalDetected(`command -p env python ${EVAL_PAYLOAD}`);
	});

	it('consumes exec -a NAME (argv[0] override) with its argument', () => {
		expectEvalDetected(`exec -a myname python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`exec -a myname python3.11 ${EVAL_PAYLOAD}`);
	});

	it('detects wrapper chains of unbounded depth (no hop cap)', () => {
		const deep = [
			'command',
			'command',
			'command',
			'command',
			'command',
			'command',
			'command',
		].join(' ');
		expectEvalDetected(`${deep} python ${EVAL_PAYLOAD}`);
		expectEvalDetected(`${deep} env -u FOO python3.11 ${EVAL_PAYLOAD}`);
	});

	it('still leaves non-eval wrapper chains unclassified', () => {
		for (const command of [
			'env -u FOO python3.11 --version',
			'command env python3.11 -m pytest',
			'env -i VAR=1 python3.11 script.py',
		]) {
			const analysis = detectPosixWrites(command);
			expect(
				analysis.writes.some((w) => w.category === 'interpreter_eval'),
				`${command} must NOT classify as interpreter_eval`,
			).toBe(false);
		}
	});
});

describe('gate-level env-flag eval rejection (#3343 end-to-end)', () => {
	const TEST_DIR_G = canonicalMkdtemp('guardrails-env-flags-gate-');

	beforeEach(() => {
		resetSwarmState();
	});

	afterAll(() => {
		rmSync(TEST_DIR_G, { recursive: true, force: true });
	});

	// The gate unwraps env wrappers (dcUnwrapWrappers → destructive-command's
	// env strip) and evaluates the UNWRAPPED command; before the strip
	// learned to consume env's own flags, `env -u FOO python -c …` unwrapped
	// to `-u FOO python -c …` (no writes) and was ADMITTED for an
	// out-of-scope coder (impl-review r3 finding 2).
	it('rejects env-flag eval forms for a scoped coder at the session root', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR_G, undefined, defaultConfig());
		startAgentSession('env-gate-1', 'coder');
		installActiveScopeBinding({
			directory: TEST_DIR_G,
			childSessionId: 'env-gate-1',
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});

		for (const command of [
			`env -u FOO python ${EVAL_PAYLOAD}`,
			`env -i python ${EVAL_PAYLOAD}`,
			`env -i -u HOME python ${EVAL_PAYLOAD}`,
			`env --unset FOO python ${EVAL_PAYLOAD}`,
			`env --chdir /tmp python ${EVAL_PAYLOAD}`,
			`env -a prog python ${EVAL_PAYLOAD}`,
			`env --env0-from FILE python ${EVAL_PAYLOAD}`,
			`env --un FOO python ${EVAL_PAYLOAD}`,
			`env -iu FOO python ${EVAL_PAYLOAD}`,
			`env -uu python ${EVAL_PAYLOAD}`,
			`env --u FOO python ${EVAL_PAYLOAD}`,
			`env -P /usr/bin python ${EVAL_PAYLOAD}`,
		]) {
			await expect(
				hooks.toolBefore(
					{ tool: 'bash', sessionID: 'env-gate-1', callID: 'call-1' },
					{ args: { command } },
				),
			).rejects.toThrow(
				/outside the active scope|SCOPE_VIOLATION|evaluates inline code/,
			);
		}
	});
});

// Known edge (impl-review r3 finding 5, filed as follow-up item 4): GNU
// `env -S "python -c …"` passes the COMMAND LINE inside the -S split-string;
// the normalizer consumes the string as a flag argument and does not
// re-split it, so that form is not classified. The suite's `-S "-i" python`
// leg pins the options-usage form, which IS classified.
