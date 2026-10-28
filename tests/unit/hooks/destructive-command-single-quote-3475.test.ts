/**
 * #3475 single-quoted wrapper payloads: `sh -c 'rmdir ../zz'` (and bash/zsh
 * twins) must unwrap to the bare inner command — the single quotes are the
 * wrapper's argument delimiters, exactly like the double-quoted form. Today
 * the shell-wrapper strip keeps the quotes, so the destructive-command and
 * write-scope matchers never see the payload and the gate admits it.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcStripOneWrapper,
	dcUnwrapWrappers,
} from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('dc-single-quote-3475-');

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
	const sessionID = `dc-single-quote-${++callCounter}`;
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

describe('dcStripOneWrapper: single-quoted -c payloads unwrap cleanly (#3475)', () => {
	it("strips sh -c 'rmdir ../zz' to the bare inner command", () => {
		expect(dcStripOneWrapper("sh -c 'rmdir ../zz'")).toBe('rmdir ../zz');
	});

	it("unwraps sh -c 'rmdir ../zz' fully via dcUnwrapWrappers", () => {
		expect(dcUnwrapWrappers("sh -c 'rmdir ../zz'")).toBe('rmdir ../zz');
	});

	it('unwraps bash -c \'echo "x" > ../zz\' with the inner double quotes intact', () => {
		expect(dcUnwrapWrappers('bash -c \'echo "x" > ../zz\'')).toBe(
			'echo "x" > ../zz',
		);
	});

	it('double-quoted payloads keep unwrapping (control, already correct)', () => {
		expect(dcStripOneWrapper('sh -c "rmdir ../zz"')).toBe('rmdir ../zz');
		expect(dcUnwrapWrappers('sh -c "rmdir ../zz"')).toBe('rmdir ../zz');
	});

	// Round-2 pin (green at base and post-fix): the unquoted payload fallback
	// keeps working — no quotes around the payload means the whole remainder
	// after `-c` is the inner command, unchanged.
	it('keeps the unquoted fallback: sh -c echo hi unwraps to echo hi', () => {
		expect(dcStripOneWrapper('sh -c echo hi')).toBe('echo hi');
	});
});

describe('gate: single-quoted shell wrappers are scope-checked (#3475)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(`${TEST_DIR}/src`, { recursive: true });
	});

	it("rejects sh -c 'rmdir ../zz'", async () => {
		await expect(runAsCoder("sh -c 'rmdir ../zz'")).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it("rejects bash -c 'rmdir ../zz'", async () => {
		await expect(runAsCoder("bash -c 'rmdir ../zz'")).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects sh -c \'echo "x" > ../zz\'', async () => {
		await expect(runAsCoder('sh -c \'echo "x" > ../zz\'')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects sh -c "rmdir ../zz" (control, already correct)', async () => {
		await expect(runAsCoder('sh -c "rmdir ../zz"')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	// Round-2: escaped double quotes INSIDE a double-quoted payload. Real
	// bash executes `echo "x" > ../zz` — an out-of-workspace redirect.
	// GREEN control at base (the raw POSIX parse already surfaces the
	// redirect) and must STAY blocked after the single-quote unwrap fix.
	it('rejects bash -c with escaped double quotes inside a double-quoted payload', async () => {
		await expect(runAsCoder('bash -c "echo \\"x\\" > ../zz"')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});
});
