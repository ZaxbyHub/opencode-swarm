/**
 * Issue #3099 AC1 / AC4 / AC7 — executor-aware PowerShell classification.
 *
 * Two defects share one root cause (src/hooks/guardrails/tool-before.ts):
 *
 *  - AC1 FALSE POSITIVE. The bash tool hardcodes POSIX write detection, and
 *    bash-parser cannot parse a PowerShell script block (`{ ... }`), so a
 *    pipeline of read-only cmdlets is rejected as "bash write detection failed
 *    to parse command" — a message that is simply false for valid PowerShell.
 *
 *  - AC7 FALSE NEGATIVE (the more serious half). Because PowerShell never
 *    reaches detectWindowsWrites, PowerShell WRITE cmdlets report zero writes,
 *    tool-before.ts returns early at the `!analysis.hasWrites` guard, and the
 *    declared-scope check never runs. Out-of-scope writes are admitted.
 *
 * Contract after the fix: a pipeline built SOLELY from a known read-only cmdlet
 * allowlist classifies as a read; a pipeline containing a known write cmdlet
 * classifies as a write and is scope-checked; everything unrecognised keeps
 * failing closed. bash and shell are held to the SAME matrix.
 *
 * The sandbox executor is stubbed throughout. Without that control the native
 * Windows wrapper's own verdicts decide the outcome, which is host-dependent
 * (the runner binary is absent on many dev machines) and would make a
 * "should be blocked" assertion pass for the wrong reason.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../../src/config/schema';
import {
	_internals,
	createGuardrailsHooks,
} from '../../../../src/hooks/guardrails';
import { _resetSandboxUnavailableWarningState } from '../../../../src/hooks/guardrails/tool-before';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import { installActiveScopeBinding } from '../../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('powershell-read-classification-');
const DECLARED_SCOPE = ['src/'];

const originalGetSandboxExecutor = _internals.getSandboxExecutor;
const originalAssessSandboxEnforcement = _internals.assessSandboxEnforcement;

function defaultConfig(): GuardrailsConfig {
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

/**
 * Deterministic sandbox stub so only the classification path decides the
 * verdict. Three invariants must hold or the stub itself fails:
 * wrapCommand must return a string DIFFERENT from its input; the executor's
 * mechanism must equal assessSandboxEnforcement().capability.mechanism; and
 * capability must carry both identity and mechanism.
 */
function stubSandbox(): void {
	_internals.getSandboxExecutor = async () =>
		({
			mechanism: 'bubblewrap',
			isAvailable: () => true,
			wrapCommand: () => 'wrapped-command',
			getEnvOverrides: () => ({}),
		}) as never;
	_internals.assessSandboxEnforcement = async () =>
		({
			capability: { identity: 'cap-1', mechanism: 'bubblewrap' },
			requirements: {
				mode: 'advisory',
				require_filesystem: false,
				require_network: false,
				require_process: false,
			},
			satisfied: true,
			missing: [],
			cacheKey: 'cap-1',
			supported: true,
			unsupported: [],
		}) as never;
}

let sessionCounter = 0;

/**
 * Drive the real toolBefore hook for `bash` or `shell`. Returns the thrown
 * message when blocked, or null when admitted.
 */
