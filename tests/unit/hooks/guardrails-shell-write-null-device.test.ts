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
// The authority layer names the resolved target: "/etc/passwd" on POSIX,
// "C:\etc\passwd" on win32. Anchored at the message start so it cannot match
// a path echoed elsewhere in the text, and pinned to the root /etc/passwd so
// a workspace path ending in etc/passwd does not satisfy it.
const ETC_PASSWD_ROOT_ESCAPE =
	/^WRITE BLOCKED: Agent "[^"]+" is not authorised to write "(?:[A-Za-z]:)?[\\/]etc[\\/]passwd" \(via shell\)\. Reason: AUTHORITY_ROOT_ESCAPE: /;

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

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('guardrails shell writes: /dev/null redirects', () => {
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
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
	});

	it('architect: sed -i 1d on an outside file is a root escape on that file', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-sed-1d', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-sed-1d'),
				output('sed -i 1d /etc/passwd 2>/dev/null'),
			),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
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
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
	});
});

/**
 * An attached script flag (`-e's/a/b/'`, `-es/a/b/`, `-fs.sed`) once made
 * the detector take the real file for the implicit script and report no
 * write, so toolBefore returned early and admitted the edit for every role.
 */
describe('guardrails shell writes: in-place edits with attached script flags', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	const attachedForms = [
		"sed -i -e's/a/b/' /etc/passwd",
		'sed -i -es/a/b/ /etc/passwd',
		'sed -i -fs.sed /etc/passwd',
	];

	it.each(
		['architect', 'sme', 'critic_sounding_board'].flatMap((role) =>
			attachedForms.map((command) => [role, command]),
		),
	)('%s: %s is a root escape on the real file', async (role, command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-attached`, role);
		await expect(
			hooks.toolBefore(bashInput(`${role}-attached`), output(command)),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
	});

	it('architect: perl -i with a dot-prefixed script path is a root escape', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-perl-script', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-perl-script'),
				output('perl -i ./s.pl /etc/passwd'),
			),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
	});

	it('coder: an attached script flag on an out-of-scope file is a scope violation', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-attached-out', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-attached-out'),
				output("sed -i -e's/a/b/' outside.txt"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: SCOPE_VIOLATION: shell write target "[^"]*outside\.txt" is outside the active scope/,
		);
	});

	it('coder: an attached script flag on an in-scope file is allowed', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-attached-in', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-attached-in'),
				output("sed -i -e's/a/b/' src/ok.ts"),
			),
		).resolves.toBeUndefined();
	});

	it('sme (read-only): an attached script flag on a workspace file is rejected', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('sme-attached-in', 'sme');
		await expect(
			hooks.toolBefore(
				bashInput('sme-attached-in'),
				output("sed -i -e's/a/b/' src/ok.ts"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: Agent "sme" is not authorised to write "[^"]*src[\\/]ok\.ts" \(via shell\)\. Reason: /,
		);
	});

	// GNU sed runs `''` as an empty script here: with -n the file is truncated.
	it.each([
		'architect',
		'sme',
	])('%s: sed -i with an empty script word is a write to the file', async (role) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`${role}-empty-script`, role);
		await expect(
			hooks.toolBefore(
				bashInput(`${role}-empty-script`),
				output("sed -i '' /etc/passwd"),
			),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
		// GNU edits every word after '' as a file; the first one is named.
		await expect(
			hooks.toolBefore(
				bashInput(`${role}-empty-script`),
				output("sed -i '' /etc/passwd x -n"),
			),
		).rejects.toThrow(ETC_PASSWD_ROOT_ESCAPE);
		for (const command of ["sed -n -i '' .env", "sed -n -i '' .env x"]) {
			await expect(
				hooks.toolBefore(bashInput(`${role}-empty-script`), output(command)),
			).rejects.toThrow(
				new RegExp(
					`^WRITE BLOCKED: Agent "${role}" is not authorised to write "[^"]*[\\\\/]\\.env" \\(via shell\\)\\. Reason: `,
				),
			);
		}
	});

	// GNU sed edits every file named; a path holding ; { } next to an
	// in-scope file must not hide behind it.
	const MULTI_FILE = [
		["sed -i -e 1d '../{a}' src/a.ts", '[^"]*[\\\\/]\\{a\\}'],
		["sed -i 1d '/opt/a;b' src/a.ts", '(?:[A-Za-z]:)?[\\\\/]opt[\\\\/]a;b'],
	] as const;

	it.each(
		MULTI_FILE,
	)('architect: %s is a root escape on the outside file', async (command, target) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-multi-file', 'architect');
		await expect(
			hooks.toolBefore(bashInput('arch-multi-file'), output(command)),
		).rejects.toThrow(
			new RegExp(
				`^WRITE BLOCKED: Agent "architect" is not authorised to write "${target}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
			),
		);
	});

	it.each(
		MULTI_FILE,
	)('scoped coder: %s is rejected on the outside file', async (command, target) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-multi-file', ['src/']);
		await expect(
			hooks.toolBefore(bashInput('coder-multi-file'), output(command)),
		).rejects.toThrow(
			new RegExp(
				`^WRITE BLOCKED: Agent "coder" is not authorised to write "${target}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
			),
		);
	});
});

