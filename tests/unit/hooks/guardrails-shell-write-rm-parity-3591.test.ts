/**
 * #3591 parity pins (collated trace 3586-3588-3591-shell-gate-walk-fixpoint,
 * Fix 6, plan "Parity tests"): the live gate, `/swarm guardrail explain`
 * (with and without --scope), and the scope_validate tool must AGREE on the
 * rm coverage classes the write-layer arm closes —
 * - flagless escape: all three deny;
 * - flagless in-scope: all three allow;
 * - late-flag escape: all three deny, naming the escaping target.
 * All three surfaces consume detectPosixWrites, so these rows pin that
 * sharing against drift (the pre-fix split-brain: gate ALLOW + explain
 * ALLOW + scope_validate DENY for `rm foo -rf ../../outside`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { handleGuardrailExplain } from '../../../src/services/guardrail-explain-service';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { evaluateScopeValidate } from '../../../src/tools/scope-validate';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const created: string[] = [];
let counter = 0;
afterAll(() => {
	for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

function workspace(): string {
	const root = canonicalMkdtemp('rmpar3591-');
	created.push(root);
	mkdirSync(path.join(root, 'src'), { recursive: true });
	return root;
}

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

/** The LIVE gate (coder agent, declared scope src/) — same harness class as the frozen C-checks. */
async function gateVerdict(
	root: string,
	command: string,
): Promise<{ allow: boolean; message: string }> {
	const sessionID = `rmpar3591-s${++counter}`;
	const callID = `rmpar3591-call-${counter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: root,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	const hooks = createGuardrailsHooks(root, undefined, config());
	try {
		await hooks.toolBefore(
			{ tool: 'bash', sessionID, callID },
			{ args: { command } },
		);
		return { allow: true, message: '' };
	} catch (error) {
		return {
			allow: false,
			message: (error as Error).message.split('\n')[0] ?? '',
		};
	} finally {
		resetSwarmState();
	}
}

async function explainDecision(root: string, argv: string[]): Promise<string> {
	const explained = await handleGuardrailExplain(root, argv);
	const m = /\| *Decision *\| *(\w+) */i.exec(explained);
	return m?.[1]?.toLowerCase() ?? `unparsed(${explained.slice(0, 80)})`;
}

function svVerdict(root: string, command: string): 'allow' | 'deny' {
	try {
		const result = evaluateScopeValidate(
			{ command, shell: 'posix', scope_files: ['src/'] },
			root,
		);
		return result.allowed ? 'allow' : 'deny';
	} catch {
		return 'deny';
	}
}

async function allSurfaces(command: string): Promise<{
	gate: boolean;
	explainScope: string;
	explainNoScope: string;
	sv: 'allow' | 'deny';
}> {
	const root = workspace();
	const words = command.split(' ');
	const gate = await gateVerdict(root, command);
	return {
		gate: gate.allow,
		explainScope: await explainDecision(root, ['--scope', 'src/', ...words]),
		explainNoScope: await explainDecision(root, words),
		sv: svVerdict(root, command),
	};
}

describe('#3591 parity: flagless escape — all surfaces deny', () => {
	test.each([
		'rm ../esc',
		'rm ../../outside',
		'rm -v ../esc',
	])('%s: gate/explain(±scope)/scope_validate all deny', async (command) => {
		const got = await allSurfaces(command);
		expect(got.gate).toBe(false);
		expect(got.explainScope).toBe('block');
		expect(got.explainNoScope).toBe('block');
		expect(got.sv).toBe('deny');
	}, 30_000);
});

describe('#3591 parity: flagless in-scope — all surfaces allow', () => {
	test.each([
		'rm src/temp.ts',
		'rm -i src/temp.ts',
		'rm src/a src/b',
	])('%s: gate/explain(±scope)/scope_validate all allow', async (command) => {
		const got = await allSurfaces(command);
		expect(got.gate).toBe(true);
		expect(got.explainScope).toBe('allow');
		expect(got.explainNoScope).toBe('allow');
		expect(got.sv).toBe('allow');
	}, 30_000);
});

describe('#3591 parity: late-flag escape — all deny, naming the escape', () => {
	test.each([
		['rm foo -rf ../../outside', '../../outside'],
		['rm -rf foo ../../outside', '../../outside'],
	])(
		'%s: all deny; the gate and explain name the escaping target',
		async (command, escapeTarget) => {
			const got = await allSurfaces(command);
			expect(got.gate).toBe(false);
			expect(got.explainScope).toBe('block');
			expect(got.explainNoScope).toBe('block');
			expect(got.sv).toBe('deny');
			// The denial names the ESCAPING target, not the first
			// non-allowlisted operand (plan r1 blocker 5).
			const root = workspace();
			const gate = await gateVerdict(root, command);
			expect(gate.message).toContain(escapeTarget);
			const explainText = await handleGuardrailExplain(root, [
				'--scope',
				'src/',
				...command.split(' '),
			]);
			expect(explainText).toContain(escapeTarget);
		},
		30_000,
	);
});
