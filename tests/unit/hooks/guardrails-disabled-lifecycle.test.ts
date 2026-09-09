/**
 * Issue #2664 — with guardrails.enabled=false the OPTIONAL policy denials
 * are inert while MANDATORY lifecycle bookkeeping stays active: Stage A
 * receipts land, lease candidates are remembered, and the structural
 * 1 MiB patch-payload bound still fails closed in BOTH modes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	clearScopeBindings,
	createScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	resolveAuthorizedScopeBinding,
} from '../../../src/scope/scope-persistence';
import {
	getAgentSession,
	resetSwarmState as resetState,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PASS_PAYLOAD = JSON.stringify({
	gates_passed: true,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 0,
			findings: [],
			files_scanned: 5,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

function config(enabled: boolean): GuardrailsConfig {
	return {
		enabled,
		max_tool_calls: 1,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
	};
}

let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('swarm-disabled-lifecycle-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	resetState();
});

afterEach(() => {
	resetState();
	clearScopeBindings();
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
});

describe('guardrails disabled — mandatory lifecycle, inert policy', () => {
	test('Stage A receipt lands with guardrails off (task reaches pre_check_passed)', async () => {
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder:setup-1.1',
		});
		resetState();
		const { ensureAgentSession } = await import('../../../src/state');
		const session = ensureAgentSession('architect');
		session.currentTaskId = '1.1';
		const hooks = createGuardrailsHooks(directory, config(false));
		await hooks.toolBefore(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c1' },
			{ args: {} },
		);
		await hooks.toolAfter(
			{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'c1' },
			{ title: '', output: PASS_PAYLOAD, metadata: null },
		);
		const snapshot = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		);
		expect(snapshot.state).toBe('pre_check_passed');
	});

	test('policy battery is inert with guardrails off (no denial throws)', async () => {
		const hooks = createGuardrailsHooks(directory, config(false));
		// Destructive-pattern shell command.
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 's', callID: 'p1' },
			{ args: { command: 'rm -rf /tmp/whatever' } },
		);
		// Full test-suite invocation without a file argument.
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 's', callID: 'p2' },
			{ args: { command: 'bun test' } },
		);
		// Interpreter command (bash tool is always interpreter-gated shape).
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 's', callID: 'p3' },
			{ args: { command: 'echo ok' } },
		);
	});

	test('policy battery still denies with guardrails on (control)', async () => {
		const hooks = createGuardrailsHooks(directory, config(true));
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 's', callID: 'p1' },
				{ args: { command: 'rm -rf /tmp/whatever' } },
			),
		).rejects.toThrow();
	});

	test('structural 1 MiB patch-payload bound still fails closed with guardrails off', async () => {
		const hooks = createGuardrailsHooks(directory, config(false));
		const hugePatch = `*** Begin Patch\n${'x'.repeat(1_100_000)}\n*** End Patch\n`;
		await expect(
			hooks.toolBefore(
				{ tool: 'apply_patch', sessionID: 's', callID: 'big' },
				{ args: { patch: hugePatch } },
			),
		).rejects.toThrow(/Patch payload exceeds 1 MB/);
	});

	test('lease maintenance active with guardrails off (revision CAS bump)', async () => {
		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'lease',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'renew',
							depends: [],
							files_touched: ['src/a.ts'],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
		const pending = createScopeBinding({
			directory,
			plan,
			taskId: '1.1',
			files: ['src/a.ts'],
			ownerSessionId: 'architect-session',
			ownerMessageId: 'task-call',
			dispatchCallId: 'task-call',
			activation: 'pending_child',
			source: 'plan',
		});
		expect(pending).not.toBeNull();
		const published = await persistAndRegisterScopeBinding(directory, pending!);
		expect(published.ok).toBe(true);
		const claimed = await claimScopeBindingForChildDurably({
			directory,
			parentSessionId: 'architect-session',
			childSessionId: 'coder-session',
			dispatchCallId: 'task-call',
		});
		expect(claimed.ok).toBe(true);
		const before = claimed.value.claimed;
		startAgentSession('coder-session', 'coder', directory);
		const session = getAgentSession('coder-session');
		expect(session).not.toBeNull();
		session!.currentTaskId = '1.1';
		session!.declaredCoderScope = ['src/a.ts'];
		const file = path.join(directory, 'src', 'a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'before');
		const hooks = createGuardrailsHooks(directory, config(false));
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-session', callID: 'w1' },
			{ args: { path: 'src/a.ts', content: 'after' } },
		);
		fs.writeFileSync(file, 'after');
		await hooks.toolAfter(
			{ tool: 'write', sessionID: 'coder-session', callID: 'w1' },
			{ title: '', output: 'Wrote file successfully.', metadata: null },
		);
		const refreshed = resolveAuthorizedScopeBinding({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(refreshed).not.toBeNull();
		expect(refreshed!.revision).toBe(before.revision + 1);
		expect(refreshed!.expiresAt).toBeGreaterThanOrEqual(before.expiresAt);
	});
});
