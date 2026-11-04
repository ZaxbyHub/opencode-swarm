/**
 * #3539 W6 shipped suite — destructive verb spellings (quote/escape/basename
 * normalization at every dc verb position), the index-based PowerShell
 * parameter walk with colon-glued `-Param:Value` binding, and the
 * basename-normalized path-qualified cmd.exe wrapper authority — driven
 * through the real `createGuardrailsHooks().toolBefore` gate (coder, declared
 * scope `src/`), with unit-level pins on the exported extractors and
 * `/swarm guardrail explain` parity legs for the cmd.exe authority.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcExtractPowerShellTargets,
	dcNormalizeVerbWord,
} from '../../../src/hooks/guardrails/destructive-command';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function config(destructive: boolean): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...(destructive ? { block_destructive_commands: true } : {}),
	};
}

interface Verdict {
	verdict: 'ADMITTED' | 'DENIED';
	message: string;
}

async function gate(command: string, destructive = false): Promise<Verdict> {
	const ws = canonicalMkdtemp('w6verb-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `w6v-s${++counter}`;
	const callID = `w6v-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config(destructive));
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { verdict: 'ADMITTED', message: '' };
	} catch (error) {
		return {
			verdict: 'DENIED',
			message: (error as Error).message.split('\n')[0],
		};
	} finally {
		resetSwarmState();
	}
}

const explainRoots: string[] = [];
afterEach(() => {
	for (const root of explainRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

beforeEach(() => {
	resetSwarmState();
});

describe('W6 verb spelling matrix (rm recursion arm, destructive config)', () => {
	test.each([
		['\\rm -rf ../../outside'],
		['"rm" -rf ../../outside'],
		["'/bin/rm' -rf ../../outside"],
		['/bin/rm -rf ../../outside'],
		['C:\\Windows\\system32\\rm.EXE -rf ../../outside'],
		['C:/Windows/system32/rm.exe -rf ../../outside'],
		// #3539 review advisory 2: on Git Bash the bare `rm.exe` IS rm
		// (ground truth: `rm.exe FILE` deletes); `/bin/rm.exe` matching rm is
		// the same over-match in the deny direction.
		['rm.exe -rf ../../outside'],
		['rm.EXE -rf ../../outside'],
		['/bin/rm.exe -rf ../../outside'],
	])('%s → DENIED (normalized verb)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test.each([
		['./rm -rf ../../outside'],
		['../tools/rm -rf ../../outside'],
		['/bin/RM -rf ../../outside'],
	])('%s → ADMITTED (relative paths stay project-local; POSIX basename is case-SENSITIVE)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('control: bare rm -rf ../../outside stays blocked', async () => {
		const got = await gate('rm -rf ../../outside', true);
		expect(got.verdict).toBe('DENIED');
	});
});

describe('W6 verb word normalization unit pins', () => {
	test.each([
		['\\rm', 'rm'],
		['"rm"', 'rm'],
		["'rm'", 'rm'],
		['/bin/rm', 'rm'],
		['C:\\Windows\\system32\\RM.EXE', 'rm'],
		['C:/Windows/system32/rm.exe', 'rm'],
		['\\Windows\\rm.exe', 'rm'],
	])('%s normalizes to %s', (word, expected) => {
		expect(dcNormalizeVerbWord(word)).toBe(expected);
	});

	test.each([
		['./rm'],
		['../rm'],
	])('%s is NOT normalized (relative spellings stay verbatim)', (word) => {
		expect(dcNormalizeVerbWord(word)).toBe(word);
	});

	test('/bin/RM keeps its case (POSIX absolutes are case-SENSITIVE — stays unmatched)', () => {
		// Basename extraction happens, but the CASE is preserved: 'RM' never
		// equals the lowercase verb, so /bin/RM does not match rm arms.
		expect(dcNormalizeVerbWord('/bin/RM')).toBe('RM');
	});
});

describe('W6 gate-local arm parity (normalized verbs)', () => {
	test.each([
		['\\rmdir /s ..\\x'],
		['"rmdir" /s ..\\x'],
		['C:\\Windows\\system32\\rmdir.exe /s ..\\x'],
	])('%s → DENIED (cmd rmdir arm)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test.each([
		['\\del /s ..\\x'],
		['"del" /s ..\\x'],
	])('%s → DENIED (cmd del arm)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test('"ri" -Recurse ../../outside → DENIED (PS arm through quotes)', async () => {
		const got = await gate('"ri" -Recurse ../../outside', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test.each([
		['\\mv a .swarm/state.json'],
		['"mv" a .swarm/state.json'],
		['/bin/mv a .swarm/state.json'],
	])('%s → DENIED (mv .swarm arm)', async (command) => {
		const got = await gate(command, true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/\.swarm/);
	});

	test('\\mv a src/b stays admitted (control)', async () => {
		const got = await gate('\\mv a src/b', true);
		expect(got.verdict).toBe('ADMITTED');
	});

	test('"git" worktree remove --force ../outside → DENIED (git arm through quotes)', async () => {
		const got = await gate('"git" worktree remove --force ../outside', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/worktree/);
	});
});

describe('W6 PowerShell parameter walk: index-based + colon-glued (RC-7)', () => {
	test('colon-glued -Path:/etc → DENIED through the gate', async () => {
		const got = await gate(
			'ri -Recurse -Path:/etc -Exclude node_modules',
			true,
		);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/system path "\/etc"/);
	});

	test('space-separated -Path /etc stays DENIED (control)', async () => {
		const got = await gate('ri -Recurse -Path /etc', true);
		expect(got.verdict).toBe('DENIED');
	});

	test.each([
		['ri -Recurse -Path:/etc'],
		['ri -Path:/etc -Recurse'],
		['ri -LiteralPath:/etc -Recurse'],
	])('%s extracts the glued value', (segment) => {
		expect(dcExtractPowerShellTargets(segment)).toContain('/etc');
	});

	test('repeated -Path binds EVERY occurrence (indexOf defect regression)', () => {
		const targets = dcExtractPowerShellTargets(
			'ri -Path /etc -Path /usr -Recurse',
		);
		expect(targets).toContain('/etc');
		expect(targets).toContain('/usr');
	});

	test('colon-glued switch value (-Recurse:$true) is not a path target', () => {
		expect(
			dcExtractPowerShellTargets('ri -Recurse:$true node_modules'),
		).toEqual(['node_modules']);
	});

	test('quoted verb reaches the extractor', () => {
		expect(dcExtractPowerShellTargets('"ri" -Path:/etc -Recurse')).toContain(
			'/etc',
		);
	});
});

describe('W6 path-qualified cmd.exe wrapper authority (RC-8)', () => {
	const PATH_QUALIFIED = 'C:\\Windows\\System32\\cmd.exe /c copy a ..\\x';

	test('write config: DENIED (win32 authority selected for the qualified spelling)', async () => {
		const got = await gate(PATH_QUALIFIED);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('destructive config: DENIED', async () => {
		const got = await gate(PATH_QUALIFIED, true);
		expect(got.verdict).toBe('DENIED');
	});

	test('control: bare cmd /c spelling stays denied', async () => {
		const got = await gate('cmd /c copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
	});

	test('in-scope payload through the qualified spelling admits (no over-block)', async () => {
		const got = await gate('C:\\Windows\\System32\\cmd.exe /c copy a src\\b');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('forward-slash absolute spelling (/c/Windows/... via MSYS path) selects the authority too', async () => {
		const got = await gate('/c/Windows/System32/cmd.exe /c copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
	});

	test.each([
		['C:\\Windows\\System32\\cmd.exe /c copy a ..\\x'],
		['cmd /c copy a ..\\x'],
	])('explain parity: %s explains as block', async (command) => {
		const root = canonicalMkdtemp('w6verb-explain-');
		explainRoots.push(root);
		const explained = await handleGuardrailExplain(root, [
			'--scope',
			'src/',
			...command.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *block */i);
	});

	test('explain parity: qualified spelling with in-scope payload explains as allow', async () => {
		const root = canonicalMkdtemp('w6verb-explain-');
		explainRoots.push(root);
		const explained = await handleGuardrailExplain(root, [
			'--scope',
			'src/',
			...'C:\\Windows\\System32\\cmd.exe /c copy a src\\b'.split(' '),
		]);
		expect(explained).toMatch(/\| *Decision *\| *allow */i);
	});
});
