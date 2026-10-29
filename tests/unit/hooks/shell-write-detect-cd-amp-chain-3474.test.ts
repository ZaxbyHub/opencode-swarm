/**
 * #3474 `cd a && cd b && …` chains: the effective-directory walker must track
 * EVERY cd of an &&-separated chain exactly like the `;`-separated twin, so
 * the write target is judged where it actually resolves. The escape legs
 * (cd out of scope, then write) must REJECT and the stay-in-scope legs (cd
 * src, cd sub, write ../esc.md) must RESOLVE, for BOTH separators.
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

const TEST_DIR = canonicalMkdtemp('shell-write-cd-amp-chain-3474-');

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
	const sessionID = `cd-amp-chain-${++callCounter}`;
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

describe('gate: cd chains track every cd under && like under ; (#3474)', () => {
	beforeEach(() => {
		resetSwarmState();
		const src = path.join(TEST_DIR, 'src');
		const sub = path.join(src, 'sub');
		mkdirSync(sub, { recursive: true });
		writeFileSync(path.join(src, 'x.txt'), 'x');
		writeFileSync(path.join(sub, 'note.md'), 'note');
	});

	it('rejects a && chain that cds out of scope and writes at the workspace root', async () => {
		await expect(
			runAsCoder('cd src && cd .. && echo x > escape.txt'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects the ; twin (control, already correct at base)', async () => {
		await expect(
			runAsCoder('cd src; cd ..; echo x > escape.txt'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('blocks a && chain whose ../esc.md is in scope only if every cd succeeds (PRR-001 dual-context)', async () => {
		// CHECK_WRONG (feedback round, security): under the pessimistic reading
		// a failing left operand skips `cd sub`, so ../esc.md lands at
		// ws/esc.md — outside scope src/. The write must pass BOTH readings.
		await expect(
			runAsCoder('cd src && cd sub && echo x > ../esc.md'),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('resolves the ; twin (control, already correct at base)', async () => {
		await expect(
			runAsCoder('cd src; cd sub; echo x > ../esc.md'),
		).resolves.toBeUndefined();
	});

	it('rejects a && chain that cds out of scope before an interpreter eval', async () => {
		await expect(
			runAsCoder("cd src && cd .. && python -c \"open('esc.py.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	it('rejects the ; twin of the eval escape (control)', async () => {
		await expect(
			runAsCoder("cd src; cd ..; python -c \"open('esc.py.txt','w')\""),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});

	// Round-2 control (green at base AND post-fix): the first `cd ..` of an
	// || chain succeeds, so the write runs from OUTSIDE the workspace no
	// matter what the skipped right branch would have done — it must stay
	// blocked under both the old single-cd walker and the fixed && walker.
	it('rejects cd .. || cd <workspace>/src && echo x > escape.txt (control)', async () => {
		const workspaceSrc = `${path.basename(TEST_DIR)}/src`;
		await expect(
			runAsCoder(`cd .. || cd ${workspaceSrc} && echo x > escape.txt`),
		).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
	});
});