/**
 * GNU sed edits the file after a script placed before `-i`, and with a
 * script flag it edits a dot-word after a bare `-i`; only a conventional
 * backup suffix (`.bak`) is taken as the BSD suffix.
 */
describe('guardrails shell writes: sed script and suffix placement', () => {
	const OUTSIDE_X = '[^"]*[\\\\/]x';
	const ESCAPES = ['sed 1d -i ../x', 'sed -e 1d -i ../x src/a.ts'];

	it.each(
		ESCAPES,
	)('architect: %s is a root escape on ../x', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`arch-placement-${command}`, 'architect');
		await expect(
			hooks.toolBefore(bashInput(`arch-placement-${command}`), output(command)),
		).rejects.toThrow(
			new RegExp(
				`^WRITE BLOCKED: Agent "architect" is not authorised to write "${OUTSIDE_X}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
			),
		);
	});

	it.each(ESCAPES)('scoped coder: %s is rejected on ../x', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope(`coder-placement-${command}`, ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput(`coder-placement-${command}`),
				output(command),
			),
		).rejects.toThrow(
			new RegExp(
				`^WRITE BLOCKED: Agent "coder" is not authorised to write "${OUTSIDE_X}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
			),
		);
	});

	it('sme: sed -e 1d -i .env src/a.ts is rejected on .env', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('sme-placement', 'sme');
		await expect(
			hooks.toolBefore(
				bashInput('sme-placement'),
				output('sed -e 1d -i .env src/a.ts'),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: Agent "sme" is not authorised to write "[^"]*[\\/]\.env" \(via shell\)\. Reason: /,
		);
	});

	it.each([
		"sed -i .bak -e 's/a/b/' src/f.ts",
		'sed -i -e 1d src/f.ts',
	])('scoped coder: %s is allowed', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope(`coder-placement-in-${command}`, ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput(`coder-placement-in-${command}`),
				output(command),
			),
		).resolves.toBeUndefined();
	});

	// After `-i ''` GNU sed edits the next word as a file; a word with a `..`
	// component is never taken for the BSD script, whatever its delimiter.
	it('architect: a traversal word after -i is a root escape', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-traversal-word', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-traversal-word'),
				output("sed -i '' 's-x-/../../victim-1' src/a.ts -n"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: Agent "architect" is not authorised to write "[^"]*[\\/]victim-1" \(via shell\)\. Reason: AUTHORITY_ROOT_ESCAPE: /,
		);
	});

	// A word with an expansion is never the BSD script: it stays a dynamic
	// write target and is blocked as one.
	it.each([
		"D=/etc/passwd; sed -i '' ${D} src/a.ts -n",
		"D=/etc/passwd; sed -i '' $D src/a.ts -n",
	])('architect: %s is blocked as a dynamic target', async (command) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession(`arch-dynamic-${command}`, 'architect');
		await expect(
			hooks.toolBefore(bashInput(`arch-dynamic-${command}`), output(command)),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "\$\{?D\}?" that cannot be statically resolved/,
		);
	});

	// In the GNU script slot an unquoted expansion can field-split into the
	// script plus files, so it is never consumed as the script.
	it('architect: an unquoted expansion in the script slot is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		startAgentSession('arch-script-slot', 'architect');
		await expect(
			hooks.toolBefore(
				bashInput('arch-script-slot'),
				output("S='1d ../../x'; sed -i $S src/a.ts"),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target "\$S" that cannot be statically resolved/,
		);
	});

	it('scoped coder: a brace word in the script slot is rejected', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-script-slot', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-script-slot'),
				output('sed -i {1d,../../outside/v} src/a.ts'),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: SCOPE_VIOLATION: shell write target "[^"]*outside[\\/]v\}" is outside the active scope/,
		);
	});

	it('scoped coder: a brace-expansion word after -i is rejected', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-brace-word', ['src/']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-brace-word'),
				output("sed -i '' s-x-/{..,a}/{..,b}/outside/victimH-1 src/a.ts -n"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: SCOPE_VIOLATION: shell write target "[^"]*victimH-1" is outside the active scope/,
		);
	});

	it('scoped coder: a traversal word into .swarm after -i is rejected', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		coderWithScope('coder-traversal-word', ['src/a.ts']);
		await expect(
			hooks.toolBefore(
				bashInput('coder-traversal-word'),
				output("sed -i '' 's-x-/../.swarm/plan-1' src/a.ts -n"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: Agent "coder" is not authorised to write "[^"]*[\\/]\.swarm[\\/]plan-1" \(via shell\)\. Reason: AUTHORITY_PROTECTED_PATH: /,
		);
	});
});
