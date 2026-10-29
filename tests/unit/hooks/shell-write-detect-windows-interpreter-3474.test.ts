/**
 * #3474 Windows grammar: detectWindowsWrites has no interpreter-eval table,
 * so `C:\Python311\python.exe -c "x=1"` classifies as no write under either
 * cmd or powershell parsing. Desired: an absolute Windows interpreter path
 * (backslash and forward-slash spelling) with an inline-code flag yields an
 * interpreter_eval write, and the win32 shell-tool gate blocks an eval whose
 * working directory is the workspace root outside the coder's scope.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectWindowsWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-win-interp-3474-');

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

function expectEvalWrite(command: string, shell: 'cmd' | 'powershell'): void {
	const analysis = detectWindowsWrites(command, shell);
	expect(
		analysis.writes.some((w) => w.category === 'interpreter_eval'),
		`${shell}: ${command} must classify as interpreter_eval`,
	).toBe(true);
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

describe('detector: Windows interpreter eval (#3474)', () => {
	it('detects C:\\Python311\\python.exe -c under the cmd grammar', () => {
		expectEvalWrite('C:\\Python311\\python.exe -c "x=1"', 'cmd');
	});

	it('detects C:\\Python311\\python.exe -c under the powershell grammar', () => {
		expectEvalWrite('C:\\Python311\\python.exe -c "x=1"', 'powershell');
	});

	it('detects the forward-slash spelling C:/Python311/python.exe -c', () => {
		expectEvalWrite('C:/Python311/python.exe -c "x=1"', 'cmd');
	});

	// Round-2: the eval write is the inspectable capability class — it must
	// carry `capability: true` (routed through declared scope at the eval's
	// directory) and `path: null` (no static target), not just the category.
	it('marks the cmd-grammar eval write capability=true with path=null', () => {
		const analysis = detectWindowsWrites(
			'C:\\Python311\\python.exe -c "x=1"',
			'cmd',
		);
		const evalWrite = analysis.writes.find(
			(w) => w.category === 'interpreter_eval',
		);
		expect(evalWrite).toBeDefined();
		expect(evalWrite?.capability).toBe(true);
		expect(evalWrite?.path).toBeNull();
	});

	it('marks the powershell-grammar eval write capability=true with path=null', () => {
		const analysis = detectWindowsWrites(
			'C:\\Python311\\python.exe -c "x=1"',
			'powershell',
		);
		const evalWrite = analysis.writes.find(
			(w) => w.category === 'interpreter_eval',
		);
		expect(evalWrite).toBeDefined();
		expect(evalWrite?.capability).toBe(true);
		expect(evalWrite?.path).toBeNull();
	});

	// Round-2/3/4: two interpreter invocations in one command string must be
	// RETAINED as EXACTLY two eval rows with two distinct operator keys —
	// not one collapsed row, and not three-plus rows. An occurrence-suffixed
	// operator (e.g. "python.exe [eval#2]") is fine as long as the total is
	// exactly 2 with 2 distinct keys.
	it('surfaces both evals of a repeated interpreter invocation', () => {
		// CHECK_WRONG amend (implementation round): `&` is cmd.exe's command
		// separator (`;` is not — splitWindowsCommands never split the
		// original `;` form, so it could only ever see one interpreter).
		const analysis = detectWindowsWrites(
			'C:\\Python311\\python.exe -c "x=1" & C:\\Python311\\python.exe -c "x=2"',
			'cmd',
		);
		const evalWrites = analysis.writes.filter(
			(w) => w.category === 'interpreter_eval',
		);
		expect(
			evalWrites.length,
			`expected exactly 2 eval writes, got: ${JSON.stringify(evalWrites.map((w) => w.operator))}`,
		).toBe(2);
		expect(
			new Set(evalWrites.map((w) => w.operator)).size,
			`expected 2 distinct operator keys, got: ${JSON.stringify(evalWrites.map((w) => w.operator))}`,
		).toBe(2);
	});
});

describe.skipIf(process.platform !== 'win32')(
	'gate: Windows interpreter eval at the workspace root (#3474)',
	() => {
		beforeEach(() => {
			resetSwarmState();
			mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
		});

		it('rejects mkdir d9 && C:\\Python311\\python.exe -c for a src/-scoped coder', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
			const sessionID = `win-interp-${++callCounter}`;
			const callID = `call-${callCounter}`;
			startAgentSession(sessionID, 'coder');
			installActiveScopeBinding({
				directory: TEST_DIR,
				childSessionId: sessionID,
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: callID,
			});
			await expect(
				hooks.toolBefore(
					{ tool: 'shell', sessionID, callID },
					{
						args: {
							command: 'mkdir d9 && C:\\Python311\\python.exe -c "x=1"',
						},
					},
				),
			).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
		});

		// Round-2/3: the Windows-grammar eval authorizes against the command's
		// STARTING directory (the documented narrow contract) — the workspace
		// root here — NOT against a cd the command performs later. With scope
		// src/ the starting directory is outside scope, so this must REJECT;
		// a Windows walker that "fixes" this by tracking the cd would be
		// widening beyond the documented contract. (Round-3: the command is
		// mkdir-prefixed because a cd-prefixed form never selects the Windows
		// grammar at all — bash-classified content resolves windowsShell to
		// null — while the mkdir-prefixed form is the proven cmd-inheritance
		// pattern.)
		it('rejects mkdir d9 && cd src && C:\\Python311\\python.exe -c (starting directory is the out-of-scope workspace root)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
			const sessionID = `win-interp-cd-${++callCounter}`;
			const callID = `call-${callCounter}`;
			startAgentSession(sessionID, 'coder');
			installActiveScopeBinding({
				directory: TEST_DIR,
				childSessionId: sessionID,
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: callID,
			});
			await expect(
				hooks.toolBefore(
					{ tool: 'shell', sessionID, callID },
					{
						args: {
							command:
								'mkdir d9 && cd src && C:\\Python311\\python.exe -c "x=1"',
						},
					},
				),
			).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
		});

		// Round-4: critic R2/R3 raw-operator identity requirement (attribution: the && cwd fix alone would restore the tracked src context; this leg catches a MISMATCHED Windows operator re-adding a fallback-root row, while the backslash legs force the Windows table itself). The
		// forward-slash spelling is readable by the POSIX grammar, which
		// tracks `cd src` and authorizes the eval at src (in scope). The
		// supplementary Windows row uses the SAME raw-word operator key and
		// inherits the tracked src context. Round-5 re-freeze (PRR-001
		// dual-context, delta re-gate nit: the stale pre-re-freeze title
		// said "admits"): the Windows reading is AUTHORITATIVE for the
		// `shell` tool, but the pessimistic reading of the failing-`&&`
		// chain evals at the START directory (d9, outside scope src/), so
		// the write must pass BOTH readings and the leg stays RED at base
		// and pins REJECT at head.
		it('rejects mkdir d9 && cd src && C:/Python311/python.exe -c (write must pass both readings)', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
			const sessionID = `win-interp-fwd-${++callCounter}`;
			const callID = `call-${callCounter}`;
			startAgentSession(sessionID, 'coder');
			installActiveScopeBinding({
				directory: TEST_DIR,
				childSessionId: sessionID,
				taskId: '1.1',
				files: ['src/'],
				dispatchCallId: callID,
			});
			await expect(
				hooks.toolBefore(
					{ tool: 'shell', sessionID, callID },
					{
						args: {
							command: 'mkdir d9 && cd src && C:/Python311/python.exe -c "x=1"',
						},
					},
				),
			).rejects.toThrow(/^WRITE BLOCKED(?: \[shell-write-scope\])?: /);
		});
	},
);
