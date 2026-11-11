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
		const text = (error as Error).message ?? '';
		if (!/BLOCKED|SCOPE_/.test(text)) throw error;
		return {
			allow: false,
			message: text.split('\n')[0] ?? '',
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
	} catch (error) {
		// PR #3615 feedback PRR-010: only a genuine scope-validate REJECTION
		// counts as a deny — a thrown ROOT_ESCAPE/SCOPE violation is
		// evaluateScopeValidate's deny channel, but any unrelated error must
		// fail the leg loudly instead of masquerading as a deny verdict.
		const message = (error as Error).message ?? '';
		if (/\b(?:ROOT_ESCAPE|SCOPE_[A-Z_]+|DESTRUCTIVE_COMMAND)\b/.test(message))
			return 'deny';
		throw error;
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
		// #3616 D2: a coder explain WITHOUT --scope no longer fabricates the
		// project-root scope — the scope dimension is unevaluated and the
		// verdict renders block (the pinned #3591 divergence is closed).
		expect(got.explainNoScope).toBe('block');
		expect(got.sv).toBe('allow');
	}, 30_000);
});

describe('#3591 parity: quoted and escaped destructive flags — all deny', () => {
	// PR #3615 feedback PRR-002: the boundary decode must hold on every
	// surface. Each surface must deny through the DESTRUCTIVE channel: a
	// flag misread as a filename would still be denied as a generic scope
	// write for an out-of-scope operand, so the verdict alone proves nothing.
	// Explain joins its argv with spaces, so it sees this exact command text.
	test.each([
		['rm "-rf" ../../outside', /^ *DESTRUCTIVE_TARGET_INVALID/],
		["rm '-rf' ../../outside", /^ *DESTRUCTIVE_TARGET_INVALID/],
		['rm \\-rf ../../outside', /^ *DESTRUCTIVE_TARGET_INVALID/],
		['rm "--recursive" ../../outside', /^ *DESTRUCTIVE_TARGET_INVALID/],
		['rm "-rf" .git', /^ *DESTRUCTIVE_TARGET_PROTECTED/],
		['rm "-rf" src', /^ *DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT/],
		['rm \\-rf src', /^ *DESTRUCTIVE_TARGET_NOT_SAFE_ARTIFACT/],
	])(
		'%s: every surface denies through the destructive channel',
		async (command, rule) => {
			const got = await allSurfaces(command);
			expect(got.gate).toBe(false);
			expect(got.explainScope).toBe('block');
			expect(got.explainNoScope).toBe('block');
			expect(got.sv).toBe('deny');
			const root = workspace();
			expect((await gateVerdict(root, command)).message).toContain(
				'Recursive delete target',
			);
			const report = await handleGuardrailExplain(root, [
				'--scope',
				'src/',
				...command.split(' '),
			]);
			expect(/\| *Firing Rule *\|(.*)\|/i.exec(report)?.[1]).toMatch(rule);
			expect(() =>
				evaluateScopeValidate(
					{ command, shell: 'posix', scope_files: ['src/'] },
					root,
				),
			).toThrow(/DESTRUCTIVE_COMMAND/);
		},
		30_000,
	);
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
			// The report echoes the command, so only the rule row can prove this.
			const firingRule = /\| *Firing Rule *\|(.*)\|/i.exec(explainText)?.[1];
			expect(firingRule).toContain(escapeTarget);
		},
		30_000,
	);
});

describe('#3591 brace operands — three-surface agreement (no-scope explain re-pinned by D2)', () => {
	// #3616 D2: explain WITHOUT `--scope` for a write-bearing command now
	// renders block (scope_unevaluated) — parity with the live gate's
	// SCOPE_NOT_DECLARED — replacing the pre-D2 "allow" divergence this
	// describe previously disclosed. Both brace shapes below block: the
	// `rm` shape via the #3569 brace-borne extractor rule (scope-
	// independent), the `rmdir` shape via the D2 scope-unevaluated rule.
	test('rm src/{a,../esc}: gate DENY, explain --scope block, scope_validate deny; explain no-scope stays block (extractor rule is scope-independent)', async () => {
		const command = 'rm src/{a,../esc}';
		const got = await allSurfaces(command);
		expect(got.gate).toBe(false);
		expect(got.explainScope).toBe('block');
		expect(got.sv).toBe('deny');
		// Honest current value: the brace-borne recursive-rm rule blocks even
		// without a declared scope (no divergence on THIS shape).
		expect(got.explainNoScope).toBe('block');
	}, 30_000);

	test('rmdir src/{a,../esc}: gate DENY, explain --scope block, scope_validate deny, explain WITHOUT --scope block (#3616 D2 scope_unevaluated)', async () => {
		const command = 'rmdir src/{a,../esc}';
		const got = await allSurfaces(command);
		expect(got.gate).toBe(false);
		expect(got.explainScope).toBe('block');
		expect(got.sv).toBe('deny');
		// #3616 D2 closed the #3591 explain no-scope divergence: a coder
		// explain without --scope now renders block (scope-unevaluated)
		// instead of an unverified "allow" for a gate-denied command.
		expect(got.explainNoScope).toBe('block');
	}, 30_000);
});
