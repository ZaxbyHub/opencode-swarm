/**
 * #3474 process-modifier prefixes: `timeout DURATION` and `stdbuf OPTIONS`
 * wrap the real command the way `command`/`env` do. Desired: a prefixed
 * inline-code interpreter eval to an out-of-scope target is REJECTED like the
 * unprefixed form, while prefixed read-only/build commands stay admitted.
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

const TEST_DIR = canonicalMkdtemp('shell-write-proc-modifiers-3474-');

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
	const sessionID = `proc-mod-${++callCounter}`;
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

describe('gate: process-modifier prefixed eval writes (#3474)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
		writeFileSync(path.join(TEST_DIR, 'src', 'x.txt'), 'x');
	});

	it('rejects timeout 5 python -c writing out of scope', async () => {
		await expect(
			runAsCoder("timeout 5 python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects timeout 5s python -c writing out of scope (unit-suffixed duration)', async () => {
		await expect(
			runAsCoder("timeout 5s python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects stdbuf -o0 python -c writing out of scope', async () => {
		await expect(
			runAsCoder("stdbuf -o0 python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// Round-2: stdbuf option-form spellings of the same evasion.
	it('rejects stdbuf -oL python -c writing out of scope', async () => {
		await expect(
			runAsCoder("stdbuf -oL python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects stdbuf --output=L python -c writing out of scope', async () => {
		await expect(
			runAsCoder("stdbuf --output=L python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// Round-2: timeout's own long flag before the duration.
	it('rejects timeout --foreground 5 python -c writing out of scope', async () => {
		await expect(
			runAsCoder(
				"timeout --foreground 5 python -c \"open('../zzpy.txt','w')\"",
			),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects the unprefixed control (the detector fires on it)', async () => {
		await expect(
			runAsCoder("python -c \"open('../zzpy.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('still admits timeout 5 make test', async () => {
		await expect(runAsCoder('timeout 5 make test')).resolves.toBeUndefined();
	});

	it('still admits timeout 5 ls src', async () => {
		await expect(runAsCoder('timeout 5 ls src')).resolves.toBeUndefined();
	});

	it('still admits stdbuf -oL cat src/x.txt', async () => {
		await expect(
			runAsCoder('stdbuf -oL cat src/x.txt'),
		).resolves.toBeUndefined();
	});

	// Round-2 FP legs: `command -v` / `command -V` are QUERY forms — they
	// print information and never execute the named command, so they must
	// not be unwrapped as an execution of the queried write command.
	it('still admits command -v rmdir ../zz (query form, not execution)', async () => {
		await expect(runAsCoder('command -v rmdir ../zz')).resolves.toBeUndefined();
	});

	it('still admits command -V ls (query form, not execution)', async () => {
		await expect(runAsCoder('command -V ls')).resolves.toBeUndefined();
	});
});
