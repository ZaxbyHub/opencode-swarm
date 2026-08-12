import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	clearScopeBindings,
	createScopeBinding,
} from '../../../src/scope/scope-binding';
import {
	claimScopeBindingForChildDurably,
	persistAndRegisterScopeBinding,
	resolveAuthorizedScopeBinding,
	tombstoneScopeBinding,
} from '../../../src/scope/scope-persistence';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const cleanups: Array<() => void> = [];
const config: GuardrailsConfig = {
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

async function fixture() {
	const created = createSafeTestDir('scope-lease-wiring-2096-');
	cleanups.push(created.cleanup);
	const directory = created.dir;
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Lease wiring',
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
						description: 'renew exact active lease',
						depends: [],
						files_touched: ['src/a.ts'],
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
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
	if (!pending) throw new Error('pending binding fixture failed');
	const published = await persistAndRegisterScopeBinding(directory, pending);
	if (!published.ok) throw new Error(published.message);
	const claimed = await claimScopeBindingForChildDurably({
		directory,
		parentSessionId: 'architect-session',
		childSessionId: 'coder-session',
		dispatchCallId: 'task-call',
	});
	if (!claimed.ok) throw new Error(claimed.message);
	startAgentSession('coder-session', 'coder', directory);
	const session = getAgentSession('coder-session');
	if (!session) throw new Error('coder session fixture failed');
	session.currentTaskId = '1.1';
	session.declaredCoderScope = ['src/a.ts'];
	return { directory, binding: claimed.value.claimed };
}

afterEach(() => {
	resetSwarmState();
	clearScopeBindings();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('scope lease renewal production wiring', () => {
	test('toolBefore snapshot plus successful toolAfter refreshes disk and memory', async () => {
		const { directory, binding } = await fixture();
		const file = path.join(directory, 'src', 'a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'before');
		const hooks = createGuardrailsHooks(directory, undefined, config);
		await hooks.toolBefore(
			{ tool: 'write', sessionID: 'coder-session', callID: 'write-call' },
			{ args: { path: 'src/a.ts', content: 'after' } },
		);
		fs.writeFileSync(file, 'after');
		await hooks.toolAfter(
			{ tool: 'write', sessionID: 'coder-session', callID: 'write-call' },
			{ title: '', output: 'Wrote file successfully.', metadata: null },
		);
		const refreshed = resolveAuthorizedScopeBinding({
			directory,
			taskId: '1.1',
			activeSessionId: 'coder-session',
		});
		expect(refreshed?.generationId).toBe(binding.generationId);
		expect(refreshed?.revision).toBe(binding.revision + 1);
		expect(refreshed?.leaseStartedAt).toBeGreaterThanOrEqual(
			binding.leaseStartedAt,
		);
	});

	test('shell guard reports an expired durable generation before generic denial', async () => {
		const { directory, binding } = await fixture();
		expect(
			await tombstoneScopeBinding(directory, binding, 'expired'),
		).toMatchObject({
			ok: true,
		});
		const hooks = createGuardrailsHooks(directory, undefined, config);
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: 'coder-session', callID: 'expired-call' },
				{ args: { command: 'echo changed > src/a.ts' } },
			),
		).rejects.toThrow(/^SCOPE_BINDING_EXPIRED:.*ACTION\[architect\]/);
	});
});
