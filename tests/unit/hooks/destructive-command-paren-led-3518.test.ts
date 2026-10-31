/**
 * Parenthesis-led segments must reach the live destructive-command arms
 * (issue #3518 P-5 / frozen check C5's shipped surface, plus the class
 * sweep: rd/rmdir/del (cmd.exe), rm (POSIX), and Remove-Item (PowerShell)).
 * A parenthesized segment `(rd ../../outside /s)` runs the same verb in a
 * POSIX subshell; the live arms' segment-START anchors let it skip them,
 * while the delimiter-aware classifier already fires — the reversed wedge.
 * Analysis-only legs through the real toolBefore: nothing executes.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const ANY_BLOCK = /^(WRITE )?BLOCKED/;
const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

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

async function gate(
	command: string,
	tool: 'bash' | 'shell' = 'bash',
): Promise<string> {
	const ws = canonicalMkdtemp('p3518e-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `p3518e-${++counter}`;
	const callID = `p3518e-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: ws,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(ws, undefined, config());
	try {
		await hooks.toolBefore({ tool, sessionID, callID }, { args: { command } });
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message.split('\n')[0];
	} finally {
		resetSwarmState();
	}
}

describe('gate: paren-led recursive delete segments (analysis-only)', () => {
	test('(rd <oos> /s) is BLOCKED by the live arm', async () => {
		await expect(gate('(rd ../../outside /s)')).resolves.toMatch(ANY_BLOCK);
	});
	test('(rd /s /q <oos>) is BLOCKED', async () => {
		await expect(gate('(rd /s /q ../../outside)')).resolves.toMatch(ANY_BLOCK);
	});
	test('(del /s /q <oos>) is BLOCKED', async () => {
		await expect(gate('(del /s /q ../../outside)')).resolves.toMatch(ANY_BLOCK);
	});
	test('(rmdir /s <oos>) is BLOCKED', async () => {
		await expect(gate('(rmdir /s ../../outside)')).resolves.toMatch(ANY_BLOCK);
	});
	test('no-paren control rd <oos> /s stays BLOCKED', async () => {
		await expect(gate('rd ../../outside /s')).resolves.toMatch(ANY_BLOCK);
	});
	test('benign paren segment stays ADMITTED (control)', async () => {
		await expect(gate('(echo hi); echo ok > src/f')).resolves.toBe('ADMITTED');
	});
});

describe('gate: paren-led POSIX rm and PowerShell Remove-Item (class sweep)', () => {
	test('(rm -rf <oos>) is BLOCKED (glued paren)', async () => {
		await expect(gate('(rm -rf ../../outside)')).resolves.toMatch(ANY_BLOCK);
	});
	test('( rm -rf <oos> ) is BLOCKED (spaced paren — final-critic round 1)', async () => {
		await expect(gate('( rm -rf ../../outside )')).resolves.toMatch(ANY_BLOCK);
	});
	test('{ rm -rf <oos> } is BLOCKED (brace group)', async () => {
		await expect(gate('{ rm -rf ../../outside; }')).resolves.toMatch(ANY_BLOCK);
	});
	test('(Remove-Item <oos> -Recurse) is BLOCKED', async () => {
		await expect(
			gate('(Remove-Item ../../outside -Recurse)', 'shell'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('no-paren rm -rf control stays BLOCKED', async () => {
		await expect(gate('rm -rf ../../outside')).resolves.toMatch(ANY_BLOCK);
	});
});
