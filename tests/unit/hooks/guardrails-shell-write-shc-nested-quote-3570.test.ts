/**
 * #3570 shipped suite — nested `sh -c` chains through the real gate.
 *
 * Root cause (trace 3569-3570-shell-write-gate-windows, 04-root-cause.md):
 * dcNormalizeCommand Step 4's blind `''` collapse corrupted the POSIX `'\''`
 * splice so the unwrap truncated payloads to the bare verb; the fix preserves
 * backslash-escaped pairs AND withdraws (fail-closed, via the existing
 * depthExceeded channel) chains nesting >= 3 `sh -c` layers, whose quote
 * structure cannot be re-parsed faithfully level over level. Levels 1-2 keep
 * their verdicts; a 2-level in-scope write must keep ADMITTING (the
 * anti-over-block boundary).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	dcNormalizeCommand,
	dcUnwrapWrappersBounded,
} from '../../../src/hooks/guardrails/destructive-command';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

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
		block_destructive_commands: true,
	};
}

async function gate(command: string): Promise<'ADMITTED' | string> {
	const ws = canonicalMkdtemp('shc3570-ws-');
	created.push(ws);
	mkdirSync(path.join(ws, 'src'), { recursive: true });
	const sessionID = `shc3570-s${++counter}`;
	const callID = `shc3570-call-${counter}`;
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
		return (error as Error).message.split('\n')[0] ?? 'DENIED';
	} finally {
		resetSwarmState();
	}
}

// '\'' — close-quote, escaped quote, re-open-quote (runtime constant so no
// tooling escaping ambiguity can corrupt the splice).
const Q = String.fromCharCode(39, 92, 39, 39);

beforeEach(() => {
	resetSwarmState();
});

describe('normalization preserves the POSIX quote splice', () => {
	test("an escaped-quote pair survives Step 4 ('\\''), an even-run pair still collapses", () => {
		const norm = dcNormalizeCommand(`rm ${Q}src/x${Q}`);
		// The 4-char splice survives INTACT (an escaped quote is never an
		// empty-string splice); the pre-fix bug collapsed it to quote+backslash.
		expect(norm).toContain(Q);
		// r''m evasion decode is unchanged (no backslash before the pair).
		expect(dcNormalizeCommand(`R''e''m`)).toBe('Rem');
	});
});

describe('layer counting + withdrawal (4.5 r2 narrowing)', () => {
	test('multi-token products keep normal verdicts; single-token truncation withdraws', () => {
		const l2 = `sh -c "sh -c 'tee src/f'"`;
		expect(dcUnwrapWrappersBounded(dcNormalizeCommand(l2)).depthExceeded).toBe(
			false,
		);
		// alt-quote 3-level: extracts FULLY (multi-token product) — no
		// withdrawal; the verb arms see the real payload.
		const altL3 = dcUnwrapWrappersBounded(
			dcNormalizeCommand(`sh -c 'sh -c "sh -c ${Q}rm -rf ../../outside${Q}"'`),
		);
		expect(altL3.depthExceeded).toBe(false);
		expect(altL3.command).toBe('rm -rf ../../outside');
		// same-kind 3-level + 4-level alt: iterative product collapses to a
		// single token -> withdrawal with the distinct flag.
		for (const chain of [
			`sh -c 'sh -c ${Q}sh -c ${Q}${Q}rm -rf ../../outside${Q}${Q}${Q}'`,
			`sh -c 'sh -c "sh -c ${Q}sh -c ${Q}}"rm -rf ../../outside"${Q}"'`,
		]) {
			const b = dcUnwrapWrappersBounded(dcNormalizeCommand(chain));
			expect(b.depthExceeded).toBe(true);
			expect(b.shCWithdrawal).toBe(true);
		}
	});
});

describe('gate verdicts', () => {
	// PRR-011: each DENY leg pins its full reason — the alt-quote/space-
	// separated shapes extract faithfully and deny via the recursive-delete
	// arm ("Recursive delete target ... traversal"); the same-kind/4-level
	// shapes truncate and deny via the distinct sh-c withdrawal message.
	test('3-level alternating-quote rm chain DENIES', async () => {
		const got = await gate(
			`sh -c 'sh -c "sh -c ${Q}rm -rf ../../outside${Q}"'`,
		);
		expect(got).toContain('BLOCKED');
		expect(got).toContain('Recursive delete target');
	});
	test('3-level same-kind chain DENIES via the withdrawal message', async () => {
		const got = await gate(
			`sh -c 'sh -c ${Q}sh -c ${Q}${Q}rm -rf ../../outside${Q}${Q}${Q}'`,
		);
		expect(got).toContain('shell chain nests 3 or more sh -c layers');
	});
	test('4-level alternating chain DENIES via the withdrawal message', async () => {
		const got = await gate(
			`sh -c 'sh -c "sh -c ${Q}sh -c ${Q}"rm -rf ../../outside"${Q}"'`,
		);
		expect(got).toContain('shell chain nests 3 or more sh -c layers');
	});
	test('levels 1 and 2 keep their DENY', async () => {
		expect(await gate(`sh -c 'rm -rf ../../outside'`)).toContain('BLOCKED');
		expect(await gate(`sh -c "sh -c 'rm -rf ../../outside'"`)).toContain(
			'BLOCKED',
		);
	});
	test('2-level in-scope write keeps ADMITTING (anti-over-block boundary)', async () => {
		expect(await gate(`sh -c "sh -c 'tee src/f'"`)).toBe('ADMITTED');
	});
});

describe('withdrawal deny messages (PRR-011)', () => {
	test('whole-command withdrawal emits the distinct sh-c message', async () => {
		// A TRUNCATING (same-kind) chain — its iterative unwrap collapses to
		// a single token, so the withdrawal fires (the alt-quote shape
		// extracts faithfully and denies via the recursive-delete arm
		// instead; the withdrawal message legs below pin the distinct reason).
		const got = await gate(
			`sh -c 'sh -c ${Q}sh -c ${Q}${Q}rm -rf ../../outside${Q}${Q}${Q}'`,
		);
		expect(got).toContain('shell chain nests 3 or more sh -c layers');
	});
	test('compound command whose SECOND segment triggers the withdrawal', async () => {
		const got = await gate(
			`echo ok && sh -c 'sh -c ${Q}sh -c ${Q}${Q}rm -rf ../../outside${Q}${Q}${Q}'`,
		);
		expect(got).toContain('shell chain nests 3 or more sh -c layers');
	});
});
