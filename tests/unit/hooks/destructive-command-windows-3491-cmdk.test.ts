/**
 * #3539 closure F-4 shipped suite — cmd /k authority parity. CMD_STRIP_PREFIX
 * always modeled `\/[ck]`, but the declaration/builtin-prefix predicates
 * matched `\/c` only, so `cmd /k copy a ..\x` (the payload EXECUTES; the
 * shell merely stays open — executed ground truth) never selected the win32
 * authority and ADMITTED. Both predicates now match `\/[ck]`.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
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
	const ws = canonicalMkdtemp('cmdk-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `cmdk-s${++counter}`;
	const callID = `cmdk-call-${counter}`;
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

beforeEach(() => {
	resetSwarmState();
});

describe('closure F-4: cmd /k selects the win32 authority (#3539)', () => {
	test('cmd /k copy a ..\\x → DENIED (write config)', async () => {
		const got = await gate('cmd /k copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('cmd.exe /k copy a ..\\x → DENIED (destructive config)', async () => {
		const got = await gate('cmd.exe /k copy a ..\\x', true);
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/BLOCKED/);
	});

	test('path-qualified C:\\Windows\\System32\\cmd.exe /k copy a ..\\x → DENIED', async () => {
		const got = await gate('C:\\Windows\\System32\\cmd.exe /k copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('in-scope payload through /k admits (no over-block)', async () => {
		const got = await gate('cmd /k copy a src\\b');
		expect(got.verdict).toBe('ADMITTED');
	});

	test('switches before /k keep the parity (cmd /d /s /k)', async () => {
		const got = await gate('cmd /d /s /k copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
		expect(got.message).toMatch(/^WRITE BLOCKED/);
	});

	test('cmd /c control stays denied', async () => {
		const got = await gate('cmd /c copy a ..\\x');
		expect(got.verdict).toBe('DENIED');
	});
});
