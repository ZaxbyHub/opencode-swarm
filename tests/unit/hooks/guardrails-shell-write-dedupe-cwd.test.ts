/**
 * Same-literal writes from two different cwds must each be scope-checked at
 * their own resolved path (issue #3518 P-4 / frozen check C4's shipped
 * surface). The dedupe key previously collapsed the second occurrence onto
 * the first occurrence's resolution, so `cd src && echo x > f; cd ../.. &&
 * echo PWN > f` was admitted while real bash wrote outside the workspace.
 * Direct occurrence-survival + per-occurrence resolution assertions are
 * included (not only gate-denial end-to-end), per the plan critic.
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
	const ws = canonicalMkdtemp('p3518d-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `p3518d-${++counter}`;
	const callID = `p3518d-call-${counter}`;
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

describe('gate: same-literal writes from two cwds (real toolBefore)', () => {
	test('redirect pair separated by cd is DENIED at the second occurrence', async () => {
		await expect(
			gate('cd src && echo x > f; cd ../.. && echo PWN > f'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	test('builtin-operator pair separated by cd is DENIED', async () => {
		await expect(
			gate('cd src && truncate -s 0 f; cd ../.. && truncate -s 0 f'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	test('single in-scope write after cd stays ADMITTED (control)', async () => {
		await expect(gate('cd src && echo x > f')).resolves.toBe('ADMITTED');
	});
	test('single out-of-scope write stays BLOCKED (control)', async () => {
		await expect(gate('echo PWN > ../f')).resolves.toMatch(ANY_WRITE_BLOCK);
	});
});

describe('detection surface: both occurrences survive with distinct keys', () => {
	test('two same-literal redirect occurrences keep distinct operators', () => {
		const analysis = detectPosixWrites(
			'cd src && echo x > f; cd ../.. && echo PWN > f',
		);
		const fWrites = analysis.writes.filter((w) => w.path === 'f');
		expect(fWrites).toHaveLength(2);
		expect(new Set(fWrites.map((w) => w.operator)).size).toBe(2);
	});

	test('each occurrence resolves at its own tracked cwd', () => {
		const root = canonicalMkdtemp('p3518d-direct-');
		created.push(root);
		mkdirSync(path.join(root, 'src'), { recursive: true });
		// After `cd src`, `cd ../..` lands at the mkdtemp PARENT of root's
		// parent — one level ABOVE root, i.e. outside the workspace.
		const command = 'cd src && echo x > f; cd .. && echo PWN > f';
		const analysis = detectPosixWrites(command);
		const result = resolveWriteTargets(command, analysis.writes, root);
		const paths = result.map((r) => r.resolvedPath);
		expect(paths).toContain(path.resolve(root, 'src', 'f'));
		expect(paths).toContain(path.resolve(root, 'f'));
	});
});
