/**
 * The parse-failure process-substitution fallback must not resolve writes
 * at the starting cwd when the same line changed directory (issue #3518
 * P-3 / frozen check C3's shipped surface). `cd ../.. && true >(truncate -s
 * 0 src/f)` was ADMITTED while its procsub-free twin was BLOCKED; the fix
 * withdraws such writes to a null resolution (fail-closed). Also pins the
 * direct resolved shape.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	detectPosixWrites,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const ANY_WRITE_BLOCK = /^(WRITE )?BLOCKED/;
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
	const ws = canonicalMkdtemp('p3518c-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `p3518c-${++counter}`;
	const callID = `p3518c-call-${counter}`;
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

describe('gate: procsub fallback after cd (real toolBefore, coder scope src/)', () => {
	test('cd ../.. && true >(truncate src/f) is DENIED like its plain twin', async () => {
		await expect(
			gate('cd ../.. && true >(truncate -s 0 src/f)'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	test('the procsub-free twin stays BLOCKED (control)', async () => {
		await expect(gate('cd ../.. && truncate -s 0 src/f')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('a procsub with NO cd in the line keeps today’s in-scope admission (control)', async () => {
		await expect(gate('true >(truncate -s 0 src/f)')).resolves.toBe('ADMITTED');
	});
});

describe('resolved shape: post-cd fallback writes null out (fail-closed)', () => {
	test('cd-context procsub write resolves to resolvedPath null', () => {
		const command = 'cd ../.. && true >(truncate -s 0 src/f)';
		const analysis = detectPosixWrites(command);
		expect(analysis.writes.length).toBeGreaterThan(0);
		const result = resolveWriteTargets(command, analysis.writes, '/ws');
		for (const entry of result) {
			if (entry.original.unresolvedContext === true) {
				expect(entry.resolvedPath).toBeNull();
				expect(entry.resolved).toBe(false);
			}
		}
		expect(result.some((e) => e.original.unresolvedContext === true)).toBe(
			true,
		);
	});
});
