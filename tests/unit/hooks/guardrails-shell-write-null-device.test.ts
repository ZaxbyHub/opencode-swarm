/**
 * Integration: the guardrails toolBefore hook no longer blocks a bash call
 * whose only "write" is a redirect into /dev/null. Observed in a swarm session
 * as 18 AUTHORITY_ROOT_ESCAPE rejections across architect, coder, critic and
 * sme for commands such as `ls -la .swarm 2>/dev/null`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-null-device-');

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

function bashInput(sessionID: string) {
	return { tool: 'bash' as const, sessionID, callID: 'call-1' };
}

function output(command: string) {
	return { args: { command } };
}

function coderWithScope(sessionID: string, files: string[]): void {
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files,
		dispatchCallId: 'call-1',
	});
}

describe('guardrails shell writes: /dev/null redirects', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
	});

	it.each([
		'ls -la .swarm 2>/dev/null',
		'cat package.json 2>/dev/null; ls -la',
		'node t.js >/dev/null 2>&1 && echo PASS',
		'ps -o pid -p 1 2>/dev/null; echo "---"; git status --porcelain',
	])('architect: %s is allowed', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-null', 'architect');
		await expect(
			hooks.toolBefore(bashInput('arch-null'), output(command)),
		).resolves.toBeUndefined();
	});

	it('coder with a declared scope: stderr to /dev/null is allowed', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-null', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-null'),
				output('cat src/a.ts 2>/dev/null'),
			),
		).resolves.toBeUndefined();
	});

	it.each([
		'reviewer',
		'critic',
		'sme',
	])('%s (non-writer role): stderr to /dev/null is allowed', async (role) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-null`, role);
		await expect(
			hooks.toolBefore(
				bashInput(`${role}-null`),
				output('ls -la .swarm 2>/dev/null'),
			),
		).resolves.toBeUndefined();
	});

	it('coder: a real out-of-scope redirect beside 2>/dev/null is still blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-mixed', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-mixed'),
				output('cat src/a.ts 2>/dev/null > outside.txt'),
			),
		).rejects.toThrow('WRITE BLOCKED: SCOPE_VIOLATION:');
	});

	it('architect: cp to an outside path with 2>/dev/null is a root escape', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-cp-outside', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-cp-outside'),
				output('cp a.txt /etc/passwd 2>/dev/null'),
			),
		).rejects.toThrow(
			/not authorised to write "\/etc\/passwd".*AUTHORITY_ROOT_ESCAPE/,
		);
	});

	it('architect: sed -i 1d on an outside file is a root escape on that file', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-sed-1d', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-sed-1d'),
				output('sed -i 1d /etc/passwd 2>/dev/null'),
			),
		).rejects.toThrow(
			/not authorised to write "\/etc\/passwd".*AUTHORITY_ROOT_ESCAPE/,
		);
	});

	// Read-only roles go through the authority check like the architect.
	// (Direct-write roles other than architect and coder keep the pre-existing
	// no-scope leniency from issue #1778 and are not asserted here.)
	it.each([
		'sme',
		'critic_sounding_board',
	])('%s: cp to an outside path with 2>/dev/null is a root escape on the real target', async (role) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-cp-outside`, role);
		await expect(
			hooks.toolBefore(
				bashInput(`${role}-cp-outside`),
				output('cp a.txt /etc/passwd 2>/dev/null'),
			),
		).rejects.toThrow(/AUTHORITY_ROOT_ESCAPE/);
	});

	it('coder: cp to an out-of-scope path with 2>/dev/null names the real target', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-cp-outside', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-cp-outside'),
				output('cp src/a.ts outside.txt 2>/dev/null'),
			),
		).rejects.toThrow(/WRITE BLOCKED: SCOPE_VIOLATION:.*outside\.txt/);
	});

	it('coder: cp inside scope with 2>/dev/null is allowed', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-cp-inside', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-cp-inside'),
				output('cp src/a.ts src/b.ts 2>/dev/null'),
			),
		).resolves.toBeUndefined();
	});

	it('architect: a traversal through /dev/null is still a root escape', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-traversal', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-traversal'),
				output('echo x > /dev/null/../../etc/passwd'),
			),
		).rejects.toThrow(/AUTHORITY_ROOT_ESCAPE/);
	});

	it('coder: a relative dev/null is a scoped workspace write, not an exemption', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-relative', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-relative'),
				output('echo x > dev/null'),
			),
		).rejects.toThrow('WRITE BLOCKED: SCOPE_VIOLATION:');
	});

	it('architect: sed -i on an outside file with 2>/dev/null is a root escape', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-sed-outside', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-sed-outside'),
				output('sed -e s/a/b/ -i 2>/dev/null /etc/passwd'),
			),
		).rejects.toThrow(
			/not authorised to write "\/etc\/passwd".*AUTHORITY_ROOT_ESCAPE/,
		);
	});
});
