/**
 * Integration: an in-place edit whose option word the picker does not model
 * (`sed -i -bes/a/X/ /etc/passwd`, `sed --e=s/a/X/ -i /etc/passwd`,
 * `perl -i -fpes/a/X/ /etc/passwd`, `awk -i inplace --sourc=... /etc/passwd`)
 * used to have its real file taken for the implicit script, so nothing was
 * reported and toolBefore allowed the write for every role. The real file is
 * now reported and the call is blocked; modelled options still pass.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-unknown-option-');
// "/etc/passwd" on POSIX, "C:\etc\passwd" on win32 (see the null-device suite).
const ETC_PASSWD_ROOT_ESCAPE =
	/^WRITE BLOCKED: Agent "architect" is not authorised to write "(?:[A-Za-z]:)?[\\/]etc[\\/]passwd" \(via shell\)\. Reason: AUTHORITY_ROOT_ESCAPE: /;

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

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// [command, the path the first sme/critic_sounding_board rejection names:
// the root /etc/passwd ("C:\etc\passwd" on win32) or an in-workspace word]
const ETC_PASSWD = String.raw`(?:[A-Za-z]:)?[\\/]etc[\\/]passwd`;
const UNMODELLED_ROWS: Array<[string, string]> = [
	['sed -i -bes/a/X/ /etc/passwd', ETC_PASSWD],
	['sed --e=s/a/X/ -i /etc/passwd', String.raw`[^"]*[\\/]--e=s[\\/]a[\\/]X`],
	['perl -i -fpes/a/X/ /etc/passwd', String.raw`[^"]*[\\/]-fpes[\\/]a[\\/]X`],
	[
		`awk -i inplace --sourc='{print "X"}' /etc/passwd`,
		String.raw`[^"]*[\\/]--sourc=\{print "X"\}`,
	],
	// A dash-word taken as an option's argument (FS is `-f` / `-v`) is not
	// parsed again as an option that supplies the program.
	[`awk -i inplace -F -f '{print "X"}' /etc/passwd`, ETC_PASSWD],
	[`awk -i inplace -F -v '{print "X"}' /etc/passwd`, ETC_PASSWD],
	// awk edits every file: the second one is not hidden behind the first.
	[
		"awk -i inplace '{print}' src/a.ts /etc/passwd",
		String.raw`[^"]*[\\/]src[\\/]a\.ts`,
	],
];
const UNMODELLED = UNMODELLED_ROWS.map(([command]) => command);

const MODELLED = [
	"sed -i -E -e 's/a/b/' src/a.ts",
	"sed -i 's/a/b/' src/a.ts",
	'sed -n -i p src/a.ts',
	"sed --posix -i 's/a/b/' src/a.ts",
	'sed -l 5 -i 1d src/a.ts',
	"perl -i -pe 's/a/b/' src/a.ts",
	"perl -i.bak -ne 'print' src/a.ts",
	"awk -i inplace -v x=1 '{print}' src/a.ts",
	'awk -i inplace -f p.awk src/a.ts',
];

describe('guardrails shell writes: an option word the picker does not model', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		UNMODELLED,
	)('architect: %s is blocked on /etc/passwd', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-unknown', 'architect');
		await expect(
			hooks.toolBefore(bashInput('arch-unknown'), output(command)),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
	});

	it.each(
		UNMODELLED_ROWS.flatMap(([command, path]) =>
			['sme', 'critic_sounding_board'].map((role) => [role, command, path]),
		),
	)('%s: %s is blocked', async (role, command, path) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-unknown`, role);
		await expect(
			hooks.toolBefore(bashInput(`${role}-unknown`), output(command)),
		).rejects.toThrow(
			new RegExp(
				String.raw`^WRITE BLOCKED: Agent "${role}" is not authorised to write "${path}" \(via shell\)`,
			),
		);
	});

	it.each(MODELLED)('architect: %s is allowed', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-modelled', 'architect');
		await expect(
			hooks.toolBefore(bashInput('arch-modelled'), output(command)),
		).resolves.toBeUndefined();
	});

	// One session per case: a reused child session id makes the scope
	// binding ambiguous.
	it.each(
		MODELLED.map((command, n) => [command, `coder-modelled-${n}`]),
	)('coder scoped to src/: %s is allowed', async (command, sessionID) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(sessionID, 'coder');
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: sessionID,
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
		await expect(
			hooks.toolBefore(bashInput(sessionID), output(command)),
		).resolves.toBeUndefined();
	});
});
