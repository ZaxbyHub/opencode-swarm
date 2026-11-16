/**
 * #3475 mid-word `#`: a `#` embedded inside a word (`src/x.txt#../../../zz`) is
 * NOT a comment start in real bash — the whole word is the operand, and the
 * real write lands outside the declared scope. The detector must treat `#`
 * as a comment only at a word start (after whitespace or line begin), so the
 * mid-word operand is checked as written. A genuine word-start comment
 * (`echo x > src/ok.txt # just a note`) must keep truncating and stay
 * admitted.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-midword-hash-3475-');

function config(): GuardrailsConfig {
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

let callCounter = 0;

async function runAsCoder(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const sessionID = `midword-hash-${++callCounter}`;
	const callID = `call-${callCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	await hooks.toolBefore(
		{ tool: 'bash', sessionID, callID },
		{ args: { command } },
	);
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

describe('gate: mid-word # is not a comment start (#3475)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
		writeFileSync(path.join(TEST_DIR, 'src', 'x.txt'), 'x');
	});

	it('rejects cp src/x.txt src/x.txt#../../../zz (real operand escapes scope)', async () => {
		await expect(
			runAsCoder('cp src/x.txt src/x.txt#../../../zz'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects mv src/x.txt src/f#../../../zz (real operand escapes scope)', async () => {
		await expect(runAsCoder('mv src/x.txt src/f#../../../zz')).rejects.toThrow(
			/^WRITE BLOCKED(?: \[shell-write-scope\])?: /,
		);
	});

	it('resolves a real word-start comment after an in-scope redirect', async () => {
		await expect(
			runAsCoder('echo x > src/ok.txt # just a note'),
		).resolves.toBeUndefined();
	});

	it('resolves an in-scope copy with no # at all', async () => {
		await expect(
			runAsCoder('cp src/x.txt src/copy.txt'),
		).resolves.toBeUndefined();
	});

	it('still rejects an out-of-scope redirect whose target contains # (control)', async () => {
		await expect(runAsCoder('echo x > ../zz#a')).rejects.toThrow(
			/^WRITE BLOCKED(?: \[shell-write-scope\])?: /,
		);
	});

	// Round-2: the # must not truncate a MIXED-quoted operand either —
	// src/'x.txt'#../../../zz is one operand in real bash and escapes scope.
	it("rejects cp src/x.txt src/'x.txt'#../../../zz (mixed-quote truncation)", async () => {
		await expect(
			runAsCoder("cp src/x.txt src/'x.txt'#../../../zz"),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// Round-2: a redirect target whose mid-word # truncates the parsed file
	// to the in-scope src/x while real bash writes src/x#../../../zz — the
	// parsed prefix being in scope must not authorize the real target.
	it('rejects echo x > src/x#../../../zz (redirect file truncated at #)', async () => {
		await expect(runAsCoder('echo x > src/x#../../../zz')).rejects.toThrow(
			/^WRITE BLOCKED(?: \[shell-write-scope\])?: /,
		);
	});

	// Round-2 control (green at base and post-fix): a QUOTED literal #
	// operand inside scope — quotes make # part of the filename, there is no
	// comment and no traversal; the copy stays admitted.
	it("resolves cp src/x.txt 'src/ok#a' (quoted literal # inside scope)", async () => {
		await expect(
			runAsCoder("cp src/x.txt 'src/ok#a'"),
		).resolves.toBeUndefined();
	});
});
