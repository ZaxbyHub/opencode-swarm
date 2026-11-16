/**
 * Dual-resolution cd tracking (#3530 feedback round): an unprovable cd is
 * judged at BOTH landings — tracked walk models the cd failing (cwd kept),
 * pessimistic walk models it succeeding (bash-true target, MSYS drive mapping,
 * landing propagated through && chains and control-flow bodies). The gate
 * requires EVERY landing to pass, so an ambiguity whose success landing is
 * outside the declared scope DENIES without filesystem truth at execution
 * time (mkdir-then-cd, win32 drive-phantom paths, stat error classes), while
 * every leg that base admitted for a genuinely in-scope landing stays
 * admitted (controls).
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

async function gate(command: string): Promise<string> {
	const ws = canonicalMkdtemp('dual3530-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `dual3530-${++counter}`;
	const callID = `dual3530-call-${counter}`;
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
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return 'ADMITTED';
	} catch (error) {
		return (error as Error).message.split('\n')[0];
	} finally {
		resetSwarmState();
	}
}

describe('dual-resolution: mkdir/clone-then-cd escapes base blocked (PRR-001)', () => {
	test('mkdir && cd && out-of-scope write is BLOCKED', async () => {
		await expect(
			gate('mkdir -p zz/src && cd zz && echo pwn > src/f'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('mkdir ; cd ; write (semicolon chain) is BLOCKED', async () => {
		await expect(
			gate('mkdir -p zz/src; cd zz; echo pwn > src/f'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('git init && cd && write is BLOCKED', async () => {
		await expect(
			gate('git init -q zz && cd zz && echo pwn > src/f'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('mkdir outside workspace && cd is BLOCKED', async () => {
		await expect(
			gate('mkdir -p ../oo && cd ../oo && echo pwn > src/f'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('working mkdir + in-scope write stays ADMITTED (control)', async () => {
		await expect(gate('mkdir -p zz && echo x > src/f')).resolves.toBe(
			'ADMITTED',
		);
	});
});

describe('dual-resolution: win32 drive-phantom cd (PRR-003)', () => {
	test('cd /e/... (MSYS drive spelling) + relative write is BLOCKED', async () => {
		await expect(gate('cd /e/ClaudeCode && echo x > src/f')).resolves.toMatch(
			ANY_BLOCK,
		);
	});
});

describe('dual-resolution: grouped cd forms (PRR-002)', () => {
	test('(cd missing; out-of-scope write) is BLOCKED', async () => {
		await expect(gate('(cd nx/y; echo pwn > ../../src/f2)')).resolves.toMatch(
			ANY_BLOCK,
		);
	});
	test('{ cd missing; write } is BLOCKED', async () => {
		await expect(
			gate('{ cd nx/y; echo pwn > ../../src/f2; }'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('if/then body cd + write is BLOCKED', async () => {
		await expect(
			gate('if true; then cd nx/y; echo pwn > ../../src/f2; fi'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('grouped working cd + in-scope write stays ADMITTED (control)', async () => {
		await expect(gate('(cd src; echo x > src/f)')).resolves.toBe('ADMITTED');
	});
});

describe('procsub withdrawal: then-led and pushd-led (PRR-005)', () => {
	test('then-led cd + procsub is BLOCKED', async () => {
		await expect(
			gate('if true; then cd ../..; fi; true >(truncate -s 0 src/f)'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('pushd-led directory change + procsub is BLOCKED', async () => {
		await expect(
			gate('pushd ../..; true >(truncate -s 0 src/f)'),
		).resolves.toMatch(ANY_BLOCK);
	});
});

describe('procsub withdrawal: fragment and torn operands (PRR-006)', () => {
	test('fragment redirect + sibling write is BLOCKED', async () => {
		await expect(
			gate('true >(cat > ../../src/"f"); true >(cat > src/ok)'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('single procsub carrying fragment + clean write is BLOCKED', async () => {
		await expect(
			gate('true >(cat > ../../src/"f" && cat > src/ok)'),
		).resolves.toMatch(ANY_BLOCK);
	});
	test('quoted-with-space redirect target is BLOCKED', async () => {
		await expect(gate('true >(cat > "../../outside t.txt")')).resolves.toMatch(
			ANY_BLOCK,
		);
	});
	test('backslash-escaped-space cp operand is BLOCKED', async () => {
		await expect(gate('true >(cp a ../../out\\ src)')).resolves.toMatch(
			ANY_BLOCK,
		);
	});
	test('benign in-scope procsub stays ADMITTED (control)', async () => {
		await expect(gate('true >(cat > src/ok)')).resolves.toBe('ADMITTED');
	});
});