async function run(
	tool: 'bash' | 'shell',
	command: string,
): Promise<string | null> {
	resetSwarmState();
	_resetSandboxUnavailableWarningState();
	sessionCounter += 1;
	const sessionID = `ps-${sessionCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files: DECLARED_SCOPE,
		dispatchCallId: 'call-1',
	});
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
	try {
		await hooks.toolBefore(
			{ tool, sessionID, callID: 'call-1' } as never,
			{ args: { command } } as never,
		);
		return null;
	} catch (error) {
		return String((error as Error)?.message ?? error);
	}
}

const TOOLS: Array<'bash' | 'shell'> = ['bash', 'shell'];

describe('#3099 AC1/AC4/AC7 — PowerShell classification in the shell-write guard', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
		stubSandbox();
	});
	afterEach(() => {
		_internals.getSandboxExecutor = originalGetSandboxExecutor;
		_internals.assessSandboxEnforcement = originalAssessSandboxEnforcement;
	});

	// ------------------------------------------------------------------
	// AC1 DISCRIMINATING: read-only cmdlet pipelines must be admitted.
	// The script block `{ ... }` is the construct bash-parser cannot parse.
	// ------------------------------------------------------------------
	const READ_ONLY_PIPELINES: Array<[string, string]> = [
		[
			'Where-Object script block filter',
			'Get-Content a.md | Where-Object { $_.Length -gt 5 }',
		],
		[
			'ForEach-Object script block projection',
			'Get-Content a.md | ForEach-Object { $_ }',
		],
		[
			'Where-Object over a read-only directory listing',
			'Get-ChildItem . | Where-Object { $_.PSIsContainer }',
		],
		[
			'Select-String over a read-only pipeline',
			'Get-Content a.md | Select-String -Pattern "foo"',
		],
	];

	for (const tool of TOOLS) {
		for (const [label, command] of READ_ONLY_PIPELINES) {
			it(`[${tool}] admits read-only PowerShell pipeline: ${label}`, async () => {
				expect(await run(tool, command)).toBeNull();
			});
		}
	}

	// ------------------------------------------------------------------
	// AC7 DISCRIMINATING: a PowerShell WRITE cmdlet must be detected as a
	// write so declared scope applies. Every target here is OUTSIDE the
	// declared scope ['src/'].
	// ------------------------------------------------------------------
	const OUT_OF_SCOPE_WRITES: Array<[string, string]> = [
		['bare Set-Content', 'Set-Content OUTSIDE.md hello'],
		[
			'Set-Content at the tail of a pipeline',
			'Get-Content a.md | Set-Content OUTSIDE.md',
		],
		[
			'Out-File at the tail of a pipeline',
			'Get-Content a.md | Out-File OUTSIDE.md',
		],
		[
			'Add-Content at the tail of a pipeline',
			'Get-Content a.md | Add-Content OUTSIDE.md',
		],
		['Copy-Item', 'Copy-Item a.md OUTSIDE.md'],
		['New-Item directory', 'New-Item -ItemType Directory OUTSIDE_DIR'],
	];

	for (const tool of TOOLS) {
		for (const [label, command] of OUT_OF_SCOPE_WRITES) {
			it(`[${tool}] blocks out-of-scope PowerShell write: ${label}`, async () => {
				expect(await run(tool, command)).not.toBeNull();
			});
		}
	}

	// ------------------------------------------------------------------
	// AC7 DISCRIMINATING: an unknown cmdlet is NOT a read. Fail-closed means
	// "not positively classified read-only" is a rejection, not an admission.
	// ------------------------------------------------------------------
	for (const tool of TOOLS) {
		it(`[${tool}] blocks a pipeline whose cmdlet is not on the read-only allowlist`, async () => {
			expect(
				await run(tool, 'Get-Content a.md | Some-UnknownCustomThing'),
			).not.toBeNull();
		});
	}

	// ------------------------------------------------------------------
	// AC4 PRESERVING: read-only commands already work and must keep working.
	// ------------------------------------------------------------------
	const READ_ONLY_SINGLE: Array<[string, string]> = [
		['Get-Content', 'Get-Content a.md'],
		['Select-String', 'Select-String -Path a.md -Pattern "foo"'],
		['Test-Path', 'Test-Path a.md'],
		['Measure-Object in a pipe', 'Get-Content a.md | Measure-Object -Line'],
	];

	for (const tool of TOOLS) {
		for (const [label, command] of READ_ONLY_SINGLE) {
			it(`[${tool}] keeps admitting read-only command: ${label}`, async () => {
				expect(await run(tool, command)).toBeNull();
			});
		}
	}

	// ------------------------------------------------------------------
	// AC4 PRESERVING: POSIX controls must keep failing closed.
	// ------------------------------------------------------------------
	const POSIX_WRITES: Array<[string, string]> = [
		['cp', 'cp a.md OUTSIDE.md'],
		['redirect', 'cat a.md > OUTSIDE.md'],
		['tee', 'tee OUTSIDE.md < a.md'],
	];

	for (const [label, command] of POSIX_WRITES) {
		it(`keeps blocking POSIX control: ${label}`, async () => {
			expect(await run('bash', command)).not.toBeNull();
		});
	}

	it('keeps blocking a recursive PowerShell delete on both tools', async () => {
		for (const tool of TOOLS) {
			expect(
				await run(tool, 'Get-ChildItem . | Remove-Item -Recurse'),
			).not.toBeNull();
		}
	});

	// ------------------------------------------------------------------
	// AC4 PRESERVING: genuinely unparseable commands keep failing closed on
	// the parse-error path — the fix must not become a blanket "allow".
	// ------------------------------------------------------------------
	const UNPARSEABLE: Array<[string, string]> = [
		['unclosed single quote', "echo 'unclosed quote"],
		['unclosed command substitution', 'echo $(unclosed'],
	];

	for (const [label, command] of UNPARSEABLE) {
		it(`keeps blocking an unparseable POSIX command: ${label}`, async () => {
			expect(await run('bash', command)).toContain(
				'bash write detection failed to parse command',
			);
		});
	}

	it('keeps blocking an unparseable PowerShell command that is not read-only', async () => {
		expect(
			await run('bash', "Get-Content a.md | Where-Object { $_ '"),
		).not.toBeNull();
	});
});
