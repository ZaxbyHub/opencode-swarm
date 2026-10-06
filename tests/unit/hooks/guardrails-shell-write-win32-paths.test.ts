/**
 * Integration: a win32 path word in sed's BSD script slot (`\..\` components,
 * a drive-absolute `C:\` prefix) and a redirect into an escaped sink device
 * (`>'/dev/nul\154'`, which bash writes as a literal file) reach the
 * guardrails toolBefore hook as write targets and are blocked. Ordinary
 * scripts with backslash escapes and plain `/dev/null` redirects still pass.
 *
 * On win32 a `\..\` word names a file above the root (root escape). On POSIX
 * a backslash is a file-name character, so the same word is an in-root file:
 * only the scoped coder is blocked there (scope violation), and the
 * architect rows run on win32 only.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-shell-write-win32-');
const IS_WIN32 = process.platform === 'win32';
const B = '\\';

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
	const id = `${role}-win32-${sessionCounter++}`;
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

const rootEscape = (role: string, name: string) =>
	new RegExp(
		`^WRITE BLOCKED: Agent "${role}" is not authorised to write "[^"]*${name}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: `,
	);
// The coder is blocked on every platform: a root escape on win32, a scope
// violation on POSIX (the word is an in-root file outside src/ there).
const coderBlocked = (name: string) =>
	new RegExp(
		`^WRITE BLOCKED: (?:Agent "coder" is not authorised to write "[^"]*${name}" \\(via shell\\)\\. Reason: AUTHORITY_ROOT_ESCAPE: |SCOPE_VIOLATION: shell write target "[^"]*${name}" is outside the active scope)`,
	);

// [command, end of the file name the block message names]
const BSD_SLOT: Array<[string, string]> = [
	[`sed -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts -n`, 'pwned-1'],
	[`sed -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts`, 'pwned-1'],
	[`sed -n -i '' 's-x-${B}..${B}..${B}pwned-1' src/a.ts`, 'pwned-1'],
	[`sed -i '' 'x;${B}..${B}..${B}pwned' src/a.ts -n`, 'pwned'],
	[`sed -i '' '{${B}..${B}..${B}pwned' src/a.ts -n`, 'pwned'],
	[`sed -i '' 'y-${B}..${B}..${B}pwned-a-' src/a.ts -n`, 'pwned-a-'],
	[`sed -i -e 1d 's/..${B}..${B}x/g'`, String.raw`x[\\/]g`],
];

const DEVICE = [
	`echo x >'/dev${B}x2fnull'`,
	`echo x >'/dev/nul${B}x6c'`,
	`echo x >'/dev/nul${B}154'`,
];

const ALLOWED = [
	`sed -i '' 's/a${B}/b/c/' src/a.ts`,
	`sed -i '' 's/${B}t/ /g' src/a.ts`,
	`sed -i '' 's/${B}(a${B})/${B}1/' src/a.ts`,
	`sed -i '' 'y/abc/xyz/' src/a.ts`,
	`sed -i '' '1d;$d' src/a.ts`,
	'echo x >"/dev/null"',
	"echo x >'/dev/null'",
	"echo x >/dev/nul''l",
	'sed -i -e 1d src/a.ts 2>/dev/null',
];

describe('guardrails shell writes: win32 path words and escaped sink devices', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it.each(
		BSD_SLOT,
	)('coder scoped to src/: %s is blocked', async (command, name) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session('coder', true);
		await expect(
			hooks.toolBefore(bashInput(id), output(command)),
		).rejects.toThrow(coderBlocked(name));
	});

	it
		.skipIf(!IS_WIN32)
		.each(
			BSD_SLOT.flatMap(([command, name]) =>
				['architect', 'sme', 'critic_sounding_board'].map(
					(role) => [role, command, name] as const,
				),
			),
		)('win32 %s: %s is a root escape', async (role, command, name) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role);
		await expect(
			hooks.toolBefore(bashInput(id), output(command)),
		).rejects.toThrow(rootEscape(role, name));
	});

	// A drive-absolute word (no `..`) outside the root, built from the
	// fixture's parent directory.
	it.skipIf(!IS_WIN32).each(['architect', 'coder'])(
		'win32 %s: a drive-absolute word in the BSD slot is a root escape',
		async (role) => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
			const id = session(role, role === 'coder');
			const word = path.join(path.dirname(TEST_DIR), 'x;y');
			await expect(
				hooks.toolBefore(
					bashInput(id),
					output(`sed -i '' '${word}' src/a.ts -n`),
				),
			).rejects.toThrow(rootEscape(role, 'x;y'));
		},
	);

	it.each(
		DEVICE.flatMap((command) => [
			['architect', command, false] as const,
			['coder', command, true] as const,
		]),
	)('%s: %s is blocked', async (role, command, scoped) => {
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		const id = session(role, scoped);
		await expect(
			hooks.toolBefore(bashInput(id), output(command)),
		).rejects.toThrow(rootEscape(role, String.raw`[\\/]dev[\\/]null`));
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
