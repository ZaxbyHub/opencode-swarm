/**
 * Integration: in-place edit targets the picker used to miss now reach the
 * guardrails toolBefore hook and are blocked: a glob in a detached option
 * argument, a quoted dynamic file operand, GNU sed's `--in-place`, a path
 * shaped like `s/../../x`, and an awk operand after the program that starts
 * with `-`. Quoted sed/perl/awk scripts with regex characters still pass.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-operands-');

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

let sessionCounter = 0;
function session(role: string, scoped = false): string {
	const id = `${role}-operands-${sessionCounter++}`;
	startAgentSession(id, role);
	if (scoped) {
		installActiveScopeBinding({
			directory: TEST_DIR,
			childSessionId: id,
			taskId: '1.1',
			files: ['src/'],
			dispatchCallId: 'call-1',
		});
	}
	return id;
}

afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

const rootEscape = (role: string, path: string) =>
	new RegExp(
		`^WRITE BLOCKED: Agent "${role}" is not authorised to write "[^"]*${path}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
	);

// [command, path pattern the root-escape message names ("/etc/passwd" on
// POSIX, "C:\etc\passwd" on win32), or null for a dynamic-target block]
const BLOCKED: Array<[string, string | null]> = [
	['sed -i --file ../[ab].sed src/a.ts', '[\\\\/]\\[ab\\]\\.sed'],
	['sed --in-place s/a/b/ /etc/passwd', '[\\\\/]etc[\\\\/]passwd'],
	['sed -i -e 1d s/../../etc/g', '[\\\\/]etc[\\\\/]g'],
	['X=/etc/passwd; sed -i -e 1d "$X"', null],
];

const ALLOWED = [
	"sed -i 's/a*/b/' src/a.ts",
	"sed -i -E -e 's/(a|b)?/x/' src/a.ts",
	"perl -i -pe 's/\\s+$//' src/a.ts",
	"awk -i inplace -F '[,;]' '{print}' src/a.ts",
	"awk -i inplace -v 're=[0-9]*' '{print}' src/a.ts",
	'sed --in-place -e 1d src/a.ts',
];

describe('guardrails shell writes: in-place operands the picker used to miss', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		BLOCKED.flatMap(([command, path]) =>
			['architect', 'sme', 'critic_sounding_board'].map(
				(role) => [role, command, path] as const,
			),
		),
	)('%s: %s is blocked', async (role, command, path) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role);
		await expect(
			hooks.toolBefore(bashInput(id), output(command)),
		).rejects.toThrow(
			path === null
				? /^BLOCKED: bash\/shell write to a dynamic path target ""\$X"" that cannot be statically resolved/
				: rootEscape(role, path),
		);
	});

	// gawk reads `-v` after the program as a file operand, not an option.
	it('architect: an awk operand after the program is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session('architect');
		await expect(
			hooks.toolBefore(
				bashInput(id),
				output("awk -i inplace '{print}' src/a.ts -v ../v"),
			),
		).rejects.toThrow(rootEscape('architect', '[\\\\/]v'));
	});

	it('coder scoped to src/: an awk dash operand is a scope violation', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session('coder', true);
		await expect(
			hooks.toolBefore(
				bashInput(id),
				output("awk -i inplace '{print}' src/a.ts -v ../v"),
			),
		).rejects.toThrow(
			/^WRITE BLOCKED: SCOPE_VIOLATION: shell write target "[^"]*[\\/]-v" is outside the active scope/,
		);
	});

	// Documented over-block: a quoted dynamic file operand is a dynamic target.
	it('architect: a quoted dynamic perl file operand is blocked', async () => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session('architect');
		await expect(
			hooks.toolBefore(
				bashInput(id),
				output('FILE=src/a.ts; perl -i -pe X "$FILE"'),
			),
		).rejects.toThrow(
			/^BLOCKED: bash\/shell write to a dynamic path target ""\$FILE"" that cannot be statically resolved/,
		);
	});

	it.each(
		ALLOWED.flatMap((command) => [
			['architect', command, false] as const,
			['coder', command, true] as const,
		]),
	)('%s: %s is allowed', async (role, command, scoped) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role, scoped);
		await expect(
			hooks.toolBefore(bashInput(id), output(command)),
		).resolves.toBeUndefined();
	});
});
