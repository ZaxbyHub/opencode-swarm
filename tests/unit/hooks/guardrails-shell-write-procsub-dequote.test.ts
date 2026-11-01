/**
 * Quoted operands inside process substitutions must not escape the shell
 * write-scope gate (issue #3518 P-1 / frozen check C1's shipped surface).
 * The parse-failure string fallback splits on whitespace and keeps quote
 * characters; a quoted traversal operand resolved to a lexically different
 * path than the one bash writes. Legs run through the REAL
 * createGuardrailsHooks().toolBefore with a coder bound to scope src/,
 * plus direct resolved-shape pins (resolvedPath null, fail-closed).
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
	const ws = canonicalMkdtemp('p3518a-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `p3518a-${++counter}`;
	const callID = `p3518a-call-${counter}`;
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

describe('gate: quoted procsub operands (real toolBefore, coder scope src/)', () => {
	test('quoted out-of-scope rmdir operand is DENIED', async () => {
		await expect(gate('true >(rmdir "../../src/f")')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('quoted out-of-scope truncate operand is DENIED', async () => {
		await expect(
			gate('true >(truncate -s 0 "../../src/t.txt")'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	test('quoted out-of-scope mv destination is DENIED', async () => {
		await expect(gate('true >(mv a "../../src/t.txt")')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('unquoted in-scope operand stays ADMITTED (control)', async () => {
		await expect(gate('true >(rmdir src/f)')).resolves.toBe('ADMITTED');
	});
	test('unquoted out-of-scope operand stays BLOCKED (control)', async () => {
		await expect(gate('true >(rmdir ../../src/f)')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});

	// Critic round-1 finding 1: the whitespace-in-quotes and
	// fragment-in-unselected-token variants of the same class.
	test('quoted destination containing whitespace is DENIED (fragmented fallback)', async () => {
		await expect(gate('true >(mv a "../../outside src/f")')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	test('quoted redirect target with whitespace is DENIED', async () => {
		await expect(gate('true >(cat > "../../outside t.txt")')).resolves.toMatch(
			ANY_WRITE_BLOCK,
		);
	});
	// #3530 critic C2: the sibling form discriminates the fix — at base the
	// clean sibling write cleared the parse-error backstop and the torn
	// target escaped with the whole stage unflagged.
	test('clean sibling does not mask a torn redirect target', async () => {
		await expect(
			gate('true >(cat > src/ok); true >(cat > "../../outside t.txt")'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
	// #3530 critic D4: one procsub carrying both a fragment target and a
	// clean write — the multi-redirect withdrawal must name the stage.
	test('single procsub with fragment + clean write is DENIED', async () => {
		await expect(
			gate('true >(cat > ../../src/"f" && cat > src/ok)'),
		).resolves.toMatch(ANY_WRITE_BLOCK);
	});
});

describe('resolved shape: withdrawn fallback writes null out (fail-closed)', () => {
	test('a quote-fragment fallback operand resolves to resolvedPath null', () => {
		const analysis = detectPosixWrites('true >(mv a "../../outside src/f")');
		expect(analysis.writes.length).toBeGreaterThan(0);
		const result = resolveWriteTargets(
			'true >(mv a "../../outside src/f")',
			analysis.writes,
			'/ws',
		);
		for (const entry of result) {
			expect(entry.resolvedPath).toBeNull();
			expect(entry.resolved).toBe(false);
		}
	});

	test('a fully-quoted fallback operand dequotes and resolves', () => {
		const analysis = detectPosixWrites(
			'true >(truncate -s 0 "../../src/t.txt")',
		);
		expect(analysis.writes).toHaveLength(1);
		expect(analysis.writes[0].path).toBe('../../src/t.txt');
	});
});
